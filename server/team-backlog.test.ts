import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTeamBacklog, type BacklogScope } from "../shared/team-backlog.ts";
import type { StoredConnection } from "./connectors/types.ts";
import { OngoingGoals } from "./ongoing-goals.ts";
import { backlogScopeContains, inferTeamBacklog, jiraProjectsFromBoard, scanTeamBacklog } from "./team-backlog.ts";
import { advanceTeamBacklog } from "./team-backlog-runner.ts";
import type { GroupRecord } from "./store.ts";
import type { WorkCoordination } from "./work-coordination.ts";
import type { WorkRecord } from "./work-items.ts";
import type { Watch } from "../shared/watches.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const sha = "a".repeat(40);
const connections: StoredConnection[] = [
  { id: "jira-main", connectorId: "jira", label: "Jira", settings: { site: "http://127.0.0.1:8025" },
    secrets: { email: "fixture@example.invalid", apiToken: "fixture" }, sections: ["Delivery"], enabled: true },
  { id: "gitlab-main", connectorId: "gitlab", label: "GitLab", settings: { site: "http://127.0.0.1:8025", project: "acme/app" },
    secrets: { token: "fixture" }, sections: ["Delivery"], enabled: true },
];
const group = { id: "room", name: "Delivery board", threadId: "room-thread", memberIds: ["lead"],
  section: "Delivery", taskBoard: { connectionId: "jira-main", query: "project = PAY AND sprint in openSprints()" }, dm: false } as GroupRecord;
const scopes: BacklogScope[] = [
  { id: "jira", connectorId: "jira", connectionId: "jira-main", query: "project = PAY", label: "Jira", groupId: "room" },
  { id: "gitlab", connectorId: "gitlab", connectionId: "gitlab-main", query: "acme/app", label: "GitLab", groupId: "room" },
];

function mockApi() {
  let jiraPageTwoFails = false;
  let addedIssue = false;
  let addedMr = false;
  let closedMr = false;
  let mergedMr = false;
  let blockerDone = false;
  let currentSha = sha;
  const requested: string[] = [];
  const response = (body: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json", ...headers },
  });
  const issue = (key: string, blockers: string[] = [], done = false) => ({ key, fields: {
    summary: `Deliver ${key}`, description: `Accept ${key}`, priority: { name: key.endsWith("1") ? "High" : "Medium" },
    status: { name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" } },
    project: { key: "PAY" }, updated: "2026-09-24T10:00:00Z",
    issuelinks: blockers.map(blocker => ({ type: { inward: "is blocked by" }, inwardIssue: { key: blocker } })),
  } });
  const mr = (iid: number, state = "opened") => ({ iid, title: `Review !${iid}`, state, sha: currentSha,
    updated_at: "2026-09-24T10:00:00Z" });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requested.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/rest/api/3/search/jql")) {
      const cursor = JSON.parse(String(init?.body ?? "{}")) as { nextPageToken?: string };
      if (cursor.nextPageToken === "jira-two") {
        if (jiraPageTwoFails) return new Response("down", { status: 503 });
        return response({ issues: [issue("PAY-2", [], blockerDone), ...(addedIssue ? [issue("PAY-4")] : [])] });
      }
      return response({ issues: [issue("PAY-1", ["PAY-2"]), issue("PAY-3")], nextPageToken: "jira-two" });
    }
    if (url.includes("/issues?")) {
      const page = new URL(url).searchParams.get("page");
      return response(page === "1" ? [{ iid: 71, title: "GitLab issue", state: "opened" }] : [], { "x-next-page": page === "1" ? "2" : "" });
    }
    if (url.includes("/merge_requests?")) return response([
      ...(closedMr || mergedMr ? [] : [mr(10)]), ...(addedMr ? [mr(11)] : []),
    ], { "x-next-page": "" });
    if (url.endsWith("/merge_requests/10/approvals")) return response({ approvals_left: 2 });
    if (url.endsWith("/merge_requests/10")) return response({ ...mr(10, mergedMr ? "merged" : "closed"),
      ...(mergedMr ? { merge_commit_sha: "c".repeat(40) } : {}) });
    throw new Error(`Unexpected fixture request ${url}`);
  };
  return { fetchImpl, requested, failSecondJiraPage: () => { jiraPageTwoFails = true; },
    restoreJira: () => { jiraPageTwoFails = false; }, addIssue: () => { addedIssue = true; },
    addMr: () => { addedMr = true; }, closeMr: () => { closedMr = true; },
    mergeMr: () => { closedMr = false; mergedMr = true; }, finishBlocker: () => { blockerDone = true; },
    moveHead: () => { currentSha = "b".repeat(40); } };
}

