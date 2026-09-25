import { createHmac, timingSafeEqual } from "node:crypto";
import type { LinkKind, StatusCategory, SyncedItem } from "../../../shared/work-links.ts";
import type { SourceChange } from "../../../shared/watches.ts";
import {
  beforeFromSnapshot,
  connectionActor,
  encodeChangeCursor,
  parseChangeCursor,
  rememberSnapshot,
  type SeenSnapshot,
} from "../change-cursor.ts";
import type { CaptureCall, CaptureRule, ConnectionContext, Connector, WatchScope } from "../types.ts";

const ISSUE_KEY = /\b([A-Z][A-Z0-9_]+-\d+)\b/i;
const COMMENT_REF = /^([A-Z][A-Z0-9_]+-\d+):(\d+)$/i;
const COMMENT_ID = /comment(?:\s*id)?[:\s#]+(\d+)|\bid[:\s#]+(\d+)/i;
const PREVIEW_CUT = "[… preview shortened]";
const ISSUE_FIELDS = ["summary", "status", "assignee", "issuetype", "priority", "updated", "project", "labels", "created", "description", "issuelinks"] as const;
const CHANGE_FIELDS = [...ISSUE_FIELDS, "description", "comment"] as const;
const COMMENT_FIELDS = [...ISSUE_FIELDS, "comment"] as const;
const FETCH_BATCH = 100;

const STATUS_DEFAULTS: Record<string, StatusCategory> = {
  "to do": "todo",
  todo: "todo",
  backlog: "todo",
  "in progress": "in_progress",
  "in-progress": "in_progress",
  done: "done",
  "in review": "in_review",
  review: "in_review",
  "ready for review": "in_review",
  blocked: "blocked",
  "on hold": "blocked",
  impediment: "blocked",
  cancelled: "cancelled",
  canceled: "cancelled",
  "won't do": "cancelled",
  obsolete: "cancelled",
};

export const JIRA_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 2 14 8 8 14 2 8z"/></svg>`;

interface JiraStatus {
  name?: string;
  statusCategory?: { key?: string; name?: string };
}

interface JiraComment {
  id?: string;
  created?: string;
  updated?: string;
  body?: unknown;
  author?: JiraPerson;
}

interface JiraPerson {
  displayName?: string;
  accountId?: string;
  emailAddress?: string;
  accountType?: string;
  timeZone?: string;
}

interface JiraChangelogItem {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
}

interface JiraHistory {
  id?: string;
  created?: string;
  author?: JiraPerson;
  items?: JiraChangelogItem[];
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    status?: JiraStatus;
    assignee?: JiraPerson;
    creator?: JiraPerson;
    reporter?: JiraPerson;
    issuetype?: { name?: string };
    priority?: { name?: string };
    project?: { key?: string };
    labels?: string[];
    created?: string;
    updated?: string;
    description?: unknown;
    issuelinks?: { type?: { inward?: string; outward?: string }; inwardIssue?: { key?: string }; outwardIssue?: { key?: string } }[];
    comment?: { comments?: JiraComment[] };
  };
  changelog?: { histories?: JiraHistory[] };
}

function editionOf(ctx: ConnectionContext): "cloud" | "datacenter" {
  return ctx.settings.edition === "datacenter" ? "datacenter" : "cloud";
}

