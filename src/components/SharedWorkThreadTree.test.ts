import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";
import type { WorkItem } from "../../shared/work-item";
import type { LinkedItem } from "../../shared/work-links";
import { compactTaskRowModel, matchesSidebarWorkFilter, selectedSharedWork, sharedWorkIds, sharedWorkMatches, sharedWorkThreads, workItemKey } from "@/lib/shared-work-sidebar";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/state/store", async importOriginal => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { SharedWorkThreadTree } from "./SharedWorkThreadTree";
import { BotThreadList, GroupListItem, GroupThreadList } from "./Sidebar";
import { SidebarBotActivity } from "./SidebarBotActivity";

const link = (partial: Partial<LinkedItem> & Pick<LinkedItem, "id" | "kind" | "title">): LinkedItem => ({
  role: "output", provenance: "observed", updatedAt: 2, ...partial,
});

const item: WorkItem = { id: "onboarding", groupId: "product", threadId: "hub-onboarding", title: "Customer onboarding findings", objective: "Produce actionable customer findings",
  coordinatorBotId: "chief", acceptanceCriteria: ["Findings supported by evidence"], revision: 2, status: "active", detail: "Working", decisions: [], artifacts: [], evidence: [],
  criteria: [{ id: "c1", text: "Findings supported by evidence", state: "in_progress", evidence: [] }],
  links: [
    link({ id: "src", kind: "work_item", role: "source", title: "Onboarding", externalId: "PAY-9" }),
    link({ id: "mr", kind: "change_request", title: "Onboarding review", externalId: "acme/payments!482", state: { label: "opened", category: "in_review" } }),
  ],
  assignments: [{ id: "analysis", botId: "analyst", threadId: "analysis-thread", revision: 2, attempts: 1, message: "Analyze onboarding interviews", status: "running", result: "",
    currentStep: { summary: "reading interview notes", since: 3 } }],
  createdAt: 1, updatedAt: 2 };
const bot = (id: string, name: string): Bot => ({ id, name, threadId: `${id}-chat`, title: "", description: "", color: "blue", notifications: true, unread: false,
  modelSelection: { instanceId: "fake", model: "fake" }, messages: [], tasks: [{ threadId: `${id}-chat`, title: "Ordinary chat", createdAt: 1 }] });
const chief = bot("chief", "Manager");
const analyst: Bot = { ...bot("analyst", "Research Analyst"), tasks: [
  { threadId: "analyst-chat", title: "Ordinary chat", createdAt: 1 },
  { threadId: "analysis-thread", title: "Customer onboarding findings", createdAt: 2, workItemId: item.id, busy: true },
  { threadId: "other-work", title: "Other outcome", createdAt: 3, workItemId: "other" },
] };
const historical: Bot = { ...bot("historical", "Previous specialist"), tasks: [{ threadId: "prior-work", title: "Earlier investigation", createdAt: 1, workItemId: item.id }] };
const group: Group = { id: "product", name: "Product discovery", threadId: item.threadId, memberIds: [chief.id], createdAt: 1, unread: false, messages: [], bulletin: "", defaultResponder: { kind: "member", botId: chief.id },
  tasks: [{ threadId: item.threadId, title: item.title, createdAt: 1, workItemId: item.id, workItem: item }] };

beforeEach(() => { fixture.state = { activeView: "chat", selectedId: chief.id, bots: [chief, analyst, historical], groups: [group], pendingQueued: {} }; });