function mutatingWrite(request: string) {
  return /^(PUT|PATCH|DELETE) /.test(request) || /^(POST) .*(?:\/merge$|\/transitions$)/.test(request);
}

function writeReadyApi() {
  let merged = false;
  let jiraDone = false;
  const requested: string[] = [];
  const body = (value: unknown, headers?: Record<string, string>) => new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json", ...headers },
  });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requested.push(`${method} ${url}`);
    if (url.endsWith("/rest/api/3/search/jql")) return body({ issues: [{ key: "PAY-1", fields: {
      summary: "Deliver PAY-1", description: "Accept PAY-1",
      status: { name: jiraDone ? "Done" : "In Progress", statusCategory: { key: jiraDone ? "done" : "indeterminate" } },
      project: { key: "PAY" }, updated: "2026-09-24T10:00:00Z",
    } }] });
    if (url.includes("/issues?")) return body([], { "x-next-page": "" });
    if (url.includes("/merge_requests?")) return body([{ iid: 10, title: "Ready", state: merged ? "merged" : "opened",
      sha, updated_at: "2026-09-24T10:00:00Z" }], { "x-next-page": "" });
    if (url.endsWith("/merge_requests/10/merge")) {
      merged = true;
      return body({ state: "merged" });
    }
    if (url.endsWith("/merge_requests/10")) return body({
      state: merged ? "merged" : "opened", sha, detailed_merge_status: "mergeable",
      draft: false, has_conflicts: false, blocking_discussions_resolved: true,
      head_pipeline: { status: "success", sha }, merge_commit_sha: merged ? "c".repeat(40) : null,
    });
    if (url.endsWith("/merge_requests/10/approvals")) return body({
      approvals_left: 0,
      approved_by: [
        { user: { id: 101 }, approved_at: "2026-09-24T11:00:00Z" },
        { user: { id: 102 }, approved_at: "2026-09-24T11:00:00Z" },
      ],
    });
    if (url.endsWith("/merge_requests/10/approval_state")) return body({ rules: [
      { name: "Security", approved: true, approved_by: [{ id: 101 }] },
      { name: "Manager", approved: true, approved_by: [{ id: 102 }] },
    ] });
    if (url.includes("/merge_requests/10/versions")) return body([{ head_commit_sha: sha, created_at: "2026-09-24T10:00:00Z" }]);
    if (url.endsWith("/projects/acme%2Fapp")) return body({
      only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true,
    });
    if (url.includes("/issue/PAY-1/transitions")) {
      if (method === "POST") {
        jiraDone = true;
        return new Response(null, { status: 204 });
      }
      return body({ transitions: [{ id: "11", to: { name: "Done", statusCategory: { key: "done" } } }] });
    }
    if (url.includes("/issue/PAY-1")) return body({ key: "PAY-1", fields: { status: {
      name: jiraDone ? "Done" : "In Progress", statusCategory: { key: jiraDone ? "done" : "indeterminate" },
    } } });
    throw new Error(`Unexpected fixture request ${method} ${url}`);
  };
  return { fetchImpl, requested };
}

function evidencedItem(id: string, identity: string): WorkRecord {
  return {
    id, groupId: "room", threadId: `hub-${id}`, scope: "Delivery", identity, coordinatorBotId: "lead",
    title: identity, status: "completed", revision: 1, objective: "Deliver", detail: "Evidenced",
    acceptanceCriteria: ["Done"], criteria: [{ id: "check", text: "Done", state: "checked", evidence: ["ev"] }],
    assignments: [], decisions: [], artifacts: [], evidence: [], links: [], inputHash: "fixture",
    executions: 1, runStartedAt: 1, sources: [], createdAt: 1, updatedAt: 1,
  } as WorkRecord;
}

