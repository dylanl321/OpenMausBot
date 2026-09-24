import type { LinkKind, StatusCategory, SyncedItem } from "../../../shared/work-links.ts";
import type {
  CaptureCall,
  CaptureRule,
  ConnectionContext,
  Connector,
  SourceChange,
  WatchScope,
} from "../types.ts";

const PREVIEW_CUT = "[… preview shortened]";
const IDENTIFIER = /\b([A-Z][A-Z0-9_]+-\d+)\b/i;
const COMMENT_REF = /^([A-Z][A-Z0-9_]+-\d+):([0-9a-f-]{8,})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_API = "https://api.plane.so";
const DEFAULT_APP = "https://app.plane.so";

const GROUP_CATEGORY: Record<string, StatusCategory> = {
  backlog: "todo",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  cancelled: "cancelled",
};

export const PLANE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 10 14 3l-3 11-3-4-4 1z"/></svg>`;

interface PlaneProject {
  id?: string;
  name?: string;
  identifier?: string;
}

interface PlaneState {
  id?: string;
  name?: string;
  group?: string;
}

interface PlanePerson {
  display_name?: string;
  first_name?: string;
  last_name?: string;
}

interface PlaneWorkItem {
  id?: string;
  name?: string;
  sequence_id?: number;
  project?: string;
  project_id?: string;
  priority?: string;
  state?: PlaneState | string;
  assignees?: Array<PlanePerson | string>;
  labels?: unknown[];
  created_at?: string;
  updated_at?: string;
}

interface PlaneComment {
  id?: string;
  comment_stripped?: string;
  comment_html?: string;
  created_at?: string;
  updated_at?: string;
  actor?: PlanePerson | string;
  issue?: string;
}

interface PlanePage<T> {
  results?: T[];
  next_cursor?: string;
  next_page_results?: boolean;
}

