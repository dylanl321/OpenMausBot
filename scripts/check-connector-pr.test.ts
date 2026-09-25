import { describe, expect, it } from "vitest";
import { connectorOnlyProblems } from "./check-connector-pr.mjs";

describe("connector-only path allowlist", () => {
  it("allows a new connector folder, the registry line, and docs", () => {
    expect(connectorOnlyProblems([
      "server/connectors/plane/index.ts",
      "server/connectors/plane/plane.test.ts",
      "server/connectors/registry.ts",
      "docs/connectors.md",
    ])).toEqual([]);
  });

  it("allows a Plane-only actions addition inside the connector folder", () => {
    expect(connectorOnlyProblems([
      "server/connectors/plane/index.ts",
      "server/connectors/plane/actions.ts",
      "server/connectors/plane/plane.test.ts",
      "server/connectors/registry.ts",
      "docs/connectors.md",
    ])).toEqual([]);
  });

  it("rejects a connector PR that also edits UI or shared server files", () => {
    const problems = connectorOnlyProblems([
      "server/connectors/plane/index.ts",
      "server/connectors/registry.ts",
      "src/components/SettingsModal.tsx",
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("src/components/SettingsModal.tsx");
    expect(problems[0]).toContain("server/connectors/plane/**");
  });

  it("stays silent for mixed work that is not a drop-in connector PR", () => {
    expect(connectorOnlyProblems([
      "src/components/connections/ConnectionEditor.tsx",
      "src/locales/en.json",
    ])).toEqual([]);
    expect(connectorOnlyProblems([
      "server/connectors/jira/index.ts",
      "server/task-connections.ts",
    ])).toEqual([]);
  });
});
