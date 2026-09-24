import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

async function fixture(test: (fixture: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const actions: unknown[] = [];
  const cli = (...args: string[]) => {
    actions.push({ command: args });
    return runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
  };
  const api = (path: string, body?: unknown, method = "POST") => {
    if (body !== undefined) actions.push({ path, method, body });
    return request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
  };
  try {
    const chief = (await cli("new-bot", "--name", "Clive", "--section", "Delivery")).bot;
    const engineer = (await cli("new-bot", "--name", "Eli", "--section", "Delivery")).bot;
    const reviewer = (await cli("new-bot", "--name", "Nora", "--section", "Delivery")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true }, "PATCH");
    const planPath = join(session.info.dataDir, "room-plan.json");
    const plan: Record<string, any> = {};
    const save = () => writeFileSync(planPath, JSON.stringify(plan));
    const items = async () => (await api("/api/work-items")).workItems;
    const messages = async (threadId: string) => (await api(`/api/threads/${threadId}/messages`)).messages;
    const evidence = () => existsSync(`${planPath}.evidence.jsonl`) ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    await test({ session, cli, api, chief, engineer, reviewer, plan, save, items, messages, evidence });
    const workItems = await items();
    const threadIds = new Set<string>([chief.activeTaskId, ...workItems.flatMap((item: any) => [item.threadId, ...item.assignments.map((assignment: any) => assignment.threadId)])]);
    const transcripts = Object.fromEntries(await Promise.all([...threadIds].map(async threadId => [threadId, await messages(threadId)])));
    const evidencePath = session.info.logPath + ".shared-work.json";
    writeFileSync(evidencePath, JSON.stringify({ actions, workItems, transcripts, executions: evidence() }, null, 2));
    console.log("Shared work fixture evidence:", evidencePath);
  } finally { await session.close(); }
}

const brief = { topic: "Payments", identity: "jira:account-a:PAY-123", title: "Refund failures", objective: "Fix refund failures and independently review the result",
  acceptance_criteria: ["Refund boundary cases checked"] };
const complete = { tool: "update_work_item", arguments: { work_item_id: "$current", expected_revision: "$current", status: "completed",
  detail: "Refund changes implemented and independently checked", completed_criteria: "$current", evidence: ["Nora's linked task records the boundary checks"] } };

