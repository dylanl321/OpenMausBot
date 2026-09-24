import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { gitlabConnector } from "../../../server/connectors/gitlab/index";
import { jiraConnector } from "../../../server/connectors/jira/index";
import { planeConnector } from "../../../server/connectors/plane/index";
import type { TaskConnectionListing, TaskConnectorManifest } from "../work/model";
import { ConnectionEditor } from "./ConnectionEditor";

function listing(connector: TaskConnectorManifest, id = `${connector.id}-acme`): TaskConnectionListing {
  return {
    id,
    connectorId: connector.id,
    label: `${connector.name} Acme`,
    settings: {},
    sections: ["Payments"],
    enabled: true,
    secretKeys: connector.secrets?.map((secret) => secret.key) ?? [],
  };
}

function renderEditor(props: Partial<Parameters<typeof ConnectionEditor>[0]> & {
  connectors: TaskConnectorManifest[];
}) {
  return renderToStaticMarkup(createElement(ConnectionEditor, {
    teams: ["Payments", "Platform"],
    existingIds: [],
    onClose: vi.fn(),
    onSave: vi.fn(),
    onTest: vi.fn(),
    ...props,
  }));
}

const connectors = {
  jira: jiraConnector.manifest,
  gitlab: gitlabConnector.manifest,
  plane: planeConnector.manifest,
};

describe("connection editor", () => {
  it("uses the same generated form for Jira, GitLab, and Plane", () => {
    const cases: Array<{
      connector: TaskConnectorManifest;
      setting: string;
      secret: string;
      secretKey: string;
    }> = [
      { connector: connectors.jira, setting: "Site URL", secret: "API token", secretKey: "apiToken" },
      { connector: connectors.gitlab, setting: "Instance URL", secret: "Access token", secretKey: "token" },
      { connector: connectors.plane, setting: "Workspace slug", secret: "API key", secretKey: "apiKey" },
    ];

    for (const item of cases) {
      const html = renderEditor({
        connection: listing(item.connector),
        connectors: [item.connector],
      });
      expect(html, item.connector.id).toContain('data-connection-editor=""');
      expect(html, item.connector.id).toContain(`data-connection-connector="${item.connector.id}"`);
      expect(html, item.connector.id).toContain(`data-connection-setting="`);
      expect(html, item.connector.id).toContain(item.setting);
      expect(html, item.connector.id).toContain(item.secret);
      expect(html, item.connector.id).toContain(`data-connection-secret="${item.secretKey}"`);
      expect(html, item.connector.id).toContain("Saved — leave blank to keep");
      expect(html, item.connector.id).toContain("Payments");
      expect(html, item.connector.id).toContain("Platform");
      expect(html, item.connector.id).toContain("Test");
      expect(html, item.connector.id).toContain("Enabled");
      expect(html, item.connector.id).toContain("Save connection");
      expect(html, item.connector.id).not.toContain("Jira-specific");
      expect(html, item.connector.id).not.toContain("GitLab-specific");
      expect(html, item.connector.id).not.toContain("super-secret");
      expect(html, item.connector.id).not.toContain("api-token-value");
      for (const key of item.connector.secrets ?? []) {
        expect(html, item.connector.id).toContain(`data-connection-secret="${key.key}"`);
        expect(html, item.connector.id).not.toContain(`${key.key}=`);
      }
    }
  });

  it("renders Jira edition choices and Plane workspace fields from the real manifests", () => {
    const jira = renderEditor({
      connection: listing(connectors.jira),
      connectors: [connectors.jira],
    });
    expect(jira).toContain("Edition");
    expect(jira).toContain("cloud");
    expect(jira).toContain("datacenter");
    expect(jira).toContain("Email");
    expect(jira).toContain("Personal access token");

    const plane = renderEditor({
      connection: listing(connectors.plane),
      connectors: [connectors.plane],
    });
    expect(plane).toContain("API URL");
    expect(plane).toContain("Workspace slug");
    expect(plane).toContain("Default project");
    expect(plane).toContain("API key");
  });

  it("does not put saved secret values into the form, only key names", () => {
    const html = renderEditor({
      connection: {
        ...listing(connectors.gitlab),
        secretKeys: ["token", "webhookSecret"],
        settings: { site: "https://gitlab.example", project: "acme/app" },
      },
      connectors: [connectors.gitlab],
    });
    expect(html).toContain("https://gitlab.example");
    expect(html).toContain("acme/app");
    expect(html).toContain('data-connection-secret="token"');
    expect(html).toContain('data-connection-secret="webhookSecret"');
    expect(html).not.toContain("glpat-");
    expect(html).not.toContain("secretKeys");
  });
});
