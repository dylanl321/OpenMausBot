import { describe, expect, it } from "vitest";
import { publishGoalLive, type GoalLiveFrame } from "./goal-live";
import { createSerialRefresh, subscribeWorkOverviewLive, WORK_FALLBACK_POLL_MS } from "./serial-refresh";

describe("serial Work/goal refresh", () => {
  it("uses a 30s fallback poll and never overlaps in-flight fetches", async () => {
    expect(WORK_FALLBACK_POLL_MS).toBe(30_000);
    const started: number[] = [];
    const blockers: Array<(value: void) => void> = [];
    const poll = createSerialRefresh(async generation => {
      started.push(generation);
      await new Promise<void>(resolve => { blockers.push(resolve); });
    });
    const first = poll.refresh();
    const second = poll.refresh();
    expect(poll.inFlight).toBe(true);
    expect(started).toEqual([1]);
    blockers[0]?.();
    await expect.poll(() => started.slice()).toEqual([1, 2]);
    blockers[1]?.();
    await first;
    await second;
    expect(started).toEqual([1, 2]);
    expect(poll.inFlight).toBe(false);
  });

  it("invalidates an in-flight generation so a stale result is dropped", async () => {
    const seen: number[] = [];
    let release: ((value: void) => void) | undefined;
    const poll = createSerialRefresh(async generation => {
      await new Promise<void>(resolve => { release = resolve; });
      if (poll.isCurrent(generation)) seen.push(generation);
    });
    const pending = poll.refresh();
    poll.invalidate();
    release?.();
    await pending;
    expect(seen).toEqual([]);
    expect(poll.isCurrent(1)).toBe(false);
  });

  it("refreshes Work from a goal frame without waiting for the fallback poll", () => {
    const seen: string[] = [];
    const stop = subscribeWorkOverviewLive(() => { seen.push("refresh"); });
    const frame: GoalLiveFrame = {
      kind: "goal",
      goal: { id: "g1", revision: 2, status: "paused", detail: "Paused by you", gateCount: 0, gateCounts: {} },
      ownerBotId: "lead", sourceThreadId: "thread", workItemIds: [], workItems: [], scopeGroupIds: [],
    };
    publishGoalLive(frame);
    stop();
    publishGoalLive(frame);
    expect(seen).toEqual(["refresh"]);
  });
});
