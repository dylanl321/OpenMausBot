import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import type { Routine, RoutineSchedule } from "@/lib/routines";
import type {
  SourceChangeType,
  Watch,
  WatchAction,
  WatchFilter,
  WatchSource,
} from "@/lib/watches";
import { SOURCE_CHANGE_TYPES } from "@/lib/watches";
import type { SettingField, TaskConnectionListing, TaskConnectorManifest } from "../work/model";

export type WatchSourceKind = "connection" | "git" | "webhook";

export interface WatchDraft {
  name?: string;
  source?: WatchSource;
  events?: SourceChangeType[];
  filter?: WatchFilter;
  check?: RoutineSchedule;
  action?: WatchAction;
  startFrom?: "now" | "backfill";
  fromRoutineId?: string;
}

export interface FilterRow {
  id: string;
  not?: boolean;
  field: string;
  op: "eq" | "in" | "contains" | "changed";
  value: string;
  changedFrom: string;
  changedTo: string;
}

const POLL_VERBS = /\b(check|look for|poll|watch for|scan|see if|any new|new issues?|new stories|new tickets|failed (build|pipeline)|bot-ready)\b/i;
const INTERVAL_HINT = /every\s+\d+\s*(m|min|mins|minutes?|h|hr|hours?)\b/i;

export const FILTER_FIELDS = [
  "type",
  "actor.isBot",
  "actor.name",
  "state.category",
  "state.label",
  "item.title",
  "item.kind",
  "item.externalId",
  "fields.project",
  "fields.labels",
  "fields.priority",
  "fields.branch",
  "fields.author",
  "fields.assignee",
] as const;

const EVENT_KEYS: Record<SourceChangeType, LocaleKey> = {
  "item.created": "watches.event.itemCreated",
  "item.updated": "watches.event.itemUpdated",
  "item.state_changed": "watches.event.itemStateChanged",
  "item.assigned": "watches.event.itemAssigned",
  "item.labeled": "watches.event.itemLabeled",
  "comment.added": "watches.event.commentAdded",
  "change_request.opened": "watches.event.changeOpened",
  "change_request.updated": "watches.event.changeUpdated",
  "change_request.merged": "watches.event.changeMerged",
  "change_request.closed": "watches.event.changeClosed",
  "review.requested": "watches.event.reviewRequested",
  "review.submitted": "watches.event.reviewSubmitted",
  "commit.pushed": "watches.event.commitPushed",
  "build.failed": "watches.event.buildFailed",
  "build.succeeded": "watches.event.buildSucceeded",
  "branch.created": "watches.event.branchCreated",
};

const ACTION_KEYS: Record<WatchAction["type"], { label: LocaleKey; help: LocaleKey }> = {
  record: { label: "watches.action.record", help: "watches.action.recordHelp" },
  notify: { label: "watches.action.notify", help: "watches.action.notifyHelp" },
  task_update: { label: "watches.action.taskUpdate", help: "watches.action.taskUpdateHelp" },
  ensure_task: { label: "watches.action.ensureTask", help: "watches.action.ensureTaskHelp" },
  run_routine: { label: "watches.action.runRoutine", help: "watches.action.runRoutineHelp" },
};

export const GIT_WATCH_MANIFEST: TaskConnectorManifest = {
  id: "git",
  name: "Git",
  watch: {
    scopes: [
      { key: "remote", label: "Remote", type: "string", help: "A git URL or path. The watch polls `git ls-remote --heads`." },
      { key: "cwd", label: "Working directory", type: "string", help: "Optional local folder used to run git." },
    ],
    events: ["commit.pushed", "branch.created"],
  },
};

export const WEBHOOK_WATCH_MANIFEST: TaskConnectorManifest = {
  id: "webhook",
  name: "Webhook",
  watch: {
    scopes: [],
    events: [...SOURCE_CHANGE_TYPES],
  },
};

export function gitWatchFields(): SettingField[] {
  return [
    { key: "remote", label: t("watches.git.remote"), type: "string", help: t("watches.git.remoteHelp") },
    { key: "cwd", label: t("watches.git.cwd"), type: "string", help: t("watches.git.cwdHelp") },
  ];
}

export function eventLabel(type: SourceChangeType): string {
  return t(EVENT_KEYS[type]);
}

export function actionLabel(type: WatchAction["type"]): string {
  return t(ACTION_KEYS[type].label);
}

export function actionHelp(type: WatchAction["type"]): string {
  return t(ACTION_KEYS[type].help);
}

