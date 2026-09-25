import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyTeamBacklog } from "../../shared/team-backlog.ts";
import { VisibleSet } from "../bot-visibility.ts";
import { json, readBody } from "../harness/http.ts";
import { OngoingGoals } from "../ongoing-goals.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { WorkRecord } from "../work-items.ts";
import { dispatchRoutes } from "./table.ts";
import { createWorkOverviewRoutes } from "./work-overview.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(done => server.close(() => done()))));
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

async function serve(includeConversations = false) {
  const dir = mkdtempSync(join(tmpdir(), "omb-work-overview-")); dirs.push(dir);
  const goals = new OngoingGoals(join(dir, "goals.json"));
  const publicBot = { id: "lead", threadId: "lead-thread", tasks: [{ threadId: "execution" }, { threadId: "direct-task" }], visibility: "everyone" as const };
  const financeBot = { id: "finance", threadId: "finance-main", tasks: [{ threadId: "finance-thread" }], visibility: "everyone" as const };
  const privateBot = { id: "secret", threadId: "secret-thread", tasks: [{ threadId: "private-thread" }], visibility: "admins" as const };
  const publicGroup = { id: "public", threadId: "room", tasks: [{ threadId: "hub" }, { threadId: "group-task" }], memberIds: ["lead"] };
  const privateGroup = { id: "private", threadId: "private-room", tasks: [{ threadId: "private-hub" }], memberIds: ["secret"] };
  const visible = new VisibleSet([publicBot, financeBot, privateBot], [publicGroup, privateGroup], { kind: "member", email: "requester@example.invalid" });
  const authFor = (header: string | undefined): RequestAuth => ({ kind: "session", via: "bearer", scopes: ["client"],
    session: { id: header ?? "requester", tokenHash: "0".repeat(64), label: header ?? "requester", scopes: ["client"],
      createdAt: 0, lastSeenAt: 0, expiresAt: 100_000, email: `${header ?? "requester"}@example.invalid` } });
  const visibleFor = () => visible;
  const backlog = emptyTeamBacklog("Delivery");
  backlog.choices = [
    { id: "jira", connectorId: "jira", connectionId: "jira-main", query: "project = PAY", label: "Jira board", groupId: "public" },
    { id: "repo", connectorId: "gitlab", connectionId: "gitlab-main", query: "acme/app", label: "App repo", groupId: "public" },
  ];
  backlog.gates = [{ kind: "scope", detail: "Choose the repo", decisionMaker: "Original requester" }];
  const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "room", objective: "Finish team backlog" }, "execution", backlog);
  const publicItem = { id: "task", groupId: "public", threadId: "hub", coordinatorBotId: "lead", title: "Visible task",
    objective: "Deliver", acceptanceCriteria: ["Checked"], status: "active", detail: "Working", revision: 1,
    decisions: [], artifacts: [], evidence: ["observed:check"], criteria: [], links: [], assignments: [],
    scope: "Delivery", identity: "jira:jira-main:PAY-1", inputHash: "hash", executions: 0, runStartedAt: 1, sources: [],
    createdAt: 1, updatedAt: 2 } as WorkRecord;
  const hiddenItem = { ...publicItem, id: "private-task", groupId: "private", threadId: "private-hub", coordinatorBotId: "secret",
    title: "Private task" } as WorkRecord;
  const subtitle = `Full request: ${"review details ".repeat(1500)}`;
  const messages = (id: string) => id === "lead-thread" ? [{ id: "main-decision", kind: "options", card: {
    title: "Main permission", subtitle: "Approve this call", options: ["Allow", "Deny"], tool: "Bash", requestId: "main-request",
  } }] : id === "direct-task" ? [{ id: "direct-decision", kind: "options", card: {
    title: "Direct permission", subtitle: "Exact direct request", fullRequest: "Full direct task request",
    options: ["Allow", "Deny"], tool: "Bash", requestId: "direct-request",
  } }] : id === "hub" ? [{ id: "message", kind: "options", card: {
    title: "Review command", subtitle, options: ["Allow", "Deny"], tool: "Bash", requestId: "request-1",
  } }] : [];
  const routes = [createWorkOverviewRoutes({
    visible: visibleFor, tasks: () => [publicItem, hiddenItem], goals: () => [...goals.records.values()],
    conversations: () => includeConversations ? [
      { threadId: "lead-thread", title: "Lead · Main conversation", team: "Delivery", ownerBotId: "lead", busy: false,
        waiting: false, lifecycle: "open", updatedAt: 3 },
      { threadId: "direct-task", title: "Direct task", team: "Delivery", ownerBotId: "lead", busy: false,
        waiting: false, lifecycle: "open", updatedAt: 4 },
      { threadId: "group-task", title: "Room task", team: "Delivery", ownerBotId: "lead", groupId: "public", busy: true,
        waiting: false, lifecycle: "open", updatedAt: 5 },
      { threadId: "finance-thread", title: "Finance task", team: "Finance", ownerBotId: "finance", busy: true,
        waiting: false, lifecycle: "open", updatedAt: 5 },
      { threadId: "private-thread", title: "Secret task", team: "Private", ownerBotId: "secret", busy: true,
        waiting: false, lifecycle: "open", updatedAt: 6 },
      { threadId: "execution", title: "Goal coordinator", team: "Delivery", ownerBotId: "lead", busy: false,
        waiting: false, lifecycle: "open", updatedAt: 7 },
      { threadId: "hub", title: "Already shared", team: "Delivery", ownerBotId: "lead", groupId: "public", busy: false,
        waiting: false, lifecycle: "open", updatedAt: 8 },
    ] : [],
    teamForGroup: () => "Delivery", teamForBot: () => "Delivery", botName: id => id,
    messages, cardRefusal: (auth) => auth.kind === "session" && auth.session.id === "requester" ? null : "Not requester",
    cardDecisionMaker: () => "requester@example.invalid",
    canChooseScope: auth => auth.kind === "session" && auth.session.id === "requester",
    chooseScope: (selected, revision, ids) => goals.chooseBacklogScopes(selected, revision, ids),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: authFor(req.headers["x-fixture-actor"] as string | undefined), json, readBody });
    if (!handled) json(res, 404, { error: "Not found" });
  });
  servers.push(server);
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, goal, subtitle };
}

