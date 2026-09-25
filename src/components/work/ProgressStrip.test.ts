import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkItem } from "../../../shared/work-item";
import { ProgressStrip } from "./ProgressStrip";

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Tests pass", "Reviewed"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "", decisions: [], artifacts: [], evidence: [],
  criteria: [
    { id: "c1", text: "Tests pass", state: "checked", evidence: [] },
    { id: "c2", text: "Reviewed", state: "pending", evidence: [] },
  ],
  assignments: [{ id: "a1", botId: "eng", threadId: "t", revision: 1, attempts: 1, message: "Implement the fix", status: "running", result: "" }],
  createdAt: 1, updatedAt: 2,
};

describe("ProgressStrip", () => {
  it("labels progress from criteria and assignments", () => {
    const html = renderToStaticMarkup(createElement(ProgressStrip, { item }));
    expect(html).toContain("1/2 criteria");
    expect(html).toContain("0/1 specialists");
    expect(html).toContain("data-progress-source=\"criterion\"");
    expect(html).toContain("data-progress-source=\"assignment\"");
    expect(html).toContain("data-progress-tone=\"done\"");
    expect(html).toContain("data-progress-tone=\"active\"");
    expect(html).not.toContain("Design");
    expect(html).not.toContain("Merge");
  });
});