const FIELD_KEYS: Record<string, LocaleKey> = {
  type: "watches.field.type",
  "actor.isBot": "watches.field.actorIsBot",
  "actor.name": "watches.field.actorName",
  "state.category": "watches.field.stateCategory",
  "state.label": "watches.field.stateLabel",
  "item.title": "watches.field.itemTitle",
  "item.kind": "watches.field.itemKind",
  "item.externalId": "watches.field.itemExternalId",
  "fields.project": "watches.field.project",
  "fields.labels": "watches.field.labels",
  "fields.priority": "watches.field.priority",
  "fields.branch": "watches.field.branch",
  "fields.author": "watches.field.author",
  "fields.assignee": "watches.field.assignee",
};

export function fieldLabel(field: string): string {
  const key = FIELD_KEYS[field];
  return key ? t(key) : field;
}

export function sourceKindOf(source?: WatchSource): WatchSourceKind | null {
  return source?.type ?? null;
}

export function connectorForSource(
  source: WatchSource | undefined,
  connections: readonly TaskConnectionListing[],
  connectors: readonly TaskConnectorManifest[],
): TaskConnectorManifest | undefined {
  if (!source) return undefined;
  if (source.type === "git") return GIT_WATCH_MANIFEST;
  if (source.type === "webhook") return WEBHOOK_WATCH_MANIFEST;
  const connection = connections.find((item) => item.id === source.connectionId);
  return connection ? connectors.find((item) => item.id === connection.connectorId) : undefined;
}

export function connectionForSource(
  source: WatchSource | undefined,
  connections: readonly TaskConnectionListing[],
): TaskConnectionListing | undefined {
  if (source?.type !== "connection") return undefined;
  return connections.find((item) => item.id === source.connectionId);
}

export function watchManifest(
  source: WatchSource | undefined,
  connections: readonly TaskConnectionListing[],
  connectors: readonly TaskConnectorManifest[],
): TaskConnectorManifest | undefined {
  return connectorForSource(source, connections, connectors);
}

export function defaultEventsFor(manifest?: TaskConnectorManifest): SourceChangeType[] {
  return [...(manifest?.watch?.events ?? [])];
}

export function pollingRoutineHint(routine: Pick<Routine, "prompt" | "schedule" | "onlyIfChanged">): boolean {
  if (routine.onlyIfChanged) return false;
  const prompt = routine.prompt.trim();
  if (!prompt) return false;
  const mentionsPoll = POLL_VERBS.test(prompt) || INTERVAL_HINT.test(prompt);
  const repeating = routine.schedule.type === "interval" || routine.schedule.type === "daily" || routine.schedule.type === "cron";
  return mentionsPoll && repeating;
}

export function suggestedWatchEvents(prompt: string): SourceChangeType[] {
  const text = prompt.toLowerCase();
  if (/pipeline|build/.test(text)) return ["build.failed", "build.succeeded"];
  if (/merge request|pull request|\bmr\b|\bpr\b/.test(text)) {
    return ["change_request.opened", "change_request.updated", "change_request.merged"];
  }
  if (/commit|push|branch/.test(text)) return ["commit.pushed", "branch.created"];
  if (/comment/.test(text)) return ["comment.added"];
  if (/label/.test(text)) return ["item.labeled", "item.created"];
  if (/assign/.test(text)) return ["item.assigned"];
  if (/status|state|ready|done/.test(text)) return ["item.state_changed", "item.created"];
  return ["item.created", "item.updated"];
}

export function draftFromRoutine(routine: Routine): WatchDraft {
  return {
    name: routine.name,
    events: suggestedWatchEvents(routine.prompt),
    check: routine.schedule.type === "interval"
      ? routine.schedule
      : { type: "interval", everyMinutes: 15, anchorAt: Date.now() },
    action: { type: "run_routine", routineId: routine.id },
    fromRoutineId: routine.id,
  };
}

