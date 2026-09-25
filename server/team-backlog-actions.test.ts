import { describe, expect, it } from "vitest";
import type { BacklogTarget } from "../shared/team-backlog.ts";
import type { StoredConnection } from "./connectors/types.ts";
import { mergeReviewedRequest, MISSION_WRITES_DISABLED, transitionEvidencedJiraIssue } from "./team-backlog-actions.ts";

const sha = "a".repeat(40);
const newer = "b".repeat(40);
const target: BacklogTarget = { identity: "gitlab:gitlab-main:acme/app!10", connectorId: "gitlab", connectionId: "gitlab-main",
  externalId: "acme/app!10", kind: "change_request", title: "Ready", state: "in_review", label: "opened",
  updatedAt: 1, observedAt: 2, headSha: sha };
const connection: StoredConnection = { id: "gitlab-main", connectorId: "gitlab", label: "GitLab",
  settings: { site: "http://127.0.0.1:8325", project: "acme/app" }, secrets: { token: "fixture" }, sections: ["Delivery"], enabled: true };
const gitlabUnlocked: StoredConnection = { ...connection, writes: { enabled: true, allow: ["merge_change_request"] } };
const jiraConnection: StoredConnection = { ...connection, connectorId: "jira", id: "jira-main",
  secrets: { email: "fixture@example.invalid", apiToken: "fixture" } };
const jiraUnlocked: StoredConnection = { ...jiraConnection, writes: { enabled: true, allow: ["complete_work_item"] } };
const jiraIssue: BacklogTarget = { ...target, identity: "jira:jira-main:PAY-1", connectorId: "jira", connectionId: "jira-main",
  externalId: "PAY-1", kind: "work_item", state: "in_progress", label: "In Progress", headSha: undefined };

function mutating(requests: Array<{ method: string }>) {
  return requests.filter(request => ["PUT", "POST", "PATCH", "DELETE"].includes(request.method));
}

function commitMerge(fetchImpl: typeof fetch, mayWrite: () => boolean = () => true) {
  return mergeReviewedRequest(gitlabUnlocked, target, fetchImpl, mayWrite, true);
}

function gitlabFixture(options: { head?: string; manager?: boolean; error?: boolean; pipeline?: string;
  pipelineSha?: string | null; staleApproval?: boolean; policyUnknown?: boolean;
  undated?: boolean; forgedNote?: boolean; noteError?: boolean } = {}) {
  let merged = false;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body?.toString() });
    if (url.endsWith("/merge_requests/10/merge")) {
      expect(method).toBe("PUT");
      expect(JSON.parse(init?.body?.toString() ?? "{}")).toEqual({ sha });
      merged = true;
      return body({ state: "merged" });
    }
    if (url.endsWith("/merge_requests/10")) return body({ state: merged ? "merged" : "opened", sha: options.head ?? sha,
      detailed_merge_status: "mergeable", draft: false, has_conflicts: false, blocking_discussions_resolved: true,
      head_pipeline: { status: options.pipeline ?? "success", sha: options.pipelineSha === null ? undefined : options.pipelineSha ?? sha },
      merge_commit_sha: merged ? newer : null });
    if (url.endsWith("/merge_requests/10/approvals")) return options.error ? new Response("error", { status: 503 }) : body({ approvals_left: 0,
      approved_by: [{ user: { id: 101 }, ...(!options.undated ? { approved_at: "2026-09-24T11:00:00Z" } : {}) },
        { user: { id: 102 }, ...(!options.undated ? { approved_at: options.staleApproval ? "2026-09-24T09:00:00Z" : "2026-09-24T11:00:00Z" } : {}) }] });
    if (url.endsWith("/merge_requests/10/approval_state")) return body({ rules: [
      { name: "Security", approved: true, approved_by: [{ id: 101 }] },
      { name: "Manager", approved: options.manager !== false, approved_by: options.manager === false ? [] : [{ id: 102 }] },
    ] });
    if (url.endsWith("/merge_requests/10/versions?per_page=100")) return body([{ head_commit_sha: sha, created_at: "2026-09-24T10:00:00Z" }]);
    if (url.includes("/merge_requests/10/notes?")) {
      if (options.noteError) return new Response("error", { status: 503 });
      const page = new URL(url).searchParams.get("page");
      const note = (id: number) => ({ system: options.forgedNote && id === 102 ? false : true,
        body: "approved this merge request", author: { id },
        created_at: options.staleApproval && id === 102 ? "2026-09-24T09:00:00Z" : "2026-09-24T11:00:00Z" });
      return new Response(JSON.stringify(page === "1" ? [note(101)] : [note(102)]), { status: 200,
        headers: { "x-next-page": page === "1" ? "2" : "" } });
    }
    if (url.endsWith("/projects/acme%2Fapp")) return body(options.policyUnknown ? {} : {
      only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true,
    });
    throw new Error(`Unexpected fixture request ${url}`);
  };
  return { fetchImpl, requests };
}

