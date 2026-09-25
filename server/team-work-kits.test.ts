import { describe, expect, it } from "vitest";
import { gitlabConnector } from "./connectors/gitlab/index.ts";
import { jiraConnector } from "./connectors/jira/index.ts";
import { planeConnector } from "./connectors/plane/index.ts";
import {
  defaultMissionKinds, GITLAB_KIT, JIRA_GITLAB_KIT, JIRA_KIT, kindsForConnector,
  matchTeamWorkKit, missingKindsFallback, PLANE_KIT, scopeKinds,
} from "./team-work-kits.ts";

describe("team work kits", () => {
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
    expect(kindsForConnector("gitlab", ["jira", "gitlab"])).toEqual(["change_request"]);
    expect(kindsForConnector("gitlab", ["gitlab"])).toEqual(["work_item", "change_request"]);
    expect(kindsForConnector("plane", ["plane"])).toEqual(["work_item"]);
  });

  it("fills missing stored kinds from the jira-gitlab kit so GitLab issues stay dropped", () => {
    expect(missingKindsFallback("gitlab")).toEqual(["change_request"]);
    expect(missingKindsFallback("jira")).toEqual(["work_item"]);
    expect(scopeKinds({ connectorId: "gitlab" })).toEqual(["change_request"]);
    expect(scopeKinds({ connectorId: "gitlab", kinds: ["work_item", "change_request"] }))
      .toEqual(["work_item", "change_request"]);
  });
});
