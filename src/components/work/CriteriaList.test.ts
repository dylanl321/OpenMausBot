import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkItem } from "../../../shared/work-item";
import { CriteriaList } from "./CriteriaList";

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Boundary cases pass"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: 1, updatedAt: 2,
  criteria: [
    { id: "c1", text: "Tests pass", state: "checked", evidence: ["commit-1", "evt-1"] },
    { id: "c2", text: "Reviewed", state: "blocked", evidence: [] },
  ],
};

describe("CriteriaList", () => {
  it("shows criterion state and evidence as kind-driven links or event summaries", () => {
    const html = renderToStaticMarkup(createElement(CriteriaList, {
      item,
      links: [{ id: "commit-1", kind: "commit", role: "output", title: "commit 3f2a1c9", provenance: "observed", updatedAt: 1 }],
      events: [{ id: "evt-1", workItemId: "work", revision: 1, at: 1, actor: { type: "system" }, kind: "output", summary: "opened !482", provenance: "observed" }],
    }));
    expect(html).toContain("Tests pass");
    expect(html).toContain("Checked");
    expect(html).toContain("commit 3f2a1c9");
    expect(html).toContain("opened !482");
    expect(html).toContain("data-criterion-state=\"blocked\"");
    expect(html).toContain("Reviewed");
  });
});