describe("permission-filtered Work overview", () => {
  it("contains every accessible task and goal, the full card request and only actionable decisions", async () => {
    const { base, subtitle, goal } = await serve();
    const response = await fetch(`${base}/api/work/overview?team=Delivery&limit=1`);
    const first = await response.json() as any;
    expect(first.teams).toEqual(["Delivery"]);
    expect(first.counts["needs-you"]).toBe(2);
    expect(first.entries).toHaveLength(1);
    const second = await fetch(`${base}/api/work/overview?team=Delivery&limit=1&cursor=${first.nextCursor}`);
    const page = await second.json() as any;
    expect([...first.entries, ...page.entries].map(entry => entry.id)).toEqual(expect.arrayContaining(["task", goal.id]));
    expect(JSON.stringify([first, page])).not.toContain("Private task");
    expect([...first.cards, ...page.cards][0]).toMatchObject({ canAct: true, card: { subtitle } });
    const other = await fetch(`${base}/api/work/overview`, { headers: { "x-fixture-actor": "other" } });
    const stranger = await other.json() as any;
    expect(stranger.cards[0]).toMatchObject({ canAct: false, decisionMaker: "requester@example.invalid" });
    expect(stranger.entries.find((entry: any) => entry.id === "task").queue).toBe("working");
  });

  it("requires the original requester, exact server choices and current revision for scope resolution", async () => {
    const { base, goal } = await serve();
    const choose = (body: unknown, actor?: string) => fetch(`${base}/api/goals/${goal.id}/scope-choice`, { method: "POST",
      headers: { "content-type": "application/json", ...(actor ? { "x-fixture-actor": actor } : {}) }, body: JSON.stringify(body) });
    expect((await choose({ expectedRevision: goal.revision, scopeIds: ["jira", "repo"] }, "other")).status).toBe(403);
    expect((await choose({ expectedRevision: goal.revision, scopeIds: ["jira", "not-listed"] })).status).toBe(409);
    expect((await choose({ expectedRevision: goal.revision, scopeIds: ["jira", "repo"] })).status).toBe(200);
    expect((await choose({ expectedRevision: goal.revision, scopeIds: ["jira", "repo"] })).status).toBe(409);
  });

  it("shows discovered source items even before a shared task can be dispatched", async () => {
    const { base, goal } = await serve();
    const target = { identity: "jira:jira-main:PAY-1", connectorId: "jira" as const,
      connectionId: "jira-main", externalId: "PAY-1", kind: "work_item" as const,
      title: "Blocked refund", state: "blocked" as const, label: "Blocked", updatedAt: 2, observedAt: 3 };
    goal.teamBacklog!.targets = [target];
    goal.teamBacklog!.gates = [{ kind: "task", identity: target.identity, detail: "PAY-1 awaits PAY-2",
      decisionMaker: "Owning task team" }];
    const overview = await (await fetch(`${base}/api/work/overview`)).json() as any;
    const source = overview.entries.find((entry: any) => entry.kind === "source");
    expect(source).toMatchObject({ title: "PAY-1 · Blocked refund", queue: "waiting",
      owner: { id: "lead" }, gates: [expect.objectContaining({ decisionMaker: "Owning task team" })] });
  });

  it("includes accessible direct and team-room task conversations, but not hidden or duplicate hubs", async () => {
    const { base } = await serve(true);
    const overview = await (await fetch(`${base}/api/work/overview`)).json() as any;
    expect(overview.entries.find((entry: any) => entry.id === "thread:direct-task")).toMatchObject({
      team: "Delivery", queue: "needs-you", owner: { id: "lead" },
    });
    expect(overview.entries.find((entry: any) => entry.id === "thread:lead-thread")).toMatchObject({ queue: "needs-you" });
    expect(overview.entries.find((entry: any) => entry.id === "thread:group-task")).toMatchObject({ queue: "working" });
    expect(overview.cards.find((card: any) => card.entryId === "thread:direct-task")).toMatchObject({
      canAct: true, card: { fullRequest: "Full direct task request" },
    });
    expect(JSON.stringify(overview)).not.toContain("Secret task");
    expect(overview.entries.some((entry: any) => entry.id === "thread:execution" || entry.id === "thread:hub")).toBe(false);
    const other = await (await fetch(`${base}/api/work/overview`, { headers: { "x-fixture-actor": "other" } })).json() as any;
    expect(other.cards.find((card: any) => card.entryId === "thread:direct-task")).toMatchObject({
      canAct: false, decisionMaker: "requester@example.invalid",
    });
    const filtered = await (await fetch(`${base}/api/work/overview?team=Finance&status=working`)).json() as any;
    expect(filtered.teams).toEqual(["Delivery", "Finance"]);
    expect(filtered.entries.map((entry: any) => entry.id)).toEqual(["thread:finance-thread"]);
    expect(filtered.counts).toMatchObject({ "needs-you": 0, waiting: 0, working: 1, completed: 0 });
  });
});
