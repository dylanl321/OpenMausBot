import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic.ts";
import type { WorkAssignment, WorkItem, WorkItemStatus } from "../shared/work-item.ts";
import { workItemSchema } from "../shared/work-item.ts";
import { criteriaFromTexts, type LinkedItem, type Provenance } from "../shared/work-links.ts";

const key = z.string().min(1).max(240);
const text = z.string().trim().min(1).max(4000);
const MAX_WORK_ITEMS = 10_000;
const artifactSchema = z.object({ ref: text, label: z.string().max(200), revision: key.optional() });
const sourceSchema = z.object({
  botId: key, threadId: key, groupId: key.optional(), revision: z.number().int().positive(),
  messageId: key.optional(),
  delivered: z.boolean().default(false),
});
const recordSchema = workItemSchema.extend({
  scope: z.string().max(240), identity: key, inputHash: z.string(),
  rootId: key.optional(), executions: z.number().int().nonnegative(),
  runStartedAt: z.number(), sources: z.array(sourceSchema).max(1000),
});
export type WorkRecord = z.infer<typeof recordSchema>;
export type WorkSource = Omit<z.infer<typeof sourceSchema>, "revision" | "delivered">;

export const ensureWorkItemSchema = z.object({
  workItemId: key.optional(), groupId: key.optional(), topic: z.string().trim().min(1).max(100).optional(),
  identity: key.optional(), title: z.string().trim().min(1).max(80), objective: text,
  acceptanceCriteria: z.array(text).min(1).max(20),
  input: z.string().max(12_000).optional(),
}).strict();
export const updateWorkItemSchema = z.object({
  expectedRevision: z.number().int().positive(),
  status: z.enum(["blocked", "needs-input", "completed", "cancelled"]).optional(),
  detail: text.optional(), decision: text.optional(), artifacts: z.array(artifactSchema).max(100).optional(),
  evidence: z.array(text).max(100).optional(), completedCriteria: z.array(text).max(20).optional(),
  criteria: z.array(z.object({
    index: z.number().int().min(0).max(19),
    state: z.enum(["pending", "in_progress", "checked", "blocked"]),
    evidence: z.array(key).max(20),
  }).strict()).max(20).optional(),
  reopen: z.boolean().optional(), objective: text.optional(), acceptanceCriteria: z.array(text).min(1).max(20).optional(),
}).strict();
export type WorkUpdate = z.infer<typeof updateWorkItemSchema>;

export function publicWorkItem(record: WorkRecord): WorkItem {
  const { scope: _scope, identity: _identity, inputHash: _inputHash, rootId: _rootId,
    executions: _executions, runStartedAt: _runStartedAt, sources: _sources, ...item } = record;
  const view = structuredClone(item);
  if (view.criteria?.length) view.acceptanceCriteria = view.criteria.map(criterion => criterion.text);
  if (view.links?.length) view.artifacts = view.links.map(linkToArtifact);
  return view;
}

const OBSERVED = new Set<Provenance>(["observed", "synced"]);

export function linkToArtifact(link: LinkedItem): WorkItem["artifacts"][number] {
  const revision = typeof link.details?.revision === "string" ? link.details.revision : undefined;
  return { ref: link.url ?? link.externalId ?? link.id, label: link.title, ...(revision ? { revision } : {}) };
}

function artifactLink(artifact: WorkItem["artifacts"][number], at: number): LinkedItem {
  return {
    id: `artifact:${createHash("sha256").update(artifact.ref).digest("hex").slice(0, 16)}`,
    kind: "link", role: "reference", title: artifact.label, url: artifact.ref,
    ...(artifact.revision ? { details: { revision: artifact.revision } } : {}),
    provenance: "claimed", updatedAt: at,
  };
}

/** Fill links and criteria from the pre-connector fields. String evidence stays a string list. */
export function migrateWorkRecord(item: WorkRecord): boolean {
  let changed = false;
  if (!item.criteria) {
    item.criteria = criteriaFromTexts(item.acceptanceCriteria);
    changed = true;
  }
  if (!item.links) {
    item.links = item.artifacts.map(artifact => artifactLink(artifact, item.updatedAt));
    changed = true;
  }
  return changed;
}

function mirrorLegacy(item: WorkRecord) {
  if (item.criteria?.length) item.acceptanceCriteria = item.criteria.map(criterion => criterion.text);
  if (item.links) item.artifacts = item.links.map(linkToArtifact);
}

const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const unsettled = (assignment: WorkAssignment) => ["queued", "running", "waiting"].includes(assignment.status);