it.each([
  { kind: "stories", titles: ["PAY-201: Fix refunds", "PAY-202: Export receipts"], identities: ["jira:account-a:PAY-201", "jira:account-a:PAY-202"] },
  { kind: "independent research outcomes", titles: ["Customer onboarding findings", "Pricing experiment proposal"], identities: ["research:product-a:onboarding", "research:product-a:pricing"] },
])("turns a priority consultation into focused delivery tasks for $kind without a second user request", ({ titles, identities }) => fixture(async fixture => {
  const { chief, engineer, reviewer, plan } = fixture;
  const gate = join(fixture.session.info.dataDir, "priority-worker-gate");
  const priorities = titles.map((title, index) => ({ topic: "Product delivery", identity: identities[index], title,
    objective: `Deliver ${title}. Priority ${index + 1}: actionable according to the planning teammate's current source review.`, acceptance_criteria: [`${title} delivered with evidence`] }));
  const dispatch = { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "deliver", message: "Execute only this shared task's outcome and return evidence" } }], reply: "Delivery assigned" };
  const finish = { steps: [{ tool: "update_work_item", arguments: { work_item_id: "$current", expected_revision: "$current", status: "completed",
    detail: "Chosen outcome delivered and checked", completed_criteria: "$current", evidence: ["Linked specialist result records the completed deliverable"] } }], reply: "Delivered" };
  plan[chief.id] = { turns: [
    { expectSystemIncludes: ["Organize by outcome", "Do not substitute a readiness report"], steps: [{ arguments: { intent: "consultation", bot_ids: [reviewer.id], request_key: "priorities",
      message: "Which two authorized outcomes are next by priority and dependencies? Return current source evidence; do not start any work." } }], reply: "Checking priorities" },
    { expectContextIncludes: ["Ranked actionable outcomes"], steps: priorities.map(argumentsForTask => ({ tool: "ensure_work_item", arguments: argumentsForTask })), reply: "Starting the selected delivery tasks" },
    dispatch, dispatch, finish, finish,
  ] };
  plan[reviewer.id] = { steps: [{ tool: "ensure_work_item", arguments: priorities[0], expectError: true }], reply: `Ranked actionable outcomes: ${titles.join("; ")}. Source: current prioritized backlog; no dependencies outstanding.` };
  plan[engineer.id] = { gateFile: gate, reply: "Current outcome delivered with checks and artifact evidence" };
  fixture.save();
  await fixture.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Let's begin working on the next priorities");
  await expect.poll(async () => (await fixture.items()).filter((item: any) => item.assignments[0]?.status === "running").length, { timeout: 35_000 }).toBe(2);
  const selected = await fixture.items();
  expect(selected.map((item: any) => item.title)).toEqual(titles);
  expect(new Set(selected.map((item: any) => item.groupId)).size).toBe(1);
  expect(new Set(selected.map((item: any) => item.threadId)).size).toBe(2);
  expect(selected.every((item: any) => item.assignments.length === 1)).toBe(true);
  writeFileSync(gate, "finish selected outcomes");
  await expect.poll(async () => (await fixture.items()).filter((item: any) => item.status === "completed").length, { timeout: 30_000 }).toBe(2);
  expect(fixture.evidence().filter((entry: any) => entry.botId === engineer.id)).toHaveLength(2);
  expect((await fixture.messages(chief.activeTaskId)).filter((message: any) => message.role === "user")).toHaveLength(1);
}), 85_000);

it.each(["routine", "webhook"])("organizes %s deliveries into the same task without repeating completed work", trigger => fixture(async fixture => {
  const { chief, engineer, plan } = fixture;
  const gate = join(fixture.session.info.dataDir, "automation-worker-gate");
  plan[chief.id] = { turns: [
    { steps: [{ tool: "ensure_work_item", arguments: brief }], reply: "Work attached to the shared task" },
    { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "work", message: "Implement and check refunds" } }], reply: "Assigned" },
    { steps: [complete], reply: "Checked" },
    { steps: [{ tool: "ensure_work_item", arguments: brief }], reply: "Reused the recorded outcome" },
  ] };
  plan[engineer.id] = { gateFile: gate, reply: "Refund boundary cases checked" };
  fixture.save();
  let start: (delivery: string) => Promise<string>;
  if (trigger === "routine") {
    const { routine } = await fixture.api("/api/routines", { name: "Watch delivery", prompt: brief.objective, botId: chief.id,
      enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    start = async () => (await fixture.api(`/api/routines/${routine.id}/run`, {})).run.id;
  } else {
    const created = await fixture.api("/api/webhooks", { name: "Watch delivery", prompt: brief.objective, botId: chief.id });
    start = async delivery => {
      const response = await fetch(created.credential.url, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": delivery },
        body: JSON.stringify({ issue: "PAY-123", relevantRequirements: "Fix refunds" }) });
      expect(response.status).toBe(202);
      return (await response.json() as { runId: string }).runId;
    };
  }
  const runState = async (id: string) => (await fixture.api("/api/routines")).runs.find((run: any) => run.id === id);
  const firstId = await start("first");
  await expect.poll(async () => (await fixture.items())[0]?.assignments[0]?.status, { timeout: 25_000 }).toBe("running");
  expect(await runState(firstId)).toMatchObject({ status: "waiting", workItemIds: [(await fixture.items())[0].id] });
  writeFileSync(gate, "finish automation work");
  await expect.poll(async () => (await runState(firstId))?.status, { timeout: 25_000 }).toBe("completed");
  const secondId = await start("second");
  await expect.poll(async () => (await runState(secondId))?.status, { timeout: 20_000 }).toBe("completed");
  expect(await fixture.items()).toHaveLength(1);
  expect(fixture.evidence().filter((entry: any) => entry.botId === engineer.id)).toHaveLength(1);
}), 80_000);

