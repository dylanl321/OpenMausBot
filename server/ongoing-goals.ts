import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import {
  goalControlSchema, goalCreateSchema, ongoingGoalSchema,
  type OngoingGoal,
} from "../shared/ongoing-goal.ts";
import type { WorkRecord, WorkSource } from "./work-items.ts";
import { criteriaFromScopes, canSubmitScopeChoice, type TeamBacklog } from "../shared/team-backlog.ts";
import { CONNECTORS } from "./connectors/registry.ts";
import { stampScopes } from "./team-work-kits.ts";

const DELAYS = [5, 15, 60, 360].map(minutes => minutes * 60_000);
const MAX_GOALS = 1000;
const active = (goal: OngoingGoal) => goal.status === "working" || goal.status === "waiting";

export function interruptedLinkedWork(item: WorkRecord): boolean {
  return item.status === "blocked" && (item.detail.startsWith("Interrupted by server restart;") ||
    item.assignments.some(assignment => assignment.revision === item.revision &&
      assignment.result.startsWith("Interrupted by server restart;")));
}

export function referencedGoalWork(objective: string, items: readonly WorkRecord[]): WorkRecord | undefined {
  const references = [...new Set(objective.match(/\b[A-Z][A-Z0-9]{1,15}-\d+\b/g) ?? [])];
  if (references.length !== 1) return undefined;
  const matches = items.filter(item => item.identity === references[0] || item.identity.endsWith(`:${references[0]}`));
  return matches.length === 1 ? matches[0] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesConnectorOrMergeRequests(objective: string): boolean {
  if (/\bmerge requests?\b/i.test(objective) || /\bmrs?\b/i.test(objective)) return true;
  return CONNECTORS.some(connector => {
    const id = escapeRegExp(connector.manifest.id);
    const name = escapeRegExp(connector.manifest.name);
    return new RegExp(`\\b${id}\\b`, "i").test(objective) || new RegExp(`\\b${name}\\b`, "i").test(objective);
  });
}

export function requiresExternalInventory(objective: string, options?: { hasQueryCapableConnection?: boolean }): boolean {
  return /\ball\b/i.test(objective) && namesConnectorOrMergeRequests(objective) ||
    isTeamBacklogObjective(objective, options);
}

export function isTeamBacklogObjective(objective: string, options?: { hasQueryCapableConnection?: boolean }): boolean {
  // A named issue or MR is a specific deliverable. Never widen that request
  // into authority over every project item just because it also says "all".
  if (/\b[A-Z][A-Z0-9_]*-\d+\b/i.test(objective) || /(?:[\w.-]+\/)+[\w.-]+!\d+/.test(objective) ||
      /(?:^|[^\w])!\d+\b/.test(objective)) return false;
  if (!/\b(?:all|current|our|backlog|unfinished)\b/i.test(objective)) return false;
  return namesConnectorOrMergeRequests(objective) || options?.hasQueryCapableConnection === true;
}

export function inGoalScope(goal: OngoingGoal, identity: string): boolean {
  return goal.teamBacklog ? goal.teamBacklog.targets.some(target => target.identity === identity) : identity.startsWith(goal.scope);
}

export function canRetryGoalWork(goal: OngoingGoal, item: WorkRecord, source: WorkSource, ownerScope: string): boolean {
  return active(goal) && goal.ownerBotId === source.botId && goal.workItemIds.includes(item.id) &&
    inGoalScope(goal, item.identity) && item.scope === ownerScope &&
    item.coordinatorBotId === source.botId && item.threadId === source.threadId &&
    item.status === "blocked" && !interruptedLinkedWork(item) &&
    !item.assignments.some(assignment => assignment.revision === item.revision && ["queued", "running", "waiting"].includes(assignment.status)) &&
    goal.actions < goal.maxActions && goal.activeMs < goal.maxActiveMinutes * 60_000 &&
    (goal.maxSpendUsd === undefined || goal.spentUsd < goal.maxSpendUsd);
}

export type GoalDecision =
  | { status: "continue"; detail: string; nextAction: string; evidence?: string[] }
  | { status: "waiting"; detail: string; nextAction: string; evidence?: string[] }
  | { status: "completed"; detail: string; evidence: string[] }
  | { status: "needs-input"; detail: string };

export type GoalResponse = GoalDecision & { acceptanceCriteria?: string[] };

export function parseGoalDecision(text: string): { text: string; decision: GoalResponse | null } {
  const open = "<openmaus-pursuit>";
  const close = "</openmaus-pursuit>";
  const end = text.lastIndexOf(close);
  const start = end < 0 ? -1 : text.lastIndexOf(open, end);
  const visible = text.replace(/<openmaus-pursuit>[\s\S]*?<\/openmaus-pursuit>/g, "").split(open)[0]?.trim() ?? "";
  if (start < 0 || end < 0) return { text: visible, decision: null };
  try {
    const raw = JSON.parse(text.slice(start + open.length, end)) as Record<string, unknown>;
    const detail = typeof raw.detail === "string" ? raw.detail.trim().slice(0, 1000) : "";
    const evidence = Array.isArray(raw.evidence) ? raw.evidence.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20) : [];
    const checks = z.array(z.string().trim().min(1).max(1000)).min(1).max(20).safeParse(raw.acceptanceCriteria);
    const acceptanceCriteria = checks.success ? { acceptanceCriteria: checks.data } : {};
    if (!detail) return { text: visible, decision: null };
    if (raw.status === "continue" || raw.status === "waiting") {
      const nextAction = typeof raw.nextAction === "string" ? raw.nextAction.trim().slice(0, 2000) : "";
      if (!nextAction) return { text: visible, decision: null };
      return { text: visible, decision: { status: raw.status, detail, nextAction, evidence, ...acceptanceCriteria } };
    }
    if (raw.status === "completed" && evidence.length) return { text: visible, decision: { status: "completed", detail, evidence, ...acceptanceCriteria } };
    if (raw.status === "needs-input") return { text: visible, decision: { status: "needs-input", detail, ...acceptanceCriteria } };
  } catch {}
  return { text: visible, decision: null };
}

