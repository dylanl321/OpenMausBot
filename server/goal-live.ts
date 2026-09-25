import type { OngoingGoal } from "../shared/ongoing-goal.ts";
import type { GoalLiveUpdate, GoalLiveWorkItem, ServerFrame } from "../shared/wire.ts";
import type { WorkItem } from "../shared/work-item.ts";

export type GoalLiveTask = Pick<WorkItem, "id" | "groupId" | "threadId" | "coordinatorBotId">;

function scopeGroupIds(goal: OngoingGoal): string[] {
  const ids = new Set<string>();
  for (const scope of [...(goal.teamBacklog?.scopes ?? []), ...(goal.teamBacklog?.choices ?? [])]) {
    if (scope.groupId) ids.add(scope.groupId);
  }
  return [...ids];
}

function gateCounts(goal: OngoingGoal): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const gate of goal.teamBacklog?.gates ?? []) {
    counts[gate.kind] = (counts[gate.kind] ?? 0) + 1;
  }
  return counts;
}

export function goalLiveUpdate(goal: OngoingGoal): GoalLiveUpdate {
  return {
    id: goal.id,
    revision: goal.revision,
    status: goal.status,
    detail: goal.detail,
    ...(goal.teamBacklog ? { scan: goal.teamBacklog.scan } : {}),
    gateCount: goal.teamBacklog?.gates.length ?? 0,
    gateCounts: gateCounts(goal),
  };
}

export function goalLiveFrame(
  goal: OngoingGoal,
  tasks: ReadonlyMap<string, GoalLiveTask>,
): Extract<ServerFrame, { kind: "goal" }> {
  const workItems: GoalLiveWorkItem[] = [];
  for (const id of goal.workItemIds) {
    const item = tasks.get(id);
    if (item) workItems.push({
      id: item.id, groupId: item.groupId, threadId: item.threadId, coordinatorBotId: item.coordinatorBotId,
    });
  }
  return {
    kind: "goal",
    goal: goalLiveUpdate(goal),
    ownerBotId: goal.ownerBotId,
    sourceThreadId: goal.sourceThreadId,
    workItemIds: [...goal.workItemIds],
    workItems,
    scopeGroupIds: scopeGroupIds(goal),
  };
}
