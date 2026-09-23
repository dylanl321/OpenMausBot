import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";
import type { WorkItem } from "../../shared/work-item";
import { selectedSharedWork, sharedWorkIds, sharedWorkMatches, sharedWorkThreads } from "@/lib/shared-work-sidebar";

const fixture = vi.hoisted(() => ({ state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/state/store", async importOriginal => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));

import { SharedWorkThreadTree } from "./SharedWorkThreadTree";
import { BotThreadList, GroupListItem } from "./Sidebar";
import { SidebarBotActivity } from "./SidebarBotActivity";

const item: WorkItem = { id: "onboarding", groupId: "product", threadId: "hub-onboarding", title: "Customer onboarding findings", objective: "Produce actionable customer findings",
  coordinatorBotId: "chief", acceptanceCriteria: ["Findings supported by evidence"], revision: 2, status: "active", detail: "Working", decisions: [], artifacts: [], evidence: [],
  assignments: [{ id: "analysis", botId: "analyst", threadId: "analysis-thread", revision: 2, attempts: 1, message: "Analyze onboarding interviews", status: "running", result: "" }],
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
  it("renders a distinct topic folder containing a task, shared chat and linked specialist chats", () => {
    const html = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    for (const text of ['data-work-topic="product"', "Work topic", 'data-work-item-tree="onboarding"', "Customer onboarding findings", "Shared chat", "Research Analyst", "Previous specialist", "3 chats"])
      expect(html).toContain(text);
    expect(html).not.toContain("Other outcome");
    expect(html).toContain('data-sidebar-thread-row="hub-onboarding"');
    expect(html).toContain('data-sidebar-thread-row="analysis-thread"');
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
    const html = renderToStaticMarkup(createElement(SharedWorkThreadTree, { item }));
    expect(html).toContain("Previous work");
    expect(html).toContain("Waiting");
    expect(sharedWorkThreads(item, [blockedAnalyst, historical]).map(worker => worker.task.threadId)).toEqual(["analysis-thread", "prior-work"]);
  });

  it("matches topics by specialist and assignment context without matching unrelated bot work", () => {
    expect(sharedWorkMatches(item, [analyst], "Research Analyst")).toBe(true);
    expect(sharedWorkMatches(item, [analyst], "interviews")).toBe(true);
    expect(sharedWorkMatches(item, [analyst], "Other outcome")).toBe(false);
    expect(sharedWorkIds([group])).toEqual(new Set([item.id]));
    expect(selectedSharedWork({ activeView: "chat", selectedId: analyst.id, bots: [{ ...analyst, threadId: "analysis-thread" }], groups: [group] })?.id).toBe(item.id);
  });
});
