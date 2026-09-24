import { timingSafeEqual } from "node:crypto";
import type { LinkKind, StatusCategory, SyncedItem } from "../../../shared/work-links.ts";
import type { SourceChange } from "../../../shared/watches.ts";
import {
  connectionActor,
  encodeChangeCursor,
  parseChangeCursor,
  rememberSnapshot,
} from "../change-cursor.ts";
import type { CaptureCall, CaptureRule, ConnectionContext, Connector, WatchScope } from "../types.ts";

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
const QUALIFIED_ISSUE = new RegExp(`^${PROJECT}#(\\d+)$`, "i");
const SHORT_ISSUE = /^#(\d+)$/;
const QUALIFIED_ISSUE_NOTE = new RegExp(`^${PROJECT}#(\\d+):note:(\\d+)$`, "i");
const SHORT_ISSUE_NOTE = /^#(\d+):note:(\d+)$/;
const PROJECT_PATH = /^(?:[\w.-]+\/)+[\w.-]+$/;
const MR_IN_TEXT = new RegExp(`${PROJECT}!(\\d+)|!(\\d+)`, "i");
const ISSUE_IN_TEXT = new RegExp(`${PROJECT}#(\\d+)(?!:)|(?<!\\w)#(\\d+)\\b`, "i");
const PIPELINE_IN_TEXT = /(?:pipeline|Pipeline)[:\s#]+(\d+)|\b#(\d+)\b.*pipeline/i;
const NOTE_IN_TEXT = /#note_(\d+)|(?:note|comment)(?:\s*id)?[:\s#]+(\d+)/i;
const THREAD_IN_TEXT = /(?:thread|discussion)[:\s#]+([\w.-]+)/i;

export const GITLAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 13 8 3l5 10"/><path d="M5.5 13a2.5 2.5 0 0 1 5 0"/></svg>`;

interface GitlabUser {
  username?: string;
  name?: string;
  bot?: boolean;
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

interface GitlabIssue {
  iid?: number;
  title?: string;
  state?: string;
  web_url?: string;
  labels?: string[] | { name?: string }[];
  assignees?: { username?: string; name?: string }[];
  issue_type?: string;
  updated_at?: string;
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
  | { kind: "work_item"; project: string; iid: string; externalId: string }
  | { kind: "change_request"; project: string; iid: string; externalId: string }
  | { kind: "commit"; project: string; sha: string; externalId: string }
  | { kind: "build"; project: string; pipelineId: string; externalId: string }
  | { kind: "comment"; project: string; iid: string; noteId?: string; threadId?: string; on: "issue" | "mr"; externalId: string };

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

function issueId(project: string, iid: string): string {
  return `${project}#${iid}`;
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
    if (note) return { kind: "comment", project, iid: mr[1], noteId: note[1], on: "mr", externalId: noteId(project, mr[1], note[1]) };
    return { kind: "change_request", project, iid: mr[1], externalId: mrId(project, mr[1]) };
  }
  const issue = /\/-\/issues\/(\d+)/i.exec(url.pathname) ?? /\/issues\/(\d+)/i.exec(url.pathname);
  if (issue) {
    const marker = url.pathname.includes("/-/issues/") ? "/-/issues/" : "/issues/";
    const project = url.pathname.slice(1, url.pathname.toLowerCase().indexOf(marker)).replace(/\/$/, "");
    if (!project || !PROJECT_PATH.test(project)) return null;
    const note = /^note_(\d+)$/i.exec(url.hash.replace(/^#/, ""));
    if (note) return { kind: "comment", project, iid: issue[1], noteId: note[1], on: "issue", externalId: `${issueId(project, issue[1])}:note:${note[1]}` };
    return { kind: "work_item", project, iid: issue[1], externalId: issueId(project, issue[1]) };
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
  const qualifiedIssueNote = QUALIFIED_ISSUE_NOTE.exec(text);
  if (qualifiedIssueNote) return { kind: "comment", project: qualifiedIssueNote[1], iid: qualifiedIssueNote[2], noteId: qualifiedIssueNote[3], on: "issue", externalId: `${issueId(qualifiedIssueNote[1], qualifiedIssueNote[2])}:note:${qualifiedIssueNote[3]}` };
  const shortIssueNote = SHORT_ISSUE_NOTE.exec(text);
  if (shortIssueNote && project) return { kind: "comment", project, iid: shortIssueNote[1], noteId: shortIssueNote[2], on: "issue", externalId: `${issueId(project, shortIssueNote[1])}:note:${shortIssueNote[2]}` };
  const qualifiedNote = QUALIFIED_NOTE.exec(text);
  if (qualifiedNote) return { kind: "comment", project: qualifiedNote[1], iid: qualifiedNote[2], noteId: qualifiedNote[3], on: "mr", externalId: noteId(qualifiedNote[1], qualifiedNote[2], qualifiedNote[3]) };
  const shortNote = SHORT_NOTE.exec(text);
  if (shortNote && project) return { kind: "comment", project, iid: shortNote[1], noteId: shortNote[2], on: "mr", externalId: noteId(project, shortNote[1], shortNote[2]) };
  const qualifiedThread = QUALIFIED_THREAD.exec(text);
  if (qualifiedThread) return { kind: "comment", project: qualifiedThread[1], iid: qualifiedThread[2], threadId: qualifiedThread[3], on: "mr", externalId: threadId(qualifiedThread[1], qualifiedThread[2], qualifiedThread[3]) };
  const shortThread = SHORT_THREAD.exec(text);
  if (shortThread && project) return { kind: "comment", project, iid: shortThread[1], threadId: shortThread[2], on: "mr", externalId: threadId(project, shortThread[1], shortThread[2]) };
  const qualifiedMr = QUALIFIED_MR.exec(text);
  if (qualifiedMr) return { kind: "change_request", project: qualifiedMr[1], iid: qualifiedMr[2], externalId: mrId(qualifiedMr[1], qualifiedMr[2]) };
  const shortMr = SHORT_MR.exec(text);
  if (shortMr) {
    return project
      ? { kind: "change_request", project, iid: shortMr[1], externalId: mrId(project, shortMr[1]) }
      : { kind: "change_request", project: "", iid: shortMr[1], externalId: `!${shortMr[1]}` };
  }
  const qualifiedIssue = QUALIFIED_ISSUE.exec(text);
  if (qualifiedIssue) return { kind: "work_item", project: qualifiedIssue[1], iid: qualifiedIssue[2], externalId: issueId(qualifiedIssue[1], qualifiedIssue[2]) };
  const shortIssue = SHORT_ISSUE.exec(text);
  if (shortIssue) {
    return project
      ? { kind: "work_item", project, iid: shortIssue[1], externalId: issueId(project, shortIssue[1]) }
      : { kind: "work_item", project: "", iid: shortIssue[1], externalId: `#${shortIssue[1]}` };
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

function mapIssueState(issue: GitlabIssue): { label: string; category: StatusCategory } {
  const state = (issue.state ?? "unknown").toLowerCase();
  if (state === "opened") return { label: "opened", category: "todo" };
  if (state === "closed") return { label: "closed", category: "done" };
  return { label: (issue.state ?? "unknown").slice(0, 80), category: "unknown" };
}

function issueDetails(issue: GitlabIssue): SyncedItem["details"] {
  const details: Record<string, string | number | boolean> = {};
  const labels = (issue.labels ?? []).map(label => typeof label === "string" ? label : label.name ?? "").filter(Boolean);
  if (labels.length) details.labels = labels.slice(0, 8).join(", ").slice(0, 200);
  const assignee = issue.assignees?.[0]?.name ?? issue.assignees?.[0]?.username;
  if (assignee) details.assignee = assignee;
  if (issue.issue_type) details.type = issue.issue_type;
  return Object.keys(details).length ? details : undefined;
}

function syncedIssue(issue: GitlabIssue, ctx: ConnectionContext, project: string): SyncedItem | null {
  if (issue.iid == null) return null;
  const iid = String(issue.iid);
  return {
    kind: "work_item",
    externalId: issueId(project, iid),
    title: (issue.title ?? `#${iid}`).slice(0, 300) || `#${iid}`,
    url: issue.web_url ?? `${siteUrl(ctx)}/${project}/-/issues/${iid}`,
    state: mapIssueState(issue),
    connectorId: "gitlab",
    connectionId: ctx.connectionId,
    details: issueDetails(issue),
    updatedAt: when(issue.updated_at),
    syncedAt: Date.now(),
  };
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

function mrIidFromPipelineRef(ref: string | undefined): string | undefined {
  const match = /refs\/merge-requests\/(\d+)/i.exec(ref ?? "");
  return match?.[1];
}

function syncedPipeline(pipeline: GitlabPipeline, ctx: ConnectionContext, project: string, jobs: GitlabJob[] = []): SyncedItem {
  const id = String(pipeline.id ?? "");
  const status = pipeline.status ?? "unknown";
  const mrIid = mrIidFromPipelineRef(pipeline.ref);
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
      ...(mrIid ? { mr: mrId(project, mrIid) } : {}),
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
  const parent = ref.on === "issue" ? issueId(ref.project, ref.iid) : mrId(ref.project, ref.iid);
  const details: Record<string, string | number | boolean> = ref.on === "issue" ? { issue: parent } : { mr: parent };
  if (file) details.file = file;
  if (line != null) details.line = line;
  if (found?.discussion.id) details.thread = found.discussion.id;
  const mark = ref.on === "issue" ? `#${ref.iid}` : `!${ref.iid}`;
  const title = (note?.body ?? `Comment on ${mark}`).replace(/\s+/g, " ").trim().slice(0, 80) || `Comment on ${mark}`;
  const path = ref.on === "issue" ? "issues" : "merge_requests";
  return {
    kind: "comment",
    externalId: ref.externalId,
    title,
    url: `${siteUrl(ctx)}/${ref.project}/-/${path}/${ref.iid}${ref.noteId ? `#note_${ref.noteId}` : ""}`,
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
  if (kind === "issue") {
    const iid = attrs.iid;
    if (typeof iid !== "number" && typeof iid !== "string") return [];
    return [{ kind: "work_item", externalId: issueId(project, String(iid)) }];
  }
  if (kind === "note") {
    const note = attrs.id;
    if (attrs.noteable_type === "Issue") {
      const issue = record.issue as { iid?: unknown } | undefined;
      const iid = issue?.iid;
      if ((typeof iid !== "number" && typeof iid !== "string") || (typeof note !== "number" && typeof note !== "string")) return [];
      return [
        { kind: "work_item", externalId: issueId(project, String(iid)) },
        { kind: "comment", externalId: `${issueId(project, String(iid))}:note:${note}` },
      ];
    }
    if (attrs.noteable_type !== "MergeRequest") return [];
    const mr = record.merge_request as { iid?: unknown } | undefined;
    const iid = mr?.iid;
    if ((typeof iid !== "number" && typeof iid !== "string") || (typeof note !== "number" && typeof note !== "string")) return [];
    return [
      { kind: "change_request", externalId: mrId(project, String(iid)) },
      { kind: "comment", externalId: noteId(project, String(iid), String(note)) },
    ];
  }
  return [];
}

interface GitlabEvent {
  id?: number;
  action_name?: string;
  target_type?: string | null;
  target_iid?: number;
  target_title?: string;
  created_at?: string;
  author?: { username?: string; name?: string; bot?: boolean };
  note?: { id?: number; noteable_type?: string; noteable_iid?: number };
  push_data?: { commit_to?: string; ref?: string; action?: string };
}

interface GitlabAccount {
  accountId?: string;
  username?: string;
  email?: string;
  displayName?: string;
  bot?: boolean;
}

function gitlabAction(raw: string | undefined): string {
  const value = (raw ?? "").toLowerCase();
  if (value === "opened" || value === "open") return "open";
  if (value === "accepted" || value === "merged" || value === "merge") return "merge";
  if (value === "closed" || value === "close") return "close";
  if (value === "reopened" || value === "reopen") return "reopen";
  if (value === "updated" || value === "update") return "update";
  if (value.startsWith("commented")) return "comment";
  if (value.startsWith("pushed")) return "push";
  if (value === "approved") return "review";
  return value;
}

function gitlabActor(author: { username?: string; name?: string; bot?: boolean } | undefined, account?: GitlabAccount) {
  return connectionActor({
    name: author?.name ?? author?.username,
    username: author?.username,
    bot: author?.bot,
    account,
  });
}

function changeFromItem(
  item: SyncedItem,
  ctx: ConnectionContext,
  type: SourceChange["type"],
  id: string,
  at: number,
  actor: { name: string; isBot: boolean },
  extra: Record<string, string | number | boolean | string[]> = {},
  before?: SourceChange["before"],
): SourceChange {
  return {
    id,
    type,
    connectionId: ctx.connectionId,
    item,
    ...(before ? { before } : {}),
    actor,
    fields: {
      ...(item.details?.assignee ? { assignee: String(item.details.assignee) } : {}),
      ...(typeof item.details?.labels === "string" ? { labels: String(item.details.labels).split(",") } : {}),
      ...(item.details?.mr ? { mr: String(item.details.mr) } : {}),
      ...(item.state?.category ? { "state.category": item.state.category } : {}),
      ...extra,
    },
    at,
  };
}

function eventToChanges(
  event: GitlabEvent,
  ctx: ConnectionContext,
  project: string,
  account?: GitlabAccount,
): SourceChange[] {
  const action = gitlabAction(event.action_name);
  const at = when(event.created_at);
  const actor = gitlabActor(event.author, account);
  const iid = event.target_iid != null ? String(event.target_iid) : "";
  const title = (event.target_title ?? "").slice(0, 300);
  if (event.target_type === "Issue" && iid) {
    const item = {
      kind: "work_item" as const,
      externalId: issueId(project, iid),
      title: title || `#${iid}`,
      url: `${siteUrl(ctx)}/${project}/-/issues/${iid}`,
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      updatedAt: at,
    };
    const type = action === "open" ? "item.created" : action === "close" ? "item.state_changed" : "item.updated";
    return [changeFromItem(item, ctx, type, `${item.externalId}@${action || "update"}`, at, actor)];
  }
  if (event.target_type === "MergeRequest" && iid) {
    const item = {
      kind: "change_request" as const,
      externalId: mrId(project, iid),
      title: title || `!${iid}`,
      url: `${siteUrl(ctx)}/${project}/-/merge_requests/${iid}`,
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      updatedAt: at,
    };
    const type = action === "open" ? "change_request.opened"
      : action === "merge" ? "change_request.merged"
      : action === "close" ? "change_request.closed"
      : action === "review" ? "review.submitted"
      : "change_request.updated";
    return [changeFromItem(item, ctx, type, `${item.externalId}@${action || "update"}`, at, actor)];
  }
  if (action === "comment" && event.note) {
    const noteIdValue = event.note.id != null ? String(event.note.id) : "";
    const noteIid = event.note.noteable_iid != null ? String(event.note.noteable_iid) : iid;
    if (!noteIid || !noteIdValue) return [];
    const onIssue = event.note.noteable_type === "Issue";
    const parent = onIssue ? issueId(project, noteIid) : mrId(project, noteIid);
    const externalId = onIssue ? `${parent}:note:${noteIdValue}` : noteId(project, noteIid, noteIdValue);
    return [changeFromItem({
      kind: "comment",
      externalId,
      title: title || `Comment on ${onIssue ? `#${noteIid}` : `!${noteIid}`}`,
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      details: onIssue ? { issue: parent } : { mr: parent },
      updatedAt: at,
    }, ctx, "comment.added", externalId.includes(":note:") ? `${parent}@comment:${noteIdValue}` : `${externalId}`, at, actor, onIssue ? { issue: parent } : { mr: parent })];
  }
  if (action === "push" && event.push_data?.commit_to) {
    const sha = event.push_data.commit_to;
    return [changeFromItem({
      kind: "commit",
      externalId: commitId(project, sha),
      title: (event.push_data.ref ?? sha).slice(0, 300),
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      updatedAt: at,
    }, ctx, "commit.pushed", `${project}@${sha.toLowerCase()}`, at, actor, event.push_data.ref ? { branch: event.push_data.ref } : {})];
  }
  return [];
}

function pipelineChangeType(status: string): SourceChange["type"] {
  if (status === "failed") return "build.failed";
  if (status === "success") return "build.succeeded";
  return "change_request.updated";
}

function pipelineChange(
  pipeline: GitlabPipeline,
  ctx: ConnectionContext,
  project: string,
  account?: GitlabAccount,
  mrExternalId?: string,
): SourceChange | null {
  if (pipeline.id == null) return null;
  const item = syncedPipeline(pipeline, ctx, project);
  if (mrExternalId && !item.details?.mr) item.details = { ...item.details, mr: mrExternalId };
  const status = (pipeline.status ?? "unknown").toLowerCase();
  return changeFromItem(
    item,
    ctx,
    pipelineChangeType(status),
    `${item.externalId}@${status}`,
    when(pipeline.updated_at),
    gitlabActor(undefined, account),
    item.details?.mr ? { mr: String(item.details.mr) } : {},
  );
}

async function loadGitlabUser(ctx: ConnectionContext): Promise<GitlabAccount | undefined> {
  const result = await gitlabRequest(ctx, "/user");
  if (!result.ok || !result.body || typeof result.body !== "object") return undefined;
  const user = result.body as GitlabUser;
  return { username: user.username, displayName: user.name, bot: user.bot === true };
}

function isoDate(ms: number): string {
  return new Date(ms || Date.now()).toISOString().slice(0, 10);
}

async function listProjectEvents(ctx: ConnectionContext, project: string, since: number): Promise<GitlabEvent[]> {
  const params = new URLSearchParams({ per_page: "50", sort: "asc" });
  if (since) params.set("after", isoDate(Math.max(0, since - 86_400_000)));
  const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/events?${params}`);
  if (!result.ok) throw new Error(result.error);
  return Array.isArray(result.body) ? result.body as GitlabEvent[] : [];
}

async function listProjectPipelines(ctx: ConnectionContext, project: string, since: number): Promise<GitlabPipeline[]> {
  const params = new URLSearchParams({ per_page: "50", order_by: "updated_at", sort: "asc" });
  if (since) params.set("updated_after", new Date(since).toISOString());
  const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/pipelines?${params}`);
  if (!result.ok) throw new Error(result.error);
  return Array.isArray(result.body) ? result.body as GitlabPipeline[] : [];
}

function webhookChangesFrom(body: unknown, ctx: ConnectionContext, account?: GitlabAccount): SourceChange[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const project = webhookProject(record);
  if (!project) return [];
  const kind = typeof record.object_kind === "string" ? record.object_kind : "";
  const attrs = (record.object_attributes ?? {}) as Record<string, unknown>;
  const user = record.user as { username?: string; name?: string; bot?: boolean } | undefined;
  if (kind === "merge_request") {
    const iid = attrs.iid;
    if (typeof iid !== "number" && typeof iid !== "string") return [];
    const action = gitlabAction(typeof attrs.action === "string" ? attrs.action : undefined);
    const at = when(typeof attrs.updated_at === "string" ? attrs.updated_at : typeof attrs.created_at === "string" ? attrs.created_at : undefined);
    const item = {
      kind: "change_request" as const,
      externalId: mrId(project, String(iid)),
      title: (typeof attrs.title === "string" ? attrs.title : `!${iid}`).slice(0, 300),
      url: typeof attrs.url === "string" ? attrs.url : `${siteUrl(ctx)}/${project}/-/merge_requests/${iid}`,
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      updatedAt: at,
    };
    const type = action === "open" ? "change_request.opened"
      : action === "merge" ? "change_request.merged"
      : action === "close" ? "change_request.closed"
      : "change_request.updated";
    return [changeFromItem(item, ctx, type, `${item.externalId}@${action || "update"}`, at, gitlabActor(user, account))];
  }
  if (kind === "pipeline") {
    const id = attrs.id;
    if (typeof id !== "number" && typeof id !== "string") return [];
    const mr = record.merge_request as { iid?: unknown } | undefined;
    const mrIdValue = typeof mr?.iid === "number" || typeof mr?.iid === "string" ? mrId(project, String(mr.iid)) : undefined;
    const pipeline: GitlabPipeline = {
      id: Number(id),
      status: typeof attrs.status === "string" ? attrs.status : undefined,
      ref: typeof attrs.ref === "string" ? attrs.ref : undefined,
      sha: typeof attrs.sha === "string" ? attrs.sha : undefined,
      web_url: typeof attrs.url === "string" ? attrs.url : undefined,
      updated_at: typeof attrs.updated_at === "string" ? attrs.updated_at : typeof attrs.finished_at === "string" ? attrs.finished_at : undefined,
    };
    const change = pipelineChange(pipeline, ctx, project, account, mrIdValue);
    return change ? [change] : [];
  }
  if (kind === "issue") {
    const iid = attrs.iid;
    if (typeof iid !== "number" && typeof iid !== "string") return [];
    const action = gitlabAction(typeof attrs.action === "string" ? attrs.action : undefined);
    const at = when(typeof attrs.updated_at === "string" ? attrs.updated_at : typeof attrs.created_at === "string" ? attrs.created_at : undefined);
    const item = {
      kind: "work_item" as const,
      externalId: issueId(project, String(iid)),
      title: (typeof attrs.title === "string" ? attrs.title : `#${iid}`).slice(0, 300),
      url: typeof attrs.url === "string" ? attrs.url : `${siteUrl(ctx)}/${project}/-/issues/${iid}`,
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      updatedAt: at,
    };
    const type = action === "open" ? "item.created" : action === "close" ? "item.state_changed" : "item.updated";
    return [changeFromItem(item, ctx, type, `${item.externalId}@${action || "update"}`, at, gitlabActor(user, account))];
  }
  if (kind === "note") {
    const note = attrs.id;
    const onIssue = attrs.noteable_type === "Issue";
    const target = onIssue ? record.issue as { iid?: unknown; title?: unknown } | undefined : record.merge_request as { iid?: unknown; title?: unknown } | undefined;
    const iid = target?.iid;
    if ((typeof iid !== "number" && typeof iid !== "string") || (typeof note !== "number" && typeof note !== "string")) return [];
    const parent = onIssue ? issueId(project, String(iid)) : mrId(project, String(iid));
    const at = when(typeof attrs.updated_at === "string" ? attrs.updated_at : typeof attrs.created_at === "string" ? attrs.created_at : undefined);
    return [changeFromItem({
      kind: "comment",
      externalId: onIssue ? `${parent}:note:${note}` : noteId(project, String(iid), String(note)),
      title: (typeof attrs.note === "string" ? attrs.note : `Comment on ${onIssue ? `#${iid}` : `!${iid}`}`).slice(0, 80),
      connectorId: "gitlab",
      connectionId: ctx.connectionId,
      details: onIssue ? { issue: parent } : { mr: parent },
      updatedAt: at,
    }, ctx, "comment.added", `${parent}@comment:${note}`, at, gitlabActor(user, account), onIssue ? { issue: parent } : { mr: parent })];
  }
  return [];
}

function previewSource(call: CaptureCall): string | null {
  const output = call.output ?? "";
    if (output.includes(PREVIEW_CUT)) {
    const head = output.split(PREVIEW_CUT)[0] ?? "";
    if (!MR_IN_TEXT.test(head) && !ISSUE_IN_TEXT.test(head) && !/\/-\/(?:merge_requests|issues)\/\d+/i.test(head) && !/\/-\/pipelines\/\d+/i.test(head) && !NOTE_IN_TEXT.test(head)) {
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
  const url = /https?:\/\/[^\s]+\/((?:[\w.-]+\/)+[\w.-]+)\/-\/(?:merge_requests|issues|commit|pipelines)\//i.exec(text);
  if (url) return url[1];
  const qualified = new RegExp(`${PROJECT}[!#]\\d+`, "i").exec(text);
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

function issueFromText(text: string, ctx: ConnectionContext): { project: string; iid: string; externalId: string } | null {
  const url = parseUrlRef((/https?:\/\/[^\s<>"')\]]+/i.exec(text) ?? [])[0] ?? "", ctx);
  if (url?.kind === "work_item") return { project: url.project, iid: url.iid, externalId: url.externalId };
  if (url?.kind === "comment" && url.on === "issue") return { project: url.project, iid: url.iid, externalId: issueId(url.project, url.iid) };
  const qualified = QUALIFIED_ISSUE.exec((new RegExp(`${PROJECT}#(\\d+)`, "i").exec(text) ?? [])[0] ?? "");
  if (qualified) return { project: qualified[1], iid: qualified[2], externalId: issueId(qualified[1], qualified[2]) };
  const short = /#(\d+)/.exec(text);
  const project = projectFromText(text, ctx);
  if (short && project && !/#pipeline:/i.test(text.slice(Math.max(0, (short.index ?? 0) - 20), (short.index ?? 0) + 20))) {
    return { project, iid: short[1], externalId: issueId(project, short[1]) };
  }
  return null;
}

function extractIssue(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const text = previewSource(call);
  if (!text) return null;
  const json = mergedRecord(call);
  const context = emptyCtx();
  const web = typeof json?.web_url === "string" ? json.web_url : "";
  const fromUrl = web ? parseUrlRef(web, context) : null;
  const nested = json?.issue && typeof json.issue === "object" ? json.issue as Record<string, unknown> : null;
  const rawIid = json?.iid ?? json?.issue_iid ?? json?.issueIid ?? nested?.iid;
  const iid = typeof rawIid === "number" || typeof rawIid === "string" ? String(rawIid) : null;
  const project = (fromUrl && "project" in fromUrl ? fromUrl.project : null) ?? projectFromJson(json) ?? projectFromText(`${web}\n${text}`, context);
  if (iid && project) {
    return {
      externalId: issueId(project, iid),
      url: web || undefined,
      title: typeof json?.title === "string" ? json.title : `#${iid}`,
      details: { issue: issueId(project, iid) },
    };
  }
  const parsed = issueFromText(text, context);
  if (!parsed) return null;
  const title = /#\d+\s+(.+)/.exec(text)?.[1]?.split("\n")[0]?.trim();
  return { externalId: parsed.externalId, title: title || parsed.externalId, url: (/https?:\/\/[^\s]+\/-\/issues\/\d+/i.exec(text) ?? [])[0] };
}

function extractComment(call: CaptureCall): ReturnType<CaptureRule["extract"]> {
  const text = previewSource(call);
  if (!text) return null;
  const context = emptyCtx();
  const json = mergedRecord(call);
  const mr = mrFromText(text, context);
  const issue = issueFromText(text, context);
  const noteMatch = NOTE_IN_TEXT.exec(text);
  const threadMatch = THREAD_IN_TEXT.exec(text);
  const web = typeof json?.web_url === "string" ? json.web_url : (/https?:\/\/[^\s]+#note_\d+/i.exec(text) ?? [])[0];
  const fromUrl = web ? parseUrlRef(web, context) : null;
  const project = (fromUrl && "project" in fromUrl ? fromUrl.project : null) ?? mr?.project ?? issue?.project ?? projectFromJson(json) ?? projectFromText(text, context);
  const iid = (fromUrl && "iid" in fromUrl ? fromUrl.iid : null) ?? mr?.iid ?? issue?.iid ?? iidFromJson(json);
  const onIssue = (fromUrl?.kind === "comment" && fromUrl.on === "issue") || (!mr && Boolean(issue));
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
  const parentRef = onIssue ? issueId(project, iid) : mrId(project, iid);
  const position = positionOf(json);
  const details: Record<string, string | number | boolean> = onIssue ? { issue: parentRef } : { mr: parentRef };
  if (position.file) details.file = position.file;
  if (position.line != null) details.line = position.line;
  if (threadKey) details.thread = threadKey;
  return {
    externalId: noteKey
      ? (onIssue ? `${parentRef}:note:${noteKey}` : noteId(project, iid, noteKey))
      : threadKey && !onIssue ? threadId(project, iid, threadKey) : parentRef,
    parentRef,
    title: `Comment on ${onIssue ? `#${iid}` : `!${iid}`}`,
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
  {
    match: { tool: /(?:gitlab|glab)[_-].*[_-]issue[_-]?create|GITLAB_CREATE_ISSUE\b|(?:gitlab|glab).*create[_-]?issue/i },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => extractIssue(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { server: /\bgitlab\b/i, tool: /^(?:create[_-]?issue|issue_create)\b(?![_\s-]?(?:note|comment))/i },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => extractIssue(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { command: /^glab\s+issue\s+create\b/ },
    on: "completed",
    produce: { kind: "work_item" },
    extract: call => extractIssue(call),
    event: item => `opened ${item.externalId ?? item.title}`,
  },
  {
    match: { tool: /issue.*(?:note|comment)|create[_-]?issue[_-]?(?:note|comment)|GITLAB_.*ISSUE.*(?:NOTE|COMMENT)/i },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => extractComment(call),
    event: item => `commented on ${String(item.details?.issue ?? item.externalId ?? item.title).split(":")[0]}`,
  },
  {
    match: { command: /^glab\s+issue\s+(?:note|comment)\b/ },
    on: "completed",
    produce: { kind: "comment" },
    eventKind: "comment",
    extract: call => extractComment(call),
    event: item => `commented on ${String(item.details?.issue ?? item.externalId ?? item.title).split(":")[0]}`,
  },
];

export const gitlabConnector: Connector = {
  manifest: {
    id: "gitlab",
    name: "GitLab",
    icon: GITLAB_ICON,
    kinds: ["work_item", "change_request", "commit", "build", "comment"],
    settings: [
      { key: "site", label: "Instance URL", type: "string", help: "https://gitlab.com or your self-managed GitLab URL" },
      { key: "project", label: "Default project", type: "string", help: "group/project used for #140, !482, commit hashes, and issue or merge-request queries" },
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
    watch: {
      scopes: [
        { key: "project", label: "Project", type: "string", help: "group/project. Defaults to the connection project." },
        { key: "query", label: "Search", type: "string", help: "Optional text filter applied to event titles" },
      ],
      events: [
        "item.created", "item.updated", "item.state_changed", "comment.added",
        "change_request.opened", "change_request.updated", "change_request.merged", "change_request.closed",
        "review.submitted", "commit.pushed", "build.failed", "build.succeeded",
      ],
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
      new RegExp(`^${base}/[^\\s]+/-/issues/\\d+`, "i"),
      new RegExp(`^${base}/[^\\s]+/merge_requests/\\d+`, "i"),
      new RegExp(`^${base}/[^\\s]+/-/commit/${SHA.slice(1, -1)}`, "i"),
      new RegExp(`^${base}/[^\\s]+/-/pipelines/\\d+`, "i"),
    ];
  },
  async fetch(ctx, refs) {
    const resolved = refs.map(ref => ({ ref, parsed: parseStructured(ref.externalId, ctx) }));
    const issues = new Map<string, GitlabIssue>();
    const mrs = new Map<string, GitlabMergeRequest>();
    const approvals = new Map<string, GitlabApprovals | null>();
    const discussions = new Map<string, GitlabDiscussion[]>();
    const commits = new Map<string, GitlabCommit>();
    const pipelines = new Map<string, { pipeline: GitlabPipeline; jobs: GitlabJob[] }>();
    const wantedIssues = new Set<string>();
    const wantedMrs = new Set<string>();
    const wantedDiscussions = new Set<string>();
    const wantedIssueDiscussions = new Set<string>();
    for (const { ref, parsed } of resolved) {
      if (!parsed?.project || parsed.kind !== ref.kind) continue;
      if (parsed.kind === "work_item") wantedIssues.add(`${parsed.project}\t${parsed.iid}`);
      if (parsed.kind === "change_request" || (parsed.kind === "comment" && parsed.on === "mr")) wantedMrs.add(`${parsed.project}\t${parsed.iid}`);
      if (parsed.kind === "comment" && parsed.on === "mr") wantedDiscussions.add(`${parsed.project}\t${parsed.iid}`);
      if (parsed.kind === "comment" && parsed.on === "issue") {
        wantedIssues.add(`${parsed.project}\t${parsed.iid}`);
        wantedIssueDiscussions.add(`${parsed.project}\t${parsed.iid}`);
      }
    }
    await Promise.all([...wantedIssues].map(async key => {
      const [project, iid] = key.split("\t");
      const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/issues/${iid}`);
      if (result.ok && result.body && typeof result.body === "object") issues.set(key, result.body as GitlabIssue);
    }));
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
    await Promise.all([...wantedIssueDiscussions].map(async key => {
      const [project, iid] = key.split("\t");
      const result = await gitlabRequest(ctx, `/projects/${projectPath(project)}/issues/${iid}/discussions`);
      discussions.set(`issue\t${key}`, result.ok && Array.isArray(result.body) ? result.body as GitlabDiscussion[] : []);
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
    const loaded = issues.size + mrs.size + commits.size + pipelines.size + discussions.size;
    if (loaded) ctx.log(`Fetched ${loaded} GitLab item(s).`);
    return resolved.map(({ ref, parsed }) => {
      if (!parsed || parsed.kind !== ref.kind || !parsed.project) return stub(ref, ctx);
      if (parsed.kind === "work_item") {
        const item = issues.get(`${parsed.project}\t${parsed.iid}`);
        return item ? syncedIssue(item, ctx, parsed.project) ?? stub(ref, ctx) : stub(ref, ctx);
      }
      if (parsed.kind === "change_request") {
        const key = `${parsed.project}\t${parsed.iid}`;
        const item = mrs.get(key);
        return item ? syncedMr(item, ctx, parsed.project, approvals.get(key)) ?? stub(ref, ctx) : stub(ref, ctx);
      }
      if (parsed.kind === "comment") {
        const key = parsed.on === "issue" ? `issue\t${parsed.project}\t${parsed.iid}` : `${parsed.project}\t${parsed.iid}`;
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
    ctx.log("Queried GitLab issues and merge requests.");
    const page = cursor && /^\d+$/.test(cursor) ? cursor : "1";
    const params = new URLSearchParams({ state: "opened", per_page: "50", page });
    if (search) params.set("search", search);
    const [issueResult, mrResult] = await Promise.all([
      gitlabRequest(ctx, `/projects/${projectPath(project)}/issues?${params}`),
      gitlabRequest(ctx, `/projects/${projectPath(project)}/merge_requests?${params}`),
    ]);
    if (!issueResult.ok) throw new Error(issueResult.error);
    if (!mrResult.ok) throw new Error(mrResult.error);
    const issueRows = Array.isArray(issueResult.body) ? issueResult.body as GitlabIssue[] : [];
    const mrRows = Array.isArray(mrResult.body) ? mrResult.body as GitlabMergeRequest[] : [];
    const items = [
      ...issueRows.flatMap(issue => syncedIssue(issue, ctx, project) ?? []),
      ...mrRows.flatMap(mr => syncedMr(mr, ctx, project) ?? []),
    ];
    const next = issueResult.headers.get("x-next-page") || mrResult.headers.get("x-next-page");
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
  async changes(ctx, scope: WatchScope, cursor: string | null) {
    const project = typeof scope.project === "string" && PROJECT_PATH.test(scope.project)
      ? scope.project : defaultProject(ctx);
    if (!project) return { changes: [], cursor: cursor ?? "" };
    const parsed = parseChangeCursor(cursor);
    const account = await loadGitlabUser(ctx);
    const [events, pipelines] = await Promise.all([
      listProjectEvents(ctx, project, parsed.since),
      listProjectPipelines(ctx, project, parsed.since),
    ]);
    const needle = typeof scope.query === "string" ? scope.query.trim().toLowerCase() : "";
    const seen = new Map(parsed.seen);
    const raw = [
      ...events.flatMap(event => eventToChanges(event, ctx, project, account)),
      ...pipelines.flatMap(pipeline => {
        const change = pipelineChange(pipeline, ctx, project, account);
        return change ? [change] : [];
      }),
    ].filter(change => change.at > parsed.since && (!needle || change.item.title.toLowerCase().includes(needle) || String(change.item.externalId ?? "").toLowerCase().includes(needle)));
    raw.sort((left, right) => left.at - right.at);
    for (const change of raw) rememberSnapshot(seen, change.item);
    const latest = Math.max(parsed.since, ...raw.map(change => change.at));
    if (raw.length) ctx.log(`GitLab changes named ${raw.length} item(s).`);
    return {
      changes: raw,
      cursor: encodeChangeCursor(latest || Date.now(), seen, raw.flatMap(change => change.item.externalId ? [change.item.externalId] : [])),
    };
  },
  async webhookChanges(ctx, headers, body) {
    const secret = ctx.secret("webhookSecret");
    if (secret && !verifyGitlabWebhook(secret, headers.get("x-gitlab-token"))) {
      ctx.log("Ignored a GitLab webhook with a bad token.");
      return [];
    }
    let parsed: unknown = body;
    if (typeof body === "string") {
      try { parsed = JSON.parse(body); } catch { return []; }
    }
    const account = await loadGitlabUser(ctx);
    const changes = webhookChangesFrom(parsed, ctx, account);
    if (changes.length) ctx.log(`GitLab webhook changes named ${changes.length} item(s).`);
    return changes;
  },
  capture: captureRules,
};
