import type { LinkedItem, TaskEvent } from "../../shared/work-links";

export type WorkLiveScope = { groupId: string; threadId: string; coordinatorBotId: string };

export type WorkLiveFrame =
  | { kind: "work.event"; event: TaskEvent; workItem: WorkLiveScope }
  | { kind: "work.link"; link: LinkedItem; workItem: WorkLiveScope };

const listeners = new Set<(frame: WorkLiveFrame) => void>();

export function subscribeWorkLive(listener: (frame: WorkLiveFrame) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishWorkLive(frame: WorkLiveFrame): void {
  for (const listener of listeners) listener(frame);
}