describe("current-head external actions", () => {
  it("does not write a ready MR or unique Jira Done transition unless both locks are open", async () => {
    const gitlab = gitlabFixture();
    const locked = await mergeReviewedRequest(connection, target, gitlab.fetchImpl);
    expect(locked).toMatchObject({ changed: false, target, gates: [expect.objectContaining({
      kind: "access", detail: MISSION_WRITES_DISABLED,
    })] });
    expect(mutating(gitlab.requests)).toEqual([]);
    expect(gitlab.requests.some(request => request.url.endsWith("/approvals"))).toBe(true);
    const flagOnly = await mergeReviewedRequest(connection, target, gitlabFixture().fetchImpl, () => true, true);
    expect(flagOnly).toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "access" })] });
    const allowOnly = await mergeReviewedRequest(gitlabUnlocked, target, gitlabFixture().fetchImpl, () => true, false);
    expect(allowOnly).toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "access" })] });
    const emptyAllow = await mergeReviewedRequest({ ...connection, writes: { enabled: true, allow: [] } },
      target, gitlabFixture().fetchImpl, () => true, true);
    expect(emptyAllow).toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "access" })] });

    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(url.endsWith("?fields=status")
        ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
        : { transitions: [{ id: "11", to: { name: "Done", statusCategory: { key: "done" } } }] }), { status: 200 });
    };
    expect(await transitionEvidencedJiraIssue(jiraConnection, jiraIssue, fetchImpl)).toMatchObject({
      changed: false, target: jiraIssue, gates: [expect.objectContaining({ kind: "access", detail: MISSION_WRITES_DISABLED })],
    });
    expect(requests.every(request => request.startsWith("GET"))).toBe(true);
    expect(requests.some(request => request.includes("/transitions"))).toBe(true);
  });

  it("merges only after current-head Security, Manager and project policy checks, with an exact SHA precondition", async () => {
    const api = gitlabFixture();
    const result = await commitMerge(api.fetchImpl);
    expect(result).toMatchObject({ changed: true, target: { state: "done", label: "merged", headSha: sha }, gates: [] });
    expect(result.target.result).toContain(newer);
    expect(api.requests.filter(request => request.method === "PUT")).toHaveLength(1);
    expect(api.requests.some(request => /pipelines\/?$|close/.test(request.url))).toBe(false);
  });

  it("invalidates a stale head and waits for the actual reviewer or policy actor without writing", async () => {
    const head = gitlabFixture({ head: newer });
    expect(await mergeReviewedRequest(connection, target, head.fetchImpl)).toMatchObject({ changed: false,
      target: { headSha: newer }, gates: [expect.objectContaining({ kind: "review" })] });
    expect(head.requests.some(request => request.method === "PUT")).toBe(false);
    const manager = gitlabFixture({ manager: false });
    const missing = await mergeReviewedRequest(connection, target, manager.fetchImpl);
    expect(missing.gates.map(gate => gate.kind)).toContain("manager");
    expect(manager.requests.some(request => request.method === "PUT")).toBe(false);
    const stale = gitlabFixture({ staleApproval: true });
    expect((await mergeReviewedRequest(connection, target, stale.fetchImpl)).gates.map(gate => gate.kind)).toContain("manager");
    expect(stale.requests.some(request => request.method === "PUT")).toBe(false);
    const policy = gitlabFixture({ pipeline: "running" });
    expect((await mergeReviewedRequest(connection, target, policy.fetchImpl)).gates.map(gate => gate.kind)).toContain("policy");
    expect(policy.requests.some(request => request.method === "PUT")).toBe(false);
    for (const unsafe of [gitlabFixture({ policyUnknown: true }), gitlabFixture({ pipelineSha: null })]) {
      expect((await mergeReviewedRequest(connection, target, unsafe.fetchImpl)).gates.map(gate => gate.kind)).toContain("policy");
      expect(unsafe.requests.some(request => request.method === "PUT")).toBe(false);
    }
    const error = gitlabFixture({ error: true });
    await expect(mergeReviewedRequest(connection, target, error.fetchImpl)).rejects.toThrow(/approvals returned 503/);
    expect(error.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it("proves undated current approvers using paginated post-head system notes, not forged or stale comments", async () => {
    const proved = gitlabFixture({ undated: true });
    expect((await commitMerge(proved.fetchImpl)).target.state).toBe("done");
    expect(proved.requests.filter(request => request.url.includes("/notes?"))).toHaveLength(2);
    for (const unsafe of [gitlabFixture({ undated: true, forgedNote: true }),
      gitlabFixture({ undated: true, staleApproval: true })]) {
      expect((await mergeReviewedRequest(connection, target, unsafe.fetchImpl)).gates.map(gate => gate.kind)).toContain("manager");
      expect(unsafe.requests.some(request => request.method === "PUT")).toBe(false);
    }
    const incomplete = gitlabFixture({ undated: true, noteError: true });
    await expect(mergeReviewedRequest(connection, target, incomplete.fetchImpl)).rejects.toThrow(/approval notes returned 503/);
    expect(incomplete.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it("rechecks a stopped mission immediately before either external write", async () => {
    const gitlab = gitlabFixture();
    await expect(commitMerge(gitlab.fetchImpl, () => false)).rejects.toThrow(/stopped before/);
    expect(mutating(gitlab.requests)).toEqual([]);
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(url.endsWith("?fields=status")
        ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
        : { transitions: [{ id: "11", to: { name: "Done", statusCategory: { key: "done" } } }] }), { status: 200 });
    };
    await expect(transitionEvidencedJiraIssue(jiraUnlocked, jiraIssue, fetchImpl, () => false, true)).rejects.toThrow(/stopped before/);
    expect(requests.every(request => request.startsWith("GET"))).toBe(true);
  });

  it("transitions a Jira issue through a unique done transition and reads back the status", async () => {
    let done = false;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("?fields=status")) return new Response(JSON.stringify({ key: "PAY-1", fields: { status: {
        name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" },
      } } }), { status: 200 });
      if (url.endsWith("/transitions") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ transition: { id: "11" } });
        done = true; return new Response(null, { status: 204 });
      }
      if (url.endsWith("/transitions")) return new Response(JSON.stringify({ transitions: [
        { id: "11", to: { name: "Done", statusCategory: { key: "done" } } },
        { id: "12", to: { name: "Cancelled", statusCategory: { key: "done" } } },
      ] }), { status: 200 });
      throw new Error(`Unexpected ${url}`);
    };
    expect(await transitionEvidencedJiraIssue(jiraUnlocked, jiraIssue, fetchImpl, () => true, true)).toMatchObject({
      changed: true, target: { state: "done" }, gates: [],
    });
    expect(requests.filter(request => request.startsWith("POST"))).toHaveLength(1);
  });

  it("does not treat a rejected Jira resolution as satisfying acceptance", async () => {
    const jira = { ...connection, connectorId: "jira", id: "jira-main",
      secrets: { email: "fixture@example.invalid", apiToken: "fixture" } };
    const issue: BacklogTarget = { ...target, identity: "jira:jira-main:PAY-1", connectorId: "jira", connectionId: "jira-main",
      externalId: "PAY-1", kind: "work_item", state: "in_progress", label: "In Progress" };
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify(String(input).endsWith("?fields=status")
        ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
        : { transitions: [{ id: "11", to: { name: "Rejected", statusCategory: { key: "done" } } }] }), { status: 200 });
    };
    expect(await transitionEvidencedJiraIssue(jira, issue, fetchImpl)).toMatchObject({ changed: false,
      gates: [expect.objectContaining({ kind: "policy" })] });
    expect(requests.every(request => request.startsWith("GET"))).toBe(true);
  });
});
