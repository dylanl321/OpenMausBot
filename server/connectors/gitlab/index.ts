import { timingSafeEqual } from "node:crypto";
import type { LinkKind, StatusCategory, SyncedItem } from "../../../shared/work-links.ts";
import type { CaptureCall, CaptureRule, ConnectionContext, Connector } from "../types.ts";

const PREVIEW_CUT = "[… preview shortened]";
const PROJECT = "((?:[\\w.-]+/)+[\\w.-]+)";
const SHA = "([0-9a-f]{7,40})";
const QUALIFIED_MR = new RegExp(`^${PROJECT}!(\\d+)$`, "i");
const SHORT_MR = /^!(\d+)$/;
const QUALIFIED_NOTE = new RegExp(`^${PROJECT}!(\\d+):note:(\\d+)$`, "i");
const SHORT_NOTE = /^!(\d+):note:(\d+)$/;
const QUALIFIED_THREAD = new RegExp(`^${PROJECT}!(\\d+):thread:([\\w.-]+)$`, "i");
const SHORT_THREAD = /^!(\d+):thread:([\w.-]+)$/;
const QUALIFIED_COMMIT = new RegExp(`^${PROJECT}@${SHA}$`, "i");
const BARE_COMMIT = new RegExp(`^${SHA}$`, "i");
const QUALIFIED_PIPELINE = new RegExp(`^${PROJECT}#pipeline:(\\d+)$`, "i");
const SHORT_PIPELINE = /^pipeline:(\d+)$/;
const PROJECT_PATH = /^(?:[\w.-]+\/)+[\w.-]+$/;
const MR_IN_TEXT = new RegExp(`${PROJECT}!(\\d+)|!(\\d+)`, "i");
const PIPELINE_IN_TEXT = /(?:pipeline|Pipeline)[:\s#]+(\d+)|\b#(\d+)\b.*pipeline/i;
const NOTE_IN_TEXT = /#note_(\d+)|(?:note|comment)(?:\s*id)?[:\s#]+(\d+)/i;
const THREAD_IN_TEXT = /(?:thread|discussion)[:\s#]+([\w.-]+)/i;

export const GITLAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 13 8 3l5 10"/><path d="M5.5 13a2.5 2.5 0 0 1 5 0"/></svg>`;

interface GitlabUser {
  username?: string;
}

interface GitlabProject {
  path_with_namespace?: string;
  web_url?: string;
}

interface GitlabPipelineRef {
  id?: number;
  status?: string;
  web_url?: string;
}

interface GitlabMergeRequest {
  iid?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  has_conflicts?: boolean;
  web_url?: string;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  updated_at?: string;
  head_pipeline?: GitlabPipelineRef | null;
}

interface GitlabApprovals {
  approvals_required?: number;
  approvals_left?: number;
  approved?: boolean;
}

interface GitlabCommit {
  id?: string;
  short_id?: string;
  title?: string;
  author_name?: string;
  committed_date?: string;
  web_url?: string;
  status?: string;
}

interface GitlabPipeline {
  id?: number;
  status?: string;
  ref?: string;
  sha?: string;
  web_url?: string;
  updated_at?: string;
}

interface GitlabJob {
  name?: string;
  stage?: string;
  status?: string;
}

interface GitlabNotePosition {
  new_path?: string;
  new_line?: number;
  old_path?: string;
  old_line?: number;
}

interface GitlabNote {
  id?: number;
  body?: string;
  created_at?: string;
  updated_at?: string;
  resolvable?: boolean;
  resolved?: boolean;
  position?: GitlabNotePosition | null;
}

interface GitlabDiscussion {
  id?: string;
  individual_note?: boolean;
  notes?: GitlabNote[];
}

type StructuredRef =
  | { kind: "change_request"; project: string; iid: string; externalId: string }
  | { kind: "commit"; project: string; sha: string; externalId: string }
  | { kind: "build"; project: string; pipelineId: string; externalId: string }
  | { kind: "comment"; project: string; iid: string; noteId?: string; threadId?: string; externalId: string };

const PIPELINE_STATUS: Record<string, StatusCategory> = {
  success: "done",
  failed: "blocked",
  canceled: "cancelled",
  cancelled: "cancelled",
  skipped: "cancelled",
  manual: "todo",
  scheduled: "todo",
  created: "in_progress",
  waiting_for_resource: "in_progress",
  preparing: "in_progress",
  pending: "in_progress",
  running: "in_progress",
};

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

function defaultProject(ctx: ConnectionContext): string | null {
  const raw = String(ctx.settings.project ?? "").trim();
  return PROJECT_PATH.test(raw) ? raw.replace(/\/+$/, "") : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function projectPath(value: string): string {
  return encodeURIComponent(value);
}

function mrId(project: string, iid: string): string {
  return `${project}!${iid}`;
}

function commitId(project: string, sha: string): string {
  return `${project}@${sha.toLowerCase()}`;
}

function pipelineId(project: string, id: string): string {
  return `${project}#pipeline:${id}`;
}

function noteId(project: string, iid: string, id: string): string {
  return `${project}!${iid}:note:${id}`;
}

function threadId(project: string, iid: string, id: string): string {
  return `${project}!${iid}:thread:${id}`;
}

function when(value: string | undefined): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function apiError(status: number): string {
  if (status === 401 || status === 403) return "GitLab rejected the credentials.";
  if (status === 429) return "GitLab rate limited the request.";
  return `GitLab returned ${status}.`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function gitlabRequest(
  ctx: ConnectionContext,
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; status: number; body: unknown; headers: Headers } | { ok: false; error: string }> {
  const site = siteUrl(ctx);
  if (!site) return { ok: false, error: "Instance URL is required." };
  const token = ctx.secret("token");
  if (!token) return { ok: false, error: "Personal or project access token is required." };
  const response = await ctx.fetch(`${site}/api/v4${path}`, {
    ...init,
    headers: { "PRIVATE-TOKEN": token, accept: "application/json", ...init?.headers },
  });
  if (!response.ok) return { ok: false, error: apiError(response.status) };
  return { ok: true, status: response.status, body: await readJson(response), headers: response.headers };
}

function hostMatches(url: URL, ctx: ConnectionContext): boolean {
  const site = siteUrl(ctx);
  if (!site) return true;
  try {
    return url.host === new URL(site).host;
  } catch {
    return false;
  }
}

function parseUrlRef(input: string, ctx: ConnectionContext): StructuredRef | null {
  let url: URL;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!hostMatches(url, ctx)) return null;
  const mr = /\/-\/merge_requests\/(\d+)/i.exec(url.pathname) ?? /\/merge_requests\/(\d+)/i.exec(url.pathname);
  if (mr) {
    const marker = url.pathname.includes("/-/merge_requests/") ? "/-/merge_requests/" : "/merge_requests/";
    const project = url.pathname.slice(1, url.pathname.toLowerCase().indexOf(marker)).replace(/\/$/, "");
    if (!project || !PROJECT_PATH.test(project)) return null;
    const note = /^note_(\d+)$/i.exec(url.hash.replace(/^#/, ""));
    if (note) return { kind: "comment", project, iid: mr[1], noteId: note[1], externalId: noteId(project, mr[1], note[1]) };
    return { kind: "change_request", project, iid: mr[1], externalId: mrId(project, mr[1]) };
  }
  const commit = /\/-\/commit\/([0-9a-f]{7,40})/i.exec(url.pathname);
  if (commit) {
    const project = url.pathname.slice(1, url.pathname.toLowerCase().indexOf("/-/commit/")).replace(/\/$/, "");
    if (!project || !PROJECT_PATH.test(project)) return null;
    return { kind: "commit", project, sha: commit[1].toLowerCase(), externalId: commitId(project, commit[1]) };
  }
  const pipeline = /\/-\/pipelines\/(\d+)/i.exec(url.pathname);
  if (pipeline) {
    const project = url.pathname.slice(1, url.pathname.toLowerCase().indexOf("/-/pipelines/")).replace(/\/$/, "");
    if (!project || !PROJECT_PATH.test(project)) return null;
    return { kind: "build", project, pipelineId: pipeline[1], externalId: pipelineId(project, pipeline[1]) };
  }
  return null;
}

function parseExternalId(input: string, ctx: ConnectionContext): StructuredRef | null {
  const text = input.trim();
  const project = defaultProject(ctx);
  const qualifiedNote = QUALIFIED_NOTE.exec(text);
  if (qualifiedNote) return { kind: "comment", project: qualifiedNote[1], iid: qualifiedNote[2], noteId: qualifiedNote[3], externalId: noteId(qualifiedNote[1], qualifiedNote[2], qualifiedNote[3]) };
  const shortNote = SHORT_NOTE.exec(text);
  if (shortNote && project) return { kind: "comment", project, iid: shortNote[1], noteId: shortNote[2], externalId: noteId(project, shortNote[1], shortNote[2]) };
  const qualifiedThread = QUALIFIED_THREAD.exec(text);
  if (qualifiedThread) return { kind: "comment", project: qualifiedThread[1], iid: qualifiedThread[2], threadId: qualifiedThread[3], externalId: threadId(qualifiedThread[1], qualifiedThread[2], qualifiedThread[3]) };
  const shortThread = SHORT_THREAD.exec(text);
  if (shortThread && project) return { kind: "comment", project, iid: shortThread[1], threadId: shortThread[2], externalId: threadId(project, shortThread[1], shortThread[2]) };
  const qualifiedMr = QUALIFIED_MR.exec(text);
  if (qualifiedMr) return { kind: "change_request", project: qualifiedMr[1], iid: qualifiedMr[2], externalId: mrId(qualifiedMr[1], qualifiedMr[2]) };
  const shortMr = SHORT_MR.exec(text);
  if (shortMr) {
    return project
      ? { kind: "change_request", project, iid: shortMr[1], externalId: mrId(project, shortMr[1]) }
      : { kind: "change_request", project: "", iid: shortMr[1], externalId: `!${shortMr[1]}` };
  }
  const qualifiedPipeline = QUALIFIED_PIPELINE.exec(text);
  if (qualifiedPipeline) return { kind: "build", project: qualifiedPipeline[1], pipelineId: qualifiedPipeline[2], externalId: pipelineId(qualifiedPipeline[1], qualifiedPipeline[2]) };
  const shortPipeline = SHORT_PIPELINE.exec(text);
  if (shortPipeline && project) return { kind: "build", project, pipelineId: shortPipeline[1], externalId: pipelineId(project, shortPipeline[1]) };
  const qualifiedCommit = QUALIFIED_COMMIT.exec(text);
  if (qualifiedCommit) return { kind: "commit", project: qualifiedCommit[1], sha: qualifiedCommit[2].toLowerCase(), externalId: commitId(qualifiedCommit[1], qualifiedCommit[2]) };
  const bareCommit = BARE_COMMIT.exec(text);
  if (bareCommit) {
    const sha = bareCommit[1].toLowerCase();
    return project
      ? { kind: "commit", project, sha, externalId: commitId(project, sha) }
      : { kind: "commit", project: "", sha, externalId: sha };
  }
  return null;
}

function parseStructured(input: string, ctx: ConnectionContext): StructuredRef | null {
  const text = input.trim();
  if (/^https?:\/\//i.test(text)) return parseUrlRef(text, ctx);
  return parseExternalId(text, ctx);
}

function mapPipelineStatus(status: string | undefined): StatusCategory {
  return PIPELINE_STATUS[(status ?? "").toLowerCase()] ?? "unknown";
}

function mapMrState(mr: GitlabMergeRequest): { label: string; category: StatusCategory } {
  const state = (mr.state ?? "unknown").toLowerCase();
  if (state === "merged") return { label: "merged", category: "done" };
  if (state === "closed") return { label: "closed", category: "cancelled" };
  if (state === "locked") return { label: "locked", category: "blocked" };
  if (mr.has_conflicts) return { label: "conflicts", category: "blocked" };
  if (mr.draft || mr.work_in_progress) return { label: "draft", category: "in_progress" };
  if (state === "opened") return { label: "opened", category: "in_review" };
  return { label: (mr.state ?? "unknown").slice(0, 80), category: "unknown" };
}

function mrDetails(mr: GitlabMergeRequest, approvals?: GitlabApprovals | null): SyncedItem["details"] {
  const details: Record<string, string | number | boolean> = {};
  details.draft = Boolean(mr.draft || mr.work_in_progress);
  details.conflicts = Boolean(mr.has_conflicts);
  if (mr.source_branch) details.source = mr.source_branch;
  if (mr.target_branch) details.target = mr.target_branch;
  if (mr.head_pipeline?.status) details.pipeline = mr.head_pipeline.status;
  if (mr.head_pipeline?.id != null) details.pipelineId = mr.head_pipeline.id;
  if (approvals && approvals.approvals_required != null) {
    const required = approvals.approvals_required;
    const left = approvals.approvals_left ?? 0;
    details.approvals = `${Math.max(0, required - left)}/${required}`;
    details.approvalsLeft = left;
  }
  return details;
}

function syncedMr(mr: GitlabMergeRequest, ctx: ConnectionContext, project: string, approvals?: GitlabApprovals | null): SyncedItem | null {
  if (mr.iid == null) return null;
  const iid = String(mr.iid);
  return {
    kind: "change_request",
    externalId: mrId(project, iid),
    title: (mr.title ?? `!${iid}`).slice(0, 300) || `!${iid}`,
    url: mr.web_url ?? `${siteUrl(ctx)}/${project}/-/merge_requests/${iid}`,
    state: mapMrState(mr),
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    details: mrDetails(mr, approvals),
    updatedAt: when(mr.updated_at),
    syncedAt: Date.now(),
  };
}

function syncedCommit(commit: GitlabCommit, ctx: ConnectionContext, project: string, sha: string): SyncedItem {
  const id = commit.short_id ?? commit.id ?? sha;
  const details: Record<string, string> = {};
  if (commit.author_name) details.author = commit.author_name;
  if (commit.status) details.pipeline = commit.status;
  return {
    kind: "commit",
    externalId: commitId(project, sha),
    title: (commit.title ?? `commit ${id}`).slice(0, 300),
    url: commit.web_url ?? `${siteUrl(ctx)}/${project}/-/commit/${commit.id ?? sha}`,
    ...(commit.status ? { state: { label: commit.status.slice(0, 80), category: mapPipelineStatus(commit.status) } } : {}),
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    details: Object.keys(details).length ? details : undefined,
    updatedAt: when(commit.committed_date),
    syncedAt: Date.now(),
  };
}

function stageStatus(jobs: GitlabJob[]): Record<string, string> {
  const stages: Record<string, string> = {};
  const rank = (status: string) => ({ failed: 4, canceled: 3, running: 2, pending: 2, success: 1 }[status] ?? 0);
  for (const job of jobs) {
    const stage = (job.stage ?? "").trim();
    const status = (job.status ?? "").trim();
    if (!stage || !status) continue;
    const key = `stage.${stage}`.slice(0, 40);
    if (!stages[key] || rank(status) > rank(stages[key])) stages[key] = status;
  }
  return stages;
}

function syncedPipeline(pipeline: GitlabPipeline, ctx: ConnectionContext, project: string, jobs: GitlabJob[]): SyncedItem {
  const id = String(pipeline.id ?? "");
  const status = pipeline.status ?? "unknown";
  return {
    kind: "build",
    externalId: pipelineId(project, id),
    title: `pipeline ${id}`.slice(0, 300),
    url: pipeline.web_url ?? `${siteUrl(ctx)}/${project}/-/pipelines/${id}`,
    state: { label: status.slice(0, 80), category: mapPipelineStatus(status) },
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    details: {
      ...(pipeline.ref ? { ref: pipeline.ref } : {}),
      ...(pipeline.sha ? { sha: pipeline.sha.slice(0, 40) } : {}),
      ...stageStatus(jobs),
    },
    updatedAt: when(pipeline.updated_at),
    syncedAt: Date.now(),
  };
}

function findDiscussion(discussions: GitlabDiscussion[], ref: Extract<StructuredRef, { kind: "comment" }>): { discussion: GitlabDiscussion; note?: GitlabNote } | null {
  for (const discussion of discussions) {
    if (ref.threadId && discussion.id === ref.threadId) return { discussion, note: discussion.notes?.[0] };
    const note = discussion.notes?.find(entry => ref.noteId && String(entry.id) === ref.noteId);
    if (note) return { discussion, note };
  }
  return null;
}

function commentState(discussion: GitlabDiscussion, note: GitlabNote | undefined): SyncedItem["state"] {
  const resolvable = discussion.notes?.some(entry => entry.resolvable) ?? note?.resolvable;
  if (!resolvable) return { label: "comment", category: "unknown" };
  const resolved = discussion.notes?.every(entry => !entry.resolvable || entry.resolved) ?? Boolean(note?.resolved);
  return resolved ? { label: "resolved", category: "done" } : { label: "open", category: "in_review" };
}

function syncedComment(ref: Extract<StructuredRef, { kind: "comment" }>, ctx: ConnectionContext, discussions: GitlabDiscussion[]): SyncedItem {
  const found = findDiscussion(discussions, ref);
  const note = found?.note;
  const position = note?.position;
  const file = position?.new_path ?? position?.old_path;
  const line = position?.new_line ?? position?.old_line;
  const details: Record<string, string | number | boolean> = { mr: mrId(ref.project, ref.iid) };
  if (file) details.file = file;
  if (line != null) details.line = line;
  if (found?.discussion.id) details.thread = found.discussion.id;
  const title = (note?.body ?? `Comment on !${ref.iid}`).replace(/\s+/g, " ").trim().slice(0, 80) || `Comment on !${ref.iid}`;
  return {
    kind: "comment",
    externalId: ref.externalId,
    title,
    url: `${siteUrl(ctx)}/${ref.project}/-/merge_requests/${ref.iid}${ref.noteId ? `#note_${ref.noteId}` : ""}`,
    state: found ? commentState(found.discussion, note) : { label: "open", category: "in_review" },
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    details,
    updatedAt: when(note?.updated_at ?? note?.created_at),
    syncedAt: Date.now(),
  };
}

function stub(ref: { kind: LinkKind; externalId: string }, ctx: ConnectionContext): SyncedItem {
  return {
    kind: ref.kind,
    externalId: ref.externalId,
    title: ref.externalId,
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    updatedAt: Date.now(),
  };
}

export function verifyGitlabWebhook(secret: string, header: string | null): boolean {
  if (!header) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function webhookProject(body: Record<string, unknown>): string | null {
  const project = body.project as { path_with_namespace?: unknown } | undefined;
  const path = typeof project?.path_with_namespace === "string" ? project.path_with_namespace : "";
  return PROJECT_PATH.test(path) ? path : null;
}

function webhookRefs(body: unknown): { kind: LinkKind; externalId: string }[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const project = webhookProject(record);
  if (!project) return [];
  const kind = typeof record.object_kind === "string" ? record.object_kind : "";
  const attrs = (record.object_attributes ?? {}) as Record<string, unknown>;
  if (kind === "merge_request") {
    const iid = attrs.iid;
    if (typeof iid !== "number" && typeof iid !== "string") return [];
    const refs: { kind: LinkKind; externalId: string }[] = [{ kind: "change_request", externalId: mrId(project, String(iid)) }];
    if (typeof attrs.head_pipeline_id === "number" || typeof attrs.head_pipeline_id === "string") {
      refs.push({ kind: "build", externalId: pipelineId(project, String(attrs.head_pipeline_id)) });
    }
    return refs;
  }
  if (kind === "pipeline") {
    const id = attrs.id;
    if (typeof id !== "number" && typeof id !== "string") return [];
    const refs: { kind: LinkKind; externalId: string }[] = [{ kind: "build", externalId: pipelineId(project, String(id)) }];
    const mr = record.merge_request as { iid?: unknown } | undefined;
    if (typeof mr?.iid === "number" || typeof mr?.iid === "string") refs.push({ kind: "change_request", externalId: mrId(project, String(mr.iid)) });
    return refs;
  }
  if (kind === "note") {
    if (attrs.noteable_type !== "MergeRequest") return [];
    const mr = record.merge_request as { iid?: unknown } | undefined;
    const iid = mr?.iid;
    const note = attrs.id;
    if ((typeof iid !== "number" && typeof iid !== "string") || (typeof note !== "number" && typeof note !== "string")) return [];
    return [
      { kind: "change_request", externalId: mrId(project, String(iid)) },
      { kind: "comment", externalId: noteId(project, String(iid), String(note)) },
    ];
  }
  return [];
}

function previewSource(call: CaptureCall): string | null {
  const output = call.output ?? "";
  if (output.includes(PREVIEW_CUT)) {
    const head = output.split(PREVIEW_CUT)[0] ?? "";
    if (!MR_IN_TEXT.test(head) && !/\/-\/merge_requests\/\d+/i.test(head) && !/\/-\/pipelines\/\d+/i.test(head) && !NOTE_IN_TEXT.test(head)) {
      return null;
    }
    return `${head}\n${call.summary ?? ""}\n${call.input ?? ""}`;
  }
  return `${output}\n${call.summary ?? ""}\n${call.input ?? ""}`;
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

function projectFromText(text: string, ctx: ConnectionContext): string | null {
  const url = /https?:\/\/[^\s]+\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:merge_requests|commit|pipelines)\//i.exec(text);
  if (url) return url[1];
  const qualified = new RegExp(`${PROJECT}!\\d+`, "i").exec(text);
  if (qualified) return qualified[1];
  const repo = /--repo[=\s]+([^\s]+)/.exec(text);
  if (repo && PROJECT_PATH.test(repo[1])) return repo[1];
  return defaultProject(ctx);
}

function mrFromText(text: string, ctx: ConnectionContext): { project: string; iid: string; externalId: string } | null {
  const url = parseUrlRef((/https?:\/\/[^\s<>"')\]]+/i.exec(text) ?? [])[0] ?? "", ctx);
  if (url?.kind === "change_request") return { project: url.project, iid: url.iid, externalId: url.externalId };
  if (url?.kind === "comment") return { project: url.project, iid: url.iid, externalId: mrId(url.project, url.iid) };
  const qualified = QUALIFIED_MR.exec((new RegExp(`${PROJECT}!(\\d+)`, "i").exec(text) ?? [])[0] ?? "");
  if (qualified) return { project: qualified[1], iid: qualified[2], externalId: mrId(qualified[1], qualified[2]) };
  const short = /!(\d+)/.exec(text);
  const project = projectFromText(text, ctx);
  if (short && project) return { project, iid: short[1], externalId: mrId(project, short[1]) };
  return null;
}

function mergedRecord(call: CaptureCall): Record<string, unknown> | null {
  const output = jsonObject(call.output ?? "");
  const input = jsonObject(call.input ?? "");
  if (!output && !input) return null;
  return { ...input, ...output };
}

function projectFromJson(record: Record<string, unknown> | null): string | null {
  const value = record?.project ?? record?.project_path ?? record?.projectPath ?? record?.repo;
  return typeof value === "string" && PROJECT_PATH.test(value) ? value : null;
}

function iidFromJson(record: Record<string, unknown> | null): string | null {
  const nested = record?.merge_request && typeof record.merge_request === "object" ? record.merge_request as Record<string, unknown> : null;
  const value = record?.iid ?? record?.mergeRequestIid ?? record?.merge_request_iid ?? record?.noteable_iid ?? nested?.iid;
  return typeof value === "number" || typeof value === "string" ? String(value) : null;
}

function positionOf(record: Record<string, unknown> | null): { file?: string; line?: number } {
  const notes = Array.isArray(record?.notes) ? record.notes[0] : null;
  const raw = (record?.position ?? (notes && typeof notes === "object" ? (notes as Record<string, unknown>).position : null)) as Record<string, unknown> | null;
  const file = typeof raw?.new_path === "string" ? raw.new_path : typeof raw?.old_path === "string" ? raw.old_path : undefined;
  const line = typeof raw?.new_line === "number" ? raw.new_line : typeof raw?.old_line === "number" ? raw.old_line : undefined;
  return { ...(file ? { file } : {}), ...(line != null ? { line } : {}) };
}

function extractMr(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const text = previewSource(call);
  if (!text) return null;
  const json = mergedRecord(call);
  const context = emptyCtx();
  const web = typeof json?.web_url === "string" ? json.web_url : "";
  const fromUrl = web ? parseUrlRef(web, context) : null;
  const iid = iidFromJson(json);
  const project = (fromUrl && "project" in fromUrl ? fromUrl.project : null) ?? projectFromJson(json) ?? projectFromText(`${web}\n${text}`, context);
  if (iid && project) {
    return {
      externalId: mrId(project, iid),
      url: web || undefined,
      title: typeof json?.title === "string" ? json.title : `!${iid}`,
      details: { mr: mrId(project, iid) },
    };
  }
  const parsed = mrFromText(text, context);
  if (!parsed) return null;
  const title = /!\d+\s+(.+)/.exec(text)?.[1]?.split("\n")[0]?.trim();
  return { externalId: parsed.externalId, title: title || parsed.externalId, url: (/https?:\/\/[^\s]+\/-\/merge_requests\/\d+/i.exec(text) ?? [])[0] };
}

function extractComment(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const text = previewSource(call);
  if (!text) return null;
  const context = emptyCtx();
  const json = mergedRecord(call);
  const mr = mrFromText(text, context);
  const noteMatch = NOTE_IN_TEXT.exec(text);
  const threadMatch = THREAD_IN_TEXT.exec(text);
  const web = typeof json?.web_url === "string" ? json.web_url : (/https?:\/\/[^\s]+#note_\d+/i.exec(text) ?? [])[0];
  const fromUrl = web ? parseUrlRef(web, context) : null;
  const project = (fromUrl && "project" in fromUrl ? fromUrl.project : null) ?? mr?.project ?? projectFromJson(json) ?? projectFromText(text, context);
  const iid = (fromUrl && "iid" in fromUrl ? fromUrl.iid : null) ?? mr?.iid ?? iidFromJson(json);
  const notes = Array.isArray(json?.notes) ? json.notes[0] : null;
  const nestedNote = notes && typeof notes === "object" ? (notes as Record<string, unknown>).id : null;
  const rawId = json?.id ?? json?.note_id;
  const numericNote = typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId));
  const noteKey = (fromUrl && fromUrl.kind === "comment" ? fromUrl.noteId : null)
    ?? (typeof nestedNote === "number" || typeof nestedNote === "string" ? String(nestedNote) : null)
    ?? (numericNote ? String(rawId) : null)
    ?? noteMatch?.[1] ?? noteMatch?.[2];
  const threadKey = (typeof rawId === "string" && !numericNote ? rawId : null) ?? threadMatch?.[1];
  if (!project || !iid) return null;
  const parentRef = mrId(project, iid);
  const position = positionOf(json);
  const details: Record<string, string | number | boolean> = { mr: parentRef };
  if (position.file) details.file = position.file;
  if (position.line != null) details.line = position.line;
  if (threadKey) details.thread = threadKey;
  return {
    externalId: noteKey ? noteId(project, iid, noteKey) : threadKey ? threadId(project, iid, threadKey) : parentRef,
    parentRef,
    title: `Comment on !${iid}`,
    url: web,
    details,
  };
}

function extractPipeline(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const text = previewSource(call);
  if (!text) return null;
  const context = emptyCtx();
  const url = (/https?:\/\/[^\s]+\/-\/pipelines\/\d+/i.exec(text) ?? [])[0];
  const parsed = url ? parseUrlRef(url, context) : null;
  if (parsed?.kind === "build") return { externalId: parsed.externalId, url, title: `pipeline ${parsed.pipelineId}` };
  const id = PIPELINE_IN_TEXT.exec(text)?.[1] ?? PIPELINE_IN_TEXT.exec(text)?.[2];
  const project = projectFromText(text, context);
  if (!id || !project) return null;
  return { externalId: pipelineId(project, id), title: `pipeline ${id}`, url };
}

function emptyCtx(): ConnectionContext {
  return {
    connectionId: "gitlab",
    settings: {},
    secret() { return undefined; },
    fetch: globalThis.fetch,
    log() {},
  };
}

const captureRules: CaptureRule[] = [
  {
    match: { tool: /create[_-]?merge[_-]?request(?![_\s-]?(?:note|thread|discussion|comment))|(?:gitlab|glab)[_-].*[_-](?:mr|merge_request)[_-]?create|GITLAB_CREATE_MERGE_REQUEST\b|\bmr_create\b/i },
    on: "completed",
    produce: { kind: "change_request" },
    extract: call => extractMr(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { command: /^glab\s+mr\s+create\b/ },
    on: "completed",
    produce: { kind: "change_request" },
    extract: call => extractMr(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /(?:merge[_-]?request|mr).*(?:note|comment|thread|discussion)|create[_-]?merge[_-]?request[_-]?(?:note|thread|discussion)|create[_-]?note\b|GITLAB_.*(?:NOTE|COMMENT)|mr_note|create_merge_request_thread/i },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => extractComment(call),
    event: item => `commented on ${String(item.details?.mr ?? item.externalId ?? item.title).split(":")[0]}`,
  },
  {
    match: { command: /^glab\s+mr\s+(?:note|comment|discuss)\b/ },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => extractComment(call),
    event: item => `commented on ${String(item.details?.mr ?? item.externalId ?? item.title).split(":")[0]}`,
  },
  {
    match: { tool: /(?:gitlab|glab).*(?:pipeline|ci_status)|create[_-]?pipeline|GITLAB_.*PIPELINE|\bci_status\b/i },
    on: "completed",
    produce: { kind: "build" },
    extract: call => extractPipeline(call),
    event: item => `ran ${item.externalId ?? item.title}`,
  },
  {
    match: { command: /^glab\s+(?:ci|pipeline)\b/ },
    on: "completed",
    produce: { kind: "build" },
    extract: call => extractPipeline(call),
    event: item => `ran ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /merge[_-]merge[_-]?request|(?:gitlab|glab).*mr[_-](?:merge|close)|GITLAB_MERGE_MERGE_REQUEST\b/i },
    on: "completed",
    produce: { kind: "change_request" },
    eventKind: "state_change",
    extract: call => extractMr(call),
    event: item => `updated ${item.externalId ?? item.title}`,
  },
  {
    match: { command: /^glab\s+mr\s+(?:merge|close)\b/ },
    on: "completed",
    produce: { kind: "change_request" },
    eventKind: "state_change",
    extract: call => extractMr(call),
    event: item => `updated ${item.externalId ?? item.title}`,
  },
];

export const gitlabConnector: Connector = {
  manifest: {
    id: "gitlab",
    name: "GitLab",
    icon: GITLAB_ICON,
    kinds: ["change_request", "commit", "build", "comment"],
    settings: [
      { key: "site", label: "Instance URL", type: "string", help: "https://gitlab.com or your self-managed GitLab URL" },
      { key: "project", label: "Default project", type: "string", help: "group/project used for !482, commit hashes, and merge-request queries" },
    ],
    secrets: [
      { key: "token", label: "Access token", help: "Personal or project access token with read_api" },
      { key: "webhookSecret", label: "Webhook token", help: "Optional. Compared to the X-Gitlab-Token header on webhook deliveries." },
    ],
    capabilities: { webhooks: true, query: true, poll: true },
    statusDefaults: {
      opened: "in_review",
      draft: "in_progress",
      conflicts: "blocked",
      merged: "done",
      closed: "cancelled",
      locked: "blocked",
      success: "done",
      failed: "blocked",
      running: "in_progress",
      pending: "in_progress",
      resolved: "done",
      open: "in_review",
    },
  },
  async test(ctx) {
    const project = defaultProject(ctx);
    if (project) {
      const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}`);
      if (result.ok) {
        const body = result.body as GitlabProject | null;
        ctx.log("GitLab credentials were accepted.");
        return { ok: true, account: body?.path_with_namespace ?? project };
      }
      if (!result.error.includes("rejected")) return result;
    }
    const result = await gitlabRequest(ctx, "/user");
    if (!result.ok) return result;
    const user = result.body as GitlabUser | null;
    const site = siteUrl(ctx);
    ctx.log("GitLab credentials were accepted.");
    return { ok: true, account: user?.username ?? (site ? new URL(site).host : "gitlab") };
  },
  parseRef(input, ctx) {
    const parsed = parseStructured(input, ctx);
    return parsed ? { kind: parsed.kind, externalId: parsed.externalId } : null;
  },
  urlPatterns(ctx) {
    const site = siteUrl(ctx);
    const base = site ? escapeRegExp(site) : "https?://[^\\s/]+";
    return [
      new RegExp(`^${base}/[^\\s]+/merge_requests/\\d+`, "i"),
      new RegExp(`^${base}/[^\\s]+/-/commit/${SHA.slice(1, -1)}`, "i"),
      new RegExp(`^${base}/[^\\s]+/-/pipelines/\\d+`, "i"),
    ];
  },
  async fetch(ctx, refs) {
    const resolved = refs.map(ref => ({ ref, parsed: parseStructured(ref.externalId, ctx) }));
    const mrs = new Map<string, GitlabMergeRequest>();
    const approvals = new Map<string, GitlabApprovals | null>();
    const discussions = new Map<string, GitlabDiscussion[]>();
    const commits = new Map<string, GitlabCommit>();
    const pipelines = new Map<string, { pipeline: GitlabPipeline; jobs: GitlabJob[] }>();
    const wantedMrs = new Set<string>();
    const wantedDiscussions = new Set<string>();
    for (const { ref, parsed } of resolved) {
      if (!parsed?.project || parsed.kind !== ref.kind) continue;
      if (parsed.kind === "change_request" || parsed.kind === "comment") wantedMrs.add(`${parsed.project}\t${parsed.iid}`);
      if (parsed.kind === "comment") wantedDiscussions.add(`${parsed.project}\t${parsed.iid}`);
    }
    await Promise.all([...wantedMrs].map(async key => {
      const [project, iid] = key.split("\t");
      const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/merge_requests/${iid}`);
      if (result.ok && result.body && typeof result.body === "object") mrs.set(key, result.body as GitlabMergeRequest);
      const approval = await gitlabRequest(ctx, `/projects/${projectPath(project)}/merge_requests/${iid}/approvals`);
      approvals.set(key, approval.ok && approval.body && typeof approval.body === "object" ? approval.body as GitlabApprovals : null);
    }));
    await Promise.all([...wantedDiscussions].map(async key => {
      const [project, iid] = key.split("\t");
      const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/merge_requests/${iid}/discussions`);
      discussions.set(key, result.ok && Array.isArray(result.body) ? result.body as GitlabDiscussion[] : []);
    }));
    await Promise.all(resolved.map(async ({ ref, parsed }) => {
      if (!parsed || parsed.kind !== "commit" || ref.kind !== "commit" || !parsed.project) return;
      const result = await gitlabRequest(ctx, `/projects/${projectPath(parsed.project)}/repository/commits/${parsed.sha}`);
      if (result.ok && result.body && typeof result.body === "object") commits.set(parsed.externalId, result.body as GitlabCommit);
    }));
    await Promise.all(resolved.map(async ({ ref, parsed }) => {
      if (!parsed || parsed.kind !== "build" || ref.kind !== "build" || !parsed.project) return;
      const result = await gitlabRequest(ctx, `/projects/${projectPath(parsed.project)}/pipelines/${parsed.pipelineId}`);
      if (!result.ok || !result.body || typeof result.body !== "object") return;
      const jobs = await gitlabRequest(ctx, `/projects/${projectPath(parsed.project)}/pipelines/${parsed.pipelineId}/jobs`);
      pipelines.set(parsed.externalId, {
        pipeline: result.body as GitlabPipeline,
        jobs: jobs.ok && Array.isArray(jobs.body) ? jobs.body as GitlabJob[] : [],
      });
    }));
    const loaded = mrs.size + commits.size + pipelines.size + discussions.size;
    if (loaded) ctx.log(`Fetched ${loaded} GitLab item(s).`);
    return resolved.map(({ ref, parsed }) => {
      if (!parsed || parsed.kind !== ref.kind || !parsed.project) return stub(ref, ctx);
      if (parsed.kind === "change_request") {
        const key = `${parsed.project}\t${parsed.iid}`;
        const item = mrs.get(key);
        return item ? syncedMr(item, ctx, parsed.project, approvals.get(key)) ?? stub(ref, ctx) : stub(ref, ctx);
      }
      if (parsed.kind === "comment") {
        const key = `${parsed.project}\t${parsed.iid}`;
        return syncedComment(parsed, ctx, discussions.get(key) ?? []);
      }
      if (parsed.kind === "commit") {
        const item = commits.get(parsed.externalId);
        return item ? syncedCommit(item, ctx, parsed.project, parsed.sha) : stub(ref, ctx);
      }
      const item = pipelines.get(parsed.externalId);
      return item ? syncedPipeline(item.pipeline, ctx, parsed.project, item.jobs) : stub(ref, ctx);
    });
  },
  async query(ctx, query, cursor) {
    const text = query.trim();
    const project = PROJECT_PATH.test(text) ? text : defaultProject(ctx);
    const search = text && !PROJECT_PATH.test(text) ? text : undefined;
    if (!project) return { items: [] };
    ctx.log("Queried GitLab merge requests.");
    const page = cursor && /^\d+$/.test(cursor) ? cursor : "1";
    const params = new URLSearchParams({ state: "opened", per_page: "50", page });
    if (search) params.set("search", search);
    const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/merge_requests?${params}`);
    if (!result.ok) throw new Error(result.error);
    const rows = Array.isArray(result.body) ? result.body as GitlabMergeRequest[] : [];
    const items = rows.flatMap(mr => syncedMr(mr, ctx, project) ?? []);
    const next = result.headers.get("x-next-page");
    return { items, ...(next ? { cursor: next } : {}) };
  },
  async webhook(ctx, headers, body) {
    const secret = ctx.secret("webhookSecret");
    if (secret && !verifyGitlabWebhook(secret, headers.get("x-gitlab-token"))) {
      ctx.log("Ignored a GitLab webhook with a bad token.");
      return [];
    }
    let parsed: unknown = body;
    if (typeof body === "string") {
      try { parsed = JSON.parse(body); } catch { return []; }
    }
    const refs = webhookRefs(parsed);
    if (refs.length) ctx.log(`GitLab webhook named ${refs.length} item(s).`);
    return refs;
  },
  capture: captureRules,
};
