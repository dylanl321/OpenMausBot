import { z } from "zod";
import { currentStepSchema, linkedItemSchema, workCriterionSchema, type LinkedItem, type WorkCriterion } from "./work-links.ts";

export type WorkItemStatus = "active" | "blocked" | "needs-input" | "completed" | "cancelled";
export type WorkAssignmentStatus = "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface WorkArtifact {
  ref: string;
  label: string;
  revision?: string;
}

export interface WorkAssignment {
  id: string;
  botId: string;
  threadId: string;
  revision: number;
  attempts: number;
  message: string;
  status: WorkAssignmentStatus;
  result: string;
  requestId?: string;
  currentStep?: { summary: string; since: number; itemId?: string };
}

export interface WorkItem {
  id: string;
  groupId: string;
  threadId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  coordinatorBotId: string;
  revision: number;
  status: WorkItemStatus;
  detail: string;
  decisions: string[];
  artifacts: WorkArtifact[];
  evidence: string[];
  assignments: WorkAssignment[];
  /** Additive. Absent on records written before task connectors. */
  links?: LinkedItem[];
  criteria?: WorkCriterion[];
  createdAt: number;
  updatedAt: number;
}

const key = z.string().min(1).max(240);
const text = z.string().trim().min(1).max(4000);
export const workItemSchema = z.object({
  id: key, groupId: key, threadId: key, title: z.string().min(1).max(80),
  objective: text, acceptanceCriteria: z.array(text).min(1).max(20), coordinatorBotId: key,
  revision: z.number().int().positive(), status: z.enum(["active", "blocked", "needs-input", "completed", "cancelled"]),
  detail: z.string().max(4000), decisions: z.array(text).max(100),
  artifacts: z.array(z.object({ ref: text, label: z.string().max(200), revision: key.optional() })).max(100),
  evidence: z.array(text).max(100),
  assignments: z.array(z.object({
    id: key, botId: key, threadId: key, revision: z.number().int().positive(), attempts: z.number().int().min(1).max(3), message: text,
    status: z.enum(["queued", "running", "waiting", "completed", "failed", "cancelled"]), result: z.string().max(12_000), requestId: key.optional(),
    currentStep: currentStepSchema.optional(),
  })).max(1000),
  links: z.array(linkedItemSchema).max(100).optional(),
  criteria: z.array(workCriterionSchema).max(20).optional(),
  createdAt: z.number(), updatedAt: z.number(),
});
