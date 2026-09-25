import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import type { WorkItem } from "../../shared/work-item";
import { WorkItemPanel } from "./WorkItemPanel";

const item: WorkItem = { id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refund failures",
  acceptanceCriteria: ["Boundary cases pass"], coordinatorBotId: "chief", revision: 1, status: "active", detail: "Waiting for review",
  decisions: ["Use the existing refund API"], artifacts: [{ label: "Patch", ref: "/project/refund.ts", revision: "abc123" }], evidence: [],
  assignments: [{ id: "review", botId: "reviewer", threadId: "review-thread", revision: 1, attempts: 1, message: "Review refunds", status: "running", result: "" }], createdAt: 1, updatedAt: 2 };
const render = (candidate: WorkItem) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(WorkItemPanel, { item: candidate })));

describe("shared task panel", () => {
  it("shows ownership, acceptance, addressed workers and versioned artifacts", () => {
    const html = render(item);
    expect(html).toContain('aria-label="Shared task summary"');
    for (const text of ["Owner: chief", "Boundary cases pass", "1 working", "reviewer", "abc123", "Use the existing refund API", "Stop shared task"]) expect(html).toContain(text);
    expect(html).toContain("Open reviewer&#x27;s work");
  });
  it("shows an explicit reopen action for a terminal task and keeps old revisions out of current work", () => {
    const html = render({ ...item, status: "completed", revision: 2, evidence: ["Verified output"] });
    expect(html).toContain("Reopen shared task");
    expect(html).not.toContain("Stop shared task");
    expect(html).not.toContain("Review refunds");
    expect(html).toContain("Verified output");
  });
});