export function relativeTime(at?: number, now = Date.now()): string {
  if (!at) return t("watches.never");
  const elapsed = Math.max(0, now - at);
  if (elapsed < 60_000) return t("watches.justNow");
  if (elapsed < 60 * 60_000) return t("watches.minutesAgo", { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 24 * 60 * 60_000) return t("watches.hoursAgo", { count: Math.floor(elapsed / 3_600_000) });
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

function newRowId(): string {
  return `f_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyFilterRow(): FilterRow {
  return { id: newRowId(), field: "state.category", op: "eq", value: "", changedFrom: "", changedTo: "" };
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && Number.isFinite(Number(trimmed)) && /^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function scalarText(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  return String(value);
}

function isFieldPredicate(filter: WatchFilter): filter is Extract<WatchFilter, { field: string }> {
  return "field" in filter;
}

function rowFromPredicate(filter: WatchFilter, not = false): FilterRow | null {
  if (!isFieldPredicate(filter)) return null;
  if ("eq" in filter) return { ...emptyFilterRow(), not, field: filter.field, op: "eq", value: scalarText(filter.eq) };
  if ("in" in filter) return { ...emptyFilterRow(), not, field: filter.field, op: "in", value: filter.in.map(String).join(", ") };
  if ("contains" in filter) return { ...emptyFilterRow(), not, field: filter.field, op: "contains", value: filter.contains };
  return {
    ...emptyFilterRow(),
    not,
    field: filter.field,
    op: "changed",
    changedFrom: scalarText(filter.changedFrom),
    changedTo: scalarText(filter.changedTo),
  };
}

export function flattenFilter(filter?: WatchFilter): { mode: "all" | "any"; rows: FilterRow[] } | "complex" | null {
  if (!filter) return null;
  if (isFieldPredicate(filter)) {
    const row = rowFromPredicate(filter);
    return row ? { mode: "all", rows: [row] } : "complex";
  }
  if ("not" in filter) {
    if (!isFieldPredicate(filter.not)) return "complex";
    const row = rowFromPredicate(filter.not, true);
    return row ? { mode: "all", rows: [row] } : "complex";
  }
  const parts = "all" in filter ? filter.all : "any" in filter ? filter.any : null;
  if (!parts) return "complex";
  const mode = "all" in filter ? "all" as const : "any" as const;
  const rows: FilterRow[] = [];
  for (const part of parts) {
    if (isFieldPredicate(part)) {
      const row = rowFromPredicate(part);
      if (!row) return "complex";
      rows.push(row);
      continue;
    }
    if ("not" in part && isFieldPredicate(part.not)) {
      const row = rowFromPredicate(part.not, true);
      if (!row) return "complex";
      rows.push(row);
      continue;
    }
    return "complex";
  }
  return { mode, rows };
}

export function buildFilter(mode: "all" | "any", rows: FilterRow[]): WatchFilter | undefined {
  const predicates = rows.flatMap((row): WatchFilter[] => {
    const field = row.field.trim();
    if (!field) return [];
    let predicate: WatchFilter;
    if (row.op === "in") {
      const values = row.value.split(",").map((item) => parseScalar(item)).filter((item) => item !== "");
      if (!values.length) return [];
      predicate = { field, in: values };
    } else if (row.op === "contains") {
      if (!row.value.trim()) return [];
      predicate = { field, contains: row.value.trim() };
    } else if (row.op === "changed") {
      if (!row.changedFrom && !row.changedTo) return [];
      predicate = {
        field,
        ...(row.changedFrom ? { changedFrom: parseScalar(row.changedFrom) } : {}),
        ...(row.changedTo ? { changedTo: parseScalar(row.changedTo) } : {}),
      };
    } else {
      if (row.value === "") return [];
      predicate = { field, eq: parseScalar(row.value) };
    }
    return [row.not ? { not: predicate } : predicate];
  });
  if (!predicates.length) return undefined;
  if (predicates.length === 1) return predicates[0];
  return mode === "any" ? { any: predicates } : { all: predicates };
}

export function watchSourceSummary(
  watch: Watch,
  connections: readonly TaskConnectionListing[],
  connectors: readonly TaskConnectorManifest[],
  webhooks: readonly { id: string; name: string }[] = [],
): { name: string; icon?: string; detail: string } {
  if (watch.source.type === "git") {
    return { name: t("watches.source.git"), detail: watch.source.remote };
  }
  if (watch.source.type === "webhook") {
    const hook = webhooks.find((item) => item.id === watch.source.webhookId);
    return { name: t("watches.source.webhook"), detail: hook?.name || watch.source.webhookId };
  }
  const connection = connectionForSource(watch.source, connections);
  const connector = connectorForSource(watch.source, connections, connectors);
  return {
    name: connector?.name ?? t("watches.source.connection"),
    icon: connector?.icon,
    detail: connection?.label ?? watch.source.connectionId,
  };
}

export function defaultInterval(everyMinutes = 5): RoutineSchedule {
  return { type: "interval", everyMinutes, anchorAt: Date.now() };
}
