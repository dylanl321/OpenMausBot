import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/store";
import type { Watch } from "@/lib/watches";

const fixture = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  dispatch: vi.fn(),
  admin: true as boolean | null,
}));
vi.mock("@/lib/use-owner-or-admin", () => ({
  useOwnerOrAdmin: () => fixture.admin,
}));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: vi.fn(async () => ({ connectors: [], connections: [] })),
    useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }),
  };
});

const { initialState } = await import("@/state/store");
const { WatchesPanel } = await import("./WatchesPanel");

const watch: Watch = {
  id: "w1",
  name: "Ready stories",
  source: { type: "connection", connectionId: "jira-acme" },
  events: ["item.created"],
  check: { type: "interval", everyMinutes: 5, anchorAt: 1 },
  action: { type: "record" },
  startFrom: "now",
  enabled: true,
  nextCheckAt: 2,
  createdAt: 1,
  updatedAt: 1,
  stats: { checks: 12, changesSeen: 40, matches: 3, actions: 2, runsAvoided: 9, lastCheckAt: Date.now() - 120_000 },
};

function markupOf(state?: Partial<AppState>) {
  fixture.state = { ...initialState, watchesLoadState: "ready", ...state };
  function Capture() {
    return createElement(WatchesPanel, {
      createRequest: 0,
      onCreateHandled: vi.fn(),
      onConvertHandled: vi.fn(),
    });
  }
  return renderToStaticMarkup(createElement(Capture));
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  return Children.toArray(node).map((child) => isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : textOf(child)).join("");
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.admin = true;
  fixture.state = { ...initialState, watchesLoadState: "ready" };
});

describe("watches panel", () => {
  it("lists last check, changes seen, matches, actions, and runs avoided", () => {
    const html = markupOf({ watches: [watch] });
    expect(html).toContain("Ready stories");
    expect(html).toContain("Last check");
    expect(html).toContain("Changes seen");
    expect(html).toContain("Matches");
    expect(html).toContain("Actions");
    expect(html).toContain("Runs avoided");
    expect(html).toContain("40");
    expect(html).toContain("3");
    expect(html).toContain("2");
    expect(html).toContain("9");
    expect(html).toContain("Record");
  });

  it("keeps the empty state about token-free checks", () => {
    const html = markupOf({ watches: [] });
    expect(html).toContain("No watches yet");
    expect(html).toContain("without spending tokens");
    expect(html).not.toContain("Jira");
    expect(html).not.toContain("GitLab");
    expect(textOf(createElement("div", null, html))).toBeTruthy();
  });

  it("hides watch edits when the session is not an admin", () => {
    fixture.admin = false;
    const html = markupOf({ watches: [watch] });
    expect(html).toContain("Ready stories");
    expect(html).toContain("Workspace admins can create and change watches.");
    expect(html).not.toContain("New watch");
    expect(html).not.toContain("Pause watch");
    expect(html).not.toContain("Delete watch");
  });
});
