/** Watch wire shapes and the declarative filter language.
 *
 * Detection is code: a source reports `SourceChange`s, a filter decides
 * whether they matter, and only then does an action run. Anything needing
 * judgement belongs in a `run_routine` action, not the filter.
 */
import type { StatusCategory, SyncedItem } from "./work-links.ts";
import type { RoutineSchedule } from "./routines.ts";

export const SOURCE_CHANGE_TYPES = [
  "item.created", "item.updated", "item.state_changed", "item.assigned",
  "item.labeled", "comment.added",
  "change_request.opened", "change_request.updated", "change_request.merged", "change_request.closed",
  "review.requested", "review.submitted",
  "commit.pushed", "build.failed", "build.succeeded", "branch.created",
] as const;
export type SourceChangeType = (typeof SOURCE_CHANGE_TYPES)[number];

export type WatchScope = Record<string, string | number | boolean | undefined>;

export interface SourceChange {
  id: string;
  type: SourceChangeType;
  connectionId: string;
  item: SyncedItem;
  before?: { state?: StatusCategory; stateLabel?: string; assignee?: string; labels?: string[] };
  actor?: { name: string; isBot: boolean };
  fields: Record<string, string | number | boolean | string[]>;
  at: number;
}

export type WatchFilter =
  | { all: WatchFilter[] }
  | { any: WatchFilter[] }
  | { not: WatchFilter }
  | { field: string; eq: string | number | boolean }
  | { field: string; in: Array<string | number | boolean> }
  | { field: string; contains: string }
  | { field: string; changedFrom?: string | number | boolean; changedTo?: string | number | boolean };

export type WatchSource =
  | { type: "git"; remote: string; cwd?: string }
  | { type: "webhook"; webhookId: string; fieldMap?: Record<string, string> }
  | { type: "connection"; connectionId: string; scope?: WatchScope };

export type WatchAction =
  | { type: "record" }
  | { type: "notify"; botId?: string; threadId?: string }
  | { type: "run_routine"; routineId: string }
  | { type: "task_update" }
  | { type: "ensure_task"; topic?: string; coordinatorBotId?: string; criteriaFrom?: "item" };

export interface WatchBatch {
  windowSeconds: number;
  max: number;
}

export interface WatchLimits {
  maxActionsPerDay?: number;
  quietHours?: string;
}

export interface WatchStats {
  lastCheckAt?: number;
  lastMatchAt?: number;
  checks: number;
  /** Raw source changes observed, before filters. */
  changesSeen: number;
  matches: number;
  actions: number;
  runsAvoided: number;
  lastError?: string;
}

export interface WatchDryRunResult {
  matches: SourceChange[];
  skipped: number;
  seen: number;
  matchCount: number;
  used?: "changes" | "query" | "webhook" | "git";
  error?: string;
}

export interface WatchDryRunOptions {
  payload?: unknown;
  eventName?: string;
  sinceDays?: number;
  backfill?: boolean;
}

export interface Watch {
  id: string;
  name: string;
  source: WatchSource;
  events: SourceChangeType[];
  filter?: WatchFilter;
  check: RoutineSchedule;
  batch?: WatchBatch;
  action: WatchAction;
  limits?: WatchLimits;
  startFrom: "now" | "backfill";
  enabled: boolean;
  section?: string;
  nextCheckAt: number | null;
  createdAt: number;
  updatedAt: number;
  stats: WatchStats;
}

export interface WatchInput {
  name: string;
  source: WatchSource;
  events?: SourceChangeType[];
  filter?: WatchFilter | null;
  check: RoutineSchedule;
  batch?: WatchBatch | null;
  action: WatchAction;
  limits?: WatchLimits | null;
  startFrom?: "now" | "backfill";
  enabled?: boolean;
  section?: string | null;
}

const SCALAR = new Set(["string", "number", "boolean"]);

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function equal(left: unknown, right: unknown): boolean {
  if (Array.isArray(left)) return left.some(item => equal(item, right));
  if (typeof left === "boolean" || typeof right === "boolean") return left === right;
  return String(left) === String(right);
}

