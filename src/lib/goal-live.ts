import type { GoalLiveUpdate, GoalLiveWorkItem } from "../../shared/wire";

export type GoalLiveFrame = {
  kind: "goal";
  goal: GoalLiveUpdate;
  ownerBotId: string;
  sourceThreadId: string;
  workItemIds: string[];
  workItems: GoalLiveWorkItem[];
  scopeGroupIds: string[];
};

const listeners = new Set<(frame: GoalLiveFrame) => void>();

export function subscribeGoalLive(listener: (frame: GoalLiveFrame) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishGoalLive(frame: GoalLiveFrame): void {
  for (const listener of listeners) listener(frame);
}
