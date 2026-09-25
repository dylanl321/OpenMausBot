import { describe, expect, it, vi } from "vitest";
import { publishGoalLive, type GoalLiveFrame } from "./goal-live";
import { createSerialRefresh, startWorkFallbackPoll, subscribeWorkOverviewLive, WORK_FALLBACK_POLL_MS } from "./serial-refresh";

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

  it("skips the fallback tick on a hidden tab and refreshes when it is visible again", () => {
    const seen: string[] = [];
    const listeners = new Map<string, () => void>();
    let visibility: DocumentVisibilityState = "hidden";
    const timers: Array<{ id: number; fn: () => void }> = [];
    let nextId = 1;
    vi.stubGlobal("document", {
      get visibilityState() { return visibility; },
      addEventListener(type: string, fn: () => void) { listeners.set(type, fn); },
      removeEventListener(type: string) { listeners.delete(type); },
    });
    vi.stubGlobal("window", {
      setInterval(fn: () => void) {
        const id = nextId++;
        timers.push({ id, fn });
        return id;
      },
      clearInterval(id: number) {
        const index = timers.findIndex(timer => timer.id === id);
        if (index >= 0) timers.splice(index, 1);
      },
    });
    const stop = startWorkFallbackPoll(() => { seen.push("tick"); });
    timers[0]?.fn();
    expect(seen).toEqual([]);
    visibility = "visible";
    listeners.get("visibilitychange")?.();
    expect(seen).toEqual(["tick"]);
    timers[0]?.fn();
    expect(seen).toEqual(["tick", "tick"]);
    stop();
    expect(timers).toEqual([]);
    vi.unstubAllGlobals();
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