function evidencedWriteGoal(dir: string, fetchImpl: typeof fetch, options: {
  connections?: StoredConnection[];
  teamMissionWrites?: boolean;
} = {}) {
  const goals = new OngoingGoals(join(dir, "goals.json"));
  const jiraIdentity = "jira:jira-main:PAY-1";
  const gitlabIdentity = "gitlab:gitlab-main:acme/app!10";
  const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room-thread",
    objective: "finish our current Jira work and merge the MRs" }, "execution", {
    ...emptyTeamBacklog("Delivery"), scopes, targets: [
      { identity: jiraIdentity, connectorId: "jira", connectionId: "jira-main", externalId: "PAY-1",
        kind: "work_item", title: "Deliver PAY-1", state: "in_progress", label: "In Progress",
        updatedAt: 1, observedAt: 1, taskId: "jira-task" },
      { identity: gitlabIdentity, connectorId: "gitlab", connectionId: "gitlab-main", externalId: "acme/app!10",
        kind: "change_request", title: "Ready", state: "in_review", label: "opened",
        updatedAt: 1, observedAt: 1, headSha: sha, dispatchedHeadSha: sha, taskId: "mr-task" },
    ],
  });
  const records = new Map<string, WorkRecord>([
    ["jira-task", evidencedItem("jira-task", jiraIdentity)],
    ["mr-task", evidencedItem("mr-task", gitlabIdentity)],
  ]);
  const coordination = {
    items: { records, find: (_section: string, identity: string) => [...records.values()].find(item => item.identity === identity) },
    accessible: () => true, evidenceProvenance: () => "observed",
    ensure: async () => { throw new Error("should reuse evidenced tasks"); },
  } as unknown as WorkCoordination;
  return {
    goal,
    deps: {
      goals, coordination, connections: () => options.connections ?? connections, groups: () => [group],
      watches: () => [], ownerSection: () => "Delivery", fetchImpl,
      ...(options.teamMissionWrites !== undefined ? { teamMissionWrites: options.teamMissionWrites } : {}),
    },
  };
}

