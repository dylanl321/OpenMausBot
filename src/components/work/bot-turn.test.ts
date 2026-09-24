import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem } from "../../../shared/work-links";
import { workerTurns } from "./bot-turn";

const at = 1_700_000_000_000;
const message = (partial: Partial<Message> & Pick<Message, "id" | "role" | "kind">): Message => ({
  at, ...partial,
});

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Tests pass"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "Working", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: at, updatedAt: at,
  links: [{
    id: "commit-1", kind: "commit", role: "output", title: "commit 3f2a1c9", provenance: "observed",
    createdBy: { botId: "eng", threadId: "worker" }, updatedAt: at + 3,
  } satisfies LinkedItem],
};

describe("workerTurns", () => {
  it("reads a plan from non-terminal narration, groups tools, and attaches thread outputs", () => {
    const turns = workerTurns([
      message({ id: "u1", role: "user", kind: "text", text: "Implement refunds", at }),
      message({ id: "plan", role: "bot", kind: "text", text: "Check boundaries, then commit.", turnId: "t1", at: at + 1 }),
      message({ id: "tool-1", role: "bot", kind: "activity", tool: { name: "Bash", ok: true, summary: "git commit" }, turnId: "t1", at: at + 2 }),
      message({ id: "tool-2", role: "bot", kind: "activity", tool: { name: "Bash", ok: true, summary: "git push" }, turnId: "t1", at: at + 3 }),
      message({ id: "reply", role: "bot", kind: "text", text: "Refunds checked.", turnId: "t1", turnTerminal: true, at: at + 4 }),
    ], item, "worker");
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      plan: "Check boundaries, then commit.",
      replyId: "reply",
      live: false,
      tools: [{ name: "Bash", count: 2, failed: 0, running: false }],
      outputs: [expect.objectContaining({ id: "commit-1" })],
    });
  });

  it("omits the plan section when the engine only sent a terminal reply", () => {
    const turns = workerTurns([
      message({ id: "u1", role: "user", kind: "text", text: "Go", at }),
      message({ id: "reply", role: "bot", kind: "text", text: "Done.", turnTerminal: true, at: at + 1 }),
    ], item, "worker");
    expect(turns[0]?.plan).toBeUndefined();
    expect(turns[0]?.replyId).toBe("reply");
    expect(turns[0]?.outputs).toEqual([]);
  });

  it("marks an in-flight turn live and keeps running tools", () => {
    const turns = workerTurns([
      message({ id: "u1", role: "user", kind: "text", text: "Go", at }),
      message({ id: "plan", role: "bot", kind: "text", text: "I will run tests.", at: at + 1 }),
      message({ id: "tool-1", role: "bot", kind: "activity", tool: { name: "Bash", summary: "pnpm test" }, at: at + 2 }),
    ], item, "worker");
    expect(turns[0]).toMatchObject({ live: true, plan: "I will run tests.", tools: [{ name: "Bash", running: true }] });
  });
});
