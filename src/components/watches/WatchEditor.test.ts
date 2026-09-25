import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { fakeConnector } from "../../../server/testing/fake-connector";
import { gitlabConnector } from "../../../server/connectors/gitlab/index";
import { jiraConnector } from "../../../server/connectors/jira/index";
import { planeConnector } from "../../../server/connectors/plane/index";
import type { Watch } from "@/lib/watches";
import type { TaskConnectionListing, TaskConnectorManifest } from "../work/model";
import { WatchEditor } from "./WatchEditor";
import { GIT_WATCH_MANIFEST, WEBHOOK_WATCH_MANIFEST } from "./model";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: fixture.dispatch }), api: vi.fn() };
});

const emptyStats = { checks: 0, changesSeen: 0, matches: 0, actions: 0, runsAvoided: 0 };

function connection(connector: TaskConnectorManifest, id = `${connector.id}-acme`): TaskConnectionListing {
  return {
    id,
    connectorId: connector.id,
    label: `${connector.name} Acme`,
    settings: {},
    sections: [],
    enabled: true,
    secretKeys: [],
  };
}

function watchFor(connector: TaskConnectorManifest, source: Watch["source"]): Watch {
  return {
    id: `w-${connector.id}`,
    name: `${connector.name} watch`,
    source,
    events: [...(connector.watch?.events ?? [])],
    check: { type: "interval", everyMinutes: 5, anchorAt: 1 },
    action: { type: "record" },
    startFrom: "now",
    enabled: true,
    nextCheckAt: 2,
    createdAt: 1,
    updatedAt: 1,
    stats: emptyStats,
  };
}

function renderEditor(props: Partial<Parameters<typeof WatchEditor>[0]> & { watch: Watch; connections: TaskConnectionListing[]; connectors: TaskConnectorManifest[] }) {
  return renderToStaticMarkup(createElement(WatchEditor, {
    bots: [],
    webhooks: [],
    routines: [],
    groups: [],
    onClose: vi.fn(),
    onSaved: vi.fn(),
    ...props,
  }));
}

const connectors = {
  fake: fakeConnector.manifest,
  jira: jiraConnector.manifest,
  gitlab: gitlabConnector.manifest,
  plane: planeConnector.manifest,
};

describe("watch editor", () => {
  it("uses the same generated form for Jira, GitLab, Plane, git, and a generic webhook", () => {
    const cases: Array<{
      connector: TaskConnectorManifest;
      watch: Watch;
      connections: TaskConnectionListing[];
      webhooks?: Parameters<typeof WatchEditor>[0]["webhooks"];
      scope: string;
      event: string;
      kind: string;
      provider: string;
    }> = [
      {
        connector: connectors.jira,
        watch: watchFor(connectors.jira, { type: "connection", connectionId: "jira-acme", scope: { query: "project = PAY" } }),
        connections: [connection(connectors.jira, "jira-acme")],
        scope: "JQL",
        event: "Item created",
        kind: "connection",
        provider: "jira",
      },
      {
        connector: connectors.gitlab,
        watch: watchFor(connectors.gitlab, { type: "connection", connectionId: "gitlab-acme", scope: { project: "group/app" } }),
        connections: [connection(connectors.gitlab, "gitlab-acme")],
        scope: "Project",
        event: "Change opened",
        kind: "connection",
        provider: "gitlab",
      },
      {
        connector: connectors.plane,
        watch: watchFor(connectors.plane, { type: "connection", connectionId: "plane-acme", scope: { query: "stateGroup = started" } }),
        connections: [connection(connectors.plane, "plane-acme")],
        scope: "PQL",
        event: "Comment added",
        kind: "connection",
        provider: "plane",
      },
      {
        connector: GIT_WATCH_MANIFEST,
        watch: watchFor(GIT_WATCH_MANIFEST, { type: "git", remote: "git@example.com:acme/app.git" }),
        connections: [],
        scope: "Remote",
        event: "Commit pushed",
        kind: "git",
        provider: "git",
      },
      {
        connector: WEBHOOK_WATCH_MANIFEST,
        watch: watchFor(WEBHOOK_WATCH_MANIFEST, { type: "webhook", webhookId: "wh-1" }),
        connections: [],
        webhooks: [{
          id: "wh-1",
          endpointId: "ep-1",
          name: "Inbox",
          botId: "scout",
          prompt: "",
          runOn: "maus",
          enabled: true,
          createdAt: 1,
          updatedAt: 1,
          deliveryCount: 0,
        }],
        scope: "Webhook",
        event: "Item updated",
        kind: "webhook",
        provider: "webhook",
      },
    ];

    for (const item of cases) {
      const html = renderEditor({
        watch: item.watch,
        connections: item.connections,
        connectors: [item.connector],
        webhooks: item.webhooks ?? [],
      });
      expect(html, item.connector.id).toContain('data-watch-editor=""');
      expect(html, item.connector.id).toContain(`data-watch-source-kind="${item.kind}"`);
      expect(html, item.connector.id).toContain(`data-watch-connector="${item.provider}"`);
      expect(html, item.connector.id).toContain(item.scope);
      expect(html, item.connector.id).toContain(item.event);
      expect(html, item.connector.id).toContain("Test against the last 7 days");
      expect(html, item.connector.id).toContain("From now");
      expect(html, item.connector.id).toContain("Backfill once");
      expect(html, item.connector.id).toContain("Filters, limits, and batching");
      expect(html, item.connector.id).not.toContain("Jira-specific");
      expect(html, item.connector.id).not.toContain("GitLab-specific");
    }
  });

  it("renders fake-connector scopes the same way as recorded connectors", () => {
    const html = renderEditor({
      watch: watchFor(connectors.fake, { type: "connection", connectionId: "fake-1", scope: { query: "PAY" } }),
      connections: [connection(connectors.fake, "fake-1")],
      connectors: [connectors.fake],
    });
    expect(html).toContain('data-watch-connector="fake"');
    expect(html).toContain("Query");
    expect(html).toContain("Build failed");
    expect(html).toContain("Record");
    expect(html).toContain("Ensure task");
  });

  it("does not preselect a webhook when starting a webhook watch", () => {
    const html = renderToStaticMarkup(createElement(WatchEditor, {
      draft: { name: "Inbox watch", source: { type: "webhook", webhookId: "" } },
      bots: [],
      connections: [],
      connectors: [],
      webhooks: [{
        id: "wh-1",
        endpointId: "ep-1",
        name: "Inbox",
        botId: "scout",
        prompt: "",
        runOn: "maus",
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
        deliveryCount: 0,
      }],
      routines: [],
      groups: [],
      onClose: vi.fn(),
      onSaved: vi.fn(),
    }));
    expect(html).toContain('data-watch-source-kind="webhook"');
    expect(html).toContain("Choose…");
    expect(html).not.toContain('value="wh-1" selected');
  });
});
