import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

const objective = "get all current work in progreess  losed in jira and all MRs merged and closed";
let isolated: VerificationServer | undefined;
let external: Server | undefined;
afterEach(async () => {
  if (isolated) { await isolated.close(); isolated = undefined; }
  if (external) { await new Promise<void>(done => external!.close(() => done())); external = undefined; }
});

async function fixture(nonempty: boolean) {
  const writes: string[] = [];
  const issue = { key: "PAY-1", fields: { summary: "Deliver a verified fix", description: "Acceptance: refund is correct",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, project: { key: "PAY" },
    updated: "2026-09-24T10:00:00Z" } };
  external = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rows = (value: unknown, headers?: Record<string, string>) => {
      res.writeHead(200, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (req.method !== "GET" && req.method !== "POST") writes.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith("/rest/api/3/search/jql")) return rows({ issues: nonempty ? [issue] : [] });
    if (url.pathname.endsWith("/rest/api/3/issue/bulkfetch")) return rows({ issues: [issue] });
    if (url.pathname.endsWith("/issues")) return rows([], { "x-next-page": "" });
    if (url.pathname.endsWith("/merge_requests")) return rows(nonempty ? [{ iid: 10, state: "opened", title: "Review the fix",
      sha: "a".repeat(40), updated_at: "2026-09-24T10:00:00Z" }] : [], { "x-next-page": "" });
    if (url.pathname.endsWith("/merge_requests/10")) return rows({ iid: 10, state: "opened", title: "Review the fix",
      sha: "a".repeat(40), updated_at: "2026-09-24T10:00:00Z" });
    if (url.pathname.endsWith("/merge_requests/10/approvals")) return rows({ approvals_required: 2, approvals_left: 2 });
    res.writeHead(404); res.end("fixture endpoint not found");
  });
  await new Promise<void>(ready => external!.listen(0, "127.0.0.1", ready));
  const site = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  isolated = await launchVerificationServer(process.env);
  const base = isolated.info.url;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method, headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  };
  const bot = (await api("POST", "/api/bots", { name: "Delivery lead", section: "Delivery",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  expect(bot?.id).toBeTruthy();
  const room = (await api("POST", "/api/groups", { name: "Delivery backlog", section: "Delivery", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  expect(room?.id).toBeTruthy();
  expect((await api("POST", "/api/task-connections", { id: "jira-fixture", connectorId: "jira", label: "Jira fixture",
    settings: { site }, secrets: { email: "fixture@example.invalid", apiToken: "fixture" }, sections: ["Delivery"], enabled: true })).status).toBe(201);
  expect((await api("POST", "/api/task-connections", { id: "gitlab-fixture", connectorId: "gitlab", label: "GitLab fixture",
    settings: { site, project: "acme/app" }, secrets: { token: "fixture" }, sections: ["Delivery"], enabled: true })).status).toBe(201);
  expect((await api("PATCH", `/api/groups/${room.id}/task-board`, { connectionId: "jira-fixture", query: "project = PAY" })).status).toBe(200);
  return { api, bot, room, writes };
}

async function gitlabOnlyFixture() {
  const writes: string[] = [];
  external = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const rows = (value: unknown, headers?: Record<string, string>) => {
      res.writeHead(200, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value));
    };
    if (req.method !== "GET" && req.method !== "POST") writes.push(`${req.method} ${url.pathname}`);
    if (url.pathname.endsWith("/issues")) return rows([{ iid: 71, title: "GitLab issue", state: "opened",
      updated_at: "2026-09-24T10:00:00Z" }], { "x-next-page": "" });
    if (url.pathname.endsWith("/merge_requests")) return rows([{ iid: 10, state: "opened", title: "Review the fix",
      sha: "a".repeat(40), updated_at: "2026-09-24T10:00:00Z" }], { "x-next-page": "" });
    if (url.pathname.endsWith("/merge_requests/10")) return rows({ iid: 10, state: "opened", title: "Review the fix",
      sha: "a".repeat(40), updated_at: "2026-09-24T10:00:00Z" });
    res.writeHead(404); res.end("fixture endpoint not found");
  });
  await new Promise<void>(ready => external!.listen(0, "127.0.0.1", ready));
  const site = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  isolated = await launchVerificationServer(process.env);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${isolated!.info.url}${path}`, { method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  };
  const bot = (await api("POST", "/api/bots", { name: "Delivery lead", section: "Delivery",
    modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
  const room = (await api("POST", "/api/groups", { name: "Delivery backlog", section: "Delivery", memberIds: [bot.id],
    setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } })).body.group;
  expect((await api("POST", "/api/task-connections", { id: "gitlab-fixture", connectorId: "gitlab", label: "GitLab fixture",
    settings: { site, project: "acme/app" }, secrets: { token: "fixture" }, sections: ["Delivery"], enabled: true })).status).toBe(201);
  return { api, bot, room, writes };
}

describe("isolated OpenMausBot team backlog fixture", () => {
  it("turns the exact misspelled outcome into one completed mission after a real complete empty scan", async () => {
    const { api, bot, room, writes } = await fixture(false);
    const created = await api("POST", "/api/goals", { ownerBotId: bot.id, sourceThreadId: room.threadId, objective });
    expect(created.status).toBe(201);
    await expect.poll(async () => (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal.status,
      { timeout: 12_000 }).toBe("completed");
    const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
    expect(goal).toMatchObject({ kind: "mission", teamBacklog: { section: "Delivery", scan: { status: "complete", itemCount: 0 } }, actions: 1 });
    expect(goal.evidence[0]).toMatch(/^inventory:/);
    expect(writes).toEqual([]);
  }, 35_000);

  it("inventories open issues/MRs, exposes waiting work and reuses the same team mission", async () => {
    const { api, bot, room, writes } = await fixture(true);
    const created = await api("POST", "/api/goals", { ownerBotId: bot.id, sourceThreadId: room.threadId, objective });
    expect(created.status).toBe(201);
    await expect.poll(async () => {
      const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
      return goal.teamBacklog.scan.itemCount;
    }, { timeout: 12_000 }).toBe(2);
    const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
    expect(goal.teamBacklog.scan.status).toBe("complete");
    expect(goal.teamBacklog.targets.map((target: { externalId: string }) => target.externalId).sort()).toEqual(["PAY-1", "acme/app!10"]);
    expect(goal.status).not.toBe("completed");
    const overview = await api("GET", "/api/work/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.entries.some((entry: { id: string }) => entry.id === goal.id)).toBe(true);
    const again = await api("POST", "/api/goals", { ownerBotId: bot.id, sourceThreadId: room.threadId, objective });
    expect(again).toMatchObject({ status: 200, body: { goal: { id: goal.id } } });
    expect(writes).toEqual([]);
  }, 35_000);

  it("inventories GitLab issues and MRs for a GitLab-only team without asking for Jira", async () => {
    const { api, bot, room, writes } = await gitlabOnlyFixture();
    const created = await api("POST", "/api/goals", { ownerBotId: bot.id, sourceThreadId: room.threadId,
      objective: "finish our current GitLab merge requests and issues" });
    expect(created.status).toBe(201);
    await expect.poll(async () => {
      const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
      return goal.teamBacklog.scan.itemCount;
    }, { timeout: 12_000 }).toBe(2);
    const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
    expect(goal.teamBacklog.scopes).toEqual([expect.objectContaining({ connectorId: "gitlab" })]);
    expect(goal.teamBacklog.choices).toEqual([]);
    expect(goal.teamBacklog.targets.map((target: { externalId: string }) => target.externalId).sort())
      .toEqual(["acme/app!10", "acme/app#71"]);
    expect(goal.status).not.toBe("needs-input");
    expect(writes).toEqual([]);
  }, 35_000);
});
