import { describe, expect, it } from "vitest";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem, SyncedItem } from "../../../shared/work-links";
import { sourceIdentity } from "../../../shared/work-links";
import { ensureFromSynced, nextUntrackedWork, syncedBoardCategory, taskBoardCategory, tracksSyncedItem, untrackedItems } from "./board";

const item = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Done"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: 1, updatedAt: 2, ...patch,
});

const link = (partial: Partial<LinkedItem> & Pick<LinkedItem, "id" | "kind" | "title">): LinkedItem => ({
  role: "output", provenance: "observed", updatedAt: 1, ...partial,
});

const synced = (partial: Partial<SyncedItem> & Pick<SyncedItem, "kind" | "title">): SyncedItem => ({
  connectorId: "fake", connectionId: "fake-acme", externalId: partial.externalId ?? "PAY-2", updatedAt: 1, ...partial,
});

describe("topic board model", () => {
  it("groups chat-started, repo-only and sourced tasks by statusCategory", () => {
    const chat = item({ id: "chat", title: "From chat" });
    const repo = item({
      id: "repo", title: "From git",
      links: [link({ id: "cr", kind: "change_request", title: "Round partial refunds", externalId: "482",
        state: { label: "opened", category: "in_review" } })],
    });
    const jiraLike = item({
      id: "tracker", title: "From tracker",
      links: [link({ id: "src", kind: "work_item", role: "source", title: "Refund failures", externalId: "PAY-1",
        connectorId: "fake", connectionId: "fake-acme", state: { label: "In Progress", category: "in_progress" } })],
    });
    const waiting = item({ id: "ask", status: "needs-input", detail: "Need the account id" });
    expect(taskBoardCategory(chat)).toBe("in_progress");
    expect(taskBoardCategory(repo)).toBe("in_review");
    expect(taskBoardCategory(jiraLike)).toBe("in_progress");
    expect(taskBoardCategory(waiting)).toBe("blocked");
    expect(taskBoardCategory(item({ status: "completed" }))).toBe("done");
    expect(taskBoardCategory(item({ status: "cancelled" }))).toBe("cancelled");
  });

  it("treats queried items without a matching task as untracked next work", () => {
    const tracked = item({
      links: [link({ id: "src", kind: "work_item", role: "source", title: "Refund failures", externalId: "PAY-1",
        connectorId: "fake", connectionId: "fake-acme" })],
    });
    const pay1 = synced({ kind: "work_item", title: "Refund failures", externalId: "PAY-1" });
    const pay2 = synced({ kind: "work_item", title: "Untracked refunds", externalId: "PAY-2",
      state: { label: "To Do", category: "todo" } });
    expect(tracksSyncedItem(tracked, pay1)).toBe(true);
    expect(untrackedItems([tracked], [pay1, pay2])).toEqual([pay2]);
    expect(syncedBoardCategory(pay2)).toBe("todo");
    expect(nextUntrackedWork([pay2])?.externalId).toBe("PAY-2");
    expect(ensureFromSynced(pay2, { id: "topic", name: "Payments" })).toEqual({
      groupId: "topic", topic: "Payments", identity: "fake:fake-acme:PAY-2",
      title: "Untracked refunds", objective: "Untracked refunds",
      acceptanceCriteria: ["Deliver the requested outcome"],
    });
    expect(sourceIdentity(pay2)).toBe("fake:fake-acme:PAY-2");
  });
});
