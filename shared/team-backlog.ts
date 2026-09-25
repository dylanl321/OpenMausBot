import { z } from "zod";
import { STATUS_CATEGORIES } from "./work-links.ts";

const key = z.string().min(1).max(240);

export const MISSION_KINDS = ["work_item", "change_request"] as const;
export type MissionKind = (typeof MISSION_KINDS)[number];

export const missionKindSchema = z.enum(MISSION_KINDS);

/** Registry id. Unknown ids fail closed at write/scan time, not in this schema. */
const connectorId = z.string().min(1).max(64);

export const backlogScopeSchema = z.object({
  id: key,
  connectorId,
  connectionId: key,
  query: z.string().min(1).max(4000),
  label: z.string().min(1).max(300),
  groupId: key.optional(),
  /** Absent on stored jira-gitlab missions; filled from that kit's defaults. */
  kinds: z.array(missionKindSchema).min(1).max(8).optional(),
}).strict();
export type BacklogScope = z.infer<typeof backlogScopeSchema>;

export const backlogTargetSchema = z.object({
  identity: key,
  connectorId,
  connectionId: key,
  externalId: key,
  kind: missionKindSchema,
  title: z.string().min(1).max(300),
  state: z.enum(STATUS_CATEGORIES),
  label: z.string().max(80),
  updatedAt: z.number(),
  observedAt: z.number(),
  requirements: z.string().max(500).optional(),
  priority: z.string().max(80).optional(),
  blockers: z.array(key).max(20).optional(),
  headSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  dispatchedHeadSha: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  taskId: key.optional(),
  /** Last policy/review probe on this unchanged source head and state. */
  gateCheckedAt: z.number().optional(),
  result: z.string().max(500).optional(),
}).strict();
export type BacklogTarget = z.infer<typeof backlogTargetSchema>;

export const backlogGateSchema = z.object({
  kind: z.enum(["scope", "inventory", "task", "review", "security", "manager", "policy", "access", "budget"]),
  detail: z.string().min(1).max(1000),
  decisionMaker: z.string().min(1).max(200),
  identity: key.optional(),
}).strict();
export type BacklogGate = z.infer<typeof backlogGateSchema>;

export const teamBacklogSchema = z.object({
  section: z.string().max(200),
  scopes: z.array(backlogScopeSchema).max(200),
  choices: z.array(backlogScopeSchema).max(200),
  targets: z.array(backlogTargetSchema).max(10_000),
  gates: z.array(backlogGateSchema).max(10_000),
  scan: z.object({
    status: z.enum(["not-scanned", "stale", "incomplete", "complete"]),
    attemptedAt: z.number().optional(),
    completedAt: z.number().optional(),
    itemCount: z.number().int().nonnegative(),
    errors: z.array(z.string().max(500)).max(200),
  }).strict(),
}).strict();
export type TeamBacklog = z.infer<typeof teamBacklogSchema>;

export function emptyTeamBacklog(section: string): TeamBacklog {
  return { section, scopes: [], choices: [], targets: [], gates: [],
    scan: { status: "not-scanned", itemCount: 0, errors: [] } };
}

/** Ready to scan/run: at least one scope and no unresolved choices. */
export function backlogReadyToRun(backlog: Pick<TeamBacklog, "scopes" | "choices">): boolean {
  return backlog.scopes.length >= 1 && backlog.choices.length === 0;
}

export function canSubmitScopeChoice(selectedIds: readonly string[], choices: readonly { id: string }[]): boolean {
  return selectedIds.length >= 1 && selectedIds.every(id => choices.some(choice => choice.id === id));
}

export function uniqueMissionKinds(scopes: readonly Pick<BacklogScope, "kinds">[]): MissionKind[] {
  const seen = new Set<MissionKind>();
  for (const scope of scopes) {
    for (const kind of scope.kinds ?? []) seen.add(kind);
  }
  return MISSION_KINDS.filter(kind => seen.has(kind));
}

/** Criteria text from inventory kinds, not hardcoded Jira/MR copy. */
export function criteriaFromKinds(kinds: readonly string[]): string[] {
  const lines: string[] = [];
  if (kinds.includes("work_item")) lines.push("Every scoped work item is evidenced and done");
  if (kinds.includes("change_request")) lines.push("Every scoped change request is merged at a reviewed head");
  return lines.length ? lines : ["Every scoped work item is evidenced and done"];
}

export function criteriaFromScopes(scopes: readonly Pick<BacklogScope, "kinds">[]): string[] {
  const kinds = uniqueMissionKinds(scopes);
  return criteriaFromKinds(kinds.length ? kinds : MISSION_KINDS);
}

export function scopeChoiceLabel(choice: Pick<BacklogScope, "label" | "query" | "connectorId">, connectorName?: string): string {
  const name = connectorName?.trim() || choice.connectorId;
  return `${choice.label} · ${name}`;
}
