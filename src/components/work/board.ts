import type { WorkItem, WorkItemStatus } from "../../../shared/work-item";
import { STATUS_CATEGORIES, sourceIdentity, type StatusCategory, type SyncedItem } from "../../../shared/work-links";
import { displayLinks } from "./model";

export const BOARD_COLUMNS: StatusCategory[] = ["todo", "in_progress", "in_review", "blocked", "done"];

const STATUS_CATEGORY: Record<WorkItemStatus, StatusCategory> = {
  active: "in_progress",
  blocked: "blocked",
  "needs-input": "blocked",
  completed: "done",
  cancelled: "cancelled",
};

export function taskBoardCategory(item: WorkItem): StatusCategory {
  if (item.status === "completed" || item.status === "cancelled" || item.status === "blocked" || item.status === "needs-input") {
    return STATUS_CATEGORY[item.status];
  }
  const links = displayLinks(item);
  const review = links.find(link => link.kind === "change_request" && link.state?.category === "in_review");
  if (review?.state?.category) return review.state.category;
  const source = links.find(link => link.role === "source" && link.state?.category);
  if (source?.state?.category) return source.state.category;
  const any = links.find(link => link.state?.category && link.state.category !== "unknown");
  if (any?.state?.category) return any.state.category;
  return STATUS_CATEGORY[item.status] ?? "unknown";
}

export function syncedBoardCategory(item: SyncedItem): StatusCategory {
  return item.state?.category ?? "todo";
}

export function tracksSyncedItem(item: WorkItem, synced: SyncedItem): boolean {
  return displayLinks(item).some(link =>
    Boolean(synced.externalId) && link.externalId === synced.externalId && link.kind === synced.kind
      && (!synced.connectionId || !link.connectionId || link.connectionId === synced.connectionId)
      && (!synced.connectorId || !link.connectorId || link.connectorId === synced.connectorId));
}

export function untrackedItems(tasks: readonly WorkItem[], queried: readonly SyncedItem[]): SyncedItem[] {
  return queried.filter(item => !tasks.some(task => tracksSyncedItem(task, item)));
}

export function nextUntrackedWork(items: readonly SyncedItem[]): SyncedItem | undefined {
  const rank = (category: StatusCategory | undefined) => {
    const index = BOARD_COLUMNS.indexOf(category ?? "todo");
    return index >= 0 ? index : BOARD_COLUMNS.length;
  };
  return items
    .filter(item => item.state?.category !== "done" && item.state?.category !== "cancelled")
    .slice()
    .sort((left, right) => rank(left.state?.category) - rank(right.state?.category) || left.title.localeCompare(right.title))[0];
}

export function ensureFromSynced(item: SyncedItem, group: { id: string; name: string }): {
  groupId: string;
  topic: string;
  identity: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
} | undefined {
  const identity = sourceIdentity(item);
  if (!identity) return undefined;
  return {
    groupId: group.id,
    topic: group.name,
    identity,
    title: item.title.slice(0, 80),
    objective: item.title,
    acceptanceCriteria: ["Deliver the requested outcome"],
  };
}

export function visibleBoardColumns(categories: readonly StatusCategory[]): StatusCategory[] {
  const extra = STATUS_CATEGORIES.filter(category => !BOARD_COLUMNS.includes(category) && categories.includes(category));
  return [...BOARD_COLUMNS, ...extra];
}
