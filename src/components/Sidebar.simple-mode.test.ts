import { Children, createElement, isValidElement, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, Group } from "@/state/store";
import type { SidebarDensity } from "@/lib/sidebar-preferences";

const fixture = vi.hoisted(() => ({ showThreads: true, inactiveBefore: 0, state: {} as Partial<AppState>, dispatch: vi.fn() }));
vi.mock("@/lib/thread-preferences", () => ({ useShowThreads: () => fixture.showThreads }));
vi.mock("@/lib/thread-inactivity-preference", () => ({ useThreadInactivityCutoff: () => fixture.inactiveBefore }));
vi.mock("./DesktopCapabilities", () => ({ useDesktopCapabilities: () => ({}) }));
vi.mock("react-dom", () => ({ createPortal: (node: ReactNode) => node }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});

import { BotContextMenu, BotListItem, BotThreadList, GroupListItem, GroupThreadList, SidebarNavigator } from "./Sidebar";
import { SidebarBotActivity, sidebarBotActivityTasks } from "./SidebarBotActivity";

const bot: Bot = {
  id: "atlas", threadId: "last-selected", name: "Atlas", title: "", description: "",
  notifications: true, color: "green", unread: true,
  modelSelection: { instanceId: "fake", model: "test" }, messages: [],
  projects: [{ id: "private-folder", name: "Quiet folder" }],
  tasks: [
    { threadId: "last-selected", title: "Last selected conversation", createdAt: 1 },
    { threadId: "idle-history", title: "Idle history", createdAt: 2, projectId: "private-folder" },
    { threadId: "approval", title: "Review permission", createdAt: 3, busy: false, activity: "waiting-on-you", projectId: "private-folder" },
    { threadId: "working", title: "Running job", createdAt: 4, busy: true, activity: "working" },
    { threadId: "queued", title: "Next job", createdAt: 5 },
    { threadId: "unread", title: "Finished reply", createdAt: 6, unread: true },
  ],
};
const densities: SidebarDensity[] = ["comfortable", "compact", "icons"];
const rowProps = (density: SidebarDensity) => ({ bot, density, onMenu: vi.fn() });

type ElementProps = { children?: ReactNode; onClick?: (event: MouseEvent) => void; onKeyDown?: (event: KeyboardEvent) => void; [key: string]: unknown };
function findElement(tree: ReactNode, attribute: string, value: string): ReactElement<ElementProps> | undefined {
  for (const child of Children.toArray(tree)) {
    if (!isValidElement<ElementProps>(child)) continue;
    if (child.props[attribute] === value) return child;
    const found = findElement(child.props.children, attribute, value);
    if (found) return found;
  }
}