/** Read a dotted path on a change: `type`, `actor.isBot`, `state.category`, or `fields.*`. */
export function changeField(change: SourceChange, field: string): unknown {
  const path = field.trim();
  if (!path) return undefined;
  if (path === "type") return change.type;
  if (path === "id") return change.id;
  if (path === "connectionId") return change.connectionId;
  if (path === "actor.isBot") return change.actor?.isBot ?? false;
  if (path === "actor.name") return change.actor?.name;
  if (path === "state.category") return change.item.state?.category;
  if (path === "state.label") return change.item.state?.label;
  if (path === "item.title") return change.item.title;
  if (path === "item.kind") return change.item.kind;
  if (path === "item.externalId") return change.item.externalId;
  if (path === "before.state") return change.before?.state;
  if (path === "before.stateLabel") return change.before?.stateLabel;
  if (path === "before.assignee") return change.before?.assignee;
  if (path === "before.labels") return change.before?.labels;
  if (path.startsWith("fields.")) return change.fields[path.slice("fields.".length)];
  if (path in change.fields) return change.fields[path];
  return undefined;
}

function beforeField(change: SourceChange, field: string): unknown {
  if (field === "state.category" || field === "before.state") return change.before?.state;
  if (field === "state.label" || field === "before.stateLabel") return change.before?.stateLabel;
  if (field === "assignee" || field === "fields.assignee") return change.before?.assignee;
  if (field === "labels" || field === "fields.labels") return change.before?.labels;
  return undefined;
}

function afterField(change: SourceChange, field: string): unknown {
  if (field === "state.category") return change.item.state?.category;
  if (field === "state.label") return change.item.state?.label;
  if (field === "assignee" || field === "fields.assignee") return change.fields.assignee;
  if (field === "labels" || field === "fields.labels") return change.fields.labels ?? change.before?.labels;
  return changeField(change, field);
}

export function matchWatchFilter(change: SourceChange, filter?: WatchFilter): boolean {
  if (!filter) return true;
  if ("all" in filter) return filter.all.every(part => matchWatchFilter(change, part));
  if ("any" in filter) return filter.any.some(part => matchWatchFilter(change, part));
  if ("not" in filter) return !matchWatchFilter(change, filter.not);
  if ("eq" in filter) return equal(changeField(change, filter.field), filter.eq);
  if ("in" in filter) return filter.in.some(value => equal(changeField(change, filter.field), value));
  if ("contains" in filter) {
    const value = changeField(change, filter.field);
    const needle = filter.contains.toLowerCase();
    return asList(value).some(item => String(item).toLowerCase().includes(needle));
  }
  if ("changedFrom" in filter || "changedTo" in filter) {
    const before = beforeField(change, filter.field);
    const after = afterField(change, filter.field);
    if (filter.changedFrom !== undefined && !equal(before, filter.changedFrom)) return false;
    if (filter.changedTo !== undefined && !equal(after, filter.changedTo)) return false;
    return filter.changedFrom !== undefined || filter.changedTo !== undefined;
  }
  return false;
}

/** True when the filter tree names `actor.isBot`, so the default bot skip stays off. */
export function filterMentionsBotActor(filter?: WatchFilter): boolean {
  if (!filter) return false;
  if ("all" in filter) return filter.all.some(filterMentionsBotActor);
  if ("any" in filter) return filter.any.some(filterMentionsBotActor);
  if ("not" in filter) return filterMentionsBotActor(filter.not);
  return "field" in filter && filter.field === "actor.isBot";
}

export function ignoreOwnBotWrite(change: SourceChange, filter?: WatchFilter): boolean {
  return change.actor?.isBot === true && !filterMentionsBotActor(filter);
}

export function isSourceChangeType(value: unknown): value is SourceChangeType {
  return typeof value === "string" && (SOURCE_CHANGE_TYPES as readonly string[]).includes(value);
}

/** Conservative JSONPath: `$.foo.bar`, `$.foo[0].bar`, or `foo.bar`. */
export function readJsonPath(payload: unknown, path: string): unknown {
  const cleaned = path.trim().replace(/^\$\.?/, "");
  if (!cleaned) return payload;
  const parts: Array<string | number> = [];
  for (const raw of cleaned.split(".")) {
    const indexed = /^([^[]*)\[(\d+)\]$/.exec(raw);
    if (indexed) {
      if (indexed[1]) parts.push(indexed[1]);
      parts.push(Number(indexed[2]));
      continue;
    }
    if (raw) parts.push(raw);
  }
  let current: unknown = payload;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = Array.isArray(current) && typeof part === "number"
      ? current[part]
      : (current as Record<string, unknown>)[String(part)];
  }
  return current;
}

function scalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return undefined;
}

function isChangeType(value: unknown): value is SourceChangeType {
  return isSourceChangeType(value);
}

/** Map a webhook payload onto a `SourceChange` using optional JSONPath field keys. */
export function mapWebhookChange(input: {
  webhookId: string;
  deliveryId: string;
  eventName?: string;
  payload: unknown;
  fieldMap?: Record<string, string>;
  at: number;
}): SourceChange {
  const read = (key: string, fallback?: unknown) => {
    const path = input.fieldMap?.[key];
    return path ? readJsonPath(input.payload, path) : fallback;
  };
  const mappedType = read("type", input.eventName);
  const type = isChangeType(mappedType) ? mappedType : "item.updated";
  const id = String(scalar(read("id")) ?? input.deliveryId);
  const title = String(scalar(read("title")) ?? scalar(read("item.title")) ?? input.eventName ?? "Webhook event");
  const externalId = scalar(read("externalId") ?? read("item.externalId"));
  const url = scalar(read("url") ?? read("item.url"));
  const kindRaw = scalar(read("kind") ?? read("item.kind"));
  const kind = kindRaw === "work_item" || kindRaw === "change_request" || kindRaw === "commit"
    || kindRaw === "build" || kindRaw === "comment" || kindRaw === "document" || kindRaw === "link"
    ? kindRaw : "link";
  const actorName = scalar(read("actor.name"));
  const actorBot = read("actor.isBot");
  const fields: SourceChange["fields"] = {};
  for (const [key, path] of Object.entries(input.fieldMap ?? {})) {
    if (!key.startsWith("fields.")) continue;
    const value = readJsonPath(input.payload, path);
    const name = key.slice("fields.".length);
    if (Array.isArray(value) && value.every(item => typeof item === "string")) fields[name] = value;
    else {
      const flat = scalar(value);
      if (flat !== undefined) fields[name] = flat;
    }
  }
  if (!Object.keys(fields).length && input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    for (const [key, value] of Object.entries(input.payload as Record<string, unknown>)) {
      if (!SCALAR.has(typeof value)) continue;
      fields[key] = value as string | number | boolean;
    }
  }
  return {
    id,
    type,
    connectionId: `webhook:${input.webhookId}`,
    item: {
      kind,
      title: title.slice(0, 300) || "Webhook event",
      updatedAt: input.at,
      ...(typeof externalId === "string" && externalId ? { externalId: externalId.slice(0, 240) } : {}),
      ...(typeof url === "string" && url ? { url: url.slice(0, 2000) } : {}),
    },
    ...(typeof actorName === "string" || actorBot !== undefined
      ? { actor: { name: typeof actorName === "string" ? actorName : "webhook", isBot: actorBot === true } }
      : {}),
    fields,
    at: input.at,
  };
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseQuietHours(value: string): { start: number; end: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return {
    start: Number(match[1]) * 60 + Number(match[2]),
    end: Number(match[3]) * 60 + Number(match[4]),
  };
}

export function inQuietHours(hours: string, at: number): boolean {
  const window = parseQuietHours(hours);
  if (!window) return false;
  const date = new Date(at);
  const minute = date.getHours() * 60 + date.getMinutes();
  if (window.start === window.end) return false;
  if (window.start < window.end) return minute >= window.start && minute < window.end;
  return minute >= window.start || minute < window.end;
}

export function actionDayKey(at: number): string {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function summarizeChanges(changes: readonly SourceChange[]): string {
  return changes.map(change => {
    const id = change.item.externalId ?? change.id;
    return `${change.type} ${change.item.title}${id ? ` (${id})` : ""}`;
  }).join("\n");
}

export function renderWatchPrompt(template: string, changes: readonly SourceChange[]): string {
  const summary = summarizeChanges(changes);
  if (template.includes("{{changes}}")) return template.replaceAll("{{changes}}", summary);
  return summary ? `${template}\n\n${summary}` : template;
}

export function isClockTime(value: string): boolean {
  return CLOCK.test(value);
}
