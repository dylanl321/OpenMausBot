import { useSyncExternalStore } from "react";

export const THREAD_INACTIVITY_DAYS_KEY = "omb-thread-inactivity-days";
export type ThreadInactivityDays = 0 | 14 | 30 | 90;

let sessionChoice: ThreadInactivityDays | undefined;
const listeners = new Set<() => void>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;
let clock = Date.now();

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parseDays(value: string | null | undefined): ThreadInactivityDays {
  return value === "14" || value === "30" || value === "90" ? Number(value) as ThreadInactivityDays : 0;
}

function currentDays(): ThreadInactivityDays {
  if (sessionChoice !== undefined) return sessionChoice;
  try {
    return parseDays(storage()?.getItem(THREAD_INACTIVITY_DAYS_KEY));
  } catch {
    return 0;
  }
}

function notify() {
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent) {
  if (event.key !== THREAD_INACTIVITY_DAYS_KEY && event.key !== null) return;
  if (event.storageArea && event.storageArea !== storage()) return;
  sessionChoice = undefined;
  clock = Date.now();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    clock = Date.now();
    window.addEventListener("storage", onStorage);
    refreshTimer = setInterval(() => {
      if (currentDays()) {
        clock = Date.now();
        notify();
      }
    }, 60 * 60 * 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    }
  };
}

export function setThreadInactivityDays(days: ThreadInactivityDays): void {
  sessionChoice = days;
  clock = Date.now();
  try {
    storage()?.setItem(THREAD_INACTIVITY_DAYS_KEY, String(days));
  } catch {
    notify();
    return;
  }
  notify();
}

export function useThreadInactivityDays(): ThreadInactivityDays {
  return useSyncExternalStore(subscribe, currentDays, () => 0);
}

export function useThreadInactivityCutoff(): number {
  return useSyncExternalStore(subscribe, () => currentDays() ? clock - currentDays() * 86_400_000 : 0, () => 0);
}