beforeEach(() => {
  fixture.showThreads = true;
  fixture.inactiveBefore = 0;
  fixture.state = { bots: [bot], selectedId: "other-bot", activeView: "chat", pendingQueued: { queued: [{ queueId: "q", text: "next" }] } };
  fixture.dispatch.mockClear();
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  vi.stubGlobal("document", { body: {} });
  vi.stubGlobal("HTMLInputElement", class {});
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("bot-first sidebar", () => {
  it.each([
    { enabled: true, density: "comfortable", size: 32, spacing: ["gap-2", "py-2", "pl-2"] },
    { enabled: true, density: "compact", size: 26, spacing: ["gap-1.5", "py-1", "pl-2"] },
    { enabled: true, density: "icons", size: 44, spacing: ["justify-start", "px-1", "py-1.5"] },
    { enabled: false, density: "comfortable", size: 56, spacing: ["gap-3", "py-2.5", "pl-2"] },
    { enabled: false, density: "compact", size: 40, spacing: ["gap-2", "py-1.5", "pl-2"] },
    { enabled: false, density: "icons", size: 44, spacing: ["justify-start", "px-1", "py-1.5"] },
  ] as const)("sizes bot portraits and row spacing in $density density with threads $enabled", ({ enabled, density, size, spacing }) => {
    fixture.showThreads = enabled;
    for (const avatar of [{}, { avatarUrl: "/api/attachments/portrait.png", avatarCrop: "circle" as const }]) {
      let tree: ReactNode;
      function Capture() { tree = BotListItem({ ...rowProps(density), bot: { ...bot, ...avatar } }); return tree; }
      const markup = renderToStaticMarkup(createElement(Capture));
      const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
      expect(String(row.props.className).split(" ")).toEqual(expect.arrayContaining([...spacing]));
      expect(markup).toContain(avatar.avatarUrl
        ? `width="${size}" height="${size}"`
        : `width="${size}px" height="${size}px"`);
    }
  });

  for (const enabled of [true, false]) {
    it.each(densities)(`opens the last selected conversation on mouse or keyboard, %s density, threads ${enabled ? "on" : "off"}`, (density) => {
      fixture.showThreads = enabled;
      let tree: ReactNode;
      function Capture() { tree = BotListItem(rowProps(density)); return tree; }
      renderToStaticMarkup(createElement(Capture));
      const row = findElement(tree, "data-sidebar-bot-row", bot.id)!;
      row.props.onClick!({ type: "click", target: {} } as MouseEvent);
      expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
      // Selection reuses bot.threadId; it must not create or switch a task.
      expect(bot.threadId).toBe("last-selected");
      for (const key of ["Enter", " "]) {
        fixture.dispatch.mockClear();
        const preventDefault = vi.fn();
        row.props.onKeyDown!({ key, preventDefault } as unknown as KeyboardEvent);
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "select", id: bot.id });
      }
    });
  }

  it.each(densities)("keeps selection separate from browsing in %s density", (density) => {
    fixture.state.selectedId = bot.id;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density)));
    expect(markup).not.toContain("data-sidebar-thread-row");
    expect(markup).toContain('aria-label="Browse Atlas threads and folders" aria-haspopup="dialog"');
  });

  it.each(densities)("hides thread browsing and keeps the row shallow in %s density", (density) => {
    fixture.showThreads = false;
    const markup = renderToStaticMarkup(createElement(BotListItem, rowProps(density)));
    expect(markup).not.toContain("data-sidebar-thread-row");
    expect(markup).not.toContain("data-sidebar-folder-row");
    expect(markup).not.toContain("Idle history");
    expect(markup).not.toContain("Quiet folder");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("New folder");
    expect(markup).not.toContain("Expand Atlas threads");
    expect(markup).toContain('data-testid="waiting-dot"');
    expect(markup).not.toContain('data-sidebar-activity-row=');
  });

  it("removes child controls and portals from a retained hidden folder list", () => {
    const markup = renderToStaticMarkup(createElement(BotThreadList, { bot, selected: true, hidden: true }));
    expect(markup).toContain('hidden=""');
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("data-sidebar-thread-row");
    const shown = renderToStaticMarkup(createElement(BotThreadList, { bot, selected: true }));
    expect(shown).toContain('data-sidebar-folder-row="private-folder"');
    expect(shown).toContain('data-sidebar-thread-row="idle-history"');
  });

  it("keeps bot folder and thread controls in the navigator rather than under the bot row", () => {
    const row = renderToStaticMarkup(createElement(BotListItem, rowProps("compact")));
    const navigator = renderToStaticMarkup(createElement(SidebarNavigator, {
      target: { kind: "bot", id: bot.id }, density: "compact", docked: true, onClose: vi.fn(), onNavigate: vi.fn(),
    }));
    expect(row).not.toContain("Quiet folder");
    expect(navigator).toContain('data-sidebar-folder-row="private-folder"');
    expect(navigator).toContain('aria-label="Actions for Quiet folder folder"');
    expect(navigator).toContain('data-sidebar-thread-row="idle-history"');
    expect(navigator).toContain("New thread");
  });

  it.each(densities)("hides idle bot history in the %s navigator but leaves folders, urgent threads, and Show all accessible", (density) => {
    fixture.inactiveBefore = 10;
    const navigator = renderToStaticMarkup(createElement(SidebarNavigator, {
      target: { kind: "bot", id: bot.id }, density, docked: true, onClose: vi.fn(), onNavigate: vi.fn(),
    }));
    expect(navigator).not.toContain('data-sidebar-thread-row="idle-history"');
    expect(navigator).not.toContain('data-sidebar-thread-row="last-selected"');
    for (const id of ["approval", "working", "queued", "unread"])
      expect(navigator).toContain(`data-sidebar-thread-row="${id}"`);
    expect(navigator).toContain('data-sidebar-folder-row="private-folder"');
    expect(navigator).toContain("Show all 6 threads");
    expect(renderToStaticMarkup(createElement(BotThreadList, { bot, selected: true })))
      .toContain('data-sidebar-thread-row="last-selected"');
  });

  it("keeps background teammate replies findable in a compact navigator with inactive hiding on", () => {
    fixture.inactiveBefore = 10;
    fixture.state.bots = [{ ...bot, tasks: [...bot.tasks!, { threadId: "delegated", title: "Pending teammate reply", createdAt: 1, waitingForTeammates: true }] }];
    const markup = renderToStaticMarkup(createElement(SidebarNavigator, {
      target: { kind: "bot", id: bot.id }, density: "compact", docked: true, onClose: vi.fn(), onNavigate: vi.fn(),
    }));
    expect(markup).toContain('data-sidebar-thread-row="delegated"');
    expect(markup).toContain("Pending teammate reply");
    expect(markup).toContain("Waiting for teammates");
  });

  it("keeps group chat history searchable and work-topic task lists unchanged", () => {
    fixture.inactiveBefore = 10;
    const group: Group = {
      id: "group", name: "Planning", threadId: "current", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [],
      tasks: [{ threadId: "current", title: "Current", createdAt: 1 }, { threadId: "old", title: "Old chat", createdAt: 2 }],
    };
    fixture.state.groups = [group];
    const navigator = renderToStaticMarkup(createElement(SidebarNavigator, {
      target: { kind: "group", id: group.id }, density: "comfortable", docked: false, onClose: vi.fn(), onNavigate: vi.fn(),
    }));
    expect(navigator).not.toContain('data-sidebar-thread-row="old"');
    expect(navigator).toContain("Show all 2 threads");
    expect(renderToStaticMarkup(createElement(GroupThreadList, { group, selected: false, query: "old" })))
      .toContain('data-sidebar-thread-row="old"');
    expect(renderToStaticMarkup(createElement(GroupThreadList, { group, selected: true })))
      .toContain('data-sidebar-thread-row="current"');
  });

  it("only hides thread/folder creation in the bot context menu", () => {
    const render = () => renderToStaticMarkup(createElement(BotContextMenu, {
      menu: { botId: bot.id, x: 0, y: 0 }, onClose: vi.fn(), onArchive: vi.fn(), onDelete: vi.fn(), onMoveToSection: vi.fn(), onNewFolder: vi.fn(),
    }));
    const enabled = render();
    expect(enabled).toContain("New thread");
    expect(enabled).toContain("New folder");
    fixture.showThreads = false;
    const disabled = render();
    expect(disabled).not.toContain("New thread");
    expect(disabled).not.toContain("New folder");
    expect(disabled).toContain("Edit Profile");
    expect(disabled).toContain("Move to team");
  });

  it("does not change group collaboration histories or creation", () => {
    fixture.showThreads = false;
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0, messages: [],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }],
    };
    fixture.state.selectedId = group.id;
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).not.toContain('data-sidebar-thread-row="group-thread"');
    expect(markup).toContain('aria-label="Browse Planning threads"');
    expect(renderToStaticMarkup(createElement(GroupThreadList, { group, selected: true }))).toContain('data-sidebar-thread-row="group-thread"');
    fixture.state.groups = [group];
    const navigator = renderToStaticMarkup(createElement(SidebarNavigator, {
      target: { kind: "group", id: group.id }, density: "comfortable", docked: false, onClose: vi.fn(), onNavigate: vi.fn(),
    }));
    expect(navigator).toContain('data-sidebar-thread-row="group-thread"');
    expect(navigator).toContain("New thread");
    expect(navigator).not.toContain("Filter Planning tasks");
  });
});

