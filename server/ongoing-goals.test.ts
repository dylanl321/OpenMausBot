import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OngoingGoals, canRetryGoalWork, interruptedLinkedWork, isTeamBacklogObjective, parseGoalDecision, referencedGoalWork, requiresExternalInventory } from "./ongoing-goals.ts";
import { WorkItems } from "./work-items.ts";
import { emptyTeamBacklog } from "../shared/team-backlog.ts";

const tempDirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omb-ongoing-goals-"));
  tempDirs.push(dir);
  const file = join(dir, "goals.json");
  let time = 1_000_000;
  const clock = () => time;
  const goals = new OngoingGoals(file, () => {}, clock);
  const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "chat", kind: "mission",
    objective: "Deliver the release", acceptanceCriteria: ["Shipped and verified"], scope: "jira:project:REL-" }, "execution");
  return { file, goals, goal, clock, advance: (ms: number) => { time += ms; } };
}
afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("ongoing goal accounting", () => {
  it("keeps a durable, private, uniquely scoped record and rejects stale control", () => {
    const { file, goals, goal } = fixture();
    expect(goals.due()).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(1);
    expect(() => goals.create({ ownerBotId: "lead", sourceThreadId: "chat", kind: "mission",
      objective: "Duplicate", acceptanceCriteria: ["Another"], scope: "jira:project:REL-" }, "other")).toThrow("already owns");
    expect(() => goals.control(goal.id, { expectedRevision: 0, action: "pause" })).toThrow();
    expect(goals.control(goal.id, { expectedRevision: goal.revision, action: "pause" }).status).toBe("paused");
    expect(goals.due()).toHaveLength(0);
  });

  it("reuses an exact request after a lost creation response but rejects changed intent", () => {
    const { goals, goal } = fixture();
    const request = { requestId: crypto.randomUUID(), ownerBotId: "lead", sourceThreadId: "other", kind: "deliverable" as const,
      objective: "Verify an artifact", acceptanceCriteria: ["Checked"], scope: "artifact:" };
    const created = goals.create(request, "other-execution");
    goals.begin(created);
    goals.finish(created, { status: "completed", detail: "Checked", evidence: ["artifact:1"] }, "artifact:1");
    expect(goals.create(request, "unused-execution")).toBe(created);
    expect(goals.records.size).toBe(2);
    expect(() => goals.create({ ...request, objective: "Different outcome" }, "unused-execution")).toThrow("different request");
    expect(goal.status).toBe("working");
  });

  it("accepts just the desired outcome and requires AI-derived checks before completing", () => {
    const { goals } = fixture();
    const goal = goals.create({ requestId: crypto.randomUUID(), ownerBotId: "lead", sourceThreadId: "simple",
      objective: "Finish PAY-123 and verify the result" }, "simple");
    expect(goal).toMatchObject({ criteriaPending: true, acceptanceCriteria: ["Finish PAY-123 and verify the result"],
      maxActions: 48, maxActiveMinutes: 1440 });
    expect(goal.scope).toMatch(/^goal:[\w-]+:$/);
    goals.begin(goal);
    goals.finish(goal, { status: "completed", detail: "Claimed done", evidence: ["not-checked"] }, "unchanged");
    expect(goal.status).toBe("working");
    expect(goal.detail).toContain("Define observable");
    goals.begin(goal);
    goals.finish(goal, { status: "completed", detail: "Verified", evidence: ["observed:artifact"],
      acceptanceCriteria: ["Artifact matches the expected output"] }, "verified");
    expect(goal).toMatchObject({ status: "completed", acceptanceCriteria: ["Artifact matches the expected output"], criteriaPending: false });
  });

  it("uses a single unambiguous referenced task instead of a broad project prefix", () => {
    const makeItem = (identity: string) => ({ identity }) as ReturnType<WorkItems["ensure"]>["item"];
    expect(referencedGoalWork("Finish PAY-123", [makeItem("jira:account-a:PAY-123")])?.identity).toBe("jira:account-a:PAY-123");
    expect(referencedGoalWork("Finish PAY-123 and PAY-124", [makeItem("jira:account-a:PAY-123")])).toBeUndefined();
    expect(referencedGoalWork("Finish PAY-123", [makeItem("jira:account-a:PAY-123"), makeItem("jira:account-b:PAY-123")])).toBeUndefined();
  });

  it("recognizes blanket Jira and MR requests as requiring an external inventory", () => {
    expect(requiresExternalInventory("get all current work in progreess  losed in jira and all MRs merged and closed")).toBe(true);
    expect(requiresExternalInventory("Merge the reviewed MR for PAY-123")).toBe(false);
    expect(requiresExternalInventory("Close all Jira work for PAY-123 and merge repo/app!15")).toBe(true);
    expect(requiresExternalInventory("Close all Jira issues")).toBe(true);
    expect(requiresExternalInventory("Merge all GitLab MRs")).toBe(true);
    expect(isTeamBacklogObjective("Close all Jira issues")).toBe(false);
    expect(isTeamBacklogObjective("Close all Jira work for PAY-123 and merge repo/app!15")).toBe(false);
    expect(isTeamBacklogObjective("finish our current Jira work and merge the MRs")).toBe(true);
    expect(requiresExternalInventory("Verify an artifact")).toBe(false);
  });

  it("pauses after repeated unsupported completion claims instead of spinning", () => {
    const { goals } = fixture();
    const goal = goals.create({ ownerBotId: "lead", sourceThreadId: "repeated", objective: "Verify the artifact" }, "repeated");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      goals.begin(goal);
      goals.finish(goal, { status: "completed", detail: "Done", evidence: ["unverified"] }, "no progress");
    }
    expect(goal).toMatchObject({ status: "paused", actions: 4 });
  });

  it("waits without burning action budget, wakes on a result, and completes with evidence", () => {
    const { goals, goal, advance } = fixture();
    expect(goals.begin(goal)).toBe(true);
    advance(2_000);
    goals.finish(goal, { status: "waiting", detail: "CI pending", nextAction: "Check the build" }, "build:pending");
    expect(goal).toMatchObject({ status: "waiting", actions: 1, activeMs: 2_000 });
    expect(goals.due()).toHaveLength(0);
    goals.wake(goal);
    expect(goals.due()).toHaveLength(1);
    expect(goals.begin(goal)).toBe(true);
    goals.finish(goal, { status: "completed", detail: "Shipped", evidence: ["observed:merge:abc"] }, "build:passed");
    expect(goal).toMatchObject({ status: "completed", actions: 2, evidence: ["observed:merge:abc"] });
  });

  it("does not replay an interrupted action across restart", () => {
    const { file, goals, goal, advance, clock } = fixture();
    goals.begin(goal);
    advance(3_000);
    const restored = new OngoingGoals(file, () => {}, clock);
    const recorded = restored.records.get(goal.id)!;
    expect(recorded.status).toBe("paused");
    expect(recorded.detail).toContain("inspect its effects");
    expect(recorded.activeMs).toBe(3_000);
    expect(restored.due()).toHaveLength(0);
  });

  it("distinguishes a recorded blocker from a worker interrupted by restart", () => {
    const { file, goals, goal, clock } = fixture();
    const items = new WorkItems(join(file, "..", "work.json"), clock);
    const { item } = items.ensure({ scope: "Delivery", identity: "jira:project:REL-1", groupId: "room", threadId: "hub",
      coordinatorBotId: "lead", title: "Delivery", objective: "Check the delivered artifact", acceptanceCriteria: ["Verified"] });
    goals.link(goal, item.id, true);
    items.claim(item, { botId: "worker", threadId: "worker-thread", message: "Check the artifact" });
    items.settle(item, "blocked", "Worker needs a corrected command");
    expect(interruptedLinkedWork(item)).toBe(false);
    const workFile = join(file, "..", "work.json");
    const restoredItems = new WorkItems(workFile, clock);
    const restored = restoredItems.records.get(item.id)!;
    expect(interruptedLinkedWork(restored)).toBe(true);
    expect(restored.assignments[0]?.result).toContain("not replayed");
    const waiting = new OngoingGoals(file, () => {}, clock).records.get(goal.id)!;
    expect(waiting.status).toBe("waiting");
    expect(waiting.workItemIds).toEqual([item.id]);
  });

  it("allows only the owning coordinator to retry a settled, scoped blocker", () => {
    const { file, goals, goal, clock } = fixture();
    const items = new WorkItems(join(file, "..", "retry-work.json"), clock);
    const { item } = items.ensure({ scope: "Delivery", identity: "jira:project:REL-2", groupId: "room", threadId: "hub",
      coordinatorBotId: "lead", title: "Delivery", objective: "Fix the verified blocker", acceptanceCriteria: ["Verified"] });
    const source = { botId: "lead", threadId: "hub", groupId: "room" };
    goals.link(goal, item.id, true);
    const { assignment } = items.claim(item, { botId: "worker", threadId: "worker-thread", message: "Try once" });
    items.settle(item, "blocked", "Requires a corrected command");
    expect(canRetryGoalWork(goal, item, source, "Delivery")).toBe(false);
    assignment.status = "failed";
    assignment.result = "Command rejected; no write occurred";
    items.changed(item);
    expect(canRetryGoalWork(goal, item, source, "Delivery")).toBe(true);
    expect(canRetryGoalWork(goal, item, { ...source, botId: "worker" }, "Delivery")).toBe(false);
    expect(canRetryGoalWork(goal, item, { ...source, threadId: "other" }, "Delivery")).toBe(false);
    expect(canRetryGoalWork(goal, item, source, "Unrelated")).toBe(false);
    assignment.result = "Interrupted by server restart; not replayed.";
    expect(canRetryGoalWork(goal, item, source, "Delivery")).toBe(false);
    assignment.result = "Command rejected; no write occurred";
    goals.control(goal.id, { expectedRevision: goal.revision, action: "stop" });
    expect(canRetryGoalWork(goal, item, source, "Delivery")).toBe(false);
  });

  it("pauses on exhausted limits and does not renew on a status wake", () => {
    const { goals, goal } = fixture();
    goal.maxActions = 1;
    goals.begin(goal);
    goals.finish(goal, { status: "continue", detail: "Drafted", nextAction: "Review" }, "new draft");
    expect(goals.begin(goal)).toBe(false);
    expect(goal.status).toBe("paused");
    expect(() => goals.control(goal.id, { expectedRevision: goal.revision, action: "wake" })).toThrow("resume");
    goals.control(goal.id, { expectedRevision: goal.revision, action: "resume" });
    expect(goal.actions).toBe(0);
  });

  it("wakes a scope-gated backlog mission without silently renewing its limits", () => {
    const { goals } = fixture();
    const backlog = { ...emptyTeamBacklog("Delivery"), gates: [{ kind: "scope" as const,
      decisionMaker: "Conversation requester", detail: "Choose the source projects" }] };
    const mission = goals.create({ ownerBotId: "lead", sourceThreadId: "backlog",
      objective: "finish our current Jira work and merge the MRs" }, "backlog-execution", backlog);
    goals.begin(mission);
    goals.finish(mission, { status: "needs-input", detail: "Choose the source projects" }, "scope", 0.25);
    expect(mission).toMatchObject({ status: "needs-input", actions: 1, spentUsd: 0.25 });
    goals.control(mission.id, { expectedRevision: mission.revision, action: "resume" });
    expect(mission).toMatchObject({ status: "working", actions: 1, spentUsd: 0.25 });
  });

  it("charges a reused task after this goal starts a new revision without duplicating its link", () => {
    const { goals, goal } = fixture();
    goals.link(goal, "existing-task", false);
    goals.link(goal, "existing-task", true);
    expect(goal.workItemIds).toEqual(["existing-task"]);
    expect(goal.ownedWorkItemIds).toEqual(["existing-task"]);
    goal.maxSpendUsd = 0.2;
    goals.charge(goal, "new-revision-worker", 0.15);
    expect(goal.spentUsd).toBe(0.15);
  });

  it("deduplicates charged worker turns and fails closed when a spend cap cannot be priced", () => {
    const { goals, goal } = fixture();
    goal.maxSpendUsd = 0.01;
    goals.charge(goal, "worker-turn", 0.006);
    goals.charge(goal, "worker-turn", 0.006);
    expect(goal.spentUsd).toBe(0.006);
    goals.charge(goal, "second-worker", null);
    expect(goal.status).toBe("paused");
    expect(goal.detail).toContain("cannot be priced");
  });

  it("parks an interrupted goal after Stop and never replays it on restart", () => {
    const { file, goals, goal, clock } = fixture();
    goals.begin(goal);
    goals.control(goal.id, { expectedRevision: goal.revision, action: "stop" });
    expect(new OngoingGoals(file, () => {}, clock).records.get(goal.id)?.status).toBe("stopped");
  });

  it("does not spend coordinator actions on an unchanged external observation", () => {
    const { goals, goal } = fixture();
    expect(goals.observe(goal, "mr:head1")).toBe(true);
    expect(goals.observe(goal, "mr:head1")).toBe(false);
    expect(goal).toMatchObject({ actions: 0, status: "waiting" });
  });

  it("keeps private envelopes out of visible text and rejects invented completion", () => {
    expect(parseGoalDecision("Delivered\n<openmaus-pursuit>{\"status\":\"completed\",\"detail\":\"Done\",\"evidence\":[\"id:1\"]}</openmaus-pursuit>")).toEqual({
      text: "Delivered", decision: { status: "completed", detail: "Done", evidence: ["id:1"] },
    });
    expect(parseGoalDecision("Not done\n<openmaus-pursuit>{\"status\":\"completed\",\"detail\":\"Done\"}</openmaus-pursuit>").decision).toBeNull();
    expect(parseGoalDecision('Done\n<openmaus-pursuit>{"status":"completed","detail":"Checked","evidence":["id:1"],"acceptanceCriteria":["Verified in fixture"]}</openmaus-pursuit>').decision)
      .toMatchObject({ acceptanceCriteria: ["Verified in fixture"] });
  });
});