it("moves a direct request into one shared hub, executes linked specialists and reuses the finished outcome", () => fixture(async fixture => {
  const { chief, engineer, reviewer, plan } = fixture;
  plan[chief.id] = { turns: [
    { steps: [{ tool: "ensure_work_item", arguments: brief }], reply: "Opened the shared task" },
    { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "implement", message: "Implement the refund correction" } }], reply: "Implementation assigned" },
    { steps: [{ arguments: { intent: "work", bot_ids: [reviewer.id], request_key: "review", message: "Independently check the implemented refund boundary cases" } }], reply: "Review assigned" },
    { steps: [complete], reply: "All acceptance criteria checked" },
    { steps: [{ tool: "ensure_work_item", arguments: brief }], reply: "Reused the existing result" },
  ] };
  plan[engineer.id] = { reply: "Refund correction implemented; artifact: refund.ts revision abc123", expectContextIncludes: [brief.objective] };
  plan[reviewer.id] = { reply: "Refund boundary cases checked against abc123", expectContextIncludes: ["refund.ts revision abc123"] };
  fixture.save();
  await fixture.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", brief.objective);
  await expect.poll(async () => (await fixture.items())[0]?.status, { timeout: 45_000 }).toBe("completed");
  const [item] = await fixture.items();
  expect(item.assignments).toHaveLength(2);
  expect(new Set(item.assignments.map((assignment: any) => assignment.threadId)).size).toBe(2);
  expect(item.assignments.every((assignment: any) => assignment.status === "completed")).toBe(true);
  expect((await fixture.messages(chief.activeTaskId)).filter((message: any) => message.workItemReceipt?.phase === "result")).toHaveLength(1);
  const bots = (await fixture.api("/api/bots?messages=0")).bots;
  expect(bots.find((bot: any) => bot.id === chief.id).threadId).toBe(chief.activeTaskId);
  for (const assignment of item.assignments) expect(bots.find((bot: any) => bot.id === assignment.botId).tasks.find((task: any) => task.threadId === assignment.threadId).workItemId).toBe(item.id);
  // The completion tool records the outcome before the coordinator's final
  // provider frame. Its room must settle before the same bot can be sent a
  // new direct request through the guarded external control surface.
  expect((await fixture.cli("wait", "--channel", item.groupId, "--task", item.threadId, "--timeout", "15")).status).toBe("settled");
  await fixture.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Check the same story again");
  await fixture.cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "15");
  expect(await fixture.items()).toHaveLength(1);
  expect(fixture.evidence().filter((entry: any) => entry.botId === engineer.id || entry.botId === reviewer.id)).toHaveLength(2);
  expect((await fixture.messages(chief.activeTaskId)).filter((message: any) => message.workItemReceipt?.phase === "result")).toHaveLength(1);
}), 70_000);

it("keeps task identity and worker context separate for two deliverables in one topic", () => fixture(async fixture => {
  const { chief, engineer, plan } = fixture;
  plan[chief.id] = { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "implement", message: "Implement only the current shared task" } }],
    reply: "Assigned", resumeSteps: [complete], resumeReply: "Verified" };
  plan[engineer.id] = { reply: "Current task implementation checked", delayMs: 300 };
  fixture.save();
  const create = (identity: string, title: string) => fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Delivery", identity, title, objective: title, acceptanceCriteria: ["Checked"] });
  const first = await create("generic:release-notes", "Release notes");
  const duplicates = await Promise.all(Array.from({ length: 4 }, () => create("generic:release-notes", "Release notes")));
  expect(duplicates.every(result => !result.created && !result.started && result.workItem.id === first.workItem.id)).toBe(true);
  const second = await create("generic:incident-review", "Incident review");
  expect(first.workItem.groupId).toBe(second.workItem.groupId);
  expect(first.workItem.threadId).not.toBe(second.workItem.threadId);
  await expect.poll(async () => (await fixture.items()).filter((item: any) => item.status === "completed").length, { timeout: 45_000 }).toBe(2);
  const items = await fixture.items();
  expect(items[0].assignments[0].threadId).not.toBe(items[1].assignments[0].threadId);
  const workerTurns = fixture.evidence().filter((entry: any) => entry.botId === engineer.id);
  expect(workerTurns).toHaveLength(2);
  expect(new Set(workerTurns.map((entry: any) => entry.threadId)).size).toBe(2);
}), 65_000);

