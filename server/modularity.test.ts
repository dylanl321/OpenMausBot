import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connectorOnlyProblems } from "../scripts/check-connector-pr.mjs";
import { GITLAB_KIT, JIRA_GITLAB_KIT, kitKindsForConnector } from "./team-work-kits.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");
const PROVIDER_ID = /=== ["'](?:jira|gitlab|plane)["']/;
const PROVIDER_COPY = /\b(?:Jira|GitLab)\b/;

describe("modularity guards", () => {
  it("keeps mission schemas, infer, scan, and the runner free of provider-id branches", () => {
    for (const file of [
      "shared/team-backlog.ts",
      "server/team-backlog.ts",
      "server/team-backlog-actions.ts",
      "server/team-backlog-runner.ts",
    ]) {
      expect(read(file), file).not.toMatch(PROVIDER_ID);
    }
    expect(read("shared/team-backlog.ts")).not.toMatch(/z\.enum\(\s*\[\s*["']jira["']\s*,\s*["']gitlab["']/);
  });

  it("keeps Work and runner user copy kind-driven", () => {
    expect(read("server/team-backlog-runner.ts")).not.toMatch(PROVIDER_COPY);
    expect(read("src/components/WorkPage.tsx")).not.toMatch(PROVIDER_COPY);
    expect(read("shared/team-backlog.ts")).not.toMatch(/Jira issues|GitLab MR/);
    expect(read("src/locales/en.json")).not.toMatch(/jira:connection:PROJECT-/);
  });

  it("still treats a Plane-only actions addition as a connector-only PR", () => {
    expect(connectorOnlyProblems([
      "server/connectors/plane/index.ts",
      "server/connectors/plane/actions.ts",
      "server/connectors/registry.ts",
      "docs/connectors.md",
    ])).toEqual([]);
    expect(connectorOnlyProblems([
      "server/connectors/plane/index.ts",
      "server/connectors/registry.ts",
      "src/components/WorkPage.tsx",
    ]).some(problem => problem.includes("src/components/WorkPage.tsx"))).toBe(true);
  });

  it("keeps jira-gitlab dropping GitLab issues while the gitlab kit inventories both kinds", () => {
    expect(kitKindsForConnector(JIRA_GITLAB_KIT, "gitlab")).toEqual(["change_request"]);
    expect(kitKindsForConnector(GITLAB_KIT, "gitlab")).toEqual(["work_item", "change_request"]);
  });
});