describe("outcome-centered sidebar", () => {
  it("renders a compact task row in a distinct topic folder without expanding an active task", () => {
    const html = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    for (const text of ['data-work-topic="product"', "Work topic", 'data-work-item-tree="onboarding"', 'data-sidebar-task-row="onboarding"', "Customer onboarding findings", "PAY-9", "acme/payments!482", "0/1 criteria"])
      expect(html).toContain(text);
    expect(html).not.toContain("!acme/payments!482");
    expect(html).toContain("All");
    expect(html).toContain("Needs you");
    expect(html).toContain("In review");
    expect(html).toContain("Done");
    expect(html).not.toContain("Shared chat");
    expect(html).not.toContain("3 chats");
    expect(html).not.toContain('data-sidebar-thread-row="hub-onboarding"');
    expect(html).not.toContain('data-sidebar-thread-row="analysis-thread"');
    expect(html).not.toContain("Other outcome");
    expect(html).not.toContain("reading interview notes");
  });

  it("keeps selection and its topic expanded when a specialist rather than the hub is selected", () => {
    fixture.state.selectedId = analyst.id;
    fixture.state.bots = [chief, { ...analyst, threadId: "analysis-thread" }];
    const completed = { ...item, status: "completed" as const };
    fixture.state.groups = [{ ...group, tasks: [{ ...group.tasks![0], workItem: completed }] }];
    const html = renderToStaticMarkup(createElement(GroupListItem, { group: fixture.state.groups[0], density: "compact", onMenu: vi.fn() }));
    expect(html).toContain('data-sidebar-thread-row="analysis-thread" aria-current="page"');
    expect(html).not.toContain('data-sidebar-thread-row="hub-onboarding" aria-current="page"');
    expect(html).toContain('aria-label="Collapse Customer onboarding findings task"');
    expect(html).toContain("Shared chat");
    expect(html).toContain("Research Analyst");
  });

  it("shows the selected task's live step on the compact row", () => {
    fixture.state.selectedId = "product";
    const html = renderToStaticMarkup(createElement(SharedWorkThreadTree, { item }));
    expect(html).toContain('data-task-live-step');
    expect(html).toContain("reading interview notes");
  });

  it("removes housed worker threads from bot trees and activity rows, but retains orphaned work", () => {
    const html = renderToStaticMarkup(createElement(BotThreadList, { bot: analyst, selected: false }));
    expect(html).not.toContain('data-sidebar-thread-row="analysis-thread"');
    expect(html).toContain('data-sidebar-thread-row="other-work"');
    expect(html).toContain("Ordinary chat");
    expect(renderToStaticMarkup(createElement(SidebarBotActivity, { bot: analyst, density: "comfortable" }))).toBe("");
  });

  it("keeps previous-revision conversations discoverable and surfaces pending approvals", () => {
    const blockedAnalyst = { ...analyst, tasks: analyst.tasks!.map(task => task.threadId === "analysis-thread" ? { ...task, busy: false, activity: "waiting-on-you" as const } : task) };
    fixture.state.bots = [chief, blockedAnalyst, historical];
    fixture.state.selectedId = "product";
    const html = renderToStaticMarkup(createElement(SharedWorkThreadTree, { item }));
    expect(html).toContain("Previous work");
    expect(html).toContain("Waiting");
    expect(sharedWorkThreads(item, [blockedAnalyst, historical]).map(worker => worker.task.threadId)).toEqual(["analysis-thread", "prior-work"]);
  });

  it("matches topics by specialist, key and assignment context without matching unrelated bot work", () => {
    expect(sharedWorkMatches(item, [analyst], "Research Analyst")).toBe(true);
    expect(sharedWorkMatches(item, [analyst], "interviews")).toBe(true);
    expect(sharedWorkMatches(item, [analyst], "PAY-9")).toBe(true);
    expect(sharedWorkMatches(item, [analyst], "Other outcome")).toBe(false);
    expect(sharedWorkIds([group])).toEqual(new Set([item.id]));
    expect(selectedSharedWork({ activeView: "chat", selectedId: analyst.id, bots: [{ ...analyst, threadId: "analysis-thread" }], groups: [group] })?.id).toBe(item.id);
    expect(workItemKey(item)).toBe("PAY-9");
    expect(matchesSidebarWorkFilter(item, [analyst], "in_review")).toBe(true);
    expect(matchesSidebarWorkFilter({ ...item, status: "needs-input" }, [analyst], "needs_you")).toBe(true);
    expect(matchesSidebarWorkFilter({ ...item, status: "completed" }, [analyst], "done")).toBe(true);
    expect(compactTaskRowModel(item, [chief, analyst], false)).toMatchObject({
      key: "PAY-9", expanded: false, liveStep: undefined, changeRequest: { label: "acme/payments!482" }, criteria: { total: 1 },
    });
    expect(compactTaskRowModel(item, [chief, analyst], true).liveStep).toBe("reading interview notes");
  });

  it("filters topic tasks and keeps ten-plus rows across three topics scannable", () => {
    const topics = ["payments", "onboarding", "pricing"] as const;
    const statuses = ["active", "needs-input", "completed", "active"] as const;
    const groups = topics.map((topic, topicIndex) => {
      const tasks = statuses.map((status, index) => {
        const id = `${topic}-${index}`;
        const work: WorkItem = {
          ...item, id, groupId: topic, threadId: `hub-${id}`, title: `${topic} task ${index + 1}`, status,
          links: status === "active" && index === 0
            ? [link({ id: `${id}-cr`, kind: "change_request", title: "Review", externalId: `${topicIndex}${index}`, state: { label: "opened", category: "in_review" } })]
            : [link({ id: `${id}-src`, kind: "work_item", role: "source", title: topic, externalId: `${topic.slice(0, 3).toUpperCase()}-${topicIndex}${index}` })],
          assignments: [], criteria: item.criteria,
        };
        return { threadId: work.threadId, title: work.title, createdAt: index, workItemId: work.id, workItem: work };
      });
      return { ...group, id: topic, name: `${topic} topic`, threadId: tasks[0]!.threadId, tasks };
    });
    fixture.state.groups = groups;
    fixture.state.selectedId = chief.id;
    const html = groups.map(candidate => renderToStaticMarkup(createElement(GroupListItem, { group: candidate, density: "comfortable", onMenu: vi.fn() }))).join("\n");
    expect(html.match(/data-work-item-tree="/g)?.length).toBe(12);
    expect(html.match(/data-work-topic="/g)?.length).toBe(3);
    expect(html).not.toContain("data-sidebar-thread-row=");
    expect(html).not.toContain("Shared chat");
    expect(html).toContain("PAY-01");
    expect(html).toContain("payments task 1");
    expect(html).toContain("pricing task 4");
    expect(html).toContain("!00");
    const review = renderToStaticMarkup(createElement(GroupThreadList, { group: groups[0]!, selected: false, filter: "in_review" }));
    expect(review).toContain("payments task 1");
    expect(review).not.toContain("payments task 2");
    const needs = renderToStaticMarkup(createElement(GroupThreadList, { group: groups[0]!, selected: false, filter: "needs_you" }));
    expect(needs).toContain("payments task 2");
    expect(needs).not.toContain("payments task 1");
    const done = renderToStaticMarkup(createElement(GroupThreadList, { group: groups[0]!, selected: false, filter: "done" }));
    expect(done).toContain("payments task 3");
    expect(done).not.toContain("payments task 1");
  });
});
