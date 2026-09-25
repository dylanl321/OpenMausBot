import type { OptionCardData } from "./wire.ts";
import type { BacklogGate, BacklogScope, TeamBacklog } from "./team-backlog.ts";

export type WorkQueue = "needs-you" | "waiting" | "working" | "completed";

export interface WorkOverviewEntry {
  /** Tasks include shared work items and ordinary task conversations. */
  kind: "task" | "goal" | "source";
  id: string;
  team: string;
  title: string;
  status: string;
  queue: WorkQueue;
  owner: { id: string; name: string };
  detail: string;
  nextCheckpoint?: string;
  evidence: string[];
  updatedAt: number;
  threadId: string;
  revision: number;
  gates?: BacklogGate[];
  choices?: BacklogScope[];
  scan?: TeamBacklog["scan"];
  canChooseScope?: boolean;
  canRenew?: boolean;
  canAnswerTask?: boolean;
}

export interface WorkOverviewCard {
  entryId: string;
  threadId: string;
  messageId: string;
  card: OptionCardData;
  canAct: boolean;
  decisionMaker: string;
}

export interface WorkOverview {
  entries: WorkOverviewEntry[];
  cards: WorkOverviewCard[];
  teams: string[];
  counts: Record<WorkQueue, number>;
  nextCursor?: string;
}