export class WorkItems {
  readonly records = new Map<string, WorkRecord>();
  private readonly file: string;
  private readonly now: () => number;
  private loadError?: string;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    try {
      const saved = z.array(recordSchema).max(MAX_WORK_ITEMS).parse(JSON.parse(readFileSync(file, "utf8")));
      const identities = new Set<string>();
      for (const item of saved) {
        const identity = JSON.stringify([item.scope, item.identity]);
        if (this.records.has(item.id) || identities.has(identity)) throw new Error("Duplicate work identity");
        identities.add(identity);
        if (item.status === "active") {
          item.status = "blocked";
          item.detail = "Interrupted by server restart; inspect the recorded results before explicitly reopening. Work was not replayed.";
        }
        for (const assignment of item.assignments) {
          if (unsettled(assignment)) {
            assignment.status = "failed";
            assignment.result = "Interrupted by server restart; not replayed.";
          }
          if (assignment.currentStep) delete assignment.currentStep;
        }
        migrateWorkRecord(item);
        this.records.set(item.id, item);
      }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.records.clear();
        this.loadError = "Shared task storage is unreadable; repair it before starting work.";
      }
    }
  }

  private save() {
    if (this.loadError) throw new Error(this.loadError);
    writeFileAtomic(this.file, JSON.stringify([...this.records.values()]), { mode: 0o600 });
  }

  changed(item: WorkRecord) {
    item.updatedAt = this.now();
    this.save();
  }

  find(scope: string, identity: string) {
    if (this.loadError) throw new Error(this.loadError);
    return [...this.records.values()].find(item => item.scope === scope && item.identity === identity);
  }

  forThread(threadId: string) {
    return [...this.records.values()].find(item => item.threadId === threadId || item.assignments.some(assignment => assignment.threadId === threadId));
  }

  ensure(input: z.infer<typeof ensureWorkItemSchema> & { scope: string; identity: string; groupId: string; threadId: string; coordinatorBotId: string }) {
    const existing = this.find(input.scope, input.identity);
    if (existing) {
      if (input.input !== undefined && digest(input.input) !== existing.inputHash) {
        if (existing.status === "active" || existing.assignments.some(unsettled)) throw new Error("This task is still working. Stop or settle it before changing its inputs.");
        this.advance(existing);
        existing.objective = input.objective;
        existing.acceptanceCriteria = input.acceptanceCriteria;
        existing.criteria = criteriaFromTexts(input.acceptanceCriteria);
        existing.inputHash = digest(input.input);
        this.changed(existing);
        return { item: existing, created: false, started: true };
      }
      return { item: existing, created: false, started: false };
    }
    if (this.records.size >= MAX_WORK_ITEMS) throw new Error("Shared task storage limit reached (10,000 tasks). Existing work remains readable.");
    const now = this.now();
    const item: WorkRecord = {
      id: randomUUID(), groupId: input.groupId, threadId: input.threadId, scope: input.scope,
      identity: input.identity, title: input.title, objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria, coordinatorBotId: input.coordinatorBotId,
      revision: 1, status: "active", detail: "Queued for the coordinator", decisions: [], artifacts: [], evidence: [], assignments: [],
      links: [], criteria: criteriaFromTexts(input.acceptanceCriteria),
      createdAt: now, updatedAt: now, inputHash: digest(input.input ?? ""),
      executions: 0, runStartedAt: now, sources: [],
    };
    recordSchema.parse(item);
    this.records.set(item.id, item);
    try { this.save(); } catch (error) { this.records.delete(item.id); throw error; }
    return { item, created: true, started: true };
  }

  subscribe(item: WorkRecord, source: WorkSource) {
    if (source.threadId === item.threadId) return;
    if (item.sources.some(entry => entry.threadId === source.threadId && entry.botId === source.botId && entry.revision === item.revision)) return;
    if (item.sources.length >= 1000) throw new Error("Shared task observer limit reached");
    item.sources.push({ ...source, revision: item.revision, delivered: false });
    this.changed(item);
  }

  pendingForSource(threadId: string) {
    return [...this.records.values()].some(item => item.status === "active" && item.sources.some(source => source.threadId === threadId && source.revision === item.revision && !source.delivered));
  }

  private advance(item: WorkRecord) {
    item.revision += 1;
    item.status = "active";
    item.detail = "Queued for the coordinator";
    item.evidence = [];
    if (item.criteria) {
      for (const criterion of item.criteria) {
        criterion.state = "pending";
        criterion.evidence = [];
      }
    }
    item.executions = 0;
    item.runStartedAt = this.now();
    delete item.rootId;
  }

  update(record: WorkRecord, input: WorkUpdate, actorBotId?: string, resolveEvidence?: (id: string) => Provenance | undefined) {
    const item = structuredClone(record);
    if (actorBotId && item.coordinatorBotId !== actorBotId) throw new Error("Only the task coordinator can change its objective or outcome");
    if (input.expectedRevision !== item.revision) throw new Error("Task revision changed; read the current task before updating it");
    if (input.reopen || input.objective !== undefined || input.acceptanceCriteria !== undefined) {
      if (input.status) throw new Error("Do not reopen and finish a task in the same update");
      if (item.status === "active" || item.assignments.some(unsettled)) throw new Error("Stop or settle existing work before reopening or changing requirements");
      this.advance(item);
      if (input.objective) item.objective = input.objective;
      if (input.acceptanceCriteria) {
        item.acceptanceCriteria = input.acceptanceCriteria;
        item.criteria = criteriaFromTexts(input.acceptanceCriteria);
      }
    } else {
      if (input.criteria) this.applyCriteria(item, input.criteria, resolveEvidence);
      if (input.status) {
        if (item.status !== "active") throw new Error("This task has ended. Explicitly reopen it before changing its outcome");
        if (!input.detail) throw new Error("An outcome needs a concrete result or blocker");
        const current = item.assignments.filter(assignment => assignment.revision === item.revision);
        let status = input.status;
        if (input.status === "completed") {
          if (current.some(assignment => assignment.status !== "completed")) throw new Error("Required assignments have not completed successfully");
          if (input.criteria) {
            const satisfied = (item.criteria ?? []).every(criterion => criterion.state === "checked" && criterion.evidence.some(id => OBSERVED.has(resolveEvidence?.(id) ?? "claimed")));
            if (!satisfied) {
              status = "needs-input";
              item.detail = "Observed evidence is still required before this task can be completed.";
            }
          } else if (!input.evidence?.length || item.acceptanceCriteria.some(criterion => !input.completedCriteria?.includes(criterion))) {
            throw new Error("Completion requires evidence and every acceptance criterion checked against the current revision");
          } else {
            for (const criterion of item.criteria ?? []) {
              if (input.completedCriteria?.includes(criterion.text)) criterion.state = "checked";
            }
          }
        } else if (input.status !== "cancelled" && current.some(unsettled)) {
          throw new Error("Assignments are still working; wait for results or stop this task");
        }
        item.status = status;
        if (status !== "needs-input" && input.detail) item.detail = input.detail;
      }
    }
    if (input.detail && !input.status) item.detail = input.detail;
    if (input.decision && !item.decisions.includes(input.decision)) {
      if (item.decisions.length >= 100) throw new Error("Task decision limit reached");
      item.decisions.push(input.decision);
    }
    if (input.artifacts) this.replaceClaimedArtifacts(item, input.artifacts);
    if (input.evidence) item.evidence = input.evidence;
    mirrorLegacy(item);
    Object.assign(record, item);
    // Object.assign cannot remove the old execution root from a reopened
    // record. Keeping it would bind the new revision to a completed run.
    if (item.rootId === undefined) delete record.rootId;
    this.changed(record);
    return record;
  }

  private applyCriteria(item: WorkRecord, updates: NonNullable<WorkUpdate["criteria"]>, resolveEvidence?: (id: string) => Provenance | undefined) {
    const criteria = item.criteria ?? criteriaFromTexts(item.acceptanceCriteria);
    item.criteria = criteria;
    for (const update of updates) {
      const criterion = criteria[update.index];
      if (!criterion) throw new Error("Criterion index is outside this task");
      if (update.state === "checked" && !update.evidence.length) throw new Error("Checking a criterion requires an existing evidence id");
      for (const id of update.evidence) {
        if (!resolveEvidence?.(id)) throw new Error("Evidence must be an existing link or event id");
      }
      criterion.state = update.state;
      criterion.evidence = update.evidence;
    }
  }

  private replaceClaimedArtifacts(item: WorkRecord, artifacts: WorkItem["artifacts"]) {
    const kept = (item.links ?? []).filter(link => link.provenance !== "claimed" || link.role !== "reference" || link.kind !== "link");
    item.links = [...kept, ...artifacts.map(artifact => artifactLink(artifact, this.now()))].slice(0, 100);
  }

  upsertLink(item: WorkRecord, link: LinkedItem) {
    const links = item.links ?? [];
    const index = links.findIndex(existing => existing.id === link.id);
    if (index >= 0) links[index] = { ...links[index], ...link, updatedAt: this.now() };
    else {
      if (links.length >= 100) throw new Error("Shared task link limit reached");
      links.push({ ...link, updatedAt: this.now() });
    }
    item.links = links;
    mirrorLegacy(item);
    this.changed(item);
    return item.links.find(existing => existing.id === link.id)!;
  }

  setCurrentStep(item: WorkRecord, threadId: string, step: { summary: string; since: number; itemId?: string } | null) {
    const assignment = item.assignments.find(candidate => candidate.threadId === threadId && candidate.revision === item.revision);
    if (!assignment) return;
    if (step) assignment.currentStep = step;
    else delete assignment.currentStep;
    this.changed(item);
  }

  claim(item: WorkRecord, input: { botId: string; threadId: string; message: string; assignmentId?: string; rework?: boolean }) {
    if (item.status !== "active") throw new Error(`Shared task is ${item.status}; unchanged work is not dispatched`);
    const prior = item.assignments.find(assignment => assignment.botId === input.botId && assignment.revision === item.revision);
    if (input.assignmentId && prior?.id !== input.assignmentId) throw new Error("assignment_id must identify this bot's current assignment");
    if (prior) {
      if (!input.rework || unsettled(prior)) return { assignment: prior, duplicate: true };
      if (input.assignmentId !== prior.id || input.message.trim() === prior.message.trim()) throw new Error("Rework needs the existing assignment_id and a concrete changed brief");
      if (prior.attempts >= 3) {
        item.status = "blocked";
        item.detail = "Two automatic correction attempts were exhausted. Inspect the results before explicitly reopening.";
        this.changed(item);
        throw new Error(item.detail);
      }
      prior.attempts += 1;
      prior.message = input.message;
      prior.result = "";
      prior.status = "queued";
      delete prior.requestId;
      this.changed(item);
      return { assignment: prior, duplicate: false };
    }
    if (item.assignments.filter(assignment => assignment.revision === item.revision).length >= 24 || item.assignments.length >= 1000) throw new Error("Shared task assignment budget exhausted");
    const assignment: WorkAssignment = { id: randomUUID(), botId: input.botId, threadId: input.threadId, revision: item.revision,
      attempts: 1, message: input.message, status: "queued", result: "" };
    item.assignments.push(assignment);
    this.changed(item);
    return { assignment, duplicate: false };
  }

  admit(item: WorkRecord, revision: number) {
    if (revision !== item.revision) return "This assignment belongs to an older task revision";
    if (item.status !== "active") return `Shared task is ${item.status}; no further coordination will run`;
    if (item.executions >= 48 || this.now() - item.runStartedAt >= 4 * 60 * 60_000) {
      item.status = "blocked";
      item.detail = "Shared task execution budget exhausted; another routine tick cannot reset it.";
      this.changed(item);
      return item.detail;
    }
    item.executions += 1;
    this.changed(item);
  }

  settle(item: WorkRecord, status: WorkItemStatus, detail: string) {
    if (item.status !== "active") return;
    item.status = status;
    item.detail = detail.slice(0, 4000);
    this.changed(item);
  }

  restore(input: WorkItem & { scope: string; identity: string; inputHash?: string }) {
    if (this.find(input.scope, input.identity)) throw new Error("Imported task identity already exists");
    if (this.records.size >= MAX_WORK_ITEMS) throw new Error("Shared task storage limit reached (10,000 tasks). Existing work remains readable.");
    if (this.records.has(input.id)) throw new Error("Imported task ID already exists");
    const record = recordSchema.parse({ ...input, executions: 0, runStartedAt: this.now(), sources: [], inputHash: input.inputHash ?? "" });
    migrateWorkRecord(record);
    if (record.status === "active") {
      record.status = "blocked";
      record.detail = "Imported work is paused. Inspect its artifacts and explicitly reopen it before executing.";
    }
    for (const assignment of record.assignments) {
      delete assignment.requestId;
      if (unsettled(assignment)) { assignment.status = "failed"; assignment.result = "Imported execution was not replayed."; }
    }
    this.records.set(record.id, record);
    try { this.save(); } catch (error) { this.records.delete(record.id); throw error; }
    return record;
  }

  discardImported(ids: string[]) {
    for (const id of ids) this.records.delete(id);
    this.save();
  }
}