export function goalTurnInstructions(goal: OngoingGoal, work: string): string {
  return [
    `Ongoing goal ${goal.id}, revision ${goal.revision}: ${goal.objective}`,
    `Authorized scope for new shared tasks: ${goal.scope}. Acceptance criteria: ${JSON.stringify(goal.acceptanceCriteria)}.`,
    ...(goal.criteriaPending ? ["The person supplied only the desired outcome. Derive 1–5 concrete, observable acceptance checks from that outcome. Include them as acceptanceCriteria (array of strings) in your private JSON decision before claiming completion; do not expand the authorized outcome or invent evidence."] : []),
    `Linked work and observed state: ${work}. Previous checkpoint: ${goal.detail}. Next action: ${goal.nextAction ?? "inspect the current state"}.`,
    "Take one concrete, authorized step now. Check existing shared tasks before creating work; never duplicate or silently reopen settled work. Dispatch useful work, verify returned evidence, or name exactly what event you are awaiting. If you dispatched work, wait for its result instead of spinning.",
    "Do not claim an external issue, CI run, review or merge succeeded without current observed evidence. Permission, review and policy gates remain binding. Escalate only an essential decision to the authorized owner; a status request alone is not a new authorization.",
    "After a brief human-readable update, end with a private <openmaus-pursuit> JSON object and </openmaus-pursuit>. Choose status continue, waiting, completed or needs-input. All statuses require detail; continue and waiting require nextAction; completed requires nonempty evidence (artifact paths, task ids or observed event ids). Include acceptanceCriteria when requested. Do not quote the private envelope in your update.",
  ].join("\n");
}

export class OngoingGoals {
  readonly records = new Map<string, OngoingGoal>();
  private readonly file: string;
  private readonly changed: (goal: OngoingGoal) => void;
  private readonly now: () => number;
  private loadError?: string;

