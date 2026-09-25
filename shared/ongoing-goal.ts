import { z } from "zod";
import { teamBacklogSchema, type TeamBacklog } from "./team-backlog.ts";

export const goalStatusSchema = z.enum(["working", "waiting", "paused", "needs-input", "completed", "stopped"]);
export type GoalStatus = z.infer<typeof goalStatusSchema>;

export const goalCreateSchema = z.object({
  requestId: z.string().uuid().optional(),
  ownerBotId: z.string().min(1).max(240),
  sourceThreadId: z.string().min(1).max(240),
  kind: z.enum(["deliverable", "mission"]).optional(),
  objective: z.string().trim().min(1).max(4000),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20).optional(),
  scope: z.string().trim().min(1).max(240).optional(),
  workItemIds: z.array(z.string().min(1).max(240)).max(100).optional(),
  maxActions: z.number().int().min(1).max(1000).default(48),
  maxActiveMinutes: z.number().int().min(1).max(10080).default(1440),
  maxSpendUsd: z.number().positive().finite().optional(),
}).strict();

export const goalControlSchema = z.object({
  expectedRevision: z.number().int().positive(),
  action: z.enum(["pause", "resume", "stop", "wake"]),
  detail: z.string().trim().min(1).max(1000).optional(),
}).strict();

export interface OngoingGoal {
  id: string;
  requestId?: string;
  revision: number;
  ownerBotId: string;
  sourceThreadId: string;
  executionThreadId: string;
  kind: "deliverable" | "mission";
  objective: string;
  acceptanceCriteria: string[];
  criteriaPending?: boolean;
  scope: string;
  status: GoalStatus;
  detail: string;
  nextAction?: string;
  nextWakeAt?: number;
  workItemIds: string[];
  ownedWorkItemIds: string[];
  evidence: string[];
  actions: number;
  maxActions: number;
  activeMs: number;
  maxActiveMinutes: number;
  maxSpendUsd?: number;
  spentUsd: number;
  chargedTurnIds: string[];
  createdAt: number;
  updatedAt: number;
  inFlightAt?: number;
  waitCount: number;
  noProgress: number;
  lastProgress?: string;
  lastObserved?: string;
  /** Server-owned inventory for an outcome-only team mission. */
  teamBacklog?: TeamBacklog;
}

export const ongoingGoalSchema: z.ZodType<OngoingGoal> = goalCreateSchema.omit({ sourceThreadId: true, workItemIds: true }).extend({
  id: z.string().uuid(),
  kind: z.enum(["deliverable", "mission"]),
  scope: z.string().trim().min(1).max(240),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  criteriaPending: z.boolean().optional(),
  revision: z.number().int().positive(),
  sourceThreadId: z.string().min(1).max(240),
  executionThreadId: z.string().min(1).max(240),
  status: goalStatusSchema,
  detail: z.string().max(4000),
  nextAction: z.string().max(2000).optional(),
  nextWakeAt: z.number().optional(),
  workItemIds: z.array(z.string().min(1).max(240)).max(10_000),
  ownedWorkItemIds: z.array(z.string().min(1).max(240)).max(10_000),
  evidence: z.array(z.string().min(1).max(2000)).max(100),
  actions: z.number().int().nonnegative(),
  activeMs: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  chargedTurnIds: z.array(z.string().min(1).max(240)).max(2000).default([]),
  createdAt: z.number(), updatedAt: z.number(),
  inFlightAt: z.number().optional(),
  waitCount: z.number().int().nonnegative(),
  noProgress: z.number().int().nonnegative(),
  lastProgress: z.string().max(2000).optional(),
  lastObserved: z.string().max(12000).optional(),
  teamBacklog: teamBacklogSchema.optional(),
});
