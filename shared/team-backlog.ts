import { z } from "zod";
import { STATUS_CATEGORIES } from "./work-links.ts";

const key = z.string().min(1).max(240);

export const backlogScopeSchema = z.object({
  id: key,
  connectorId: z.enum(["jira", "gitlab"]),
  connectionId: key,
  query: z.string().min(1).max(4000),
  label: z.string().min(1).max(300),
  groupId: key.optional(),
}).strict();
export type BacklogScope = z.infer<typeof backlogScopeSchema>;

export const backlogTargetSchema = z.object({
  identity: key,
  connectorId: z.enum(["jira", "gitlab"]),
  connectionId: key,
  externalId: key,
  kind: z.enum(["work_item", "change_request"]),
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