describe("group row", () => {
  it("shows the group type rather than a conversation preview", () => {
    const group: Group = {
      id: "group", name: "Planning", threadId: "group-thread", memberIds: [], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 0,
      messages: [
        { id: "b1", role: "bot", kind: "text", text: "Plan drafted.", at: 2, from: { botId: "atlas", name: "Atlas", color: "green" } },
        { id: "d1", role: "bot", kind: "digest", text: "[digest] · tools: Write ×1", at: 3, digest: { turnId: "t1", tools: [{ name: "Write", count: 1 }], hookCoverage: "full" } },
      ] as Group["messages"],
      tasks: [{ threadId: "group-thread", title: "Group conversation", createdAt: 1 }],
    };
    const markup = renderToStaticMarkup(createElement(GroupListItem, { group, density: "comfortable", onMenu: vi.fn() }));
    expect(markup).toContain("Group chat");
    expect(markup).not.toContain("Plan drafted.");
    expect(markup).not.toContain("[digest]");
  });
});

describe("activity-only escape hatch", () => {
  it("includes waiting approvals even with busy false and never treats aggregate activity as every sibling's status", () => {
    const tasks = sidebarBotActivityTasks({ ...bot, busy: true, activity: "waiting-on-you" }, fixture.state.pendingQueued!);
    expect(tasks.map((task) => task.threadId)).toEqual(["approval", "working", "queued", "unread"]);
  });

  it("switches directly to the requested work and offers no thread-management actions", () => {
    let tree: ReactNode;
    function Capture() { tree = SidebarBotActivity({ bot, density: "comfortable" }); return tree; }
    const markup = renderToStaticMarkup(createElement(Capture));
    findElement(tree, "data-sidebar-activity-row", "approval")!.props.onClick!({} as MouseEvent);
    expect(fixture.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "switchTask", botId: bot.id, threadId: "approval" });
    expect(markup).not.toContain("Actions for");
    expect(markup).not.toContain("New thread");
    expect(markup).not.toContain("Delete");
  });

  it("removes selected and settled activity but keeps unread completed replies", () => {
    const selected = { ...bot, threadId: "approval", tasks: bot.tasks!.map((task) => task.threadId === "working" ? { ...task, busy: false, activity: "idle" as const } : task) };
    const markup = renderToStaticMarkup(createElement(SidebarBotActivity, { bot: selected, density: "compact" }));
    expect(markup).not.toContain('data-sidebar-activity-row="approval"');
    expect(markup).not.toContain('data-sidebar-activity-row="working"');
    expect(markup).toContain('data-sidebar-activity-row="unread"');
  });
});
