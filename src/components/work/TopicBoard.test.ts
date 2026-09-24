import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider, type Group } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem, SyncedItem } from "../../../shared/work-links";
import { TopicBoard } from "./TopicBoard";

const at = 1_700_000_000_000;
const link = (partial: Partial<LinkedItem> & Pick<LinkedItem, "id" | "kind" | "title">): LinkedItem => ({
  role: "output", provenance: "synced", updatedAt: at, ...partial,
});

const work = (id: string, title: string, patch: Partial<WorkItem> = {}): WorkItem => ({
  id, groupId: "payments", threadId: `hub-${id}`, title, objective: title,
  acceptanceCriteria: ["Done"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: at, updatedAt: at, ...patch,
});

const group: Group = {
  id: "payments", name: "Payments", threadId: "hub-chat", memberIds: ["chief"], createdAt: 1,
  unread: false, messages: [], bulletin: "", defaultResponder: { kind: "member", botId: "chief" },
  taskBoard: { connectionId: "fake-acme", query: "all" },
  tasks: [
    { threadId: "hub-jira", title: "Refunds", createdAt: 1, workItem: work("jira", "Refunds", {
      links: [link({ id: "src", kind: "work_item", role: "source", title: "Refund failures", externalId: "PAY-1",
        connectorId: "fake", connectionId: "fake-acme", state: { label: "In Progress", category: "in_progress" } })],
    }) },
    { threadId: "hub-repo", title: "MR work", createdAt: 1, workItem: work("repo", "Round refunds", {
      links: [link({ id: "cr", kind: "change_request", title: "Round partial refunds", externalId: "acme/payments!482",
        connectorId: "fake", state: { label: "opened", category: "in_review" } }),
      link({ id: "cmt", kind: "commit", title: "commit 3f2a1c9", externalId: "3f2a1c9" })],
    }) },
    { threadId: "hub-chat", title: "From chat", createdAt: 1, workItem: work("chat", "Triage notes") },
    { threadId: "hub-ask", title: "Need input", createdAt: 1, workItem: work("ask", "Need the account id", {
      status: "needs-input", detail: "Which merchant account should we use?",
    }) },
  ],
};

describe("TopicBoard", () => {
  it("renders mixed sourced, repo-only and chat-started tasks by status category", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(TopicBoard, { group, onOpenTask: () => {}, queried: [], connections: [] })));
    expect(html).toContain('data-topic-board="payments"');
    expect(html).toContain("Start next work");
    expect(html).toContain("Board query");
    expect(html).toContain('data-board-column="in_progress"');
    expect(html).toContain('data-board-column="in_review"');
    expect(html).toContain('data-board-column="blocked"');
    expect(html).toContain('data-board-card="jira"');
    expect(html).toContain('data-board-kind="work_item"');
    expect(html).toContain("PAY-1");
    expect(html).toContain('data-board-card="repo"');
    expect(html).toContain('data-board-kind="change_request"');
    expect(html).toContain("acme/payments!482");
    expect(html).not.toContain("!acme/payments!482");
    expect(html).toContain('data-board-card="chat"');
    expect(html).toContain("Triage notes");
    expect(html).toContain('data-task-answer="ask"');
    expect(html).toContain("Which merchant account should we use?");
    expect(html).toContain("Send answer");
    expect(html).not.toContain("Jira");
    expect(html).not.toContain("GitLab");
  });

  it("can show an untracked query item as no task yet", () => {
    const untracked: SyncedItem = {
      kind: "work_item", title: "Untracked refunds", externalId: "PAY-2", connectorId: "fake",
      connectionId: "fake-acme", state: { label: "To Do", category: "todo" }, updatedAt: at,
    };
    const html = renderToStaticMarkup(createElement(StoreProvider, null,
      createElement(TopicBoard, {
        group, onOpenTask: () => {}, queried: [untracked],
        connections: [{ id: "fake-acme", connectorId: "fake", label: "Fake" }],
      })));
    expect(html).toContain("No task yet");
    expect(html).toContain("Untracked refunds");
    expect(html).toContain("PAY-2");
    expect(html).toContain('data-untracked="true"');
    expect(html).toContain("Start task");
    expect(html).toContain('data-board-column="todo"');
  });
});