function siteUrl(ctx: ConnectionContext): string | null {
  const raw = String(ctx.settings.site ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesFrom(setting: string | number | boolean | undefined): Set<string> {
  if (typeof setting !== "string" || !setting.trim()) return new Set();
  return new Set(setting.split(",").map(name => name.trim().toLowerCase()).filter(Boolean));
}

function authHeaders(ctx: ConnectionContext): { ok: true; headers: Record<string, string> } | { ok: false; error: string } {
  if (editionOf(ctx) === "datacenter") {
    const token = ctx.secret("token");
    if (!token) return { ok: false, error: "Personal access token is required." };
    return { ok: true, headers: { authorization: `Bearer ${token}`, accept: "application/json" } };
  }
  const email = ctx.secret("email");
  const apiToken = ctx.secret("apiToken");
  if (!email || !apiToken) return { ok: false, error: "Email and API token are required." };
  return {
    ok: true,
    headers: {
      authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`,
      accept: "application/json",
      "content-type": "application/json",
    },
  };
}

function apiError(status: number): string {
  if (status === 401 || status === 403) return "Jira rejected the credentials.";
  if (status === 429) return "Jira rate limited the request.";
  return `Jira returned ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function adfText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const record = node as { text?: unknown; content?: unknown[] };
  const parts = [
    typeof record.text === "string" ? record.text : "",
    ...(Array.isArray(record.content) ? record.content.map(adfText) : []),
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function issueKeyOf(text: string | undefined): string | null {
  const match = ISSUE_KEY.exec(text ?? "");
  return match ? match[1].toUpperCase() : null;
}

function issueKeyFrom(call: CaptureCall): string | null {
  const output = call.output ?? "";
  if (output.includes(PREVIEW_CUT) && !ISSUE_KEY.test(output.split(PREVIEW_CUT)[0] ?? "")) return null;
  return issueKeyOf(call.output) ?? issueKeyOf(call.summary) ?? issueKeyOf(call.input);
}

function commentIdFrom(call: CaptureCall): string | undefined {
  const match = COMMENT_ID.exec(`${call.output ?? ""}\n${call.input ?? ""}`);
  return match?.[1] ?? match?.[2];
}

function browseUrl(ctx: ConnectionContext, key: string, commentId?: string): string | undefined {
  const site = siteUrl(ctx);
  if (!site) return undefined;
  return commentId ? `${site}/browse/${key}?focusedCommentId=${commentId}` : `${site}/browse/${key}`;
}

function mapStatus(status: JiraStatus | undefined, ctx: ConnectionContext): StatusCategory {
  const label = (status?.name ?? "").trim();
  const lower = label.toLowerCase();
  if (namesFrom(ctx.settings.inReview).has(lower)) return "in_review";
  if (namesFrom(ctx.settings.blocked).has(lower)) return "blocked";
  const mapped = STATUS_DEFAULTS[lower];
  if (mapped) return mapped;
  const category = status?.statusCategory?.key;
  if (category === "new") return "todo";
  if (category === "indeterminate") return "in_progress";
  if (category === "done") return "done";
  return "unknown";
}

function detailsOf(issue: JiraIssue): SyncedItem["details"] {
  const fields = issue.fields ?? {};
  const details: Record<string, string> = {};
  if (fields.issuetype?.name) details.type = fields.issuetype.name;
  if (fields.priority?.name) details.priority = fields.priority.name;
  if (fields.assignee?.displayName) details.assignee = fields.assignee.displayName;
  if (fields.project?.key) details.project = fields.project.key;
  if (fields.labels?.length) details.labels = fields.labels.join(",");
  const description = adfText(fields.description).slice(0, 500);
  if (description) details.description = description;
  const blockers = (fields.issuelinks ?? []).flatMap(link => {
    if (link.inwardIssue?.key && /blocked by/i.test(link.type?.inward ?? "")) return [link.inwardIssue.key];
    if (link.outwardIssue?.key && /blocked by/i.test(link.type?.outward ?? "")) return [link.outwardIssue.key];
    return [];
  }).slice(0, 20).join(",").slice(0, 500);
  if (blockers) details.blockers = blockers;
  return Object.keys(details).length ? details : undefined;
}

function when(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function syncedIssue(issue: JiraIssue, ctx: ConnectionContext): SyncedItem | null {
  const key = issue.key?.toUpperCase();
  if (!key) return null;
  const status = issue.fields?.status;
  const label = status?.name?.trim() || "Unknown";
  return {
    kind: "work_item",
    externalId: key,
    title: (issue.fields?.summary ?? key).slice(0, 300) || key,
    url: browseUrl(ctx, key),
    state: { label: label.slice(0, 80), category: mapStatus(status, ctx) },
    connectorId: "jira",
    connectionId: ctx.connectionId,
    details: detailsOf(issue),
    updatedAt: when(issue.fields?.updated),
    syncedAt: Date.now(),
  };
}

function syncedComment(issue: JiraIssue, commentId: string, ctx: ConnectionContext, externalId: string): SyncedItem {
  const key = issue.key?.toUpperCase() ?? externalId;
  const comment = issue.fields?.comment?.comments?.find(entry => String(entry.id) === commentId);
  const title = adfText(comment?.body).slice(0, 80) || `Comment on ${key}`;
  return {
    kind: "comment",
    externalId,
    title,
    url: browseUrl(ctx, key, commentId),
    connectorId: "jira",
    connectionId: ctx.connectionId,
    details: { issue: key },
    updatedAt: when(comment?.updated ?? comment?.created),
    syncedAt: Date.now(),
  };
}

function stub(ref: { kind: LinkKind; externalId: string }, ctx: ConnectionContext): SyncedItem {
  return {
    kind: ref.kind,
    externalId: ref.externalId,
    title: ref.externalId,
    connectorId: "jira",
    connectionId: ctx.connectionId,
    updatedAt: Date.now(),
  };
}

function commentParts(externalId: string): { key: string; id: string } | null {
  const match = COMMENT_REF.exec(externalId.trim());
  return match ? { key: match[1].toUpperCase(), id: match[2] } : null;
}

async function jiraRequest(ctx: ConnectionContext, path: string, init?: RequestInit): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  const site = siteUrl(ctx);
  if (!site) return { ok: false, error: "Site URL is required." };
  const auth = authHeaders(ctx);
  if (!auth.ok) return auth;
  const response = await ctx.fetch(`${site}${path}`, {
    ...init,
    headers: { ...auth.headers, ...init?.headers },
  });
  if (!response.ok) return { ok: false, error: apiError(response.status) };
  return { ok: true, status: response.status, body: await readJson(response) };
}

async function loadIssues(ctx: ConnectionContext, keys: string[], withComments: boolean): Promise<JiraIssue[]> {
  const unique = [...new Set(keys.map(key => key.toUpperCase()))];
  const found: JiraIssue[] = [];
  const fields = withComments ? [...COMMENT_FIELDS] : [...ISSUE_FIELDS];
  for (let index = 0; index < unique.length; index += FETCH_BATCH) {
    const batch = unique.slice(index, index + FETCH_BATCH);
    const page = editionOf(ctx) === "datacenter"
      ? (await searchDataCenter(ctx, `key in (${batch.join(",")})`, undefined, fields)).issues
      : await bulkFetchCloud(ctx, batch, fields);
    found.push(...page);
  }
  return found;
}

async function bulkFetchCloud(ctx: ConnectionContext, keys: string[], fields: string[]): Promise<JiraIssue[]> {
  const result = await jiraRequest(ctx, "/rest/api/3/issue/bulkfetch", {
    method: "POST",
    body: JSON.stringify({ issueIdsOrKeys: keys, fields }),
  });
  if (!result.ok) throw new Error(result.error);
  const issues = (result.body as { issues?: JiraIssue[] } | null)?.issues;
  return Array.isArray(issues) ? issues : [];
}

async function searchDataCenter(ctx: ConnectionContext, jql: string, startAt: string | undefined, fields: string[]): Promise<{ issues: JiraIssue[]; cursor?: string }> {
  const params = new URLSearchParams({ jql, maxResults: "50", fields: fields.join(",") });
  if (startAt) params.set("startAt", startAt);
  const result = await jiraRequest(ctx, `/rest/api/2/search?${params}`);
  if (!result.ok) throw new Error(result.error);
  const payload = result.body as { issues?: JiraIssue[]; startAt?: number; maxResults?: number; total?: number } | null;
  if (!Array.isArray(payload?.issues) || !Number.isSafeInteger(payload.total) || payload.total! < 0) {
    throw new Error("Jira search returned an incomplete page");
  }
  const issues = payload.issues;
  const expectedOffset = startAt ? Number(startAt) : 0;
  const offset = payload.startAt ?? expectedOffset;
  const next = offset + issues.length;
  const total = payload.total!;
  if (!Number.isSafeInteger(offset) || offset !== expectedOffset || !Number.isSafeInteger(total) || total < next ||
      next < total && !issues.length) throw new Error("Jira search returned inconsistent pagination");
  return { issues, ...(Number.isFinite(total) && next < total ? { cursor: String(next) } : {}) };
}

function parseUrlRef(input: string, ctx: ConnectionContext): { kind: LinkKind; externalId: string } | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const site = siteUrl(ctx);
  if (site) {
    try {
      if (url.host !== new URL(site).host) return null;
    } catch {
      return null;
    }
  }
  const selected = url.searchParams.get("selectedIssue");
  const browse = /\/(?:browse|issues)\/([A-Z][A-Z0-9_]+-\d+)/i.exec(url.pathname);
  const key = (selected || browse?.[1] || "").toUpperCase();
  if (!key || !ISSUE_KEY.test(key)) return null;
  const commentId = url.searchParams.get("focusedCommentId");
  if (commentId && /^\d+$/.test(commentId)) return { kind: "comment", externalId: `${key}:${commentId}` };
  return { kind: "work_item", externalId: key };
}

export function jiraWebhookSignature(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
}

export function verifyJiraWebhook(secret: string, header: string | null, raw: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(jiraWebhookSignature(secret, raw));
  const actual = Buffer.from(header.trim());
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function webhookRefs(body: unknown): { kind: LinkKind; externalId: string }[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { issue?: { key?: unknown }; comment?: { id?: unknown } };
  const key = typeof record.issue?.key === "string" ? record.issue.key.toUpperCase() : null;
  if (!key || !ISSUE_KEY.test(key)) return [];
  const refs: { kind: LinkKind; externalId: string }[] = [{ kind: "work_item", externalId: key }];
  const commentId = record.comment?.id;
  if (commentId !== undefined && /^\d+$/.test(String(commentId))) {
    refs.push({ kind: "comment", externalId: `${key}:${commentId}` });
  }
  return refs;
}

function captureIssue(call: CaptureCall, title?: string, details?: Record<string, string>): ReturnType<CaptureRule["extract"]> {
  const key = issueKeyFrom(call);
  if (!key) return null;
  return { externalId: key, title: title ?? key, details };
}

interface JiraAccount {
  accountId?: string;
  username?: string;
  email?: string;
  displayName?: string;
  bot?: boolean;
  timeZone?: string;
}

function jqlDate(ms: number, timeZone?: string): string {
  if (!timeZone) return jqlDate(ms - 14 * 60 * 60_000, "UTC");
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const part = (type: string) => parts.find(value => value.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
  } catch {
    return jqlDate(ms);
  }
}

function watchJql(scope: WatchScope, since: number, timeZone?: string): string {
  const query = typeof scope.query === "string" && scope.query.trim() ? `(${scope.query.trim()})` : "updated is not EMPTY";
  if (!since) return `${query} ORDER BY updated ASC`;
  return `${query} AND updated >= "${jqlDate(since, timeZone)}" ORDER BY updated ASC`;
}

function splitLabels(value: string | null | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);
}

function actorOf(person: JiraPerson | undefined, account?: JiraAccount) {
  return connectionActor({
    name: person?.displayName,
    accountId: person?.accountId,
    email: person?.emailAddress,
    accountType: person?.accountType,
    account,
  });
}

function changeFields(item: SyncedItem, extra: Record<string, string | number | boolean | string[]> = {}): SourceChange["fields"] {
  return {
    ...(item.details?.project ? { project: String(item.details.project) } : {}),
    ...(item.details?.priority ? { priority: String(item.details.priority) } : {}),
    ...(item.details?.assignee ? { assignee: String(item.details.assignee) } : {}),
    ...(item.details?.labels ? { labels: String(item.details.labels).split(",") } : {}),
    ...(item.state?.category ? { "state.category": item.state.category } : {}),
    ...(item.state?.label ? { "state.label": item.state.label } : {}),
    ...extra,
  };
}

function issueChange(
  item: SyncedItem,
  ctx: ConnectionContext,
  type: SourceChange["type"],
  id: string,
  at: number,
  actor: { name: string; isBot: boolean },
  before?: SourceChange["before"],
  extra: Record<string, string | number | boolean | string[]> = {},
): SourceChange {
  return {
    id,
    type,
    connectionId: ctx.connectionId,
    item,
    ...(before ? { before } : {}),
    actor,
    fields: changeFields(item, extra),
    at,
  };
}

function changesFromIssue(
  issue: JiraIssue,
  item: SyncedItem,
  ctx: ConnectionContext,
  since: number,
  seen: SeenSnapshot | undefined,
  account?: JiraAccount,
): SourceChange[] {
  const key = item.externalId;
  if (!key) return [];
  const created = when(issue.fields?.created);
  const updated = when(issue.fields?.updated);
  const out: SourceChange[] = [];
  const fallbackBefore = beforeFromSnapshot(seen);
  if (issue.fields?.created && created > since) {
    out.push(issueChange(item, ctx, "item.created", `${key}@created`, created, actorOf(issue.fields?.creator ?? issue.fields?.reporter, account), fallbackBefore));
  }
  for (const history of issue.changelog?.histories ?? []) {
    const at = when(history.created);
    if (at <= since) continue;
    const actor = actorOf(history.author, account);
    const hid = history.id ?? String(at);
    const items = history.items ?? [];
    const status = items.find(entry => entry.field === "status");
    const assignee = items.find(entry => entry.field === "assignee");
    const labels = items.find(entry => entry.field === "labels");
    if (status) {
      out.push(issueChange(item, ctx, "item.state_changed", `${key}@changelog:${hid}:status`, at, actor, {
        state: mapStatus({ name: status.fromString ?? undefined }, ctx),
        stateLabel: status.fromString ?? undefined,
      }));
    }
    if (assignee) {
      out.push(issueChange(item, ctx, "item.assigned", `${key}@changelog:${hid}:assignee`, at, actor, {
        assignee: assignee.fromString ?? undefined,
      }, { assignee: assignee.toString ?? item.details?.assignee ?? "" }));
    }
    if (labels) {
      out.push(issueChange(item, ctx, "item.labeled", `${key}@changelog:${hid}:labels`, at, actor, {
        labels: splitLabels(labels.fromString),
      }, { labels: splitLabels(labels.toString) }));
    }
    if (!status && !assignee && !labels && items.length) {
      out.push(issueChange(item, ctx, "item.updated", `${key}@changelog:${hid}:updated`, at, actor, fallbackBefore));
    }
  }
  for (const comment of issue.fields?.comment?.comments ?? []) {
    const at = when(comment.created);
    if (at <= since || !comment.id) continue;
    out.push({
      id: `${key}@comment:${comment.id}`,
      type: "comment.added",
      connectionId: ctx.connectionId,
      item: syncedComment(issue, comment.id, ctx, `${key}:${comment.id}`),
      actor: actorOf(comment.author ?? issue.fields?.assignee, account),
      fields: changeFields(item, { issue: key }),
      at,
    });
  }
  if (!out.length && updated > since) {
    out.push(issueChange(item, ctx, "item.updated", `${key}@updated:${issue.fields?.updated ?? updated}`, updated, actorOf(issue.fields?.assignee, account), fallbackBefore));
  }
  return out;
}

function webhookRecord(body: unknown): Record<string, unknown> | null {
  if (!body) return null;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}

async function loadMyself(ctx: ConnectionContext): Promise<JiraAccount | undefined> {
  const path = editionOf(ctx) === "datacenter" ? "/rest/api/2/myself" : "/rest/api/3/myself";
  const result = await jiraRequest(ctx, path);
  if (!result.ok || !result.body || typeof result.body !== "object") return undefined;
  const me = result.body as JiraPerson;
  return {
    accountId: me.accountId,
    email: me.emailAddress,
    displayName: me.displayName,
    bot: me.accountType === "app",
    timeZone: me.timeZone,
  };
}

async function searchChanges(ctx: ConnectionContext, jql: string, cursor?: string): Promise<JiraIssue[]> {
  if (editionOf(ctx) === "datacenter") {
    const params = new URLSearchParams({
      jql,
      maxResults: "50",
      fields: CHANGE_FIELDS.join(","),
      expand: "changelog",
    });
    if (cursor) params.set("startAt", cursor);
    const result = await jiraRequest(ctx, `/rest/api/2/search?${params}`);
    if (!result.ok) throw new Error(result.error);
    const issues = (result.body as { issues?: JiraIssue[] } | null)?.issues;
    return Array.isArray(issues) ? issues : [];
  }
  const result = await jiraRequest(ctx, "/rest/api/3/search/jql", {
    method: "POST",
    body: JSON.stringify({
      jql,
      maxResults: 50,
      fields: [...CHANGE_FIELDS],
      expand: "changelog",
      ...(cursor ? { nextPageToken: cursor } : {}),
    }),
  });
  if (!result.ok) throw new Error(result.error);
  const issues = (result.body as { issues?: JiraIssue[] } | null)?.issues;
  return Array.isArray(issues) ? issues : [];
}

function webhookChangesFrom(body: unknown, ctx: ConnectionContext, account?: JiraAccount): SourceChange[] {
  const record = webhookRecord(body);
  if (!record) return [];
  const issue = record.issue as JiraIssue | undefined;
  const item = issue ? syncedIssue(issue, ctx) : null;
  if (!issue || !item?.externalId) return [];
  const event = typeof record.webhookEvent === "string" ? record.webhookEvent : "";
  const user = record.user as JiraPerson | undefined;
  const actor = actorOf(user ?? issue.fields?.assignee, account);
  const changelog = record.changelog as { id?: string; items?: JiraChangelogItem[] } | undefined;
  const comment = record.comment as JiraComment | undefined;
  if (event === "jira:issue_created" || event.endsWith("issue_created")) {
    return [issueChange(item, ctx, "item.created", `${item.externalId}@created`, when(issue.fields?.created ?? issue.fields?.updated), actor)];
  }
  if (comment?.id && (event.includes("comment") || record.issue_event_type_name === "issue_commented")) {
    return [{
      id: `${item.externalId}@comment:${comment.id}`,
      type: "comment.added",
      connectionId: ctx.connectionId,
      item: syncedComment(issue, String(comment.id), ctx, `${item.externalId}:${comment.id}`),
      actor,
      fields: changeFields(item, { issue: item.externalId }),
      at: when(comment.created ?? issue.fields?.updated),
    }];
  }
  if (changelog?.id && changelog.items?.length) {
    return changesFromIssue({
      ...issue,
      changelog: { histories: [{ id: changelog.id, created: typeof record.timestamp === "number" ? new Date(record.timestamp).toISOString() : issue.fields?.updated, author: user, items: changelog.items }] },
    }, item, ctx, 0, undefined, account);
  }
  return [issueChange(item, ctx, "item.updated", `${item.externalId}@updated:${issue.fields?.updated ?? Date.now()}`, when(issue.fields?.updated), actor)];
}

const captureRules: CaptureRule[] = [
  {
    match: { tool: /jira[_-]?(?:add|create)[_-]?.*comment|jira[_-]?comment[_-]?(?:add|create)|JIRA_ADD_COMMENT/i },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => {
      const key = issueKeyFrom(call);
      if (!key) return null;
      const commentId = commentIdFrom(call);
      return {
        externalId: commentId ? `${key}:${commentId}` : key,
        title: `Comment on ${key}`,
        parentRef: key,
        details: { issue: key },
      };
    },
    event: item => `commented on ${String(item.details?.issue ?? item.externalId ?? item.title).split(":")[0]}`,
  },
  {
    match: { tool: /jira.*transition|JIRA_TRANSITION/i },
    on: "completed",
    produce: { kind: "work_item" },
    eventKind: "state_change",
    extract: call => {
      const key = issueKeyFrom(call);
      if (!key) return null;
      const to = /(?:to|status)[:\s]+([A-Za-z][A-Za-z /-]{1,40})/.exec(`${call.output ?? ""} ${call.input ?? ""}`);
      return { externalId: key, title: key, ...(to ? { details: { status: to[1].trim() } } : {}) };
    },
    event: item => `transitioned ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /jira.*assign|JIRA_ASSIGN/i },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => captureIssue(call),
    event: item => `assigned ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /jira[_-]?create[_-]?(?:issue|ticket)|JIRA_CREATE_ISSUE\b/i },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => captureIssue(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
];

export const jiraConnector: Connector = {
  manifest: {
    id: "jira",
    name: "Jira",
    icon: JIRA_ICON,
    kinds: ["work_item", "comment"],
    settings: [
      { key: "site", label: "Site URL", type: "string", help: "https://your-site.atlassian.net or your Data Center base URL" },
      { key: "edition", label: "Edition", type: "enum", enum: ["cloud", "datacenter"], help: "Cloud uses an email and API token. Data Center uses a personal access token." },
      { key: "inReview", label: "In-review statuses", type: "string", help: "Comma-separated Jira status names treated as in review" },
      { key: "blocked", label: "Blocked statuses", type: "string", help: "Comma-separated Jira status names treated as blocked" },
    ],
    secrets: [
      { key: "email", label: "Email", help: "Atlassian account email for Jira Cloud" },
      { key: "apiToken", label: "API token", help: "Atlassian API token for Jira Cloud" },
      { key: "token", label: "Personal access token", help: "Jira Data Center personal access token" },
      { key: "webhookSecret", label: "Webhook secret", help: "Optional. Used to verify signed Jira webhook deliveries." },
    ],
    capabilities: { webhooks: true, query: true, poll: true },
    statusDefaults: {
      "In Review": "in_review",
      Review: "in_review",
      "Ready for Review": "in_review",
      Blocked: "blocked",
      "On Hold": "blocked",
      Impediment: "blocked",
      Cancelled: "cancelled",
      Canceled: "cancelled",
      "Won't Do": "cancelled",
      Obsolete: "cancelled",
    },
    watch: {
      scopes: [
        { key: "query", label: "JQL", type: "string", help: "Jira Query Language scope, e.g. project = PAY AND labels = bot-ready" },
        { key: "project", label: "Project", type: "string", help: "Optional project key used when JQL is empty" },
      ],
      events: ["item.created", "item.updated", "item.state_changed", "item.assigned", "item.labeled", "comment.added"],
    },
  },
  async test(ctx) {
    const path = editionOf(ctx) === "datacenter" ? "/rest/api/2/myself" : "/rest/api/3/myself";
    const result = await jiraRequest(ctx, path);
    if (!result.ok) return result;
    const site = siteUrl(ctx);
    ctx.log("Jira credentials were accepted.");
    return { ok: true, account: site ? new URL(site).host : "jira" };
  },
  parseRef(input, ctx) {
    const text = input.trim();
    if (/^https?:\/\//i.test(text)) return parseUrlRef(text, ctx);
    const comment = COMMENT_REF.exec(text) ?? /^([A-Z][A-Z0-9_]+-\d+)#comment-(\d+)$/i.exec(text);
    if (comment) return { kind: "comment", externalId: `${comment[1].toUpperCase()}:${comment[2]}` };
    const key = issueKeyOf(text);
    return key && text.toUpperCase() === key ? { kind: "work_item", externalId: key } : null;
  },
  urlPatterns(ctx) {
    const site = siteUrl(ctx);
    const base = site ? escapeRegExp(site) : "https?://[^\\s/]+(?:/jira)?";
    const key = "[A-Z][A-Z0-9_]+-\\d+";
    return [
      new RegExp(`^${base}/(?:browse|issues)/${key}`, "i"),
      new RegExp(`^${base}/[^\\s]*[?&](?:selectedIssue|focusedCommentId)=`, "i"),
    ];
  },
  async fetch(ctx, refs) {
    const comments = refs.flatMap(ref => {
      if (ref.kind !== "comment") return [];
      const parts = commentParts(ref.externalId);
      return parts ? [{ ref, ...parts }] : [];
    });
    const keys = [
      ...refs.filter(ref => ref.kind === "work_item" && ISSUE_KEY.test(ref.externalId)).map(ref => ref.externalId.toUpperCase()),
      ...comments.map(comment => comment.key),
    ];
    const issues = keys.length ? await loadIssues(ctx, keys, comments.length > 0) : [];
    if (issues.length) ctx.log(`Fetched ${issues.length} Jira issue(s).`);
    const byKey = new Map(issues.flatMap(issue => issue.key ? [[issue.key.toUpperCase(), issue] as const] : []));
    return refs.map(ref => {
      if (ref.kind === "comment") {
        const parts = commentParts(ref.externalId);
        const issue = parts ? byKey.get(parts.key) : undefined;
        if (issue && parts) return syncedComment(issue, parts.id, ctx, ref.externalId);
      }
      if (ref.kind === "work_item") {
        const issue = byKey.get(ref.externalId.toUpperCase());
        const synced = issue ? syncedIssue(issue, ctx) : null;
        if (synced) return synced;
      }
      return stub(ref, ctx);
    });
  },
  async query(ctx, query, cursor) {
    const jql = query.trim();
    if (!jql) return { items: [] };
    ctx.log("Queried Jira with JQL.");
    if (editionOf(ctx) === "datacenter") {
      const page = await searchDataCenter(ctx, jql, cursor, [...ISSUE_FIELDS]);
      if (page.issues.some(issue => !issue?.key || !ISSUE_KEY.test(issue.key))) throw new Error("Jira search returned an issue without a valid key");
      return { items: page.issues.flatMap(issue => syncedIssue(issue, ctx) ?? []), ...(page.cursor ? { cursor: page.cursor } : {}) };
    }
    const result = await jiraRequest(ctx, "/rest/api/3/search/jql", {
      method: "POST",
      body: JSON.stringify({
        jql,
        maxResults: 50,
        fields: [...ISSUE_FIELDS],
        ...(cursor ? { nextPageToken: cursor } : {}),
      }),
    });
    if (!result.ok) throw new Error(result.error);
    const payload = result.body as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean } | null;
    if (!Array.isArray(payload?.issues)) throw new Error("Jira search returned an incomplete page");
    if (payload.issues.some(issue => !issue?.key || !ISSUE_KEY.test(issue.key))) throw new Error("Jira search returned an issue without a valid key");
    if (payload.isLast === false && !payload.nextPageToken ||
        payload.isLast === true && payload.nextPageToken ||
        payload.issues.length === 50 && !payload.nextPageToken && payload.isLast !== true) {
      throw new Error("Jira omitted pagination for a full page");
    }
    const items = payload.issues.flatMap(issue => syncedIssue(issue, ctx) ?? []);
    return { items, ...(payload?.nextPageToken ? { cursor: payload.nextPageToken } : {}) };
  },
  async webhook(ctx, headers, body) {
    const secret = ctx.secret("webhookSecret");
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    if (secret && !verifyJiraWebhook(secret, headers.get("x-hub-signature"), raw)) {
      ctx.log("Ignored a Jira webhook with a bad signature.");
      return [];
    }
    let parsed: unknown = body;
    if (typeof body === "string") {
      try { parsed = JSON.parse(body); } catch { return []; }
    }
    const refs = webhookRefs(parsed);
    if (refs.length) ctx.log(`Jira webhook named ${refs.length} item(s).`);
    return refs;
  },
  async changes(ctx, scope: WatchScope, cursor: string | null) {
    const parsed = parseChangeCursor(cursor);
    const project = typeof scope.project === "string" && /^[A-Z][A-Z0-9_]+$/i.test(scope.project)
      ? `project = ${scope.project.toUpperCase()}` : "";
    const scoped: WatchScope = {
      ...scope,
      query: typeof scope.query === "string" && scope.query.trim() ? scope.query : project,
    };
    const account = await loadMyself(ctx);
    const issues = await searchChanges(ctx, watchJql(scoped, parsed.since, account?.timeZone));
    const seen = new Map(parsed.seen);
    const changes = issues.flatMap(issue => {
      const item = syncedIssue(issue, ctx);
      if (!item || when(issue.fields?.updated) <= parsed.since) return [];
      const emitted = changesFromIssue(issue, item, ctx, parsed.since, seen.get(item.externalId!), account);
      rememberSnapshot(seen, item);
      return emitted;
    }).sort((left, right) => left.at - right.at);
    const latest = Math.max(parsed.since, ...issues.map(issue => when(issue.fields?.updated)));
    if (changes.length) ctx.log(`Jira changes named ${changes.length} item(s).`);
    return {
      changes,
      cursor: encodeChangeCursor(latest || Date.now(), seen, issues.flatMap(issue => issue.key ? [issue.key.toUpperCase()] : [])),
    };
  },
  async webhookChanges(ctx, headers, body) {
    const secret = ctx.secret("webhookSecret");
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    if (secret && !verifyJiraWebhook(secret, headers.get("x-hub-signature"), raw)) {
      ctx.log("Ignored a Jira webhook with a bad signature.");
      return [];
    }
    const account = await loadMyself(ctx);
    const changes = webhookChangesFrom(body, ctx, account);
    if (changes.length) ctx.log(`Jira webhook changes named ${changes.length} item(s).`);
    return changes;
  },
  capture: captureRules,
};
