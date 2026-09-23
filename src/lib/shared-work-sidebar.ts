import type { AppState, Bot, Group } from "@/state/store";
import type { WorkItem } from "../../shared/work-item";

export function sharedWorkIds(groups: Group[]) {
  return new Set(groups.flatMap(group => group.tasks?.flatMap(task => task.workItem ? [task.workItem.id] : []) ?? []));
}

export function sharedWorkThreads(item: WorkItem, bots: Bot[]) {
  return bots.filter(bot => !bot.hidden).flatMap(bot => (bot.tasks ?? [])
    .filter(task => task.workItemId === item.id || item.assignments.some(assignment => assignment.botId === bot.id && assignment.threadId === task.threadId))
    .map(task => ({ bot, task, assignment: item.assignments.find(assignment => assignment.botId === bot.id && assignment.threadId === task.threadId && assignment.revision === item.revision) })));
}

export function selectedSharedWork(state: Pick<AppState, "activeView" | "selectedId" | "bots" | "groups">) {
  if (state.activeView !== "chat") return undefined;
  const group = state.groups.find(candidate => candidate.id === state.selectedId);
  if (group) return group.tasks?.find(task => task.threadId === group.threadId)?.workItem;
  const bot = state.bots.find(candidate => candidate.id === state.selectedId);
  const task = bot?.tasks?.find(candidate => candidate.threadId === bot.threadId);
  if (!task?.workItemId) return undefined;
  return state.groups.flatMap(candidate => candidate.tasks ?? []).find(candidate => candidate.workItem?.id === task.workItemId)?.workItem;
}

export function sharedWorkMatches(item: WorkItem, bots: Bot[], query: string) {
  const needle = query.trim().toLowerCase();
  return !needle || [item.title, item.objective, ...sharedWorkThreads(item, bots).flatMap(({ bot, task, assignment }) => [bot.name, task.title, assignment?.message ?? ""])]
    .some(text => text.toLowerCase().includes(needle));
}