it("refuses unbound work dispatch and stops a hub without replaying late worker results", () => fixture(async fixture => {
  const { chief, engineer, plan } = fixture;
  const gate = join(fixture.session.info.dataDir, "worker-gate");
  plan[chief.id] = { turns: [
    { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "bad", message: "Untracked work" }, expectError: true }], reply: "A shared task is required" },
    { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "work", message: "Do the assigned task" } }], reply: "Assigned" },
  ] };
  plan[engineer.id] = { gateFile: gate, reply: "Finished the in-flight assignment" };
  fixture.save();
  await fixture.cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Try untracked work");
  await fixture.cli("wait", "--bot", chief.id, "--task", chief.activeTaskId, "--timeout", "15");
  expect(await fixture.items()).toHaveLength(0);
  const { workItem } = await fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Delivery", identity: "generic:stop-test", title: "Stop test", objective: "Do a task", acceptanceCriteria: ["Checked"] });
  await expect.poll(async () => (await fixture.items())[0]?.assignments[0]?.status, { timeout: 20_000 }).toBe("running");
  await fixture.api(`/api/work-items/${workItem.id}`, { expectedRevision: 1, status: "cancelled", detail: "Stopped by user" }, "PATCH");
  writeFileSync(gate, "finish");
  await expect.poll(async () => (await fixture.items())[0]?.assignments[0]?.status, { timeout: 15_000 }).toBe("completed");
  expect((await fixture.items())[0].status).toBe("cancelled");
  expect(fixture.evidence().filter((entry: any) => entry.botId === chief.id)).toHaveLength(2);
}), 65_000);

it("stops the active coordinator process and reopens with a fresh execution root", () => fixture(async fixture => {
  const { chief, plan } = fixture;
  const started = (revision: number) => join(fixture.session.info.dataDir, `coordinator-started-${revision}`);
  const hold = (revision: number) => {
    plan[chief.id] = { gateFile: join(fixture.session.info.dataDir, "coordinator-release"), gateEnteredFile: started(revision), reply: "Should be interrupted" };
    fixture.save();
  };
  hold(1);
  const { workItem } = await fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Delivery", identity: "generic:coordinator-stop",
    title: "Coordinator stop", objective: "Exercise task lifecycle", acceptanceCriteria: ["Checked"] });
  const roots = new Set<string>();
  for (const revision of [1, 2]) {
    await expect.poll(() => existsSync(started(revision)), { timeout: 20_000 }).toBe(true);
    const record = JSON.parse(readFileSync(join(fixture.session.info.dataDir, "work-items.json"), "utf8")).find((item: any) => item.id === workItem.id);
    roots.add(record.rootId);
    await fixture.api(`/api/work-items/${workItem.id}`, { expectedRevision: revision, status: "cancelled", detail: "Stopped by user" }, "PATCH");
    await expect.poll(async () => (await fixture.api("/api/bots")).bots.find((bot: any) => bot.id === chief.id)?.busy, { timeout: 15_000 }).toBe(false);
    expect((await fixture.items())[0]).toMatchObject({ status: "cancelled", revision });
    if (revision === 1) {
      hold(2);
      await fixture.api(`/api/work-items/${workItem.id}`, { expectedRevision: 1, reopen: true }, "PATCH");
    }
  }
  expect(roots.size).toBe(2);
  expect((await fixture.messages(workItem.threadId)).some((message: any) => message.text === "Should be interrupted")).toBe(false);
}), 65_000);

