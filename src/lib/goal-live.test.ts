import { describe, expect, it } from "vitest";
import { publishGoalLive, subscribeGoalLive, type GoalLiveFrame } from "./goal-live";

const frame = (id: string): GoalLiveFrame => ({
  kind: "goal",
  goal: { id, revision: 2, status: "paused", detail: "Paused by you", gateCount: 0, gateCounts: {} },
  ownerBotId: "lead",
  sourceThreadId: "thread",
  workItemIds: [],
  workItems: [],
  scopeGroupIds: [],
});

describe("goal live frames", () => {
  it("delivers events to subscribers and unsubscribes", () => {
    const seen: string[] = [];
    const stop = subscribeGoalLive(next => { seen.push(next.goal.id); });
    publishGoalLive(frame("g1"));
    stop();
    publishGoalLive(frame("g2"));
    expect(seen).toEqual(["g1"]);
  });
});