  constructor(file: string, changed: (goal: OngoingGoal) => void = () => {}, now: () => number = Date.now) {
    this.file = file;
    this.changed = changed;
    this.now = now;
    try {
      const saved = z.array(ongoingGoalSchema).max(MAX_GOALS).parse(JSON.parse(readFileSync(file, "utf8")));
      for (const goal of saved) {
        if (this.records.has(goal.id)) throw new Error("Duplicate goal ID");
        if (goal.inFlightAt) {
          goal.activeMs += Math.max(0, this.now() - goal.inFlightAt);
          delete goal.inFlightAt;
          goal.status = "paused";
          goal.detail = "Execution was interrupted by restart; inspect its effects before resuming. Nothing was replayed.";
        } else if (active(goal)) {
          goal.status = "waiting";
          goal.nextWakeAt = this.now();
        }
        this.records.set(goal.id, goal);
      }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.records.clear();
        this.loadError = "Goal storage is unreadable; repair it before starting or resuming goals.";
      }
    }
  }

  private save() {
    if (this.loadError) throw new Error(this.loadError);
    writeFileAtomic(this.file, JSON.stringify([...this.records.values()]), { mode: 0o600 });
  }

  private update(goal: OngoingGoal, patch: Partial<OngoingGoal>) {
    const previous = structuredClone(goal);
    Object.assign(goal, patch, { updatedAt: this.now(), revision: goal.revision + 1 });
    ongoingGoalSchema.parse(goal);
    try { this.save(); } catch (error) { Object.assign(goal, previous); throw error; }
    this.changed(structuredClone(goal));
    return goal;
  }

  findRequest(input: z.infer<typeof goalCreateSchema>): OngoingGoal | undefined {
    if (!input.requestId) return undefined;
    const existing = [...this.records.values()].find(goal => goal.requestId === input.requestId);
    if (existing && !Object.entries(input).every(([key, value]) =>
      JSON.stringify(existing[key as keyof OngoingGoal]) === JSON.stringify(value))) {
      throw Object.assign(new Error("Goal request ID already belongs to a different request"), { status: 409 });
    }
    return existing;
  }

  create(raw: unknown, executionThreadId: string, teamBacklog?: TeamBacklog) {
    const input = goalCreateSchema.parse(raw);
    const previous = this.findRequest(input);
    if (previous) return previous;
    if ([...this.records.values()].some(goal => goal.sourceThreadId === input.sourceThreadId && !["completed", "stopped"].includes(goal.status))) {
      throw new Error("This conversation already owns an ongoing goal");
    }
    if (this.records.size >= MAX_GOALS) throw new Error("Goal storage limit reached");
    const at = this.now();
    const goal: OngoingGoal = {
      ...input, id: randomUUID(), revision: 1, executionThreadId,
      kind: teamBacklog ? "mission" : input.kind ?? "deliverable",
      scope: input.scope ?? `goal:${input.requestId ?? randomUUID()}:`,
      acceptanceCriteria: input.acceptanceCriteria ?? (teamBacklog
        ? criteriaFromScopes(teamBacklog.scopes.length ? teamBacklog.scopes : teamBacklog.choices)
        : [input.objective.slice(0, 1000)]),
      criteriaPending: !input.acceptanceCriteria && !teamBacklog,
      status: "working", detail: "Queued for the coordinator", nextWakeAt: at,
      workItemIds: input.workItemIds ?? [], ownedWorkItemIds: [], evidence: [], actions: 0, activeMs: 0, spentUsd: 0, chargedTurnIds: [],
      createdAt: at, updatedAt: at, waitCount: 0, noProgress: 0,
      ...(teamBacklog ? { teamBacklog } : {}),
    };
    this.records.set(goal.id, goal);
    try { this.save(); } catch (error) { this.records.delete(goal.id); throw error; }
    this.changed(structuredClone(goal));
    return goal;
  }

  control(id: string, raw: unknown) {
    const input = goalControlSchema.parse(raw);
    const goal = this.records.get(id);
    if (!goal) throw new Error("No such goal");
    if (input.expectedRevision !== goal.revision) throw new Error("Goal revision changed; read its current state");
    if (input.action === "stop") {
      if (["stopped", "completed"].includes(goal.status)) throw new Error("The goal has already ended");
      return this.update(goal, { status: "stopped", detail: input.detail ?? "Stopped by you", nextWakeAt: undefined,
        activeMs: goal.activeMs + (goal.inFlightAt ? Math.max(0, this.now() - goal.inFlightAt) : 0), inFlightAt: undefined });
    }
    if (input.action === "pause") {
      if (!active(goal)) throw new Error("Only a working goal can be paused");
      return this.update(goal, { status: "paused", detail: input.detail ?? "Paused by you", nextWakeAt: undefined,
        activeMs: goal.activeMs + (goal.inFlightAt ? Math.max(0, this.now() - goal.inFlightAt) : 0), inFlightAt: undefined });
    }
    if (goal.teamBacklog && goal.status === "needs-input" && goal.teamBacklog.gates.length > 0 &&
        goal.teamBacklog.gates.every(gate => gate.kind === "scope")) {
      return this.update(goal, { status: "working", nextWakeAt: this.now() });
    }
    if (input.action === "resume") {
      if (!["paused", "needs-input"].includes(goal.status)) throw new Error("This goal is not paused");
      return this.update(goal, { status: "working", detail: input.detail ?? "Resumed by you", nextWakeAt: this.now(),
        actions: 0, activeMs: 0, spentUsd: 0, chargedTurnIds: [], noProgress: 0, waitCount: 0 });
    }
    if (!active(goal)) throw new Error("This goal requires an explicit resume");
    return this.update(goal, { nextWakeAt: this.now() });
  }

  due() {
    if (this.loadError) throw new Error(this.loadError);
    return [...this.records.values()].filter(goal => active(goal) && !goal.inFlightAt && goal.nextWakeAt !== undefined && goal.nextWakeAt <= this.now());
  }

  begin(goal: OngoingGoal) {
    if (!active(goal) || goal.inFlightAt || goal.nextWakeAt === undefined) return false;
    if (goal.actions >= goal.maxActions || goal.activeMs >= goal.maxActiveMinutes * 60_000 ||
      goal.maxSpendUsd !== undefined && goal.spentUsd >= goal.maxSpendUsd) {
      this.update(goal, { status: "paused", detail: "Goal action, active-time or spend budget exhausted; explicitly renew it to continue.", nextWakeAt: undefined });
      return false;
    }
    this.update(goal, { status: "working", nextWakeAt: undefined, inFlightAt: this.now(), actions: goal.actions + 1 });
    return true;
  }

  finish(goal: OngoingGoal, decision: GoalResponse | null, progress: string, costUsd?: number | null) {
    if (!goal.inFlightAt || !active(goal)) return goal;
    const activeMs = goal.activeMs + Math.max(0, this.now() - goal.inFlightAt);
    const spentUsd = goal.spentUsd + (costUsd ?? 0);
    const noProgress = goal.teamBacklog && decision?.status === "waiting" ? 0
      : progress && progress !== goal.lastProgress ? 0 : goal.noProgress + 1;
    const generatedChecks = goal.criteriaPending && decision?.acceptanceCriteria?.length
      ? { acceptanceCriteria: decision.acceptanceCriteria, criteriaPending: false } : {};
    const base = { inFlightAt: undefined, activeMs, spentUsd, noProgress, lastProgress: progress || goal.lastProgress, ...generatedChecks };
    if (goal.maxSpendUsd !== undefined && costUsd == null) return this.update(goal, { ...base, status: "paused", detail: "Goal spending cannot be priced; inspect usage before resuming.", nextWakeAt: undefined });
    if (!decision) return this.update(goal, { ...base, status: "paused", detail: "No valid goal decision was returned; inspect the result before resuming.", nextWakeAt: undefined });
    const evidence = [...new Set([...goal.evidence, ...("evidence" in decision ? decision.evidence ?? [] : [])])].slice(-100);
    if (decision.status === "completed" && (!goal.criteriaPending || decision.acceptanceCriteria?.length)) {
      return this.update(goal, { ...base, status: "completed", detail: decision.detail, evidence, nextWakeAt: undefined });
    }
    if (goal.actions >= goal.maxActions || activeMs >= goal.maxActiveMinutes * 60_000 ||
        goal.maxSpendUsd !== undefined && spentUsd >= goal.maxSpendUsd) return this.update(goal, { ...base, status: "paused", detail: "Goal budget exhausted; explicitly renew it to continue.", nextWakeAt: undefined });
    if (noProgress >= 3) return this.update(goal, { ...base, status: "paused", detail: "No recorded progress across three coordinator actions; review the plan before resuming.", nextWakeAt: undefined });
    if (decision.status === "completed") return this.update(goal, { ...base, status: "working", detail: "Define observable acceptance checks before claiming completion.",
      nextAction: "Check the outcome and record measurable acceptance criteria.", nextWakeAt: this.now() });
    if (decision.status === "needs-input") return this.update(goal, { ...base, status: "needs-input", detail: decision.detail, nextWakeAt: undefined });
    if (decision.status === "waiting") {
      const waitCount = goal.waitCount + 1;
      return this.update(goal, { ...base, status: "waiting", detail: decision.detail, nextAction: decision.nextAction,
        evidence, waitCount, nextWakeAt: this.now() + DELAYS[Math.min(waitCount - 1, DELAYS.length - 1)]! });
    }
    return this.update(goal, { ...base, status: "working", detail: decision.detail, nextAction: decision.nextAction,
      evidence, waitCount: 0, nextWakeAt: this.now() });
  }

  link(goal: OngoingGoal, workItemId: string, owned: boolean) {
    if (!active(goal)) throw new Error("A completed or paused goal cannot acquire new work");
    if (goal.workItemIds.includes(workItemId)) {
      return owned && !goal.ownedWorkItemIds.includes(workItemId)
        ? this.update(goal, { ownedWorkItemIds: [...goal.ownedWorkItemIds, workItemId] }) : goal;
    }
    return this.update(goal, { workItemIds: [...goal.workItemIds, workItemId],
      ownedWorkItemIds: owned ? [...goal.ownedWorkItemIds, workItemId] : goal.ownedWorkItemIds });
  }

  recordBacklog(goal: OngoingGoal, teamBacklog: TeamBacklog) {
    // An in-flight SHA-locked write may finish its readback just after Stop.
    // Persist the observed result without reviving the stopped goal.
    if (!goal.teamBacklog) throw new Error("This goal has no team backlog");
    return this.update(goal, { teamBacklog });
  }

  chooseBacklogScopes(goal: OngoingGoal, expectedRevision: number, ids: string[]) {
    if (!(active(goal) || goal.status === "needs-input") || !goal.teamBacklog || !goal.teamBacklog.choices.length) throw new Error("There is no pending scope choice");
    if (goal.revision !== expectedRevision) throw new Error("Goal revision changed; read the current choices");
    const choices = goal.teamBacklog.choices;
    if (!canSubmitScopeChoice(ids, choices) || new Set(ids).size !== ids.length) {
      throw new Error("Choose one or more of the listed inventory scopes");
    }
    const selected = stampScopes(choices.filter(choice => ids.includes(choice.id)));
    return this.update(goal, {
      status: "working",
      acceptanceCriteria: criteriaFromScopes(selected),
      teamBacklog: { ...goal.teamBacklog, scopes: selected, choices: [], targets: [], gates: [],
      scan: { status: "not-scanned", itemCount: 0, errors: [] } }, nextWakeAt: this.now() });
  }

  wake(goal: OngoingGoal) {
    if (!active(goal) || goal.inFlightAt || goal.nextWakeAt !== undefined && goal.nextWakeAt <= this.now()) return;
    this.update(goal, { nextWakeAt: this.now() });
  }

  defer(goal: OngoingGoal) {
    if (!active(goal) || goal.inFlightAt) return;
    const waitCount = goal.waitCount + 1;
    this.update(goal, { status: "waiting", waitCount,
      nextWakeAt: this.now() + DELAYS[Math.min(waitCount - 1, DELAYS.length - 1)]! });
  }

  observe(goal: OngoingGoal, signature: string) {
    if (!active(goal) || goal.inFlightAt) return false;
    if (goal.lastObserved === signature) {
      this.defer(goal);
      return false;
    }
    this.update(goal, { lastObserved: signature });
    return true;
  }

  park(goal: OngoingGoal, detail: string) {
    if (!["working", "waiting"].includes(goal.status)) return;
    this.update(goal, { status: "paused", detail, inFlightAt: undefined, nextWakeAt: undefined,
      activeMs: goal.activeMs + (goal.inFlightAt ? Math.max(0, this.now() - goal.inFlightAt) : 0) });
  }

  charge(goal: OngoingGoal, turnId: string, costUsd: number | null) {
    if (goal.maxSpendUsd === undefined || goal.chargedTurnIds.includes(turnId) || !active(goal)) return;
    if (costUsd === null) {
      this.park(goal, "Goal spending cannot be priced; inspect usage before resuming.");
      return;
    }
    const spentUsd = goal.spentUsd + costUsd;
    this.update(goal, { spentUsd, chargedTurnIds: [...goal.chargedTurnIds, turnId].slice(-2000) });
    if (spentUsd >= goal.maxSpendUsd) this.park(goal, "Goal spend budget exhausted; explicitly renew it to continue.");
  }
}
