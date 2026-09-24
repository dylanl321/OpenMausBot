import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import type { TaskEvent } from "../../../shared/work-links";
import { EventRow } from "./EventRow";

const KINDS: TaskEvent["kind"][] = ["tool", "output", "state_change", "comment", "handoff", "decision", "criterion", "lifecycle"];

const event = (kind: TaskEvent["kind"]): TaskEvent => ({
  id: kind, workItemId: "work", revision: 1, at: 1, actor: { type: "bot", botId: "eng", threadId: "t" },
  kind, summary: `${kind} happened`, provenance: kind === "decision" ? "claimed" : "observed",
});

const render = (kind: TaskEvent["kind"]) => renderToStaticMarkup(createElement(StoreProvider, null, createElement(EventRow, {
  event: event(kind),
  links: [{ id: "commit-1", kind: "commit", role: "output", title: "commit 3f2a1c9", provenance: "observed", updatedAt: 1 }],
})));

describe("EventRow", () => {
  it("renders each event kind from the event, never a provider name", () => {
    for (const kind of KINDS) {
      const html = render(kind);
      expect(html).toContain(`data-event-kind="${kind}"`);
      expect(html).toContain(`${kind} happened`);
      expect(html).toContain("eng");
      expect(html).not.toContain("Jira");
    }
    expect(render("decision")).toContain("Claimed");
    expect(render("output")).not.toContain("Claimed");
  });
});
