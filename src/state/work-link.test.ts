import { describe, expect, it } from "vitest";
import type { LinkedItem } from "../../shared/work-links";
import type { WorkItem } from "../../shared/work-item";
import { initialState, reducer, type Group } from "./store";

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix",
  acceptanceCriteria: ["Done"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "", decisions: [], artifacts: [], evidence: [], assignments: [], createdAt: 1, updatedAt: 2,
};

const group: Group = {
  id: "topic", name: "Payments", threadId: "hub", memberIds: ["chief"], createdAt: 1, unread: false, messages: [],
  bulletin: "", defaultResponder: { kind: "member", botId: "chief" },
  tasks: [{ threadId: "hub", title: "Refunds", createdAt: 1, workItemId: item.id, workItem: item }],
};

const commit: LinkedItem = {
  id: "local:commit:3f2a1c9", kind: "commit", role: "output", title: "commit 3f2a1c9", provenance: "observed", updatedAt: 3,
};

describe("work.link fold", () => {
  it("upserts a captured link onto the matching hub task", () => {
    const next = reducer({ ...initialState, groups: [group] }, { type: "workLink", groupId: "topic", threadId: "hub", link: commit });
    expect(next.groups[0]!.tasks?.[0]?.workItem?.links).toEqual([commit]);
    const renamed = { ...commit, title: "commit 3f2a1c9 on fix-refunds" };
    const updated = reducer(next, { type: "workLink", groupId: "topic", threadId: "hub", link: renamed });
    expect(updated.groups[0]!.tasks?.[0]?.workItem?.links).toEqual([renamed]);
  });
});
