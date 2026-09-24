import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

describe("ongoing goals in an isolated OpenMausBot", () => {
  let session: VerificationServer;
  const reply = "Verified the output.\n<openmaus-pursuit>{\"status\":\"completed\",\"detail\":\"Artifact verified\",\"evidence\":[\"fixture:artifact\"],\"acceptanceCriteria\":[\"Artifact output matches the requested result\"]}</openmaus-pursuit>";
  beforeAll(async () => {
    session = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([reply]) });
  }, 60_000);
  afterAll(async () => { if (session) await session.close(); });

  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${session.info.url}${path}`, { method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as any };
  };

  it("starts an explicit goal, strips private control text, and persists the evidenced result", async () => {
    const bot = (await request("POST", "/api/bots", { name: "Lead", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    expect(bot?.threadId).toBeTruthy();
    expect((await request("GET", "/api/goals")).body.goals).toEqual([]);
    const input = { requestId: crypto.randomUUID(), ownerBotId: bot.id, sourceThreadId: bot.threadId,
      objective: "Verify an artifact" };
    const created = await request("POST", "/api/goals", input);
    expect(created.status).toBe(201);
    const goalId = created.body.goal.id;
    const retried = await request("POST", "/api/goals", input);
    expect(retried.status).toBe(200);
    expect(retried.body.goal.id).toBe(goalId);
    expect((await request("POST", "/api/goals", { ...input, objective: "Different goal" })).status).toBe(409);
    await expect.poll(async () => {
      const current = (await request("GET", `/api/goals/${goalId}`)).body.goal;
      if (current.status === "paused") throw new Error(`Goal paused: ${current.detail}`);
      return current.status;
    }, { timeout: 10_000 }).toBe("completed");
    const stored = (await request("GET", `/api/goals/${goalId}`)).body.goal;
    expect(stored.evidence).toEqual(["fixture:artifact"]);
    expect(stored.acceptanceCriteria).toEqual(["Artifact output matches the requested result"]);
    expect(stored.criteriaPending).toBe(false);
    expect(stored.scope).toBe(`goal:${input.requestId}:`);
    const page = (await request("GET", `/api/threads/${bot.threadId}/messages`)).body;
    expect(page.messages.some((message: { text?: string }) => message.text === "Verified the output.")).toBe(true);
    expect(JSON.stringify(page.messages)).not.toContain("<openmaus-pursuit>");
    expect((await request("GET", "/api/goals")).body.goals).toHaveLength(1);
  }, 45_000);

  it("automatically links one accessible ticket without broadening to other tickets", async () => {
    const bot = (await request("POST", "/api/bots", { name: "Ticket lead", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
    const task = await request("POST", "/api/work-items/ensure", { coordinatorBotId: bot.id, sourceThreadId: bot.threadId,
      topic: "Ticket work", identity: "jira:fixture:PAY-123", title: "PAY-123", objective: "Finish PAY-123",
      acceptanceCriteria: ["Verified outcome"] });
    expect(task.status).toBe(200);
    const input = { requestId: crypto.randomUUID(), ownerBotId: bot.id, sourceThreadId: bot.threadId, objective: "Finish PAY-123" };
    const created = await request("POST", "/api/goals", input);
    expect(created.status).toBe(201);
    expect(created.body.goal).toMatchObject({ scope: "jira:fixture:PAY-123", workItemIds: [task.body.workItem.id] });
    const retried = await request("POST", "/api/goals", input);
    expect(retried.status).toBe(200);
    expect(retried.body.goal.id).toBe(created.body.goal.id);
  }, 35_000);

  it("parks and stops a goal when its coordinator loses access to the source room", async () => {
    const lead = (await request("POST", "/api/bots", { name: "Former lead" })).body.bot;
    const witness = (await request("POST", "/api/bots", { name: "Witness" })).body.bot;
    const room = (await request("POST", "/api/groups", { name: "Access fixture", memberIds: [lead.id, witness.id],
      setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    const created = await request("POST", "/api/goals", { ownerBotId: lead.id, sourceThreadId: room.threadId,
      kind: "mission", objective: "Only coordinate while in this room", scope: "fixture:", acceptanceCriteria: ["Room access retained"] });
    expect(created.status).toBe(201);
    let goal = created.body.goal;
    expect((await request("PATCH", `/api/groups/${room.id}`, { memberIds: [witness.id] })).status).toBe(200);
    goal = (await request("GET", `/api/goals/${goal.id}`)).body.goal;
    expect(goal.status).toBe("paused");
    expect(goal.detail).toContain("permission to continue was revoked");
    expect((await request("PATCH", `/api/goals/${goal.id}`, { expectedRevision: goal.revision, action: "stop" })).body.goal.status).toBe("stopped");
    await new Promise(resolve => setTimeout(resolve, 1_600));
    expect((await request("GET", `/api/goals/${goal.id}`)).body.goal).toMatchObject({ status: "stopped", actions: 0 });
  }, 30_000);

  it("does not accept an unverified all-Jira-and-MRs completion claim", async () => {
    const claim = "All Jira work is closed and all MRs are merged.";
    const inventoryReply = "I am checking what is in scope.\n<openmaus-pursuit>{\"status\":\"continue\",\"detail\":\"Need to inventory open Jira work and MRs\",\"nextAction\":\"Check authorized projects and repositories\",\"acceptanceCriteria\":[\"Jira work is closed\",\"MRs are merged and closed\"]}</openmaus-pursuit>";
    const fakeReply = `${claim}\n<openmaus-pursuit>{"status":"completed","detail":"Everything is closed","evidence":["claimed:jira-done","claimed:mr-merged"],"acceptanceCriteria":["Jira work closed","All MRs merged"]}</openmaus-pursuit>`;
    const stateDir = mkdtempSync(join(tmpdir(), "omb-goal-inventory-"));
    let isolated: VerificationServer | undefined;
    try {
      isolated = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify([inventoryReply, fakeReply]),
        FAKE_CLAUDE_REPLY_STATE: join(stateDir, "replies") });
      const baseUrl = isolated.info.url;
      const api = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${baseUrl}${path}`, { method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined });
        return { status: response.status, body: await response.json() as any };
      };
      const bot = (await api("POST", "/api/bots", { name: "Delivery lead", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } })).body.bot;
      const objective = "get all current work in progreess  losed in jira and all MRs merged and closed";
      const created = await api("POST", "/api/goals", { ownerBotId: bot.id, sourceThreadId: bot.threadId, objective });
      expect(created.status).toBe(201);
      await expect.poll(async () => (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal.status,
        { timeout: 15_000 }).toBe("needs-input");
      const goal = (await api("GET", `/api/goals/${created.body.goal.id}`)).body.goal;
      expect(goal.detail).toMatch(/Jira.*GitLab.*scope/i);
      expect(goal.actions).toBe(2);
      expect(goal.acceptanceCriteria).toEqual(["Jira work is closed", "MRs are merged and closed"]);
      expect(goal.evidence).not.toContain("claimed:mr-merged");
      const messages = (await api("GET", `/api/threads/${bot.threadId}/messages`)).body.messages;
      expect(JSON.stringify(messages)).not.toContain(claim);
    } finally {
      if (isolated) await isolated.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 45_000);
});
