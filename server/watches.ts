/** Watch engine: durable cursors, dedupe, filters, batching, and built-in sources.
 *
 * Checks ride the routine scheduler clock. Detection is code; actions run
 * only after a matching change is committed with its cursor and receipt.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { encodeChangeCursor } from "./connectors/change-cursor.ts";
import { nextOccurrence, normalizeRoutineSchedule } from "./routines.ts";
import type { RoutineRunOn, RoutineSchedule, RoutineScheduleInput } from "./routines.ts";
import { diffGitHeads, parseLsRemote, type GitHeads } from "./watch-git.ts";
import {
  actionDayKey,
  ignoreOwnBotWrite,
  inQuietHours,
  isSourceChangeType,
  mapWebhookChange,
  matchWatchFilter,
  parseQuietHours,
  renderWatchPrompt,
  type SourceChange,
  type SourceChangeType,
  type Watch,
  type WatchAction,
  type WatchBatch,
  type WatchDryRunOptions,
  type WatchDryRunResult,
  type WatchFilter,
  type WatchInput,
  type WatchLimits,
  type WatchSource,
  type WatchStats,
} from "../shared/watches.ts";
import type { WatchScope } from "../shared/watches.ts";
import type { SyncedItem } from "../shared/work-links.ts";

const execFileAsync = promisify(execFile);
const MAX_WATCHES = 500;
const MAX_RECEIPTS = 20_000;
const RECEIPT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_PENDING = 200;
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_DRY_RUN_MATCHES = 50;
const GIT_EVENTS: SourceChangeType[] = ["commit.pushed", "branch.created"];

export type { WatchDryRunOptions, WatchDryRunResult };

export interface PortableWatch {
  name: string;
  source: WatchSource;
  events: SourceChangeType[];
  filter?: WatchFilter;
  check: RoutineSchedule;
  batch?: WatchBatch;
  action: WatchAction | { type: "run_routine"; routineName: string };
  limits?: WatchLimits;
  startFrom: "now" | "backfill";
  enabled: boolean;
  section?: string;
}

export interface WatchManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: Record<string, unknown>) => void;
  execGit?: (args: string[], cwd?: string) => Promise<string>;
  routine?: (id: string) => { id: string; name: string; prompt: string; botId: string; runOn: RoutineRunOn } | null;
  enqueueRoutine?: (input: {
    watchId: string;
    watchName: string;
    routineId: string;
    routineName: string;
    prompt: string;
    botId: string;
    runOn: RoutineRunOn;
    deliveryId: string;
    receivedAt: number;
  }) => { id: string };
  notify?: (watch: Watch, changes: SourceChange[], action: Extract<WatchAction, { type: "notify" }>) => void;
  record?: (watch: Watch, changes: SourceChange[]) => void;
  taskUpdate?: (watch: Watch, changes: SourceChange[]) => void;
  matched?: (watch: Watch, changes: SourceChange[]) => void;
  ensureTask?: (
    watch: Watch,
    changes: SourceChange[],
    action: Extract<WatchAction, { type: "ensure_task" }>,
  ) => void | Promise<void>;
  raiseAttention?: (watch: Watch, reason: string) => void;
  webhookExists?: (webhookId: string) => boolean;
  connectionChanges?: (
    connectionId: string,
    scope: WatchScope,
    cursor: string | null,
  ) => Promise<{ changes: SourceChange[]; cursor: string }>;
  connectionQuery?: (connectionId: string, query: string) => Promise<SyncedItem[]>;
}

type GitCursor = { kind: "git"; heads: GitHeads; baselined: boolean };
type ConnectionCursor = { kind: "connection"; value: string | null; baselined: boolean };
type StoredCursor = GitCursor | ConnectionCursor | { kind: "webhook" };
type Receipt = { watchId: string; changeId: string; acceptedAt: number };
type PendingBatch = { since: number; changes: SourceChange[] };
type ActionDay = { day: string; count: number; noticed?: boolean };

interface WatchFile {
  version: 1;
  watches: Watch[];
  cursors?: Record<string, StoredCursor>;
  receipts?: Receipt[];
  consumers?: Record<string, number>;
  matchSeq?: Record<string, number>;
  pending?: Record<string, PendingBatch>;
  actionDays?: Record<string, ActionDay>;
}

const emptyStats = (): WatchStats => ({ checks: 0, changesSeen: 0, matches: 0, actions: 0, runsAvoided: 0 });

function syncedItemToChange(connectionId: string, item: SyncedItem): SourceChange {
  const fields: SourceChange["fields"] = { ...item.details };
  if (item.state?.category) fields.state = item.state.category;
  if (item.state?.label) fields.stateLabel = item.state.label;
  return {
    id: `${item.externalId ?? item.title}@${item.updatedAt}`,
    type: "item.updated",
    connectionId,
    item,
    fields,
    at: item.updatedAt,
  };
}

async function defaultExecGit(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 2_000_000,
    encoding: "utf8",
  });
  return stdout;
}

function cloneSource(source: WatchSource): WatchSource {
  if (source.type === "git") return { type: "git", remote: source.remote, ...(source.cwd ? { cwd: source.cwd } : {}) };
  if (source.type === "webhook") {
    return { type: "webhook", webhookId: source.webhookId, ...(source.fieldMap ? { fieldMap: { ...source.fieldMap } } : {}) };
  }
  return { type: "connection", connectionId: source.connectionId, ...(source.scope ? { scope: { ...source.scope } } : {}) };
}

function cloneAction(action: WatchAction): WatchAction {
  if (action.type === "notify") {
    return { type: "notify", ...(action.botId ? { botId: action.botId } : {}), ...(action.threadId ? { threadId: action.threadId } : {}) };
  }
  if (action.type === "run_routine") return { type: "run_routine", routineId: action.routineId };
  if (action.type === "ensure_task") {
    return {
      type: "ensure_task",
      ...(action.topic ? { topic: action.topic } : {}),
      ...(action.coordinatorBotId ? { coordinatorBotId: action.coordinatorBotId } : {}),
      ...(action.criteriaFrom ? { criteriaFrom: action.criteriaFrom } : {}),
    };
  }
  return { type: action.type };
}

function cloneFilter(filter: WatchFilter): WatchFilter {
  if ("all" in filter) return { all: filter.all.map(cloneFilter) };
  if ("any" in filter) return { any: filter.any.map(cloneFilter) };
  if ("not" in filter) return { not: cloneFilter(filter.not) };
  if ("eq" in filter) return { field: filter.field, eq: filter.eq };
  if ("in" in filter) return { field: filter.field, in: [...filter.in] };
  if ("contains" in filter) return { field: filter.field, contains: filter.contains };
  return { field: filter.field, ...(filter.changedFrom !== undefined ? { changedFrom: filter.changedFrom } : {}), ...(filter.changedTo !== undefined ? { changedTo: filter.changedTo } : {}) };
}

function cloneWatch(watch: Watch): Watch {
  return {
    ...watch,
    source: cloneSource(watch.source),
    events: [...watch.events],
    ...(watch.filter ? { filter: cloneFilter(watch.filter) } : {}),
    check: { ...watch.check } as RoutineSchedule,
    ...(watch.batch ? { batch: { ...watch.batch } } : {}),
    action: cloneAction(watch.action),
    ...(watch.limits ? { limits: { ...watch.limits } } : {}),
    stats: { ...watch.stats },
  };
}

function cleanName(value: unknown): string {
  const name = String(value ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Give the watch a name");
  return name;
}

function cleanRemote(value: unknown): string {
  if (typeof value !== "string") throw new Error("Choose a git remote");
  const remote = value.trim();
  if (!remote) throw new Error("Choose a git remote");
  if (remote.length > 2_000) throw new Error("Git remote is too long");
  if (remote.startsWith("-")) throw new Error("Git remote cannot start with a dash");
  return remote;
}

function cleanCwd(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Choose a valid working directory");
  const cwd = value.trim();
  if (!cwd) return undefined;
  if (cwd.length > 4_096) throw new Error("Working directory is too long");
  return cwd;
}

function cleanId(value: unknown, label: string, max = 80): string {
  if (typeof value !== "string") throw new Error(`Choose a valid ${label}`);
  const id = value.trim();
  if (!id) throw new Error(`Choose a valid ${label}`);
  if (id.length > max) throw new Error(`${label} is too long`);
  return id;
}

function cleanEvents(value: unknown, source: WatchSource): SourceChangeType[] {
  if (value == null) return source.type === "git" ? [...GIT_EVENTS] : [];
  if (!Array.isArray(value)) throw new Error("Choose valid watch events");
  if (value.length > 20) throw new Error("Too many watch events");
  const events: SourceChangeType[] = [];
  for (const item of value) {
    if (!isSourceChangeType(item)) throw new Error("Choose a supported watch event");
    if (!events.includes(item)) events.push(item);
  }
  return events;
}

function cleanScalar(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("Filter values must be text, a number, or yes/no");
}

function cleanFilter(value: unknown, depth = 0): WatchFilter | undefined {
  if (value == null) return undefined;
  if (depth > 8) throw new Error("Filter is too nested");
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a valid filter");
  const obj = value as Record<string, unknown>;
  if ("all" in obj) {
    if (!Array.isArray(obj.all) || obj.all.length < 1 || obj.all.length > 20) throw new Error("Choose a valid all-filter");
    return { all: obj.all.map((part) => cleanFilter(part, depth + 1)!) };
  }
  if ("any" in obj) {
    if (!Array.isArray(obj.any) || obj.any.length < 1 || obj.any.length > 20) throw new Error("Choose a valid any-filter");
    return { any: obj.any.map((part) => cleanFilter(part, depth + 1)!) };
  }
  if ("not" in obj) return { not: cleanFilter(obj.not, depth + 1)! };
  if (typeof obj.field !== "string" || !obj.field.trim()) throw new Error("Choose a filter field");
  const field = obj.field.trim().slice(0, 80);
  if ("eq" in obj) return { field, eq: cleanScalar(obj.eq) };
  if ("in" in obj) {
    if (!Array.isArray(obj.in) || obj.in.length < 1 || obj.in.length > 40) throw new Error("Choose a valid in-filter");
    return { field, in: obj.in.map(cleanScalar) };
  }
  if ("contains" in obj) {
    if (typeof obj.contains !== "string" || !obj.contains) throw new Error("Choose text to match");
    return { field, contains: obj.contains.slice(0, 200) };
  }
  if ("changedFrom" in obj || "changedTo" in obj) {
    return {
      field,
      ...(obj.changedFrom !== undefined ? { changedFrom: cleanScalar(obj.changedFrom) } : {}),
      ...(obj.changedTo !== undefined ? { changedTo: cleanScalar(obj.changedTo) } : {}),
    };
  }
  throw new Error("Choose a supported filter");
}

function cleanScope(value: unknown): WatchScope | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a valid watch scope");
  const scope: WatchScope = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || key.length > 40) throw new Error("Scope field names are too long");
    if (item === undefined) continue;
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error("Scope values must be text, a number, or yes/no");
    }
    scope[key.trim()] = item;
  }
  return Object.keys(scope).length ? scope : undefined;
}

function cleanSource(value: unknown): WatchSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a watch source");
  const source = value as Record<string, unknown>;
  if (source.type === "git") {
    return { type: "git", remote: cleanRemote(source.remote), ...(cleanCwd(source.cwd) ? { cwd: cleanCwd(source.cwd) } : {}) };
  }
  if (source.type === "webhook") {
    const fieldMap = source.fieldMap && typeof source.fieldMap === "object" && !Array.isArray(source.fieldMap)
      ? Object.fromEntries(Object.entries(source.fieldMap as Record<string, unknown>).flatMap(([key, path]) => (
        typeof key === "string" && typeof path === "string" && key.trim() && path.trim()
          ? [[key.trim().slice(0, 80), path.trim().slice(0, 200)]] : []
      )))
      : undefined;
    return { type: "webhook", webhookId: cleanId(source.webhookId, "webhook id", 200), ...(fieldMap && Object.keys(fieldMap).length ? { fieldMap } : {}) };
  }
  if (source.type === "connection") {
    return {
      type: "connection",
      connectionId: cleanId(source.connectionId, "connection id", 64),
      ...(cleanScope(source.scope) ? { scope: cleanScope(source.scope) } : {}),
    };
  }
  throw new Error("Choose a git, webhook, or connection source");
}

function cleanAction(value: unknown): WatchAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a watch action");
  const action = value as Record<string, unknown>;
  if (action.type === "record" || action.type === "task_update") return { type: action.type };
  if (action.type === "notify") {
    return {
      type: "notify",
      ...(action.botId != null && action.botId !== "" ? { botId: cleanId(action.botId, "bot id") } : {}),
      ...(action.threadId != null && action.threadId !== "" ? { threadId: cleanId(action.threadId, "thread id") } : {}),
    };
  }
  if (action.type === "run_routine") return { type: "run_routine", routineId: cleanId(action.routineId, "routine id") };
  if (action.type === "ensure_task") {
    const topic = typeof action.topic === "string" ? action.topic.trim().slice(0, 100) : "";
    return {
      type: "ensure_task",
      ...(topic ? { topic } : {}),
      ...(action.coordinatorBotId != null && action.coordinatorBotId !== ""
        ? { coordinatorBotId: cleanId(action.coordinatorBotId, "coordinator bot id") } : {}),
      ...(action.criteriaFrom === "item" ? { criteriaFrom: "item" as const } : {}),
    };
  }
  throw new Error("Choose a supported watch action");
}

function cleanBatch(value: unknown): WatchBatch | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose a valid batch window");
  const batch = value as Record<string, unknown>;
  const windowSeconds = Number(batch.windowSeconds);
  const max = Number(batch.max);
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 3_600) {
    throw new Error("Batch window must be a whole number of seconds from 1 to 3600");
  }
  if (!Number.isInteger(max) || max < 1 || max > 100) {
    throw new Error("Batch size must be a whole number from 1 to 100");
  }
  return { windowSeconds, max };
}

function cleanLimits(value: unknown): WatchLimits | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Choose valid watch limits");
  const limits = value as Record<string, unknown>;
  const cleaned: WatchLimits = {};
  if (limits.maxActionsPerDay != null) {
    const max = Number(limits.maxActionsPerDay);
    if (!Number.isInteger(max) || max < 1 || max > 1_000) throw new Error("Daily action limit must be a whole number from 1 to 1000");
    cleaned.maxActionsPerDay = max;
  }
  if (limits.quietHours != null && limits.quietHours !== "") {
    if (typeof limits.quietHours !== "string" || !parseQuietHours(limits.quietHours)) {
      throw new Error("Quiet hours must look like 22:00-07:00");
    }
    cleaned.quietHours = limits.quietHours.trim();
  }
  return cleaned.maxActionsPerDay || cleaned.quietHours ? cleaned : undefined;
}

function cleanStartFrom(value: unknown): "now" | "backfill" {
  if (value == null || value === "now") return "now";
  if (value === "backfill") return "backfill";
  throw new Error("Choose now or backfill");
}

function cleanSection(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Choose a valid section");
  const section = value.trim().slice(0, 80);
  return section || undefined;
}

function loadStats(value: unknown): WatchStats {
  const stats = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const number = (key: string) => {
    const raw = stats[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 0;
  };
  const optional = (key: string) => {
    const raw = stats[key];
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= MAX_DATE_MS ? raw : undefined;
  };
  return {
    checks: number("checks"),
    changesSeen: number("changesSeen"),
    matches: number("matches"),
    actions: number("actions"),
    runsAvoided: number("runsAvoided"),
    ...(optional("lastCheckAt") !== undefined ? { lastCheckAt: optional("lastCheckAt") } : {}),
    ...(optional("lastMatchAt") !== undefined ? { lastMatchAt: optional("lastMatchAt") } : {}),
    ...(typeof stats.lastError === "string" && stats.lastError ? { lastError: stats.lastError.slice(0, 500) } : {}),
  };
}

function consumerKey(watchId: string, consumerId: string): string {
  return `${watchId}:${consumerId}`;
}

export class WatchManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: WatchManagerOptions;
  private watches: Watch[] = [];
  private cursors = new Map<string, StoredCursor>();
  private receipts: Receipt[] = [];
  private consumers = new Map<string, number>();
  private matchSeq = new Map<string, number>();
  private pending = new Map<string, PendingBatch>();
  private actionDays = new Map<string, ActionDay>();

  constructor(options: WatchManagerOptions = {}) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "watches.json");
    this.now = options.now ?? Date.now;
    try {
      const disk = JSON.parse(readFileSync(this.file, "utf8")) as Partial<WatchFile>;
      this.watches = Array.isArray(disk.watches)
        ? disk.watches.flatMap((row) => {
            try {
              return [this.loadWatch(row)];
            } catch {
              return [];
            }
          })
        : [];
      if (disk.cursors && typeof disk.cursors === "object") {
        for (const [id, cursor] of Object.entries(disk.cursors)) {
          if (cursor && typeof cursor === "object") this.cursors.set(id, cursor as StoredCursor);
        }
      }
      this.receipts = Array.isArray(disk.receipts)
        ? disk.receipts.filter((receipt): receipt is Receipt =>
            Boolean(receipt && typeof receipt.watchId === "string" && typeof receipt.changeId === "string"
              && typeof receipt.acceptedAt === "number" && Number.isFinite(receipt.acceptedAt)))
        : [];
      if (disk.consumers && typeof disk.consumers === "object") {
        for (const [key, value] of Object.entries(disk.consumers)) {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) this.consumers.set(key, value);
        }
      }
      if (disk.matchSeq && typeof disk.matchSeq === "object") {
        for (const [key, value] of Object.entries(disk.matchSeq)) {
          if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) this.matchSeq.set(key, value);
        }
      }
      if (disk.pending && typeof disk.pending === "object") {
        for (const [id, batch] of Object.entries(disk.pending)) {
          if (batch && Array.isArray(batch.changes) && typeof batch.since === "number") {
            this.pending.set(id, { since: batch.since, changes: batch.changes });
          }
        }
      }
      if (disk.actionDays && typeof disk.actionDays === "object") {
        for (const [id, day] of Object.entries(disk.actionDays)) {
          if (day && typeof day.day === "string" && typeof day.count === "number") this.actionDays.set(id, day);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.watches = [];
      }
    }
  }

  list(): Watch[] {
    return this.watches.map(cloneWatch);
  }

  get(id: string): Watch | null {
    const watch = this.watches.find((candidate) => candidate.id === id);
    return watch ? cloneWatch(watch) : null;
  }

  nextDueAt(): number | undefined {
    const now = this.now();
    const due = this.watches
      .filter((watch) => watch.enabled && watch.nextCheckAt != null)
      .map((watch) => watch.nextCheckAt!)
      .filter((at) => at <= now + 60 * 60_000)
      .sort((a, b) => a - b)[0];
    return due;
  }

  create(input: WatchInput): Watch {
    if (this.watches.length >= MAX_WATCHES) throw new Error("Watch limit reached");
    const at = this.now();
    const clean = this.sanitize(input, at);
    if (clean.source.type === "webhook" && this.options.webhookExists && !this.options.webhookExists(clean.source.webhookId)) {
      throw new Error("Choose an existing webhook");
    }
    if (clean.action.type === "run_routine" && this.options.routine && !this.options.routine(clean.action.routineId)) {
      throw new Error("Choose an existing routine");
    }
    const watch: Watch = {
      id: randomUUID(),
      ...clean,
      nextCheckAt: clean.enabled ? nextOccurrence(clean.check, at) : null,
      createdAt: at,
      updatedAt: at,
      stats: emptyStats(),
    };
    this.watches.unshift(watch);
    try { this.save(); }
    catch (error) {
      this.watches.shift();
      throw error;
    }
    this.emit(watch);
    return cloneWatch(watch);
  }

  update(id: string, patch: Partial<WatchInput>): Watch | null {
    const watch = this.watches.find((candidate) => candidate.id === id);
    if (!watch) return null;
    const at = this.now();
    const clean = this.sanitize({
      name: patch.name ?? watch.name,
      source: patch.source ?? watch.source,
      events: patch.events ?? watch.events,
      filter: Object.hasOwn(patch, "filter") ? patch.filter : watch.filter,
      check: patch.check ?? watch.check,
      batch: Object.hasOwn(patch, "batch") ? patch.batch : watch.batch,
      action: patch.action ?? watch.action,
      limits: Object.hasOwn(patch, "limits") ? patch.limits : watch.limits,
      startFrom: patch.startFrom ?? watch.startFrom,
      enabled: patch.enabled ?? watch.enabled,
      section: Object.hasOwn(patch, "section") ? patch.section : watch.section,
    }, at);
    if (clean.source.type === "webhook" && this.options.webhookExists && !this.options.webhookExists(clean.source.webhookId)) {
      throw new Error("Choose an existing webhook");
    }
    if (clean.action.type === "run_routine" && this.options.routine && !this.options.routine(clean.action.routineId)) {
      throw new Error("Choose an existing routine");
    }
    const scheduleChanged = JSON.stringify(clean.check) !== JSON.stringify(watch.check);
    const enabledChanged = clean.enabled !== watch.enabled;
    const sourceChanged = JSON.stringify(clean.source) !== JSON.stringify(watch.source);
    Object.assign(watch, clean, {
      nextCheckAt: !clean.enabled ? null : scheduleChanged || enabledChanged
        ? nextOccurrence(clean.check, at)
        : watch.nextCheckAt,
      updatedAt: Math.max(at, watch.updatedAt + 1),
    });
    if (!clean.filter) delete watch.filter;
    if (!clean.batch) delete watch.batch;
    if (!clean.limits) delete watch.limits;
    if (!clean.section) delete watch.section;
    if (sourceChanged) {
      this.cursors.delete(watch.id);
      this.pending.delete(watch.id);
    }
    this.save();
    this.emit(watch);
    return cloneWatch(watch);
  }

  remove(id: string): boolean {
    const at = this.watches.findIndex((watch) => watch.id === id);
    if (at === -1) return false;
    this.watches.splice(at, 1);
    this.cursors.delete(id);
    this.pending.delete(id);
    this.matchSeq.delete(id);
    this.actionDays.delete(id);
    this.receipts = this.receipts.filter((receipt) => receipt.watchId !== id);
    for (const key of this.consumers.keys()) {
      if (key.startsWith(`${id}:`)) this.consumers.delete(key);
    }
    this.save();
    this.options.emit?.({ kind: "watch.deleted", watchId: id });
    return true;
  }

  hasUnconsumedMatches(watchId: string, consumerId: string): boolean {
    if (!this.watches.some((watch) => watch.id === watchId)) return false;
    const seq = this.matchSeq.get(watchId) ?? 0;
    return seq > (this.consumers.get(consumerKey(watchId, consumerId)) ?? 0);
  }

  consumeMatches(watchId: string, consumerId: string): void {
    this.consumers.set(consumerKey(watchId, consumerId), this.matchSeq.get(watchId) ?? 0);
    this.save();
  }

  recordUnchanged(watchId: string): void {
    const watch = this.watches.find((candidate) => candidate.id === watchId);
    if (!watch) return;
    watch.stats.runsAvoided += 1;
    this.save();
    this.emit(watch);
  }

  async checkDue(now = this.now()): Promise<void> {
    for (const watch of this.watches) {
      if (!watch.enabled || watch.nextCheckAt == null || watch.nextCheckAt > now) continue;
      await this.checkWatch(watch, now);
    }
  }

  async check(id: string): Promise<Watch | null> {
    const watch = this.watches.find((candidate) => candidate.id === id);
    if (!watch || !watch.enabled) return watch ? cloneWatch(watch) : null;
    await this.checkWatch(watch, this.now());
    return cloneWatch(watch);
  }

  async dryRun(id: string, input: WatchDryRunOptions = {}): Promise<WatchDryRunResult | null> {
    const watch = this.watches.find((candidate) => candidate.id === id);
    if (!watch) return null;
    return this.preview(watch, input);
  }

  async dryRunInput(input: WatchInput, options: WatchDryRunOptions = {}): Promise<WatchDryRunResult> {
    const at = this.now();
    const clean = this.sanitize(input, at);
    return this.preview({
      id: "dry-run",
      ...clean,
      nextCheckAt: null,
      createdAt: at,
      updatedAt: at,
      stats: emptyStats(),
    }, options);
  }

  async ingestWebhook(input: {
    webhookId: string;
    deliveryId: string;
    eventName?: string;
    payload: unknown;
    at?: number;
  }): Promise<void> {
    const at = input.at ?? this.now();
    for (const watch of this.watches) {
      if (!watch.enabled || watch.source.type !== "webhook" || watch.source.webhookId !== input.webhookId) continue;
      const change = mapWebhookChange({
        webhookId: input.webhookId,
        deliveryId: input.deliveryId,
        eventName: input.eventName,
        payload: input.payload,
        fieldMap: watch.source.fieldMap,
        at,
      });
      await this.acceptChanges(watch, [change], at);
    }
  }

  /** Ingest connector-normalized changes (poll or webhook) for connection watches. */
  async ingestConnectionChanges(connectionId: string, changes: SourceChange[], at?: number): Promise<void> {
    const when = at ?? this.now();
    for (const watch of this.watches) {
      if (!watch.enabled || watch.source.type !== "connection" || watch.source.connectionId !== connectionId) continue;
      await this.acceptChanges(watch, changes.map((change) => ({
        ...change,
        connectionId: change.connectionId || connectionId,
      })), when);
    }
  }

  exportForBackup(routineName: (id: string) => string | undefined): PortableWatch[] {
    return this.watches.map((watch) => {
      const action = watch.action.type === "run_routine"
        ? { type: "run_routine" as const, routineName: routineName(watch.action.routineId) ?? watch.action.routineId }
        : cloneAction(watch.action);
      return {
        name: watch.name,
        source: cloneSource(watch.source),
        events: [...watch.events],
        ...(watch.filter ? { filter: cloneFilter(watch.filter) } : {}),
        check: watch.check,
        ...(watch.batch ? { batch: { ...watch.batch } } : {}),
        action,
        ...(watch.limits ? { limits: { ...watch.limits } } : {}),
        startFrom: "now",
        enabled: watch.enabled,
        ...(watch.section ? { section: watch.section } : {}),
      };
    });
  }

  importPortable(rows: PortableWatch[], routineId: (name: string) => string | undefined): Watch[] {
    const created: Watch[] = [];
    for (const row of rows) {
      const action = row.action.type === "run_routine" && "routineName" in row.action
        ? { type: "run_routine" as const, routineId: routineId(row.action.routineName) ?? row.action.routineName }
        : row.action;
      created.push(this.create({
        name: row.name,
        source: row.source,
        events: row.events,
        filter: row.filter,
        check: row.check,
        batch: row.batch,
        action: action as WatchAction,
        limits: row.limits,
        startFrom: "now",
        enabled: row.enabled,
        section: row.section,
      }));
    }
    return created;
  }

  private sanitize(input: WatchInput, after: number): Omit<Watch, "id" | "createdAt" | "updatedAt" | "nextCheckAt" | "stats"> {
    const source = cleanSource(input.source);
    const filter = cleanFilter(input.filter);
    const batch = cleanBatch(input.batch);
    const limits = cleanLimits(input.limits);
    const section = cleanSection(input.section);
    return {
      name: cleanName(input.name),
      source,
      events: cleanEvents(input.events, source),
      ...(filter ? { filter } : {}),
      check: normalizeRoutineSchedule(input.check as RoutineScheduleInput, after),
      ...(batch ? { batch } : {}),
      action: cleanAction(input.action),
      ...(limits ? { limits } : {}),
      startFrom: cleanStartFrom(input.startFrom),
      enabled: input.enabled !== false,
      ...(section ? { section } : {}),
    };
  }

  private loadWatch(row: Watch): Watch {
    const clean = this.sanitize({
      name: row.name,
      source: row.source,
      events: row.events,
      filter: row.filter,
      check: row.check,
      batch: row.batch,
      action: row.action,
      limits: row.limits,
      startFrom: row.startFrom,
      enabled: row.enabled,
      section: row.section,
    }, this.now());
    return {
      id: typeof row.id === "string" && row.id ? row.id : randomUUID(),
      ...clean,
      nextCheckAt: clean.enabled
        ? (typeof row.nextCheckAt === "number" && Number.isFinite(row.nextCheckAt) ? row.nextCheckAt : nextOccurrence(clean.check, this.now()))
        : null,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : this.now(),
      updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : this.now(),
      stats: loadStats(row.stats),
    };
  }

  private async checkWatch(watch: Watch, now: number): Promise<void> {
    try {
      if (watch.source.type === "webhook") {
        watch.stats.checks += 1;
        watch.stats.lastCheckAt = now;
        watch.stats.runsAvoided += 1;
        delete watch.stats.lastError;
        this.scheduleNext(watch, now);
        this.save();
        this.emit(watch);
        return;
      }
      const polled = await this.poll(watch, now, false);
      if (polled === null) return;
      await this.acceptChanges(watch, polled.changes, now, polled.cursor);
    } catch (error) {
      watch.stats.checks += 1;
      watch.stats.lastCheckAt = now;
      watch.stats.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.scheduleNext(watch, now);
      this.save();
      this.emit(watch);
    }
  }

  /** `null` means the source was baselined without emitting (startFrom now). */
  private async poll(watch: Watch, now: number, preview: boolean): Promise<{ changes: SourceChange[]; cursor: StoredCursor } | null> {
    if (watch.source.type === "git") {
      const stdout = await (this.options.execGit ?? defaultExecGit)(
        ["ls-remote", "--heads", "--", watch.source.remote],
        watch.source.cwd,
      );
      const heads = parseLsRemote(stdout);
      const cursor: GitCursor = { kind: "git", heads, baselined: true };
      const previous = this.cursors.get(watch.id);
      const baselined = previous?.kind === "git" && previous.baselined;
      const priorHeads = previous?.kind === "git" ? previous.heads : {};
      if (!baselined && watch.startFrom === "now" && !preview) {
        this.cursors.set(watch.id, cursor);
        watch.stats.checks += 1;
        watch.stats.lastCheckAt = now;
        watch.stats.runsAvoided += 1;
        delete watch.stats.lastError;
        this.scheduleNext(watch, now);
        this.save();
        this.emit(watch);
        return null;
      }
      const changes = !baselined && watch.startFrom === "backfill"
        ? diffGitHeads({}, heads, now, `git:${watch.id}`)
        : diffGitHeads(priorHeads, heads, now, `git:${watch.id}`);
      return { changes, cursor };
    }
    if (watch.source.type === "connection") {
      if (!this.options.connectionChanges) throw new Error("This connection has no change feed");
      const previous = this.cursors.get(watch.id);
      const value = previous?.kind === "connection" ? previous.value : null;
      const baselined = previous?.kind === "connection" && previous.baselined;
      const result = await this.options.connectionChanges(watch.source.connectionId, watch.source.scope ?? {}, value);
      const cursor: ConnectionCursor = { kind: "connection", value: result.cursor, baselined: true };
      if (!baselined && watch.startFrom === "now" && !preview) {
        this.cursors.set(watch.id, cursor);
        watch.stats.checks += 1;
        watch.stats.lastCheckAt = now;
        watch.stats.runsAvoided += 1;
        delete watch.stats.lastError;
        this.scheduleNext(watch, now);
        this.save();
        this.emit(watch);
        return null;
      }
      const connectionId = watch.source.connectionId;
      return {
        changes: result.changes.map((change) => ({ ...change, connectionId: change.connectionId || connectionId })),
        cursor,
      };
    }
    return { changes: [], cursor: { kind: "webhook" } };
  }

  private filterChanges(watch: Watch, raw: SourceChange[], ignoreReceipts = false): SourceChange[] {
    const events = watch.events.length ? new Set(watch.events) : null;
    return raw.filter((change) => {
      if (events && !events.has(change.type)) return false;
      if (ignoreOwnBotWrite(change, watch.filter)) return false;
      if (!matchWatchFilter(change, watch.filter)) return false;
      if (!ignoreReceipts && this.hasReceipt(watch.id, change.id)) return false;
      return true;
    });
  }

  private async preview(watch: Watch, input: WatchDryRunOptions): Promise<WatchDryRunResult> {
    try {
      const { raw, used } = await this.previewChanges(watch, input);
      const filtered = this.filterChanges(watch, raw, true);
      return {
        matches: filtered.slice(0, MAX_DRY_RUN_MATCHES),
        skipped: raw.length - filtered.length,
        seen: raw.length,
        matchCount: filtered.length,
        used,
      };
    } catch (error) {
      return {
        matches: [],
        skipped: 0,
        seen: 0,
        matchCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async previewChanges(
    watch: Watch,
    input: WatchDryRunOptions,
  ): Promise<{ raw: SourceChange[]; used: NonNullable<WatchDryRunResult["used"]> }> {
    if (watch.source.type === "webhook") {
      if (input.payload == null && !input.eventName) {
        throw new Error("Paste a sample event to test this webhook watch.");
      }
      return {
        raw: [mapWebhookChange({
          webhookId: watch.source.webhookId,
          deliveryId: "dry-run",
          eventName: input.eventName,
          payload: input.payload ?? {},
          fieldMap: watch.source.fieldMap,
          at: this.now(),
        })],
        used: "webhook",
      };
    }
    if (watch.source.type === "git") {
      const stdout = await (this.options.execGit ?? defaultExecGit)(
        ["ls-remote", "--heads", "--", watch.source.remote],
        watch.source.cwd,
      );
      return {
        raw: diffGitHeads({}, parseLsRemote(stdout), this.now(), `git:${watch.id}`),
        used: "git",
      };
    }
    const sinceDays = input.sinceDays ?? 7;
    const since = input.backfill ? 0 : this.now() - sinceDays * 86_400_000;
    const connectionId = watch.source.connectionId;
    if (this.options.connectionChanges) {
      try {
        const cursor = input.backfill ? null : encodeChangeCursor(since, new Map());
        const result = await this.options.connectionChanges(connectionId, watch.source.scope ?? {}, cursor);
        return {
          raw: result.changes.map((change) => ({
            ...change,
            connectionId: change.connectionId || connectionId,
          })),
          used: "changes",
        };
      } catch (error) {
        if (!this.options.connectionQuery) throw error;
      }
    }
    if (this.options.connectionQuery) {
      return { raw: await this.queryAsChanges(watch, since), used: "query" };
    }
    throw new Error("This connection has no change feed");
  }

  private async queryAsChanges(watch: Watch, since: number): Promise<SourceChange[]> {
    if (watch.source.type !== "connection" || !this.options.connectionQuery) return [];
    const source = watch.source;
    const query = typeof source.scope?.query === "string" ? source.scope.query : "";
    const items = await this.options.connectionQuery(source.connectionId, query);
    return items
      .filter((item) => !since || item.updatedAt >= since)
      .map((item) => syncedItemToChange(source.connectionId, item));
  }

  private async acceptChanges(watch: Watch, raw: SourceChange[], now: number, cursor?: StoredCursor): Promise<void> {
    if (cursor) this.cursors.set(watch.id, cursor);
    const incoming = this.filterChanges(watch, raw);
    watch.stats.checks += 1;
    watch.stats.changesSeen += raw.length;
    watch.stats.lastCheckAt = now;
    if (!incoming.length) {
      if (this.pending.get(watch.id)?.changes.length) await this.flushPending(watch, now);
      else {
        watch.stats.runsAvoided += 1;
        delete watch.stats.lastError;
      }
      this.scheduleNext(watch, now);
      this.save();
      this.emit(watch);
      return;
    }
    const pending = this.pending.get(watch.id) ?? { since: now, changes: [] };
    for (const change of incoming) {
      pending.changes.push(change);
      this.addReceipt(watch.id, change.id, now);
    }
    if (pending.changes.length > MAX_PENDING) pending.changes.splice(0, pending.changes.length - MAX_PENDING);
    this.pending.set(watch.id, pending);
    watch.stats.matches += incoming.length;
    watch.stats.lastMatchAt = now;
    this.matchSeq.set(watch.id, (this.matchSeq.get(watch.id) ?? 0) + 1);
    await this.flushPending(watch, now);
    this.scheduleNext(watch, now);
    this.save();
    this.emit(watch);
    try { this.options.matched?.(watch, incoming); }
    catch (error) { console.error("watch match notification:", error); }
  }

  private async flushPending(watch: Watch, now: number): Promise<void> {
    const pending = this.pending.get(watch.id);
    if (!pending?.changes.length) return;
    const batch = watch.batch;
    const ready = !batch
      || pending.changes.length >= batch.max
      || now - pending.since >= batch.windowSeconds * 1_000;
    if (!ready) return;
    const cap = batch?.max ?? pending.changes.length;
    const batchChanges = pending.changes.slice(0, cap);
    const leftover = pending.changes.slice(cap);
    const quiet = Boolean(watch.limits?.quietHours && inQuietHours(watch.limits.quietHours, now));
    const over = this.overBudget(watch, now);
    if (quiet || over) {
      if (leftover.length) this.pending.set(watch.id, { since: now, changes: leftover });
      else this.pending.delete(watch.id);
      const reason = quiet
        ? "Quiet hours — watch recorded changes without acting"
        : "Daily action budget reached — watch recorded changes without acting";
      const day = this.actionDays.get(watch.id);
      if (!day?.noticed) {
        this.options.raiseAttention?.(watch, reason);
        this.actionDays.set(watch.id, { day: actionDayKey(now), count: day?.count ?? 0, noticed: true });
      }
      return;
    }
    try {
      await this.act(watch, batchChanges, now);
      watch.stats.actions += 1;
      this.countAction(watch, now);
      if (leftover.length) this.pending.set(watch.id, { since: now, changes: leftover });
      else this.pending.delete(watch.id);
      delete watch.stats.lastError;
    } catch (error) {
      watch.stats.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
  }

  private async act(watch: Watch, changes: SourceChange[], now: number): Promise<void> {
    const action = watch.action;
    if (action.type === "record") {
      this.options.record?.(watch, changes);
      return;
    }
    if (action.type === "notify") {
      this.options.notify?.(watch, changes, action);
      return;
    }
    if (action.type === "task_update") {
      this.options.taskUpdate?.(watch, changes);
      return;
    }
    if (action.type === "ensure_task") {
      if (!this.options.ensureTask) throw new Error("Creating tasks from watches is unavailable");
      await this.options.ensureTask(watch, changes, action);
      return;
    }
    const routine = this.options.routine?.(action.routineId);
    if (!routine) throw new Error("The assigned routine no longer exists");
    if (!this.options.enqueueRoutine) throw new Error("Watch routine runs are unavailable");
    this.options.enqueueRoutine({
      watchId: watch.id,
      watchName: watch.name,
      routineId: routine.id,
      routineName: routine.name,
      prompt: renderWatchPrompt(routine.prompt, changes),
      botId: routine.botId,
      runOn: routine.runOn,
      deliveryId: `w:${watch.id}:${changes.map((change) => change.id).join(",")}`.slice(0, 200),
      receivedAt: now,
    });
  }

  private scheduleNext(watch: Watch, now: number): void {
    if (!watch.enabled) {
      watch.nextCheckAt = null;
      return;
    }
    watch.nextCheckAt = watch.check.type === "once" ? null : nextOccurrence(watch.check, now);
    if (watch.check.type === "once" || watch.nextCheckAt == null) {
      watch.enabled = false;
      watch.nextCheckAt = null;
      watch.updatedAt = Math.max(now, watch.updatedAt + 1);
    }
  }

  private hasReceipt(watchId: string, changeId: string): boolean {
    const floor = this.now() - RECEIPT_WINDOW_MS;
    return this.receipts.some((receipt) =>
      receipt.watchId === watchId && receipt.changeId === changeId && receipt.acceptedAt >= floor);
  }

  private addReceipt(watchId: string, changeId: string, at: number): void {
    if (this.hasReceipt(watchId, changeId)) return;
    this.receipts.push({ watchId, changeId, acceptedAt: at });
  }

  private overBudget(watch: Watch, now: number): boolean {
    const max = watch.limits?.maxActionsPerDay;
    if (!max) return false;
    const day = actionDayKey(now);
    const current = this.actionDays.get(watch.id);
    return current?.day === day && current.count >= max;
  }

  private countAction(watch: Watch, now: number): void {
    const day = actionDayKey(now);
    const current = this.actionDays.get(watch.id);
    if (!current || current.day !== day) this.actionDays.set(watch.id, { day, count: 1 });
    else current.count += 1;
  }

  private emit(watch: Watch): void {
    this.options.emit?.({ kind: "watch", watch: cloneWatch(watch) });
  }

  private save(): void {
    const floor = this.now() - RECEIPT_WINDOW_MS;
    this.receipts = this.receipts.filter((receipt) => receipt.acceptedAt >= floor);
    if (this.receipts.length > MAX_RECEIPTS) this.receipts.splice(0, this.receipts.length - MAX_RECEIPTS);
    mkdirSync(dirname(this.file), { recursive: true });
    const file: WatchFile = {
      version: 1,
      watches: this.watches,
      cursors: Object.fromEntries(this.cursors),
      receipts: this.receipts,
      consumers: Object.fromEntries(this.consumers),
      matchSeq: Object.fromEntries(this.matchSeq),
      pending: Object.fromEntries(this.pending),
      actionDays: Object.fromEntries(this.actionDays),
    };
    writeFileAtomic(this.file, JSON.stringify(file, null, 2), { mode: 0o600 });
  }
}
