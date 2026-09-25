import type { BacklogGate } from "../../../shared/team-backlog.ts";
import { sourceIdentity } from "../../../shared/work-links.ts";
import { redactSecretsInText } from "../../redact.ts";
import type { ConnectionContext, ConnectorActInput, ConnectorActResult } from "../types.ts";

const MR_ID = /^(.+)!([1-9]\d*)$/;

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

function identityOf(ctx: ConnectionContext, externalId: string): string {
  return sourceIdentity({ connectorId: "gitlab", connectionId: ctx.connectionId, externalId }) ?? externalId;
}

function gate(kind: BacklogGate["kind"], detail: string, decisionMaker: string, identity: string): BacklogGate {
  return { kind, detail: redactSecretsInText(detail).slice(0, 1000), decisionMaker, identity };
}

async function gitlabFetch(ctx: ConnectionContext, path: string, init?: RequestInit): Promise<Response> {
  const site = siteUrl(ctx);
  if (!site) throw new Error("Connection has an invalid instance URL");
  const token = ctx.secret("token");
  if (!token) throw new Error("GitLab token is unavailable");
  return ctx.fetch(`${site}/api/v4${path}`, {
    ...init,
    headers: { "PRIVATE-TOKEN": token, accept: "application/json", ...init?.headers },
  });
}

