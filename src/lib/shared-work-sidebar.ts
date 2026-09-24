import type { AppState, Bot, Group } from "@/state/store";
import type { WorkItem } from "../../shared/work-item";
import type { LinkedItem } from "../../shared/work-links";
import { displayLinks, nowFrom, progressCounts } from "@/components/work/model";

export const SIDEBAR_WORK_FILTERS = ["all", "needs_you", "in_review", "done"] as const;
export type SidebarWorkFilter = (typeof SIDEBAR_WORK_FILTERS)[number];

export function sharedWorkIds(groups: Group[]) {
  return new Set(groups.flatMap(group => group.tasks?.flatMap(task => task.workItem ? [task.workItem.id] : []) ?? []));
}

export function workItemKey(item: WorkItem): string | undefined {
  const links = displayLinks(item);
  return links.find(link => link.role === "source" && link.kind === "work_item" && link.externalId)?.externalId
    ?? links.find(link => link.kind === "work_item" && link.externalId)?.externalId;
}

export function firstChangeRequest(item: WorkItem): LinkedItem | undefined {
  return displayLinks(item).find(link => link.kind === "change_request");
}

export function matchesSidebarWorkFilter(item: WorkItem, bots: Bot[], filter: SidebarWorkFilter): boolean {
  if (filter === "all") return true;
  if (filter === "done") return item.status === "completed" || item.status === "cancelled";
  if (filter === "needs_you") {
    return item.status === "needs-input" || item.status === "blocked"
      || sharedWorkThreads(item, bots).some(({ task }) => task.activity === "waiting-on-you");
  }
  return displayLinks(item).some(link => link.kind === "change_request" && link.state?.category === "in_review");
}

export function compactTaskRowModel(item: WorkItem, bots: Bot[], selected: boolean) {
  const workers = sharedWorkThreads(item, bots);
  const owner = bots.find(bot => bot.id === item.coordinatorBotId);
  const people = [owner, ...workers.map(worker => worker.bot)].filter((bot): bot is Bot => Boolean(bot))
    .filter((bot, index, list) => list.findIndex(candidate => candidate.id === bot.id) === index);
  const counts = progressCounts(item);
  const changeRequest = firstChangeRequest(item);
  return {
    id: item.id,
    groupId: item.groupId,
    key: workItemKey(item),
    status: item.status,
    avatars: people.map(bot => bot.id),
    changeRequest: changeRequest ? { id: changeRequest.id, label: changeRequest.externalId ?? changeRequest.title } : undefined,
    criteria: { done: counts.criteriaDone, total: counts.criteriaTotal },
    liveStep: selected ? nowFrom(item)?.summary : undefined,
    expanded: selected,
  };
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
  return !needle || [
    item.title, item.objective, workItemKey(item) ?? "",
    ...displayLinks(item).flatMap(link => [link.title, link.externalId ?? ""]),
    ...sharedWorkThreads(item, bots).flatMap(({ bot, task, assignment }) => [bot.name, task.title, assignment?.message ?? ""]),
  ].some(text => text.toLowerCase().includes(needle));
}

export function workerThreadWorkItem(
  bot: { threadId: string; tasks?: Array<{ threadId: string; workItemId?: string }> },
  groups: Array<{ tasks?: Array<{ workItem?: WorkItem }> }>,
): WorkItem | undefined {
  const workItemId = bot.tasks?.find(task => task.threadId === bot.threadId)?.workItemId;
  if (!workItemId) return undefined;
  const item = groups.flatMap(group => group.tasks ?? []).find(task => task.workItem?.id === workItemId)?.workItem;
  return item && item.threadId !== bot.threadId ? item : undefined;
}