describe("team backlog scope and inventory", () => {
  it("takes the assigned Jira board, scoped repository watches and linked work, excluding another team", () => {
    const watch = { section: "Delivery", enabled: true,
      source: { type: "connection", connectionId: "gitlab-main", scope: { project: "acme/app" } }, name: "MR watch" } as unknown as Watch;
    const unrelated = { ...watch, section: "Finance", source: { ...watch.source, scope: { project: "finance/private" } } } as Watch;
    const inferred = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: [group],
      watches: [watch, unrelated], connections, work: [] });
    expect(inferred.scopes.map(scope => [scope.connectorId, scope.query])).toEqual([
      ["jira", "project = PAY AND statusCategory != Done"], ["gitlab", "acme/app"],
    ]);
    expect(inferred.choices).toHaveLength(0);
    expect(inferred.gates).toHaveLength(0);
  });

  it("offers actual repo candidates when global connections do not identify this team's owner", () => {
    const global = connections.map(connection => ({ ...connection, sections: [] }));
    global.push({ ...global[1], id: "gitlab-other", settings: { ...global[1].settings, project: "acme/other" } });
    const inferred = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: [group], watches: [], connections: global, work: [] });
    expect(inferred.choices.map(scope => scope.query)).toEqual(["project = PAY AND statusCategory != Done", "acme/app", "acme/other"]);
    expect(inferred.gates[0]?.kind).toBe("scope");
  });

  it("prefers team-scoped connections and lists both sides when global projects are ambiguous", () => {
    const global = connections.map(connection => ({ ...connection, sections: [],
      settings: { ...connection.settings, ...(connection.connectorId === "jira" ? { project: "PAY" } : {}) } }));
    const all = [...global,
      { ...global[0], id: "jira-other", settings: { ...global[0].settings, project: "OPS" } },
      { ...global[1], id: "gitlab-other", settings: { ...global[1].settings, project: "acme/other" } }];
    const missingBoard = [{ ...group, taskBoard: undefined }];
    const choice = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: missingBoard,
      watches: [], connections: all, work: [] });
    expect(choice.scopes).toEqual([]);
    expect(choice.choices.map(scope => scope.query)).toEqual(["project = PAY AND statusCategory != Done", "project = OPS AND statusCategory != Done", "acme/app", "acme/other"]);
    expect(choice.gates[0]?.detail).toContain("Select the applicable");
    const owned = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: missingBoard,
      watches: [], connections: all.map(connection => ["jira-main", "gitlab-main"].includes(connection.id)
        ? { ...connection, sections: ["Delivery"] } : connection), work: [] });
    expect(owned.scopes.map(scope => scope.query)).toEqual(["project = PAY AND statusCategory != Done", "acme/app"]);
    expect(owned.choices).toEqual([]);
  });

  it("does not mistake the only workspace-global connections for team ownership", () => {
    const global = connections.map(connection => ({ ...connection, sections: [],
      settings: { ...connection.settings, ...(connection.connectorId === "jira" ? { project: "PAY" } : {}) } }));
    const inferred = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead",
      groups: [{ ...group, taskBoard: undefined }], watches: [], connections: global, work: [] });
    expect(inferred.scopes).toEqual([]);
    expect(inferred.choices.map(choice => choice.query)).toEqual(["project = PAY AND statusCategory != Done", "acme/app"]);
    expect(inferred.gates[0]?.kind).toBe("scope");
  });

  it("includes all Jira watches without a board and never substitutes an invalid GitLab project", async () => {
    const jiraWatch = (project: string) => ({ section: "Delivery", enabled: true, name: `${project} watch`,
      source: { type: "connection", connectionId: "jira-main", scope: { project } } }) as unknown as Watch;
    const inferred = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: [{ ...group, taskBoard: undefined }],
      watches: [jiraWatch("PAY"), jiraWatch("SHIP")],
      connections: connections.map(connection => connection.connectorId === "gitlab" ? { ...connection, settings: { ...connection.settings, project: "unqualified" } } : connection),
      work: [] });
    expect(inferred.scopes.map(scope => scope.query)).toEqual(["project = PAY AND statusCategory != Done", "project = SHIP AND statusCategory != Done"]);
    expect(inferred.gates[0]?.kind).toBe("scope");
    const scan = await scanTeamBacklog({ ...emptyTeamBacklog("Delivery"), scopes: [{ ...scopes[1], query: "unqualified" }] }, connections);
    expect(scan.scan.status).toBe("incomplete");
    expect(scan.scan.errors[0]).toMatch(/repository scope/);
  });

  it("widens filtered Jira boards to every unfinished issue in exactly their projects", () => {
    expect(jiraProjectsFromBoard("project = PAY AND sprint in openSprints() AND assignee = currentUser()"))
      .toEqual(["PAY"]);
    expect(jiraProjectsFromBoard("project in (PAY, OPS) AND status = In Progress")).toEqual(["PAY", "OPS"]);
    expect(jiraProjectsFromBoard("project = PAY OR project = OPS")).toBeNull();
    expect(jiraProjectsFromBoard("assignee = currentUser()")).toBeNull();
    const source = inferTeamBacklog({ section: "Delivery", ownerBotId: "lead", groups: [{ ...group,
      taskBoard: { ...group.taskBoard!, query: "assignee = currentUser()" } }], watches: [], connections, work: [] });
    expect(source.scopes.some(scope => scope.connectorId === "jira")).toBe(false);
    expect(source.gates[0]?.kind).toBe("scope");
  });

  it("wakes for newly appearing work only on its team's source project", () => {
    expect(backlogScopeContains(scopes[0], { connectorId: "jira", connectionId: "jira-main",
      externalId: "PAY-77", kind: "work_item", title: "New work", updatedAt: 1 })).toBe(true);
    expect(backlogScopeContains(scopes[0], { connectorId: "jira", connectionId: "jira-main",
      externalId: "OPS-77", kind: "work_item", title: "Other team", updatedAt: 1 })).toBe(false);
    expect(backlogScopeContains(scopes[1], { connectorId: "gitlab", connectionId: "gitlab-main",
      externalId: "acme/app!22", kind: "change_request", title: "New MR", updatedAt: 1 })).toBe(true);
    expect(backlogScopeContains(scopes[1], { connectorId: "gitlab", connectionId: "gitlab-main",
      externalId: "acme/other!22", kind: "change_request", title: "Other repo", updatedAt: 1 })).toBe(false);
  });

  it("scans both streams through every page, retains the last inventory on an error and verifies disappearing MRs", async () => {
    const api = mockApi();
    const backlog = { ...emptyTeamBacklog("Delivery"), scopes };
    const first = await scanTeamBacklog(backlog, connections, api.fetchImpl);
    expect(first.scan).toMatchObject({ status: "complete", itemCount: 4 });
    expect(first.targets.map(target => target.externalId).sort()).toEqual(["PAY-1", "PAY-2", "PAY-3", "acme/app!10"]);
    expect(api.requested.filter(value => value.includes("/issues?"))).toHaveLength(2);
    expect(api.requested.filter(value => value.includes("/merge_requests?"))).toHaveLength(1);
    api.failSecondJiraPage();
    const failed = await scanTeamBacklog(first, connections, api.fetchImpl);
    expect(failed.scan.status).toBe("incomplete");
    expect(failed.scan.completedAt).toBe(first.scan.completedAt);
    expect(failed.targets).toEqual(first.targets);
    expect(failed.scan.errors[0]).toMatch(/Jira.*503/);
    api.restoreJira(); api.addIssue(); api.addMr();
    const grown = await scanTeamBacklog(failed, connections, api.fetchImpl);
    expect(grown.scan.itemCount).toBe(6);
    expect(grown.targets.some(target => target.externalId === "PAY-4")).toBe(true);
    api.closeMr();
    const closed = await scanTeamBacklog(grown, connections, api.fetchImpl);
    expect(closed.targets.find(target => target.externalId === "acme/app!10")?.state).toBe("cancelled");
    expect(closed.scan.status).toBe("complete");
    api.mergeMr();
    const merged = await scanTeamBacklog(closed, connections, api.fetchImpl);
    expect(merged.targets.find(target => target.externalId === "acme/app!10")).toMatchObject({ state: "done",
      result: `Observed merged commit ${"c".repeat(40)}` });
  });

  it("treats malformed source rows as an incomplete inventory rather than an empty backlog", async () => {
    const api = mockApi();
    const badFetch: typeof fetch = async (input, init) => String(input).includes("/merge_requests?")
      ? new Response(JSON.stringify([{ title: "Lost identity", state: "opened" }]), { status: 200 })
      : api.fetchImpl(input, init);
    const scan = await scanTeamBacklog({ ...emptyTeamBacklog("Delivery"), scopes }, connections, badFetch);
    expect(scan.targets).toEqual([]);
    expect(scan.scan).toMatchObject({ status: "incomplete", itemCount: 0 });
    expect(scan.scan.errors).toEqual(expect.arrayContaining([expect.stringMatching(/MR identity/)]));
    const wrongProject: typeof fetch = async (input, init) => String(input).endsWith("/rest/api/3/search/jql")
      ? new Response(JSON.stringify({ issues: [{ key: "OPS-1", fields: {
        summary: "Other project", status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      } }] }), { status: 200 }) : api.fetchImpl(input, init);
    const escaped = await scanTeamBacklog({ ...emptyTeamBacklog("Delivery"), scopes }, connections, wrongProject);
    expect(escaped.scan.status).toBe("incomplete");
    expect(escaped.targets).toEqual([]);
    expect(escaped.scan.errors).toEqual(expect.arrayContaining([expect.stringMatching(/outside the requested project/)]));
  });

  it("scrubs source descriptions before persisting or displaying the inventory", async () => {
    const api = mockApi();
    const secret = `sk-ant-api03-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
    const fetchImpl: typeof fetch = async (input, init) => String(input).endsWith("/rest/api/3/search/jql")
      ? new Response(JSON.stringify({ issues: [{ key: "PAY-77", fields: {
        summary: `Issue ${secret}`, description: `Acceptance with ${secret}`,
        status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      } }] }), { status: 200 }) : api.fetchImpl(input, init);
    const scanned = await scanTeamBacklog({ ...emptyTeamBacklog("Delivery"), scopes }, connections, fetchImpl);
    expect(scanned.scan.status).toBe("complete");
    expect(JSON.stringify(scanned)).not.toContain(secret);
  });

  it("dispatches independent items while a blocker waits, then picks up new work on a later scan", async () => {
    const api = mockApi();
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-unit-")); dirs.push(dir);
    const goals = new OngoingGoals(join(dir, "goals.json"));
    const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room-thread",
      objective: "finish our current Jira work and merge the MRs" }, "execution", { ...emptyTeamBacklog("Delivery"), scopes });
    const records = new Map<string, WorkRecord>();
    const started: string[] = [];
    const coordination = {
      items: { records, find: (_section: string, identity: string) => [...records.values()].find(item => item.identity === identity) },
      accessible: () => true,
      evidenceProvenance: () => "observed",
      ensure: async (input: { identity: string; title: string; acceptanceCriteria: string[] }) => {
        started.push(input.identity);
        const item = { id: `task-${started.length}`, groupId: "room", threadId: `hub-${started.length}`, scope: "Delivery",
          identity: input.identity, coordinatorBotId: "lead", title: input.title, status: "active", revision: 1,
          objective: input.title, detail: "Working", acceptanceCriteria: input.acceptanceCriteria, criteria: [], assignments: [],
          decisions: [], artifacts: [], evidence: [], links: [], inputHash: "fixture", executions: 0,
          runStartedAt: Date.now(), sources: [], createdAt: Date.now(), updatedAt: Date.now() } as WorkRecord;
        records.set(item.id, item);
        return { workItem: item, created: true, started: true };
      },
    } as unknown as WorkCoordination;
    const deps = { goals, coordination, connections: () => connections, groups: () => [group], watches: () => [],
      ownerSection: () => "Delivery", fetchImpl: api.fetchImpl };
    await advanceTeamBacklog(goal, deps);
    expect(started).toContain("jira:jira-main:PAY-2");
    expect(started).toContain("jira:jira-main:PAY-3");
    expect(started).toContain("gitlab:gitlab-main:acme/app!10");
    expect(started).not.toContain("jira:jira-main:PAY-1");
    expect(goal.teamBacklog?.gates).toEqual(expect.arrayContaining([expect.objectContaining({ identity: "jira:jira-main:PAY-1" })]));
    api.finishBlocker(); api.addIssue();
    goals.wake(goal);
    await advanceTeamBacklog(goal, deps);
    expect(started).toContain("jira:jira-main:PAY-1");
    expect(started).toContain("jira:jira-main:PAY-4");
    expect(goal.status).not.toBe("completed");
    expect(goal.actions).toBe(2);
  });

  it("restarts current-head review on a changed MR SHA without merging on stale evidence", async () => {
    const api = mockApi();
    const scanned = await scanTeamBacklog({ ...emptyTeamBacklog("Delivery"), scopes }, connections, api.fetchImpl);
    const old = scanned.targets.find(target => target.kind === "change_request")!;
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-head-")); dirs.push(dir);
    const goals = new OngoingGoals(join(dir, "goals.json"));
    const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room-thread",
      objective: "finish our current Jira work and merge the MRs" }, "execution", { ...scanned,
      targets: scanned.targets.map(target => target.identity === old.identity ? { ...target,
        taskId: "old-review", dispatchedHeadSha: sha, gateCheckedAt: 1 } : target),
      gates: [{ kind: "security", detail: "Old approval", decisionMaker: "Security", identity: old.identity }] });
    const previous = { id: "old-review", identity: old.identity, scope: "Delivery", coordinatorBotId: "lead",
      status: "completed", revision: 1, detail: "Reviewed old head" } as WorkRecord;
    const records = new Map<string, WorkRecord>([[previous.id, previous]]);
    const newInputs: string[] = [];
    const coordination = { items: { records, find: (_section: string, identity: string) =>
      [...records.values()].find(item => item.identity === identity) }, accessible: () => true,
    evidenceProvenance: () => "observed", ensure: async (input: { identity: string; input: string }) => {
      newInputs.push(input.input);
      const item = records.get("old-review")?.identity === input.identity ? previous : {
        id: `new-${newInputs.length}`, identity: input.identity, coordinatorBotId: "lead", revision: 1,
        detail: "Working", status: "active", updatedAt: Date.now(),
      } as WorkRecord;
      item.status = "active";
      records.set(item.id, item);
      return { workItem: item, created: item !== previous, started: true };
    } } as unknown as WorkCoordination;
    api.moveHead();
    await advanceTeamBacklog(goal, { goals, coordination, connections: () => connections,
      groups: () => [group], watches: () => [], ownerSection: () => "Delivery", fetchImpl: api.fetchImpl });
    const current = goal.teamBacklog!.targets.find(target => target.identity === old.identity)!;
    expect(current).toMatchObject({ headSha: "b".repeat(40), dispatchedHeadSha: "b".repeat(40), taskId: "old-review" });
    expect(current.gateCheckedAt).toBeUndefined();
    expect(newInputs).toContain(JSON.stringify([old.identity, "b".repeat(40)]));
    expect(goal.ownedWorkItemIds).toContain("old-review");
    expect(api.requested.every(request => request.startsWith("GET ") || request.startsWith("POST "))).toBe(true);
    expect(api.requested.some(request => request.startsWith("PUT "))).toBe(false);
    expect(goal.status).not.toBe("completed");
  });

  it("cancels a task that finishes starting after the person stops its mission", async () => {
    const api = mockApi();
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-stop-")); dirs.push(dir);
    const goals = new OngoingGoals(join(dir, "goals.json"));
    const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room-thread",
      objective: "finish our current Jira work and merge the MRs" }, "execution",
    { ...emptyTeamBacklog("Delivery"), scopes });
    const records = new Map<string, WorkRecord>();
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const coordination = { items: { records }, ensure: async (input: { identity: string }) => {
      const item = { id: "late-task", identity: input.identity, status: "active", revision: 1,
        detail: "Started late", scope: "Delivery", coordinatorBotId: "lead" } as WorkRecord;
      records.set(item.id, item);
      await pending;
      return { workItem: item, created: true, started: true };
    }, update: (id: string, input: { status: string }) => {
      const item = records.get(id)!;
      item.status = input.status as WorkRecord["status"];
      return item;
    } } as unknown as WorkCoordination;
    const run = advanceTeamBacklog(goal, { goals, coordination, connections: () => connections,
      groups: () => [group], watches: () => [], ownerSection: () => "Delivery", fetchImpl: api.fetchImpl });
    await expect.poll(() => records.has("late-task"), { timeout: 10_000 }).toBe(true);
    goals.control(goal.id, { expectedRevision: goal.revision, action: "stop" });
    release!();
    await run;
    expect(goal.status).toBe("stopped");
    expect(records.get("late-task")?.status).toBe("cancelled");
    expect(api.requested.some(request => /\/merge$|\/transitions$/.test(request))).toBe(false);
  });

  it("does not let many gated MRs starve an independent Jira issue or hide later review gates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-fair-")); dirs.push(dir);
    const goals = new OngoingGoals(join(dir, "goals.json"));
    const mrIds = Array.from({ length: 10 }, (_, index) => `acme/app!${index + 1}`);
    const oldTargets = mrIds.map((externalId, index) => ({ identity: `gitlab:gitlab-main:${externalId}`,
      connectorId: "gitlab" as const, connectionId: "gitlab-main", externalId, kind: "change_request" as const,
      title: `Review ${externalId}`, state: "in_review" as const, label: "opened", updatedAt: 1,
      observedAt: 1, headSha: sha, dispatchedHeadSha: sha, taskId: `existing-${index}` }));
    const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room-thread",
      objective: "finish our current Jira work and merge the MRs" }, "execution",
    { ...emptyTeamBacklog("Delivery"), scopes, targets: oldTargets });
    const records = new Map<string, WorkRecord>(oldTargets.map(target => [target.taskId, {
      id: target.taskId, groupId: "room", threadId: `hub-${target.taskId}`, scope: "Delivery",
      identity: target.identity, title: target.title, objective: "Review current head",
      acceptanceCriteria: ["Review current head"], status: "completed", detail: "Reviewed", revision: 1,
      criteria: [{ id: "review-check", text: "Review current head", state: "checked", evidence: ["observed-review"] }],
      coordinatorBotId: "lead", updatedAt: 1, createdAt: 1, links: [],
      decisions: [], artifacts: [], evidence: [], assignments: [], sources: [],
      inputHash: "fixture", executions: 1, runStartedAt: 1,
    } as WorkRecord]));
    const started: string[] = [];
    const coordination = { items: { records, find: (_section: string, identity: string) =>
      [...records.values()].find(item => item.identity === identity) }, accessible: () => true,
    evidenceProvenance: () => "observed", ensure: async (input: { identity: string }) => {
      started.push(input.identity);
      const item = { id: "jira-task", identity: input.identity, status: "active", updatedAt: Date.now(),
        coordinatorBotId: "lead", detail: "Working" } as WorkRecord;
      records.set(item.id, item);
      return { workItem: item, created: true, started: true };
    } } as unknown as WorkCoordination;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (url.endsWith("/rest/api/3/search/jql")) return response({ issues: [{ key: "PAY-3", fields: {
        summary: "Independent Jira work", status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      } }] });
      if (url.includes("/issues?")) return response([]);
      if (url.includes("/merge_requests?")) return response(mrIds.map((_, index) => ({
        iid: index + 1, state: "opened", title: `Review ${index + 1}`, sha,
      })));
      if (url.endsWith("/approvals")) return response({ approvals_left: 2, approved_by: [] });
      if (url.endsWith("/approval_state")) return response({ rules: [] });
      if (url.includes("/versions?")) return response([{ head_commit_sha: sha, created_at: "2026-09-24T10:00:00Z" }]);
      if (url.endsWith("/projects/acme%2Fapp")) return response({
        only_allow_merge_if_pipeline_succeeds: false, only_allow_merge_if_all_discussions_are_resolved: false,
      });
      if (/\/merge_requests\/\d+$/.test(url)) return response({ state: "opened", sha, detailed_merge_status: "mergeable" });
      throw new Error(`Unexpected fixture request ${url}`);
    };
    const deps = { goals, coordination, connections: () => connections, groups: () => [group], watches: () => [],
      ownerSection: () => "Delivery", fetchImpl };
    await advanceTeamBacklog(goal, deps);
    expect(started).toEqual(["jira:jira-main:PAY-3"]);
    expect(goal.teamBacklog?.targets.filter(target => target.gateCheckedAt)).toHaveLength(8);
    expect(goal.status).toBe("working");
    await advanceTeamBacklog(goal, deps);
    expect(goal.teamBacklog?.targets.filter(target => target.gateCheckedAt)).toHaveLength(10);
    expect(new Set(goal.teamBacklog?.gates.filter(gate => gate.kind === "security").map(gate => gate.identity)).size).toBe(10);
    expect(goal.status).toBe("waiting");
  });

  it("records an access gate and never merges or transitions when write locks are off", async () => {
    const api = writeReadyApi();
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-lock-")); dirs.push(dir);
    const { goal, deps } = evidencedWriteGoal(dir, api.fetchImpl);
    await advanceTeamBacklog(goal, deps);
    expect(api.requested.filter(request => mutatingWrite(request))).toEqual([]);
    expect(goal.teamBacklog?.gates.filter(gate => gate.kind === "access")).toHaveLength(2);
    expect(goal.teamBacklog?.targets.map(target => target.state)).toEqual(["in_progress", "in_review"]);
    expect(goal.status).not.toBe("completed");
  });

  it("merges and transitions when both locks are on and the goal is still active", async () => {
    const api = writeReadyApi();
    const dir = mkdtempSync(join(tmpdir(), "omb-backlog-unlock-")); dirs.push(dir);
    const unlocked = connections.map(connection => ({
      ...connection,
      writes: { enabled: true as const, allow: [connection.connectorId === "gitlab"
        ? "merge_change_request" as const : "complete_work_item" as const] },
    }));
    const { goal, deps } = evidencedWriteGoal(dir, api.fetchImpl, {
      connections: unlocked, teamMissionWrites: true,
    });
    await advanceTeamBacklog(goal, deps);
    expect(api.requested.some(request => request.startsWith("PUT ") && request.includes("/merge"))).toBe(true);
    expect(api.requested.some(request => request.startsWith("POST ") && request.includes("/transitions"))).toBe(true);
    expect(goal.teamBacklog?.targets.every(target => target.state === "done")).toBe(true);
    expect(goal.teamBacklog?.gates.filter(gate => gate.kind === "access")).toEqual([]);
  });
});
