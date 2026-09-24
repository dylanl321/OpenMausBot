import type { WorkAssignment, WorkItem } from "../../../shared/work-item";
import {
  LINK_KINDS,
  criteriaFromTexts,
  type LinkKind,
  type LinkedItem,
  type StatusCategory,
  type TaskEvent,
  type WorkCriterion,
} from "../../../shared/work-links";
import type { SourceChangeType } from "../../../shared/watches";

export interface SettingField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  enum?: string[];
  help?: string;
}

export interface TaskConnectionListing {
  id: string;
  connectorId: string;
  label: string;
  settings: Record<string, string | number | boolean>;
  sections: string[];
  enabled: boolean;
  secretKeys?: string[];
}

export interface TaskConnectorSecret {
  key: string;
  label: string;
  help?: string;
}

export interface TaskConnectorManifest {
  id: string;
  name: string;
  icon?: string;
  kinds?: LinkKind[];
  settings?: SettingField[];
  secrets?: TaskConnectorSecret[];
  watch?: { scopes: SettingField[]; events: SourceChangeType[] };
}

export const EVENT_FILTERS = ["all", "output", "state_change", "comment", "decision", "handoff", "criterion", "lifecycle"] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

export interface ProgressSegment {
  id: string;
  source: "criterion" | "assignment";
  label: string;
  tone: "done" | "active" | "blocked" | "pending";
}

export function taskCriteria(item: WorkItem): WorkCriterion[] {
  return item.criteria?.length ? item.criteria : criteriaFromTexts(item.acceptanceCriteria);
}

export function currentAssignments(item: WorkItem): WorkAssignment[] {
  return item.assignments.filter(assignment => assignment.revision === item.revision);
}

export function displayLinks(item: WorkItem): LinkedItem[] {
  if (item.links?.length) return item.links;
  return item.artifacts.map(artifact => ({
    id: `artifact:${artifact.ref}`,
    kind: "link" as const,
    role: "reference" as const,
    title: artifact.label,
    url: artifact.ref,
    provenance: "claimed" as const,
    updatedAt: item.updatedAt,
    ...(artifact.revision ? { details: { revision: artifact.revision } } : {}),
  }));
}

export function outputGroups(links: LinkedItem[]): Array<{ kind: LinkKind; items: LinkedItem[] }> {
  const outputs = links.filter(link => link.role === "output");
  return LINK_KINDS.flatMap(kind => {
    const items = outputs.filter(link => link.kind === kind);
    return items.length ? [{ kind, items }] : [];
  });
}

function criterionTone(state: WorkCriterion["state"]): ProgressSegment["tone"] {
  if (state === "checked") return "done";
  if (state === "blocked") return "blocked";
  if (state === "in_progress") return "active";
  return "pending";
}

function assignmentTone(status: WorkAssignment["status"]): ProgressSegment["tone"] {
  if (status === "completed") return "done";
  if (status === "failed" || status === "cancelled") return "blocked";
  if (status === "queued" || status === "running" || status === "waiting") return "active";
  return "pending";
}

export function progressSegments(item: WorkItem): ProgressSegment[] {
  return [
    ...taskCriteria(item).map(criterion => ({
      id: criterion.id, source: "criterion" as const, label: criterion.text, tone: criterionTone(criterion.state),
    })),
    ...currentAssignments(item).map(assignment => ({
      id: assignment.id, source: "assignment" as const, label: assignment.message, tone: assignmentTone(assignment.status),
    })),
  ];
}

export function progressCounts(item: WorkItem) {
  const criteria = taskCriteria(item);
  const assignments = currentAssignments(item);
  return {
    criteriaDone: criteria.filter(criterion => criterion.state === "checked").length,
    criteriaTotal: criteria.length,
    assignmentsDone: assignments.filter(assignment => assignment.status === "completed").length,
    assignmentsTotal: assignments.length,
    assignmentsWorking: assignments.filter(assignment => ["queued", "running", "waiting"].includes(assignment.status)).length,
  };
}

export function connectorFor(item: Pick<LinkedItem, "connectorId">, connectors: readonly TaskConnectorManifest[]) {
  return item.connectorId ? connectors.find(connector => connector.id === item.connectorId) : undefined;
}

export function mergeTaskEvent(events: readonly TaskEvent[], incoming: TaskEvent): TaskEvent[] {
  const index = events.findIndex(event => event.id === incoming.id);
  if (index < 0) return [...events, incoming].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  const next = events.slice();
  next[index] = incoming;
  return next;
}

export function nowFrom(item: WorkItem, events: readonly TaskEvent[] = []) {
  const assignments = currentAssignments(item);
  const stepped = assignments.find(assignment => assignment.currentStep && ["queued", "running", "waiting"].includes(assignment.status));
  if (stepped?.currentStep) {
    return { summary: stepped.currentStep.summary, since: stepped.currentStep.since, itemId: stepped.currentStep.itemId, botId: stepped.botId, threadId: stepped.threadId };
  }
  const running = [...events].reverse().find(event => event.kind === "tool" && event.state === "running");
  if (running && running.actor.type === "bot") {
    return { summary: running.summary, since: running.at, itemId: running.itemId, botId: running.actor.botId, threadId: running.actor.threadId };
  }
  const working = assignments.find(assignment => ["queued", "running", "waiting"].includes(assignment.status));
  if (working) return { summary: working.message, since: item.updatedAt, botId: working.botId, threadId: working.threadId };
  return null;
}

export function visibleEvents(events: readonly TaskEvent[], filter: EventFilter, showTools: boolean): TaskEvent[] {
  return events
    .filter(event => event.kind === "tool" ? showTools && filter === "all" : filter === "all" || event.kind === filter)
    .sort((left, right) => right.at - left.at || right.id.localeCompare(left.id));
}

export function statusCategoryClass(category: StatusCategory | undefined): string {
  if (category === "in_progress") return "text-accent";
  if (category === "in_review") return "text-warning";
  if (category === "blocked") return "text-danger";
  if (category === "done") return "text-success";
  if (category === "cancelled") return "text-ink-secondary line-through";
  return "text-ink-secondary";
}

let connectorsPromise: Promise<TaskConnectorManifest[]> | undefined;

export function loadTaskConnectors(request: (path: string) => Promise<{ connectors?: TaskConnectorManifest[] }> = path =>
  fetch(path).then(async response => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `${response.status}`);
    return body;
  }),
): Promise<TaskConnectorManifest[]> {
  connectorsPromise ??= request("/api/task-connectors").then(body => body.connectors ?? []).catch(() => []);
  return connectorsPromise;
}

export function resetTaskConnectorsCache() {
  connectorsPromise = undefined;
}