function siteUrl(ctx: ConnectionContext): string | null {
  const raw = String(ctx.settings.site ?? DEFAULT_API).trim() || DEFAULT_API;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function workspaceOf(ctx: ConnectionContext): string | null {
  const raw = String(ctx.settings.workspace ?? "").trim();
  return /^[a-z0-9][a-z0-9-]{0,63}$/i.test(raw) ? raw : null;
}

function appOrigin(ctx: ConnectionContext): string {
  const site = siteUrl(ctx);
  if (!site) return DEFAULT_APP;
  try {
    const host = new URL(site).host;
    if (host === "api.plane.so") return DEFAULT_APP;
    return site;
  } catch {
    return DEFAULT_APP;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function when(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function apiError(status: number): string {
  if (status === 401 || status === 403) return "Plane rejected the credentials.";
  if (status === 429) return "Plane rate limited the request.";
  return `Plane returned ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function planeRequest(
  ctx: ConnectionContext,
  path: string,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; error: string }> {
  const site = siteUrl(ctx);
  const workspace = workspaceOf(ctx);
  if (!site) return { ok: false, error: "API URL is required." };
  if (!workspace) return { ok: false, error: "Workspace slug is required." };
  const apiKey = ctx.secret("apiKey");
  if (!apiKey) return { ok: false, error: "API key is required." };
  const response = await ctx.fetch(`${site}/api/v1/workspaces/${workspace}${path}`, {
    headers: { "X-API-Key": apiKey, accept: "application/json" },
  });
  if (!response.ok) return { ok: false, error: apiError(response.status) };
  return { ok: true, status: response.status, body: await readJson(response) };
}

function projectIdentifier(ctx: ConnectionContext, item?: PlaneWorkItem): string | null {
  const fromItem = item && typeof (item as { project_identifier?: unknown }).project_identifier === "string"
    ? (item as { project_identifier: string }).project_identifier
    : "";
  if (/^[A-Z][A-Z0-9_]+$/i.test(fromItem) && !UUID.test(fromItem)) return fromItem.toUpperCase();
  const setting = String(ctx.settings.project ?? "");
  if (/^[A-Z][A-Z0-9_]+$/i.test(setting) && !UUID.test(setting)) return setting.toUpperCase();
  return null;
}

function identifierOf(item: PlaneWorkItem, ctx: ConnectionContext, fallback?: string): string | null {
  if (fallback && IDENTIFIER.test(fallback)) return fallback.toUpperCase();
  const sequence = item.sequence_id;
  const projectKey = projectIdentifier(ctx, item);
  if (projectKey && sequence != null) return `${projectKey}-${sequence}`;
  return item.id ?? (fallback && UUID.test(fallback) ? fallback : null);
}

function browseUrl(ctx: ConnectionContext, identifier: string, commentId?: string): string {
  const base = `${appOrigin(ctx)}/${workspaceOf(ctx) ?? "workspace"}/browse/${identifier}`;
  return commentId ? `${base}#${commentId}` : base;
}

function stateOf(item: PlaneWorkItem): PlaneState | undefined {
  return item.state && typeof item.state === "object" ? item.state : undefined;
}

function mapGroup(group: string | undefined, label: string): StatusCategory {
  const named = label.trim().toLowerCase();
  if (named === "in review" || named === "review" || named === "ready for review") return "in_review";
  if (named === "blocked" || named === "on hold" || named === "impediment") return "blocked";
  return GROUP_CATEGORY[(group ?? "").toLowerCase()] ?? "unknown";
}

function personName(value: PlanePerson | string | undefined): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return UUID.test(value) ? undefined : value;
  const name = value.display_name ?? [value.first_name, value.last_name].filter(Boolean).join(" ").trim();
  return name || undefined;
}

function detailsOf(item: PlaneWorkItem): SyncedItem["details"] {
  const details: Record<string, string> = {};
  if (item.priority) details.priority = item.priority;
  const assignee = personName(item.assignees?.find(entry => typeof entry !== "string") as PlanePerson | undefined)
    ?? (typeof item.assignees?.[0] === "string" ? undefined : personName(item.assignees?.[0]));
  if (assignee) details.assignee = assignee;
  const project = typeof (item as { project_identifier?: string }).project_identifier === "string"
    ? (item as { project_identifier: string }).project_identifier
    : typeof item.project === "string" && !UUID.test(item.project) ? item.project : undefined;
  if (project) details.project = project;
  if (item.id) details.workItemId = item.id;
  return Object.keys(details).length ? details : undefined;
}

function syncedWorkItem(item: PlaneWorkItem, ctx: ConnectionContext, externalId: string): SyncedItem | null {
  const id = identifierOf(item, ctx, externalId);
  if (!id) return null;
  const status = stateOf(item);
  const label = status?.name?.trim() || status?.group || "Unknown";
  return {
    kind: "work_item",
    externalId: id,
    title: (item.name ?? id).slice(0, 300) || id,
    url: browseUrl(ctx, id),
    state: { label: label.slice(0, 80), category: mapGroup(status?.group, label) },
    connectorId: "plane",
    connectionId: ctx.connectionId,
    details: detailsOf(item),
    updatedAt: when(item.updated_at),
    syncedAt: Date.now(),
  };
}

function commentText(comment: PlaneComment): string {
  const stripped = (comment.comment_stripped ?? "").replace(/\s+/g, " ").trim();
  if (stripped) return stripped;
  return (comment.comment_html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function syncedComment(comment: PlaneComment, ctx: ConnectionContext, parent: string, externalId: string): SyncedItem {
  const title = commentText(comment).slice(0, 80) || `Comment on ${parent}`;
  return {
    kind: "comment",
    externalId,
    title,
    url: browseUrl(ctx, parent, comment.id),
    connectorId: "plane",
    connectionId: ctx.connectionId,
    details: { issue: parent },
    updatedAt: when(comment.updated_at ?? comment.created_at),
    syncedAt: Date.now(),
  };
}

function stub(ref: { kind: LinkKind; externalId: string }, ctx: ConnectionContext): SyncedItem {
  return {
    kind: ref.kind,
    externalId: ref.externalId,
    title: ref.externalId,
    connectorId: "plane",
    connectionId: ctx.connectionId,
    updatedAt: Date.now(),
  };
}

function parseUrlRef(input: string, ctx: ConnectionContext): { kind: LinkKind; externalId: string } | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const site = siteUrl(ctx);
  const app = appOrigin(ctx);
  const hosts = new Set<string>([app, site ?? "", DEFAULT_APP, DEFAULT_API].flatMap(value => {
    try { return [new URL(value).host]; } catch { return []; }
  }));
  if (site && !hosts.has(url.host)) return null;
  const browse = /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i.exec(url.pathname);
  if (browse) {
    const key = browse[1].toUpperCase();
    const comment = url.hash.replace(/^#/, "");
    if (comment && (UUID.test(comment) || /^\d+$/.test(comment))) return { kind: "comment", externalId: `${key}:${comment}` };
    return { kind: "work_item", externalId: key };
  }
  const issues = /\/(?:issues|work-items)\/([0-9a-f-]{8,}|[A-Z][A-Z0-9_]+-\d+)/i.exec(url.pathname);
  if (issues) {
    const raw = issues[1];
    const key = IDENTIFIER.test(raw) ? raw.toUpperCase() : raw;
    const comment = url.hash.replace(/^#/, "");
    if (comment) return { kind: "comment", externalId: IDENTIFIER.test(key) ? `${key}:${comment}` : `${key}:${comment}` };
    return { kind: "work_item", externalId: key };
  }
  return null;
}

function identifierFrom(text: string | undefined): string | null {
  const match = IDENTIFIER.exec(text ?? "");
  return match ? match[1].toUpperCase() : null;
}

function commentParts(externalId: string): { key: string; id: string } | null {
  const match = COMMENT_REF.exec(externalId.trim());
  return match ? { key: match[1].toUpperCase(), id: match[2] } : null;
}

async function listProjects(ctx: ConnectionContext): Promise<PlaneProject[]> {
  const result = await planeRequest(ctx, "/projects/?per_page=100");
  if (!result.ok) return [];
  const page = result.body as PlanePage<PlaneProject> | PlaneProject[] | null;
  return Array.isArray(page) ? page : Array.isArray(page?.results) ? page.results : [];
}

async function resolveProjectId(ctx: ConnectionContext, hint?: string): Promise<string | null> {
  const raw = (hint ?? String(ctx.settings.project ?? "")).trim();
  if (UUID.test(raw)) return raw;
  const projects = await listProjects(ctx);
  if (!raw) return projects[0]?.id ?? null;
  const found = projects.find(project =>
    project.id === raw
    || project.identifier?.toUpperCase() === raw.toUpperCase()
    || project.name?.toLowerCase() === raw.toLowerCase());
  return found?.id ?? null;
}

function pageItems<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  const page = body as PlanePage<T> | null;
  return Array.isArray(page?.results) ? page.results : [];
}

function nextCursor(body: unknown): string | undefined {
  const page = body as PlanePage<unknown> | null;
  return page?.next_page_results && page.next_cursor ? page.next_cursor : undefined;
}

function identifierFromCall(call: CaptureCall): string | null {
  const output = call.output ?? "";
  if (output.includes(PREVIEW_CUT) && !IDENTIFIER.test(output.split(PREVIEW_CUT)[0] ?? "")) return null;
  return identifierFrom(call.output) ?? identifierFrom(call.summary) ?? identifierFrom(call.input);
}

function jsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mergedRecord(call: CaptureCall): Record<string, unknown> | null {
  const output = jsonObject(call.output ?? "");
  const input = jsonObject(call.input ?? "");
  if (!output && !input) return null;
  return { ...input, ...output };
}

function actionOf(call: CaptureCall): string {
  const json = mergedRecord(call);
  const action = json?.action;
  if (typeof action === "string") return action.toLowerCase();
  const title = call.title ?? "";
  if (/comment/i.test(title)) return "comment";
  if (/update|transition/i.test(title) || /Updated /i.test(call.output ?? "")) return "update";
  if (/create|fake\.issue/i.test(title) || /Created /i.test(call.output ?? "")) return "create";
  return "";
}

function extractWorkItem(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const json = mergedRecord(call);
  const fromJson = typeof json?.workitem_identifier === "string" ? json.workitem_identifier
    : typeof json?.identifier === "string" ? json.identifier
    : identifierFrom(typeof json?.name === "string" ? json.name : undefined);
  const key = (fromJson && IDENTIFIER.test(fromJson) ? fromJson.toUpperCase() : null) ?? identifierFromCall(call);
  if (!key) return null;
  return { externalId: key, title: typeof json?.name === "string" ? json.name : key };
}

function extractComment(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const key = identifierFromCall(call);
  if (!key) return null;
  const json = mergedRecord(call);
  const rawId = json?.id ?? json?.comment_id ?? json?.commentId;
  const fromText = /(?:\bid[:\s#]+|#)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(`${call.output ?? ""}\n${call.input ?? ""}`);
  const commentId = (typeof rawId === "string" && (UUID.test(rawId) || /^\d+$/.test(rawId)) ? rawId : undefined) ?? fromText?.[1];
  return {
    externalId: commentId ? `${key}:${commentId}` : key,
    parentRef: key,
    title: `Comment on ${key}`,
    details: { issue: key },
  };
}

const captureRules: CaptureRule[] = [
  {
    match: { tool: /workitem(?!_comment)|create[_-]?work[_-]?item\b/i },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => actionOf(call) === "comment" ? null : actionOf(call) === "update" ? null : extractWorkItem(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /workitem_comment|plane[_-]?.*comment|create[_-]?work[_-]?item[_-]?comment/i },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => extractComment(call),
    event: item => `commented on ${String(item.details?.issue ?? item.externalId ?? item.title).split(":")[0]}`,
  },
  {
    match: { tool: /workitem|plane[_-]?(?:update|transition)|update[_-]?work[_-]?item/i },
    on: "completed",
    produce: { kind: "work_item" },
    eventKind: "state_change",
    extract: call => actionOf(call) === "update" ? extractWorkItem(call) : null,
    event: item => `updated ${item.externalId ?? item.title}`,
  },
];

function changeType(item: PlaneWorkItem, cursorAt: number): SourceChange["type"] {
  const created = when(item.created_at);
  if (created > cursorAt) return "item.created";
  return "item.updated";
}

function toChange(item: SyncedItem, raw: PlaneWorkItem, ctx: ConnectionContext, type: SourceChange["type"]): SourceChange {
  const at = item.updatedAt;
  return {
    id: `${item.externalId}@${raw.updated_at ?? at}`,
    type,
    connectionId: ctx.connectionId,
    item,
    actor: { name: personName(raw.assignees?.[0] as PlanePerson | undefined) ?? "Plane", isBot: false },
    fields: {
      ...(item.details?.project ? { project: String(item.details.project) } : {}),
      ...(item.details?.priority ? { priority: String(item.details.priority) } : {}),
      ...(item.state?.category ? { "state.category": item.state.category } : {}),
      ...(item.state?.label ? { "state.label": item.state.label } : {}),
    },
    at,
  };
}

export const planeConnector: Connector = {
  manifest: {
    id: "plane",
    name: "Plane",
    icon: PLANE_ICON,
    kinds: ["work_item", "comment"],
    settings: [
      { key: "site", label: "API URL", type: "string", help: "https://api.plane.so or your self-hosted Plane origin" },
      { key: "workspace", label: "Workspace slug", type: "string", help: "The slug in https://app.plane.so/my-team/projects/" },
      { key: "project", label: "Default project", type: "string", help: "Project identifier (PAY) or id used for queries and watches" },
    ],
    secrets: [
      { key: "apiKey", label: "API key", help: "Plane personal or workspace API key (X-API-Key)" },
    ],
    capabilities: { query: true, poll: true },
    statusDefaults: {
      Backlog: "todo",
      Todo: "todo",
      "In Progress": "in_progress",
      "In Review": "in_review",
      Done: "done",
      Cancelled: "cancelled",
      Canceled: "cancelled",
    },
    watch: {
      scopes: [
        { key: "project", label: "Project", type: "string", help: "Project identifier or id. Defaults to the connection project." },
        { key: "query", label: "PQL", type: "string", help: "Optional Plane Query Language filter, e.g. stateGroup IN (unstarted, started)" },
      ],
      events: ["item.created", "item.updated", "item.state_changed", "comment.added"],
    },
  },
  async test(ctx) {
    const workspace = workspaceOf(ctx);
    if (!workspace) return { ok: false, error: "Workspace slug is required." };
    const result = await planeRequest(ctx, "/projects/?per_page=1");
    if (!result.ok) return result;
    ctx.log("Plane credentials were accepted.");
    return { ok: true, account: workspace };
  },
  parseRef(input, ctx) {
    const text = input.trim();
    if (/^https?:\/\//i.test(text)) return parseUrlRef(text, ctx);
    const comment = COMMENT_REF.exec(text);
    if (comment) return { kind: "comment", externalId: `${comment[1].toUpperCase()}:${comment[2]}` };
    if (IDENTIFIER.test(text) && text.toUpperCase() === identifierFrom(text)) return { kind: "work_item", externalId: text.toUpperCase() };
    if (UUID.test(text)) return { kind: "work_item", externalId: text.toLowerCase() };
    return null;
  },
  urlPatterns(ctx) {
    const base = escapeRegExp(appOrigin(ctx));
    const key = "[A-Z][A-Z0-9_]+-\\d+";
    return [
      new RegExp(`^${base}/[^\\s]*/browse/${key}`, "i"),
      new RegExp(`^https?://[^\\s]+/browse/${key}`, "i"),
      new RegExp(`^https?://[^\\s]+/(?:issues|work-items)/[\\w.-]+`, "i"),
    ];
  },
  async fetch(ctx, refs) {
    const comments = refs.flatMap(ref => {
      if (ref.kind !== "comment") return [];
      const parts = commentParts(ref.externalId);
      return parts ? [{ ref, ...parts }] : [];
    });
    const keys = [
      ...refs.filter(ref => ref.kind === "work_item").map(ref => ref.externalId),
      ...comments.map(comment => comment.key),
    ];
    const loaded = new Map<string, PlaneWorkItem>();
    await Promise.all([...new Set(keys)].map(async key => {
      if (IDENTIFIER.test(key)) {
        const result = await planeRequest(ctx, `/work-items/${key.toUpperCase()}/?expand=state,assignees`);
        if (result.ok && result.body && typeof result.body === "object") loaded.set(key.toUpperCase(), result.body as PlaneWorkItem);
        return;
      }
      if (!UUID.test(key)) return;
      const projectId = await resolveProjectId(ctx);
      if (!projectId) return;
      const result = await planeRequest(ctx, `/projects/${projectId}/work-items/${key}/?expand=state,assignees`);
      if (result.ok && result.body && typeof result.body === "object") loaded.set(key, result.body as PlaneWorkItem);
    }));
    const commentBodies = new Map<string, PlaneComment>();
    await Promise.all(comments.map(async comment => {
      const item = loaded.get(comment.key) ?? [...loaded.values()].find(entry => identifierOf(entry, ctx, comment.key) === comment.key);
      const projectId = item?.project_id ?? (typeof item?.project === "string" && UUID.test(item.project) ? item.project : null) ?? await resolveProjectId(ctx);
      const workItemId = item?.id;
      if (!projectId || !workItemId) return;
      const result = await planeRequest(ctx, `/projects/${projectId}/work-items/${workItemId}/comments/${comment.id}/`);
      if (result.ok && result.body && typeof result.body === "object") commentBodies.set(comment.ref.externalId, result.body as PlaneComment);
    }));
    if (loaded.size) ctx.log(`Fetched ${loaded.size} Plane work item(s).`);
    return refs.map(ref => {
      if (ref.kind === "comment") {
        const parts = commentParts(ref.externalId);
        const comment = commentBodies.get(ref.externalId);
        if (parts && comment) return syncedComment(comment, ctx, parts.key, ref.externalId);
      }
      if (ref.kind === "work_item") {
        const item = loaded.get(ref.externalId.toUpperCase()) ?? loaded.get(ref.externalId);
        const synced = item ? syncedWorkItem(item, ctx, ref.externalId) : null;
        if (synced) return synced;
      }
      return stub(ref, ctx);
    });
  },
  async query(ctx, query, cursor) {
    const text = query.trim();
    const projectHint = !text || IDENTIFIER.test(text) || UUID.test(text) || /^[A-Z][A-Z0-9_]+$/i.test(text)
      ? (IDENTIFIER.test(text) ? text.split("-")[0] : text)
      : undefined;
    const pql = text && !projectHint && !UUID.test(text) && !/^[A-Z][A-Z0-9_]+$/i.test(text) ? text : undefined;
    const projectId = await resolveProjectId(ctx, projectHint && !IDENTIFIER.test(text) ? projectHint : undefined);
    if (!projectId) return { items: [] };
    ctx.log("Queried Plane work items.");
    const params = new URLSearchParams({ per_page: "50", expand: "state,assignees", order_by: "updated_at" });
    if (pql) params.set("pql", pql);
    if (cursor) params.set("cursor", cursor);
    const result = await planeRequest(ctx, `/projects/${projectId}/work-items/?${params}`);
    if (!result.ok) throw new Error(result.error);
    const rows = pageItems<PlaneWorkItem>(result.body);
    const items = rows.flatMap(item => {
      const identifier = identifierOf(item, ctx);
      return identifier ? syncedWorkItem(item, ctx, identifier) ?? [] : [];
    });
    const next = nextCursor(result.body);
    return { items, ...(next ? { cursor: next } : {}) };
  },
  async changes(ctx, scope: WatchScope, cursor: string | null) {
    const projectId = await resolveProjectId(ctx, typeof scope.project === "string" ? scope.project : undefined);
    if (!projectId) return { changes: [], cursor: cursor ?? "" };
    const since = cursor && Date.parse(cursor) ? Date.parse(cursor) : 0;
    const params = new URLSearchParams({ per_page: "50", expand: "state,assignees", order_by: "updated_at" });
    const filters = [
      typeof scope.query === "string" && scope.query.trim() ? scope.query.trim() : "",
      since ? `updatedAt > "${new Date(since).toISOString()}"` : "",
    ].filter(Boolean);
    if (filters.length) params.set("pql", filters.join(" AND "));
    const result = await planeRequest(ctx, `/projects/${projectId}/work-items/?${params}`);
    if (!result.ok) throw new Error(result.error);
    const rows = pageItems<PlaneWorkItem>(result.body)
      .filter(item => when(item.updated_at) > since)
      .sort((left, right) => when(left.updated_at) - when(right.updated_at));
    const changes = rows.flatMap(raw => {
      const identifier = identifierOf(raw, ctx);
      const item = identifier ? syncedWorkItem(raw, ctx, identifier) : null;
      return item ? [toChange(item, raw, ctx, changeType(raw, since))] : [];
    });
    const latest = rows.at(-1)?.updated_at ?? cursor ?? new Date(since || Date.now()).toISOString();
    if (changes.length) ctx.log(`Plane changes named ${changes.length} item(s).`);
    return { changes, cursor: latest };
  },
  capture: captureRules,
};