async function read(response: Response, label: string): Promise<Record<string, any>> {
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${label} returned an invalid response`);
  return body as Record<string, any>;
}

const shaOf = (mr: Record<string, any>): string | undefined =>
  typeof mr.sha === "string" && /^[0-9a-f]{40}$/i.test(mr.sha) ? mr.sha.toLowerCase() : undefined;

function extraApprovalRuleNames(settings: ConnectionContext["settings"]):
  { ok: true; names: string[] } | { ok: false } {
  const raw = settings.requiredApprovalRules;
  if (raw === undefined || raw === "") return { ok: true, names: [] };
  if (typeof raw !== "string") return { ok: false };
  return { ok: true, names: raw.split(",").map(name => name.trim()).filter(Boolean) };
}

function ruleName(rule: Record<string, any>): string {
  return typeof rule.name === "string" ? rule.name.trim() : "";
}

function sameRuleName(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Live required when approvals_required is a positive integer. Missing means
 * not live-required. A present but unusable value is unknown policy. */
function liveRequired(rule: Record<string, any>): { required: boolean } | { unknown: true } {
  if (!Object.hasOwn(rule, "approvals_required") ||
      !Number.isSafeInteger(rule.approvals_required) || rule.approvals_required < 0) {
    return { unknown: true };
  }
  return { required: rule.approvals_required > 0 };
}

function ruleGateKind(name: string): BacklogGate["kind"] {
  const key = name.toLowerCase();
  if (key === "security") return "security";
  if (key === "manager") return "manager";
  return "review";
}

function currentHeadApproved(
  rule: Record<string, any>,
  approvalsByUser: Map<string, number>,
  versionAt: number,
): boolean {
  if (rule.approved !== true) return false;
  const approvers = Array.isArray(rule.approved_by) ? rule.approved_by as Array<Record<string, any>> : [];
  return approvers.some(approval => {
    const id = approval.user?.id ?? approval.id;
    const at = typeof id === "number" || typeof id === "string"
      ? approvalsByUser.get(String(id))
      : Date.parse(String(approval.approved_at ?? ""));
    return at !== undefined && Number.isFinite(at) && at >= versionAt;
  });
}

function ruleNeedsNoteTimes(rule: Record<string, any>, approvalsByUser: Map<string, number>): boolean {
  return Array.isArray(rule.approved_by) && (rule.approved_by as Array<Record<string, any>>).some(approval => {
    const id = approval?.user?.id ?? approval?.id;
    return (typeof id === "number" || typeof id === "string") && !approvalsByUser.has(String(id));
  });
}

/** GitLab's current approved_by list often has no timestamps. A system note
 * ties the same current approver to an actual post-head event; an ordinary
 * comment with the same words cannot manufacture review evidence. */
async function approvalNoteTimes(ctx: ConnectionContext, base: string): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const seen = new Set<string>();
  let page = "1";
  for (let index = 0; index < 1_000; index += 1) {
    const response = await gitlabFetch(ctx, `${base}/notes?per_page=100&page=${page}`);
    if (!response.ok) throw new Error(`GitLab approval notes returned ${response.status}`);
    const notes: unknown = await response.json().catch(() => null);
    if (!Array.isArray(notes)) throw new Error("GitLab approval notes returned an invalid page");
    for (const note of notes as Array<Record<string, any>>) {
      if (note?.system !== true || !/^approved this merge request\b/i.test(String(note.body ?? ""))) continue;
      const id = note.author?.id;
      const at = Date.parse(String(note.created_at ?? ""));
      if ((typeof id === "number" || typeof id === "string") && Number.isFinite(at)) {
        times.set(String(id), Math.max(times.get(String(id)) ?? 0, at));
      }
    }
    const next = response.headers.get("x-next-page");
    if (notes.length === 100 && next === null) throw new Error("GitLab omitted approval-note pagination");
    if (!next) return times;
    if (!/^[1-9]\d*$/.test(next) || seen.has(next) || next === page) throw new Error("GitLab approval-note pagination did not advance");
    seen.add(page);
    page = next;
  }
  throw new Error("GitLab approval-note pagination did not finish");
}

/** Only a reviewed, authorized current SHA can be merged. GitLab is read
 * immediately before the SHA-preconditioned PUT and again after it. Unknown
 * policy/approval state is a gate, never a reason to skip a check. */
export async function actGitlabMerge(ctx: ConnectionContext, input: ConnectorActInput): Promise<ConnectorActResult> {
  if (input.action !== "merge_change_request" || input.target.kind !== "change_request") {
    throw new Error("Unsupported GitLab action");
  }
  const match = MR_ID.exec(input.target.externalId);
  if (!match) throw new Error("Invalid GitLab MR identity");
  const identity = identityOf(ctx, input.target.externalId);
  const base = `/projects/${encodeURIComponent(match[1])}/merge_requests/${match[2]}`;
  const get = (path: string, label: string) => gitlabFetch(ctx, path).then(response => read(response, label));
  const mr = await get(base, "GitLab MR");
  const sha = shaOf(mr);
  if (mr.state === "merged") {
    return {
      changed: true,
      target: {
        state: "done", label: "merged", headSha: sha ?? input.target.headSha, observedAt: Date.now(),
        result: `Observed merged commit ${String(mr.merge_commit_sha ?? "unknown")}`,
      },
      gates: [],
    };
  }
  if (mr.state !== "opened") {
    return {
      changed: false,
      target: { state: "cancelled", label: String(mr.state ?? "closed"), observedAt: Date.now() },
      gates: [gate("policy", "This MR is closed without a merge; restore it or resolve its outcome explicitly.",
        "Repository maintainer", identity)],
    };
  }
  if (!sha || !input.target.headSha || sha !== input.target.headSha) {
    return {
      changed: false,
      target: { ...(sha ? { headSha: sha } : {}), observedAt: Date.now() },
      gates: [gate("review", "MR head changed or has no verifiable SHA; review the current head again.",
        "Project approvers", identity)],
    };
  }
  const [approvals, approvalState, project, versions] = await Promise.all([
    get(`${base}/approvals`, "GitLab approvals"),
    get(`${base}/approval_state`, "GitLab approval rules"),
    get(`/projects/${encodeURIComponent(match[1])}`, "GitLab project policy"),
    gitlabFetch(ctx, `${base}/versions?per_page=100`).then(async response => {
      if (!response.ok) throw new Error(`GitLab MR versions returned ${response.status}`);
      const body: unknown = await response.json().catch(() => null);
      if (!Array.isArray(body)) throw new Error("GitLab MR versions returned an invalid response");
      return body as Array<Record<string, any>>;
    }),
  ]);
  const version = versions.find(value => value.head_commit_sha === sha);
  if (!version || !Date.parse(String(version.created_at ?? ""))) throw new Error("Cannot identify when the current MR head was created");
  const versionAt = Date.parse(version.created_at);
  const extras = extraApprovalRuleNames(ctx.settings);
  const gates: BacklogGate[] = [];
  if (!extras.ok) {
    return {
      changed: false,
      target: {},
      gates: [gate("policy", "Connection requiredApprovalRules must be a comma-separated list of rule names.",
        "Connection owner", identity)],
    };
  }
  const extraNames = extras.names;
  if (!Array.isArray(approvalState.rules)) throw new Error("GitLab approval rules are unavailable");
  const rules = approvalState.rules as Array<Record<string, any>>;
  const approvalsByUser = new Map<string, number>();
  for (const approval of Array.isArray(approvals.approved_by) ? approvals.approved_by as Array<Record<string, any>> : []) {
    const id = approval.user?.id;
    const at = Date.parse(String(approval.approved_at ?? ""));
    if ((typeof id === "number" || typeof id === "string") && Number.isFinite(at)) approvalsByUser.set(String(id), at);
  }
  const enforced: Array<{ rule: Record<string, any>; name: string }> = [];
  for (const rule of rules) {
    const name = ruleName(rule);
    const live = liveRequired(rule);
    if ("unknown" in live) {
      gates.push(gate("policy", `GitLab approval rule ${name || "unnamed"} is missing a usable approvals_required field.`,
        name || "Project approvers", identity));
      continue;
    }
    const extra = Boolean(name && extraNames.some(entry => sameRuleName(entry, name)));
    if (!live.required && !extra) continue;
    enforced.push({ rule, name });
  }
  for (const extra of extraNames) {
    if (!rules.some(rule => sameRuleName(ruleName(rule), extra))) {
      gates.push(gate(ruleGateKind(extra), `${extra} must authorize the reviewed current head ${sha.slice(0, 12)}.`,
        extra, identity));
    }
  }
  if (enforced.some(({ rule }) => ruleNeedsNoteTimes(rule, approvalsByUser))) {
    for (const [id, at] of await approvalNoteTimes(ctx, base)) {
      approvalsByUser.set(id, Math.max(approvalsByUser.get(id) ?? 0, at));
    }
  }
  for (const { rule, name } of enforced) {
    const maker = name || "Project approvers";
    if (typeof rule.approved !== "boolean") {
      gates.push(gate("policy", `GitLab approval rule ${maker} is missing a usable approved field.`, maker, identity));
      continue;
    }
    if (!currentHeadApproved(rule, approvalsByUser, versionAt)) {
      gates.push(gate(ruleGateKind(maker), `${maker} must authorize the reviewed current head ${sha.slice(0, 12)}.`,
        maker, identity));
    }
  }
  if (!Number.isSafeInteger(approvals.approvals_left) || approvals.approvals_left !== 0) {
    gates.push(gate("policy", "GitLab still requires project approvals.", "Project approvers", identity));
  }
  if (mr.draft || mr.work_in_progress || mr.has_conflicts ||
      !["mergeable", "can_be_merged"].includes(String(mr.detailed_merge_status ?? mr.merge_status ?? ""))) {
    gates.push(gate("policy", "The live MR is draft, conflicted, or not mergeable.",
      "MR owner or repository maintainer", identity));
  }
  if (typeof project.only_allow_merge_if_pipeline_succeeds !== "boolean" ||
      typeof project.only_allow_merge_if_all_discussions_are_resolved !== "boolean") {
    gates.push(gate("policy", "The live GitLab project merge policy could not be verified.",
      "Repository maintainer", identity));
  }
  if (project.only_allow_merge_if_pipeline_succeeds === true &&
      (mr.head_pipeline?.status !== "success" || mr.head_pipeline?.sha !== sha)) {
    gates.push(gate("policy", "The current head has not passed the project's required pipeline.",
      "MR owner or CI maintainer", identity));
  }
  if (project.only_allow_merge_if_all_discussions_are_resolved === true && mr.blocking_discussions_resolved !== true) {
    gates.push(gate("policy", "Required review discussions are not resolved.", "MR reviewers", identity));
  }
  if (gates.length || input.mode !== "commit") return { changed: false, target: {}, gates };
  const merged = await gitlabFetch(ctx, `${base}/merge`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha }),
  });
  if (!merged.ok) throw new Error(`SHA-locked GitLab merge returned ${merged.status}`);
  const observed = await get(base, "Merged MR readback");
  if (observed.state !== "merged" || shaOf(observed) !== sha) throw new Error("GitLab did not confirm the reviewed SHA was merged");
  return {
    changed: true,
    target: {
      state: "done", label: "merged", headSha: sha, observedAt: Date.now(),
      result: `Observed merged commit ${String(observed.merge_commit_sha ?? sha)}`,
    },
    gates: [],
  };
}
