import { describe, expect, it } from "vitest";
import { LINK_KINDS, type LinkedItem, type TaskEvent } from "../../../shared/work-links";
import type { WorkItem } from "../../../shared/work-item";
import { displayLinks, mergeTaskEvent, nowFrom, outputGroups, progressSegments, visibleEvents } from "./model";

const item = (patch: Partial<WorkItem> = {}): WorkItem => ({
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Boundary cases pass"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "Working", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: 1, updatedAt: 2, ...patch,
});

const link = (kind: LinkedItem["kind"], role: LinkedItem["role"] = "output"): LinkedItem => ({
  id: `${kind}-1`, kind, role, title: kind, provenance: "observed", updatedAt: 1,
});

const event = (kind: TaskEvent["kind"], id: string = kind): TaskEvent => ({
  id, workItemId: "work", revision: 1, at: 1, actor: { type: "system" }, kind, summary: kind, provenance: "observed",
});

describe("task view model", () => {
  it("builds progress from criteria and current-revision assignments, not named stages", () => {
    const segments = progressSegments(item({
      criteria: [{ id: "c1", text: "Tests pass", state: "checked", evidence: [] }, { id: "c2", text: "Reviewed", state: "pending", evidence: [] }],
      assignments: [
        { id: "now", botId: "eng", threadId: "t-now", revision: 1, attempts: 1, message: "Implement", status: "running", result: "" },
        { id: "old", botId: "eng", threadId: "t-old", revision: 0, attempts: 1, message: "Earlier", status: "completed", result: "" },
      ],
    }));
    expect(segments.map(segment => [segment.source, segment.tone, segment.label])).toEqual([
      ["criterion", "done", "Tests pass"],
      ["criterion", "pending", "Reviewed"],
      ["assignment", "active", "Implement"],
    ]);
    expect(segments.some(segment => /merge|design stage/i.test(segment.label))).toBe(false);
  });

  it("falls back to artifacts as claimed links and groups outputs by kind", () => {
    const links = displayLinks(item({ artifacts: [{ label: "Patch", ref: "/refund.ts", revision: "abc123" }] }));
    expect(links).toEqual([expect.objectContaining({ kind: "link", title: "Patch", url: "/refund.ts", provenance: "claimed", details: { revision: "abc123" } })]);
    const groups = outputGroups(LINK_KINDS.map(kind => link(kind, kind === "document" ? "reference" : "output")));
    expect(groups.map(group => group.kind)).toEqual(LINK_KINDS.filter(kind => kind !== "document"));
  });

  it("reads Now from currentStep, then a running tool event", () => {
    const running = item({
      assignments: [{ id: "a", botId: "eng", threadId: "t", revision: 1, attempts: 1, message: "Implement", status: "running", result: "",
        currentStep: { summary: "git commit", since: 9 } }],
    });
    expect(nowFrom(running)?.summary).toBe("git commit");
    expect(nowFrom(item({
      assignments: [{ id: "a", botId: "eng", threadId: "t", revision: 1, attempts: 1, message: "Implement", status: "running", result: "" }],
    }), [{ ...event("tool", "tool-1"), state: "running", actor: { type: "bot", botId: "eng", threadId: "t" }, summary: "running tests" }])?.summary).toBe("running tests");
  });

  it("hides tool events until asked and merges later tool completions by id", () => {
    const events = [event("output"), { ...event("tool", "tool-1"), state: "running" as const, summary: "git commit" }];
    expect(visibleEvents(events, "all", false).map(entry => entry.kind)).toEqual(["output"]);
    expect(visibleEvents(events, "all", true).map(entry => entry.id)).toEqual(["tool-1", "output"]);
    expect(mergeTaskEvent(events, { ...events[1]!, state: "complete", summary: "committed 3f2a1c9" }).find(entry => entry.id === "tool-1"))
      .toMatchObject({ state: "complete", summary: "committed 3f2a1c9" });
  });
});
