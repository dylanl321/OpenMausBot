import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jiraConnector } from "../../../server/connectors/jira/index";
import { planeConnector } from "../../../server/connectors/plane/index";
import type { AppState } from "@/state/store";
import { resetTaskConnectorsCache, type TaskConnectionListing, type TaskConnectorManifest } from "../work/model";

const fixture = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  dispatch: vi.fn(),
  api: vi.fn(),
}));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    api: fixture.api,
    useStore: () => ({ state: fixture.state ?? original.initialState, dispatch: fixture.dispatch }),
  };
});

const { initialState } = await import("@/state/store");
const { TaskConnectionsPanel } = await import("./TaskConnectionsPanel");

const connections: TaskConnectionListing[] = [
  {
    id: "jira-acme",
    connectorId: "jira",
    label: "Acme Jira",
    settings: { site: "https://acme.atlassian.net" },
    sections: ["Payments"],
    enabled: true,
    secretKeys: ["email", "apiToken"],
  },
  {
    id: "plane-ops",
    connectorId: "plane",
    label: "Ops Plane",
    settings: { workspace: "ops" },
    sections: [],
    enabled: false,
    secretKeys: ["apiKey"],
  },
];

function markup(props: {
  connectors?: TaskConnectorManifest[];
  connections?: TaskConnectionListing[];
} = {}) {
  return renderToStaticMarkup(createElement(TaskConnectionsPanel, props));
}

beforeEach(() => {
  fixture.dispatch.mockClear();
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string) => {
    if (path === "/api/task-connectors") {
      return { connectors: [jiraConnector.manifest, planeConnector.manifest] };
    }
    if (path === "/api/task-connections") return { connections };
    return {};
  });
  fixture.state = {
    ...initialState,
    sections: ["Payments", "Platform"],
  };
  resetTaskConnectorsCache();
});

describe("task connections panel", () => {
  it("lists saved connections without secret values and offers add, test, and disable", () => {
    const html = markup({
      connectors: [jiraConnector.manifest, planeConnector.manifest],
      connections,
    });
    expect(html).toContain("Task connections");
    expect(html).toContain("Acme Jira");
    expect(html).toContain("Ops Plane");
    expect(html).toContain("Payments");
    expect(html).toContain("All teams");
    expect(html).toContain("Add connection");
    expect(html).toContain("Test");
    expect(html).toContain("Disable connection");
    expect(html).toContain("Enable connection");
    expect(html).toContain('data-connection-row="jira-acme"');
    expect(html).toContain('data-connection-row="plane-ops"');
    expect(html).not.toContain("super-secret");
    expect(html).not.toContain("api-token-value");
  });

  it("keeps the empty state about adding a tracker", () => {
    fixture.api.mockImplementation(async (path: string) => {
      if (path === "/api/task-connectors") return { connectors: [jiraConnector.manifest] };
      if (path === "/api/task-connections") return { connections: [] };
      return {};
    });
    const html = markup({ connectors: [jiraConnector.manifest], connections: [] });
    expect(html).toContain("No task connections yet");
    expect(html).toContain("Add a connection");
  });
});
