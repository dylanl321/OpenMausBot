import type { StoredConnection } from "./connectors/types.ts";
import { backlogGate } from "./team-backlog.ts";
import type { BacklogGate, BacklogTarget } from "../shared/team-backlog.ts";

type Outcome = { target: BacklogTarget; gates: BacklogGate[]; changed: boolean };

function endpoint(connection: StoredConnection, prefix: string): string {
  const raw = String(connection.settings.site ?? "");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Connection has an invalid instance URL");
  return `${url.origin}${url.pathname.replace(/\/$/, "")}${prefix}`;
}

async function read(response: Response, label: string): Promise<Record<string, any>> {
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${label} returned an invalid response`);
  return body as Record<string, any>;
}

function gitlabRequest(connection: StoredConnection, path: string, fetchImpl: typeof fetch, init?: RequestInit) {
  if (!connection.secrets.token) throw new Error("GitLab token is unavailable");
  return fetchImpl(endpoint(connection, `/api/v4${path}`), {
    ...init, headers: { "PRIVATE-TOKEN": connection.secrets.token, accept: "application/json", ...init?.headers },
  });
}

function jiraRequest(connection: StoredConnection, path: string, fetchImpl: typeof fetch, init?: RequestInit) {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (connection.settings.edition === "datacenter") {
    if (!connection.secrets.token) throw new Error("Jira token is unavailable");
    headers.authorization = `Bearer ${connection.secrets.token}`;
  } else {
    if (!connection.secrets.email || !connection.secrets.apiToken) throw new Error("Jira credentials are unavailable");
    headers.authorization = `Basic ${Buffer.from(`${connection.secrets.email}:${connection.secrets.apiToken}`).toString("base64")}`;
  }
  return fetchImpl(endpoint(connection, path), { ...init, headers: { ...headers, ...init?.headers } });
}

const shaOf = (mr: Record<string, any>): string | undefined => typeof mr.sha === "string" && /^[0-9a-f]{40}$/i.test(mr.sha) ? mr.sha.toLowerCase() : undefined;

/** GitLab's current approved_by list often has no timestamps. A system note
 * ties the same current approver to an actual post-head event; an ordinary
 * comment with the same words cannot manufacture review evidence. */
async function approvalNoteTimes(connection: StoredConnection, base: string, fetchImpl: typeof fetch): Promise<Map<string, number>> {
  const times = new Map<string, number>();
  const seen = new Set<string>();
  let page = "1";
  for (let index = 0; index < 1_000; index += 1) {
    const response = await gitlabRequest(connection, `${base}/notes?per_page=100&page=${page}`, fetchImpl);
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
export async function mergeReviewedRequest(connection: StoredConnection, target: BacklogTarget,
  fetchImpl: typeof fetch = fetch, mayWrite: () => boolean = () => true): Promise<Outcome> {
  const match = /^(.+)!([1-9]\d*)$/.exec(target.externalId);
  if (connection.connectorId !== "gitlab" || !match) throw new Error("Invalid GitLab MR identity");
  const base = `/projects/${encodeURIComponent(match[1])}/merge_requests/${match[2]}`;
  const get = (path: string, label: string) => gitlabRequest(connection, path, fetchImpl).then(response => read(response, label));
  const mr = await get(base, "GitLab MR");
  const sha = shaOf(mr);
  if (mr.state === "merged") return { target: { ...target, state: "done", label: "merged", headSha: sha ?? target.headSha,
    observedAt: Date.now(), result: `Observed merged commit ${String(mr.merge_commit_sha ?? "unknown")}` }, gates: [], changed: true };
  if (mr.state !== "opened") return { target: { ...target, state: "cancelled", label: String(mr.state ?? "closed"), observedAt: Date.now() },
    gates: [backlogGate("policy", "This MR is closed without a merge; restore it or resolve its outcome explicitly.", "Repository maintainer", target.identity)], changed: false };
  if (!sha || !target.headSha || sha !== target.headSha) return {
    target: { ...target, ...(sha ? { headSha: sha } : {}), observedAt: Date.now() },
    gates: [backlogGate("review", "MR head changed or has no verifiable SHA; review the current head again.", "Security and Manager", target.identity)], changed: false,
  };
  const [approvals, approvalState, project, versions] = await Promise.all([
    get(`${base}/approvals`, "GitLab approvals"),
    get(`${base}/approval_state`, "GitLab approval rules"),
    get(`/projects/${encodeURIComponent(match[1])}`, "GitLab project policy"),
    gitlabRequest(connection, `${base}/versions?per_page=100`, fetchImpl).then(async response => {
      if (!response.ok) throw new Error(`GitLab MR versions returned ${response.status}`);
      const body: unknown = await response.json().catch(() => null);
      if (!Array.isArray(body)) throw new Error("GitLab MR versions returned an invalid response");
      return body as Array<Record<string, any>>;
    }),
  ]);
  const version = versions.find(value => value.head_commit_sha === sha);
  if (!version || !Date.parse(String(version.created_at ?? ""))) throw new Error("Cannot identify when the current MR head was created");
  const versionAt = Date.parse(version.created_at);
  const gates: BacklogGate[] = [];
  const rules = Array.isArray(approvalState.rules) ? approvalState.rules as Array<Record<string, any>> : null;
  if (!rules) throw new Error("GitLab approval rules are unavailable");
  const approvalsByUser = new Map<string, number>();
  for (const approval of Array.isArray(approvals.approved_by) ? approvals.approved_by as Array<Record<string, any>> : []) {
    const id = approval.user?.id;
    const at = Date.parse(String(approval.approved_at ?? ""));
    if ((typeof id === "number" || typeof id === "string") && Number.isFinite(at)) approvalsByUser.set(String(id), at);
  }
  const needsNoteTimes = rules.some(rule => ["Security", "Manager"].some(role =>
    String(rule.name ?? "").toLowerCase() === role.toLowerCase()) &&
    Array.isArray(rule.approved_by) && rule.approved_by.some((approval: Record<string, any>) => {
      const id = approval?.user?.id ?? approval?.id;
      return (typeof id === "number" || typeof id === "string") && !approvalsByUser.has(String(id));
    }));
  if (needsNoteTimes) {
    for (const [id, at] of await approvalNoteTimes(connection, base, fetchImpl)) {
      approvalsByUser.set(id, Math.max(approvalsByUser.get(id) ?? 0, at));
    }
  }
  for (const role of ["Security", "Manager"] as const) {
    const rule = rules.find(candidate => typeof candidate.name === "string" && candidate.name.toLowerCase() === role.toLowerCase());
    const approvers = Array.isArray(rule?.approved_by) ? rule.approved_by as Array<Record<string, any>> : [];
    const current = approvers.some(approval => {
      const id = approval.user?.id ?? approval.id;
      const at = typeof id === "number" || typeof id === "string"
        ? approvalsByUser.get(String(id)) : Date.parse(String(approval.approved_at ?? ""));
      return at !== undefined && Number.isFinite(at) && at >= versionAt;
    });
    if (!rule || rule.approved !== true || !current) gates.push(backlogGate(role.toLowerCase() as "security" | "manager",
      `${role} must authorize the reviewed current head ${sha.slice(0, 12)}.`, role, target.identity));
  }
  if (gates.some(gate => gate.kind === "security" || gate.kind === "manager")) {
    gates.unshift(backlogGate("review", `Current-head review evidence is required for ${sha.slice(0, 12)}.`, "Security and Manager", target.identity));
  }
  if (!Number.isSafeInteger(approvals.approvals_left) || approvals.approvals_left !== 0) {
    gates.push(backlogGate("policy", "GitLab still requires project approvals.", "Project approvers", target.identity));
  }
  if (mr.draft || mr.work_in_progress || mr.has_conflicts ||
      !["mergeable", "can_be_merged"].includes(String(mr.detailed_merge_status ?? mr.merge_status ?? ""))) {
    gates.push(backlogGate("policy", "The live MR is draft, conflicted, or not mergeable.", "MR owner or repository maintainer", target.identity));
  }
  if (typeof project.only_allow_merge_if_pipeline_succeeds !== "boolean" ||
      typeof project.only_allow_merge_if_all_discussions_are_resolved !== "boolean") {
    gates.push(backlogGate("policy", "The live GitLab project merge policy could not be verified.", "Repository maintainer", target.identity));
  }
  if (project.only_allow_merge_if_pipeline_succeeds === true &&
      (mr.head_pipeline?.status !== "success" || mr.head_pipeline?.sha !== sha)) {
    gates.push(backlogGate("policy", "The current head has not passed the project's required pipeline.", "MR owner or CI maintainer", target.identity));
  }
  if (project.only_allow_merge_if_all_discussions_are_resolved === true && mr.blocking_discussions_resolved !== true) {
    gates.push(backlogGate("policy", "Required review discussions are not resolved.", "MR reviewers", target.identity));
  }
  if (gates.length) return { target, gates, changed: false };
  if (!mayWrite()) throw new Error("The goal stopped before the SHA-locked merge was sent");
  const merged = await gitlabRequest(connection, `${base}/merge`, fetchImpl, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
  if (!merged.ok) throw new Error(`SHA-locked GitLab merge returned ${merged.status}`);
  const observed = await get(base, "Merged MR readback");
  if (observed.state !== "merged" || shaOf(observed) !== sha) throw new Error("GitLab did not confirm the reviewed SHA was merged");
  return { target: { ...target, state: "done", label: "merged", headSha: sha, observedAt: Date.now(),
    result: `Observed merged commit ${String(observed.merge_commit_sha ?? sha)}` }, gates: [], changed: true };
}

export async function transitionEvidencedJiraIssue(connection: StoredConnection, target: BacklogTarget,
  fetchImpl: typeof fetch = fetch, mayWrite: () => boolean = () => true): Promise<Outcome> {
  if (connection.connectorId !== "jira" || !/^[A-Z][A-Z0-9_]*-\d+$/i.test(target.externalId)) throw new Error("Invalid Jira issue identity");
  const prefix = connection.settings.edition === "datacenter" ? "/rest/api/2" : "/rest/api/3";
  const base = `${prefix}/issue/${encodeURIComponent(target.externalId)}`;
  const get = (path: string, label: string) => jiraRequest(connection, path, fetchImpl).then(response => read(response, label));
  const issue = await get(`${base}?fields=status`, "Jira issue");
  if (issue.key !== target.externalId || !issue.fields?.status) throw new Error("Jira returned a different issue or no status");
  if (issue.fields.status.statusCategory?.key === "done") return { target: { ...target, state: "done", label: String(issue.fields.status.name ?? "Done"), observedAt: Date.now(),
    result: "Observed Jira done status" }, gates: [], changed: true };
  const transitions = await get(`${base}/transitions`, "Jira transitions");
  if (!Array.isArray(transitions.transitions)) throw new Error("Jira transitions are unavailable");
  const done = (transitions.transitions as Array<Record<string, any>>).filter(value => value.to?.statusCategory?.key === "done" &&
    /\b(?:done|complete(?:d)?|resolved|closed|shipped|delivered|accepted)\b/i.test(String(value.to?.name ?? "")) &&
    !/cancel|won'?t do|obsolete|reject|duplicate|invalid|declined|abandon/i.test(String(value.to?.name ?? "")) &&
    typeof value.id === "string");
  if (done.length !== 1) return { target, gates: [backlogGate("policy", "Choose or configure a single valid Jira done transition for this issue.",
    "Jira project manager", target.identity)], changed: false };
  if (!mayWrite()) throw new Error("The goal stopped before the Jira transition was sent");
  const changed = await jiraRequest(connection, `${base}/transitions`, fetchImpl, { method: "POST", body: JSON.stringify({ transition: { id: done[0].id } }) });
  if (!changed.ok) throw new Error(`Jira transition returned ${changed.status}`);
  const observed = await get(`${base}?fields=status`, "Jira transition readback");
  if (observed.key !== target.externalId || observed.fields?.status?.statusCategory?.key !== "done") {
    throw new Error("Jira did not confirm a done status");
  }
  return { target: { ...target, state: "done", label: String(observed.fields.status.name ?? "Done"), observedAt: Date.now(),
    result: "Observed Jira done status" }, gates: [], changed: true };
}
