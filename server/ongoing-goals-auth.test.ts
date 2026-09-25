import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("client session goal auth matrix", () => {
  let fixture: VerificationServer;

  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, body: await response.json() as any };
  }

  beforeAll(async () => {
    fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  }, 30_000);

  afterAll(async () => { await fixture?.close(); });

  it("lets a client list, create and pause visible goals, and refuses resume and Setup Guide", async () => {
    const publicBot = (await call("POST", "/api/bots", { name: "Visible lead" })).body.bot;
    const hiddenBot = (await call("POST", "/api/bots", { name: "Secret lead", visibility: "admins" })).body.bot;
    expect(hiddenBot.visibility).toBe("admins");
    const hidden = await call("POST", "/api/goals", {
      ownerBotId: hiddenBot.id, sourceThreadId: hiddenBot.threadId, objective: "Hidden deliverable",
    });
    expect(hidden.status).toBe(201);

    const pairing = await call("POST", "/api/auth/pairing", { scopes: ["client"] });
    const paired = await call("POST", "/api/auth/pair", { code: pairing.body.code, label: "Goal client" });
    expect(paired.status).toBe(200);
    const client = { authorization: `Bearer ${paired.body.token}` };

    const listed = await call("GET", "/api/goals", undefined, client);
    expect(listed.status).toBe(200);
    expect(listed.body.goals.map((goal: { id: string }) => goal.id)).not.toContain(hidden.body.goal.id);
    expect((await call("GET", `/api/goals/${hidden.body.goal.id}`, undefined, client)).status).toBe(404);

    const created = await call("POST", "/api/goals", {
      ownerBotId: publicBot.id, sourceThreadId: publicBot.threadId, objective: "Ship the visible deliverable",
    }, client);
    expect(created.status).toBe(201);
    const goalId = created.body.goal.id as string;
    expect((await call("GET", `/api/goals/${goalId}`, undefined, client)).status).toBe(200);
    expect((await call("GET", "/api/goals", undefined, client)).body.goals.map((goal: { id: string }) => goal.id)).toContain(goalId);

    let paused: { status: number; body: any } | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = (await call("GET", `/api/goals/${goalId}`, undefined, client)).body.goal;
      paused = await call("PATCH", `/api/goals/${goalId}`, {
        expectedRevision: current.revision, action: "pause",
        detail: "Goal budget exhausted; explicitly renew it to continue.",
      }, client);
      if (paused.status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(paused?.status).toBe(200);
    expect(paused?.body.goal.status).toBe("paused");

    const resume = await call("PATCH", `/api/goals/${goalId}`, {
      expectedRevision: paused!.body.goal.revision, action: "resume",
    }, client);
    expect(resume.status).toBe(403);
    expect(resume.body.error).toMatch(/resume|admin/);

    const overview = await call("GET", "/api/work/overview", undefined, client);
    expect(overview.status).toBe(200);
    expect(overview.body.entries.find((entry: { id: string }) => entry.id === goalId)?.canRenew).toBeUndefined();
    const ownerOverview = await call("GET", "/api/work/overview");
    expect(ownerOverview.body.entries.find((entry: { id: string }) => entry.id === goalId)?.canRenew).toBe(true);

    expect((await call("GET", "/api/setup-wizard/options", undefined, client)).status).toBe(403);
  });
});
