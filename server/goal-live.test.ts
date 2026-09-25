import { describe, expect, it } from "vitest";
import { emptyTeamBacklog } from "../shared/team-backlog.ts";
import { goalLiveFrame } from "./goal-live.ts";
import type { OngoingGoal } from "../shared/ongoing-goal.ts";

const goal = (patch: Partial<OngoingGoal> = {}): OngoingGoal => ({
  id: "11111111-1111-1111-1111-111111111111",
  revision: 3,
  ownerBotId: "lead",
  sourceThreadId: "room",
  executionThreadId: "execution",
  kind: "mission",
  objective: "Finish the inventory",
  acceptanceCriteria: ["Every scoped work item is evidenced and done"],
  scope: "goal:test:",
  status: "working",
  detail: "Scanning inventory",
  workItemIds: ["task"],
  ownedWorkItemIds: [],
  evidence: [],
  actions: 1,
  maxActions: 48,
  activeMs: 0,
  maxActiveMinutes: 1440,
  spentUsd: 0,
  chargedTurnIds: [],
  createdAt: 1,
  updatedAt: 2,
  waitCount: 0,
  noProgress: 0,
  teamBacklog: {
    ...emptyTeamBacklog("Delivery"),
    scopes: [{ id: "board", connectorId: "jira", connectionId: "jira-main", query: "project = PAY",
      label: "PAY", groupId: "hub", kinds: ["work_item"] }],
    gates: [{ kind: "review", detail: "Needs review", decisionMaker: "Maintainer", identity: "PAY-1" }],
    scan: { status: "complete", itemCount: 2, errors: [], completedAt: 4 },
  },
  ...patch,
});

describe("goal live frames", () => {
  it("publishes id, revision, status, detail, scan and gate counts with visibility subjects", () => {
    const frame = goalLiveFrame(goal(), new Map([["task", {
      id: "task", groupId: "hub", threadId: "hub-thread", coordinatorBotId: "lead",
    }]]));
    expect(frame).toMatchObject({
      kind: "goal",
      goal: { id: goal().id, revision: 3, status: "working", detail: "Scanning inventory",
        scan: { status: "complete", itemCount: 2 }, gateCount: 1, gateCounts: { review: 1 } },
      ownerBotId: "lead",
      sourceThreadId: "room",
      workItemIds: ["task"],
      workItems: [{ id: "task", groupId: "hub", threadId: "hub-thread", coordinatorBotId: "lead" }],
      scopeGroupIds: ["hub"],
    });
    expect(JSON.stringify(frame)).not.toContain("PAY-1 awaits");
  });

  it("omits unresolved work items so the SSE filter can fail closed", () => {
    const frame = goalLiveFrame(goal(), new Map());
    expect(frame.workItemIds).toEqual(["task"]);
    expect(frame.workItems).toEqual([]);
  });
});
