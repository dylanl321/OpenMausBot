import { subscribeGoalLive } from "./goal-live";
import { subscribeWorkLive } from "./work-live";

/** Fallback while SSE is quiet. Goal and work frames trigger an immediate refresh. */
export const WORK_FALLBACK_POLL_MS = 30_000;

/** Immediate Work refresh when a visible goal or work frame arrives. */
export function subscribeWorkOverviewLive(refresh: () => void): () => void {
  const stopGoal = subscribeGoalLive(() => { refresh(); });
  const stopWork = subscribeWorkLive(() => { refresh(); });
  return () => { stopGoal(); stopWork(); };
}

/** 30s fallback that stays quiet on a hidden tab and refreshes when it returns. */
export function startWorkFallbackPoll(refresh: () => void): () => void {
  const tick = () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    refresh();
  };
  const timer = window.setInterval(tick, WORK_FALLBACK_POLL_MS);
  const onVisible = () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    refresh();
  };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * One in-flight refresh at a time. A trigger during a fetch queues exactly one
 * follow-up instead of overlapping. `invalidate` drops the in-flight result
 * (filter change / unmount) the same way Work's serial ref does.
 */
export function createSerialRefresh(run: (generation: number) => Promise<void>) {
  let generation = 0;
  let inFlight = false;
  let queued = false;

  const refresh = async () => {
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    try {
      do {
        queued = false;
        const request = ++generation;
        try {
          await run(request);
        } catch (error) {
          if (!queued) throw error;
        }
      } while (queued);
    } finally {
      inFlight = false;
    }
  };

  return {
    refresh,
    invalidate() {
      generation += 1;
      queued = false;
    },
    isCurrent(request: number) {
      return request === generation;
    },
    get inFlight() {
      return inFlight;
    },
    get generation() {
      return generation;
    },
  };
}