it("withholds revoked peer results and never marks the task complete", () => fixture(async fixture => {
  const { chief, engineer, plan } = fixture;
  const gate = join(fixture.session.info.dataDir, "revoked-worker-gate");
  plan[chief.id] = { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "work", message: "Check the deliverable" } }], reply: "Assigned",
    resumeSteps: [{ tool: "update_work_item", arguments: { work_item_id: "$current", expected_revision: "$current", status: "blocked", detail: "Peer permission was revoked" } }], resumeReply: "Blocked" };
  plan[engineer.id] = { gateFile: gate, reply: "Private result after revocation" };
  fixture.save();
  const { workItem } = await fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Delivery", identity: "generic:revocation", title: "Revocation", objective: "Check work", acceptanceCriteria: ["Checked"] });
  await expect.poll(async () => (await fixture.items())[0]?.assignments[0]?.status, { timeout: 20_000 }).toBe("running");
  await fixture.api(`/api/bots/${chief.id}`, { peers: [] }, "PATCH");
  writeFileSync(gate, "finish");
  await expect.poll(async () => (await fixture.items())[0]?.status, { timeout: 20_000 }).toBe("blocked");
  expect(JSON.stringify(await fixture.messages(workItem.threadId))).not.toContain("Private result after revocation");
}), 55_000);

it("keeps nested specialist work in the same task using the immediate lead's peer access", () => fixture(async fixture => {
  const { chief, engineer, reviewer, plan } = fixture;
  await fixture.api(`/api/bots/${chief.id}`, { peers: [engineer.id] }, "PATCH");
  await fixture.api(`/api/bots/${engineer.id}`, { peers: [reviewer.id] }, "PATCH");
  plan[chief.id] = { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "lead", message: "Implement refunds and obtain a specialist check" } }],
    reply: "Assigned", resumeSteps: [complete], resumeReply: "Verified" };
  plan[engineer.id] = { steps: [{ arguments: { intent: "work", bot_ids: [reviewer.id], request_key: "review", message: "Check refund boundary cases" } }],
    reply: "Review assigned", resumeReply: "Implemented refunds and incorporated the specialist's boundary checks" };
  plan[reviewer.id] = { steps: [{ tool: "get_work_item", arguments: {} }], reply: "Refund boundary cases checked" };
  fixture.save();
  await fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Payments", identity: "generic:nested", title: "Nested review", objective: brief.objective,
    acceptanceCriteria: brief.acceptance_criteria });
  await expect.poll(async () => (await fixture.items())[0]?.status, { timeout: 35_000 }).toBe("completed");
  const [item] = await fixture.items();
  expect(item.assignments).toHaveLength(2);
  expect(item.assignments.every((assignment: any) => assignment.status === "completed")).toBe(true);
  expect(fixture.evidence().filter((entry: any) => entry.botId === reviewer.id)).toHaveLength(1);
}), 55_000);

it("does not leave a loose worker thread when assignment admission is rejected", () => fixture(async fixture => {
  const { chief, engineer, plan } = fixture;
  const tasks = async () => (await fixture.api("/api/bots")).bots.find((bot: any) => bot.id === engineer.id).tasks;
  const originalTasks = await tasks();
  plan[chief.id] = { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "invalid", assignment_id: "missing-assignment",
    rework: true, message: "Invalid correction request" }, expectError: true }], reply: "Cannot dispatch that correction" };
  fixture.save();
  await fixture.api("/api/work-items/ensure", { coordinatorBotId: chief.id, topic: "Delivery", identity: "generic:rejected", title: "Rejected assignment",
    objective: "Check assignment admission", acceptanceCriteria: ["No orphan threads"] });
  await expect.poll(async () => (await fixture.items())[0]?.status, { timeout: 20_000 }).toBe("blocked");
  expect((await fixture.items())[0].assignments).toHaveLength(0);
  expect((await tasks()).map((task: any) => task.threadId)).toEqual(originalTasks.map((task: any) => task.threadId));
}), 35_000);
