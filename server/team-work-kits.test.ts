import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gitlabConnector } from "./connectors/gitlab/index.ts";
import { jiraConnector } from "./connectors/jira/index.ts";
import { planeConnector } from "./connectors/plane/index.ts";
import {
  defaultMissionKinds, GITLAB_KIT, JIRA_GITLAB_KIT, JIRA_KIT, kitById, kitCriteria,
  kitKindsForConnector, kindsForConnector, matchKitFromCatalog, matchTeamWorkKit,
  missingKindsFallback, parseTeamWorkKits, pinnedConnectorIds, PLANE_KIT, scopeKinds,
  TEAM_WORK_KITS, teamWorkKitCatalogSchema,
} from "./team-work-kits.ts";

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), "team-work-kits.json");

describe("team work kits", () => {
  it("loads the four shipped kits as data and matches by pinned ids", () => {
    const fromDisk = parseTeamWorkKits(JSON.parse(readFileSync(catalogPath, "utf8")));
    expect(fromDisk.map(kit => kit.id)).toEqual(["jira-gitlab", "gitlab", "jira", "plane"]);
    expect(TEAM_WORK_KITS).toEqual(fromDisk);
    expect(TEAM_WORK_KITS.map(kit => kit.id)).toEqual(["jira-gitlab", "gitlab", "jira", "plane"]);
    expect(kitById("jira-gitlab")).toBe(JIRA_GITLAB_KIT);
    expect(kitById("gitlab")).toBe(GITLAB_KIT);
    expect(kitById("jira")).toBe(JIRA_KIT);
    expect(kitById("plane")).toBe(PLANE_KIT);
    expect(pinnedConnectorIds(JIRA_GITLAB_KIT)).toEqual(["gitlab", "jira"]);
    expect(pinnedConnectorIds(GITLAB_KIT)).toEqual(["gitlab"]);
    expect(pinnedConnectorIds(JIRA_KIT)).toEqual(["jira"]);
    expect(pinnedConnectorIds(PLANE_KIT)).toEqual(["plane"]);
  });

  it("defaults mission kinds to the connector ∩ work_item/change_request", () => {
    expect(defaultMissionKinds(jiraConnector.manifest)).toEqual(["work_item"]);
    expect(defaultMissionKinds(gitlabConnector.manifest)).toEqual(["work_item", "change_request"]);
    expect(defaultMissionKinds(planeConnector.manifest)).toEqual(["work_item"]);
  });

  it("matches branded kits and leaves unrecognized mixes to manifests", () => {
    expect(matchTeamWorkKit(["jira", "gitlab"])).toBe(JIRA_GITLAB_KIT);
    expect(matchTeamWorkKit(["gitlab"])).toBe(GITLAB_KIT);
    expect(matchTeamWorkKit(["jira"])).toBe(JIRA_KIT);
    expect(matchTeamWorkKit(["plane"])).toBe(PLANE_KIT);
    expect(matchTeamWorkKit(["jira", "plane"])).toBeUndefined();
    expect(matchTeamWorkKit([])).toBeUndefined();
    expect(kindsForConnector("gitlab", ["jira", "gitlab"])).toEqual(["change_request"]);
    expect(kindsForConnector("gitlab", ["gitlab"])).toEqual(["work_item", "change_request"]);
    expect(kindsForConnector("jira", ["jira"])).toEqual(["work_item"]);
    expect(kindsForConnector("plane", ["plane"])).toEqual(["work_item"]);
  });

  it("jira-gitlab drops GitLab issues; gitlab kit keeps work_item and change_request", () => {
    expect(kitKindsForConnector(JIRA_GITLAB_KIT, "gitlab")).toEqual(["change_request"]);
    expect(kitKindsForConnector(JIRA_GITLAB_KIT, "jira")).toEqual(["work_item"]);
    expect(kitKindsForConnector(GITLAB_KIT, "gitlab")).toEqual(["work_item", "change_request"]);
    expect(kitKindsForConnector(JIRA_KIT, "jira")).toEqual(["work_item"]);
    expect(kitKindsForConnector(PLANE_KIT, "plane")).toEqual(["work_item"]);
    expect(kitCriteria(JIRA_GITLAB_KIT)).toEqual([
      "Every scoped work item is evidenced and done",
      "Every scoped change request is merged at a reviewed head",
    ]);
    expect(kitCriteria(GITLAB_KIT)).toEqual(kitCriteria(JIRA_GITLAB_KIT));
    expect(kitCriteria(JIRA_KIT)).toEqual(["Every scoped work item is evidenced and done"]);
    expect(kitCriteria(PLANE_KIT)).toEqual(["Every scoped work item is evidenced and done"]);
  });

  it("fills missing stored kinds from the jira-gitlab kit so GitLab issues stay dropped", () => {
    expect(missingKindsFallback("gitlab")).toEqual(["change_request"]);
    expect(missingKindsFallback("jira")).toEqual(["work_item"]);
    expect(scopeKinds({ connectorId: "gitlab" })).toEqual(["change_request"]);
    expect(scopeKinds({ connectorId: "gitlab", kinds: ["work_item", "change_request"] }))
      .toEqual(["work_item", "change_request"]);
  });

  it("matches a catalog row by pinned ids without a provider-named branch", () => {
    const extra = parseTeamWorkKits({
      kits: [{
        id: "tracker-only",
        name: "Tracker",
        connectors: [{ role: "tracker", kinds: ["work_item"] }],
      }, {
        id: "acme",
        name: "Acme",
        connectors: [{ role: "other", connectorId: "fake", kinds: ["work_item"] }],
      }],
    });
    expect(matchKitFromCatalog(extra, ["fake"])).toEqual(extra[1]);
    expect(matchKitFromCatalog(extra, ["jira"])).toBeUndefined();
    expect(teamWorkKitCatalogSchema.safeParse({ kits: extra }).success).toBe(true);
  });

  it("does not compile extra approval-rule names into kit data", () => {
    const source = readFileSync(catalogPath, "utf8");
    expect(source).not.toMatch(/Security|Manager/);
    expect(TEAM_WORK_KITS.every(kit => !kit.approval?.extraRuleNames?.length)).toBe(true);
  });
});
