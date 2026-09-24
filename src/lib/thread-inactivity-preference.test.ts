import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => number),
  serverSnapshot: undefined as undefined | (() => number),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (subscribe: typeof hook.subscribe, snapshot: typeof hook.snapshot, serverSnapshot: typeof hook.serverSnapshot) => {
    Object.assign(hook, { subscribe, snapshot, serverSnapshot });
    return snapshot!();
  },
}));

let values: Map<string, string>;
let browser: EventTarget;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-24T12:00:00Z"));
  values = new Map();
  browser = new EventTarget();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local thread inactivity preference", () => {
  it("defaults off, rejects malformed stored choices, and persists opt-in choices", async () => {
    let preference = await import("./thread-inactivity-preference");
    expect(preference.useThreadInactivityDays()).toBe(0);
    expect(hook.serverSnapshot!()).toBe(0);
    for (const value of ["-1", "1", "999", "invalid"]) {
      values.set(preference.THREAD_INACTIVITY_DAYS_KEY, value);
      expect(preference.useThreadInactivityDays()).toBe(0);
    }
    preference.setThreadInactivityDays(30);
    expect(values.get(preference.THREAD_INACTIVITY_DAYS_KEY)).toBe("30");
    vi.resetModules();
    preference = await import("./thread-inactivity-preference");
    expect(preference.useThreadInactivityDays()).toBe(30);
    preference.setThreadInactivityDays(0);
    expect(preference.useThreadInactivityDays()).toBe(0);
  });

  it("updates mounted lists hourly and follows other windows without losing the saved choice", async () => {
    const preference = await import("./thread-inactivity-preference");
    preference.setThreadInactivityDays(14);
    expect(preference.useThreadInactivityCutoff()).toBe(Date.now() - 14 * 86_400_000);
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe(Date.now() - 14 * 86_400_000);
    values.set(preference.THREAD_INACTIVITY_DAYS_KEY, "90");
    browser.dispatchEvent(Object.assign(new Event("storage"), { key: preference.THREAD_INACTIVITY_DAYS_KEY, storageArea: globalThis.localStorage }));
    expect(preference.useThreadInactivityDays()).toBe(90);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("retains a session choice if storage is blocked", async () => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
    const preference = await import("./thread-inactivity-preference");
    expect(preference.useThreadInactivityDays()).toBe(0);
    preference.setThreadInactivityDays(90);
    expect(preference.useThreadInactivityDays()).toBe(90);
  });
});
