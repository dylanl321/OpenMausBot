import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem, TaskEvent } from "../../../shared/work-links";
import { TaskView } from "./TaskView";

const at = 1_700_000_000_000;
const link = (partial: Partial<LinkedItem> & Pick<LinkedItem, "id" | "kind" | "title">): LinkedItem => ({
  role: "output", provenance: "observed", updatedAt: at, ...partial,
});

const links: LinkedItem[] = [
  link({ id: "fake:work_item:PAY-1", kind: "work_item", role: "source", title: "Refund failures", externalId: "PAY-1", connectorId: "fake",
    url: "https://fake.example/work_item/PAY-1", state: { label: "In Progress", category: "in_progress" } }),
  link({ id: "fake:change_request:482", kind: "change_request", title: "Round partial refunds", externalId: "482", connectorId: "fake",
    url: "https://fake.example/change_request/482", state: { label: "opened", category: "in_review" } }),
  link({ id: "local:commit:3f2a1c9", kind: "commit", title: "commit 3f2a1c9", externalId: "3f2a1c9", details: { branch: "fix-refunds" } }),
  link({ id: "fake:build:9001", kind: "build", title: "pipeline 9001", externalId: "9001", connectorId: "fake",
    state: { label: "failed", category: "blocked" } }),
  link({ id: "fake:comment:note-1", kind: "comment", title: "Looks right", externalId: "note-1", connectorId: "fake" }),
  link({ id: "fake:document:doc-1", kind: "document", role: "reference", title: "Refund policy", externalId: "doc-1", connectorId: "fake" }),
  link({ id: "url:ref-1", kind: "link", title: "Related note", externalId: "ref-1", provenance: "claimed" }),
];

const events: TaskEvent[] = [
  { id: "e-life", workItemId: "work", revision: 1, at, actor: { type: "system" }, kind: "lifecycle", summary: "Task opened", provenance: "observed" },
  { id: "e-hand", workItemId: "work", revision: 1, at: at + 1, actor: { type: "bot", botId: "chief", threadId: "hub" }, kind: "handoff", summary: "Assigned engineer", provenance: "observed" },
  { id: "e-tool", workItemId: "work", revision: 1, at: at + 2, actor: { type: "bot", botId: "eng", threadId: "worker" }, kind: "tool", summary: "git commit", state: "complete", provenance: "observed" },
  { id: "e-out", workItemId: "work", revision: 1, at: at + 3, actor: { type: "bot", botId: "eng", threadId: "worker" }, kind: "output", summary: "committed 3f2a1c9", linkId: "local:commit:3f2a1c9", provenance: "observed" },
  { id: "e-state", workItemId: "work", revision: 1, at: at + 4, actor: { type: "connector", connectionId: "fake-acme" }, kind: "state_change", summary: "PAY-1 moved to In Progress", linkId: "fake:work_item:PAY-1", provenance: "synced" },
  { id: "e-comment", workItemId: "work", revision: 1, at: at + 5, actor: { type: "bot", botId: "eng", threadId: "worker" }, kind: "comment", summary: "Looks right", linkId: "fake:comment:note-1", provenance: "observed" },
  { id: "e-crit", workItemId: "work", revision: 1, at: at + 6, actor: { type: "bot", botId: "chief", threadId: "hub" }, kind: "criterion", summary: "Checked tests", provenance: "observed" },
  { id: "e-dec", workItemId: "work", revision: 1, at: at + 7, actor: { type: "bot", botId: "chief", threadId: "hub" }, kind: "decision", summary: "Use the existing refund API", provenance: "claimed" },
];

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refund failures",
  acceptanceCriteria: ["Tests pass", "Reviewed"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "Waiting for review", decisions: ["Use the existing refund API"], artifacts: [], evidence: [],
  criteria: [
    { id: "c1", text: "Tests pass", state: "checked", evidence: ["local:commit:3f2a1c9"] },
    { id: "c2", text: "Reviewed", state: "in_progress", evidence: ["fake:change_request:482"] },
  ],
  links,
  assignments: [{ id: "a1", botId: "eng", threadId: "worker", revision: 1, attempts: 1, message: "Implement and check refunds",
    status: "running", result: "", currentStep: { summary: "git push origin fix-refunds", since: at + 8 } }],
  createdAt: at, updatedAt: at + 8,
};

const render = (candidate: WorkItem = item) => renderToStaticMarkup(createElement(StoreProvider, null,
  createElement(TaskView, { item: candidate, events, connectors: [{ id: "fake", name: "Fake" }] })));

describe("TaskView", () => {
  it("renders a full task lifecycle from the fake connector and git capture", () => {
    const html = render();
    expect(html).toContain('aria-label="Shared task summary"');
    expect(html).toContain("Stop shared task");
    expect(html).toContain("Owner: chief");
    expect(html).toContain("Refund failures");
    expect(html).toContain("Round partial refunds");
    expect(html).toContain("commit 3f2a1c9");
    expect(html).toContain("pipeline 9001");
    expect(html).toContain("Looks right");
    expect(html).toContain("Refund policy");
    expect(html).toContain("Related note");
    expect(html).toContain("Claimed");
    expect(html).toContain("data-provider=\"fake\"");
    expect(html).toContain("fix-refunds");
    expect(html).toContain("1/2 criteria");
    expect(html).toContain("0/1 specialists");
    expect(html).toContain("git push origin fix-refunds");
    expect(html).toContain("committed 3f2a1c9");
    expect(html).toContain("PAY-1 moved to In Progress");
    expect(html).toContain("Use the existing refund API");
    expect(html).toContain("Specialists (1)");
    expect(html).toContain("Implement and check refunds");
    expect(html).toContain("Link item");
    expect(html).not.toContain("git commit");
    expect(html).not.toContain("Jira");
    expect(html).not.toContain("GitLab");
    for (const kind of ["work_item", "change_request", "commit", "build", "comment", "document", "link"]) {
      expect(html).toContain(`data-link-kind="${kind}"`);
    }
  });

  it("offers an inline answer when the task needs input", () => {
    const html = render({ ...item, status: "needs-input", detail: "Which merchant account should we use?" });
    expect(html).toContain('data-task-answer="work"');
    expect(html).toContain("Which merchant account should we use?");
    expect(html).toContain("Send answer");
  });

  it("keeps the reopen action and hides previous-revision specialist work", () => {
    const html = render({
      ...item, status: "completed", revision: 2, evidence: ["Verified output"],
      assignments: [{ ...item.assignments[0]!, revision: 1 }],
    });
    expect(html).toContain("Reopen shared task");
    expect(html).not.toContain("Stop shared task");
    expect(html).not.toContain("Implement and check refunds");
    expect(html).toContain("Verified output");
  });
});
