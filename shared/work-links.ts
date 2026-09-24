import { z } from "zod";

export const LINK_KINDS = ["work_item", "change_request", "commit", "build", "comment", "document", "link"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const STATUS_CATEGORIES = ["todo", "in_progress", "in_review", "blocked", "done", "cancelled", "unknown"] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const LINK_ROLES = ["source", "output", "reference"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const PROVENANCES = ["observed", "synced", "claimed"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const CRITERION_STATES = ["pending", "in_progress", "checked", "blocked"] as const;
export type CriterionState = (typeof CRITERION_STATES)[number];

const key = z.string().min(1).max(240);
const flat = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const linkedItemSchema = z.object({
  id: key,
  kind: z.enum(LINK_KINDS),
  role: z.enum(LINK_ROLES),
  connectorId: key.optional(),
  connectionId: key.optional(),
  externalId: z.string().min(1).max(240).optional(),
  url: z.string().max(2000).optional(),
  title: z.string().min(1).max(300),
  state: z.object({ label: z.string().min(1).max(80), category: z.enum(STATUS_CATEGORIES) }).optional(),
  parentId: key.optional(),
  details: z.record(z.string().max(40), flat).optional(),
  provenance: z.enum(PROVENANCES),
  createdBy: z.object({ botId: key, threadId: key }).optional(),
  syncedAt: z.number().optional(),
  updatedAt: z.number(),
}).strict();
export type LinkedItem = z.infer<typeof linkedItemSchema>;

export const workCriterionSchema = z.object({
  id: key,
  text: z.string().trim().min(1).max(4000),
  state: z.enum(CRITERION_STATES),
  evidence: z.array(key).max(20),
}).strict();
export type WorkCriterion = z.infer<typeof workCriterionSchema>;

export const currentStepSchema = z.object({
  summary: z.string().min(1).max(240),
  since: z.number(),
  itemId: key.optional(),
}).strict();
export type CurrentStep = z.infer<typeof currentStepSchema>;

export const taskEventSchema = z.object({
  id: key,
  workItemId: key,
  revision: z.number().int().positive(),
  at: z.number(),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("bot"), botId: key, threadId: key }).strict(),
    z.object({ type: z.literal("user"), userId: key.optional() }).strict(),
    z.object({ type: z.literal("connector"), connectionId: key }).strict(),
    z.object({ type: z.literal("system") }).strict(),
  ]),
  kind: z.enum(["tool", "output", "state_change", "comment", "handoff", "decision", "criterion", "lifecycle"]),
  summary: z.string().min(1).max(240),
  linkId: key.optional(),
  state: z.enum(["running", "complete", "failed"]).optional(),
  itemId: key.optional(),
  provenance: z.enum(PROVENANCES),
}).strict();
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** Fields a connector returns. The server owns id, role, provenance, and createdBy. */
export type SyncedItem = Omit<LinkedItem, "id" | "role" | "provenance" | "createdBy">;

/** Identity `ensure_work_item` uses for a connector-sourced item. */
export function sourceIdentity(item: Pick<SyncedItem, "connectorId" | "connectionId" | "externalId">): string | undefined {
  if (!item.connectorId || !item.connectionId || !item.externalId) return undefined;
  return `${item.connectorId}:${item.connectionId}:${item.externalId}`;
}

export function criterionId(index: number): string {
  return `c${index + 1}`;
}

export function criteriaFromTexts(texts: string[], existing: WorkCriterion[] = []): WorkCriterion[] {
  return texts.map((text, index) => {
    const prior = existing.find(criterion => criterion.text === text) ?? existing[index];
    if (prior && prior.text === text) return { ...prior, id: criterionId(index) };
    return { id: criterionId(index), text, state: "pending" as const, evidence: [] };
  });
}
