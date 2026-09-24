import { describe, expect, it } from "vitest";
import { jiraConnector } from "../../../server/connectors/jira/index";
import {
  buildSecrets,
  buildSettings,
  connectionMutation,
  slugConnectionId,
  teamChoices,
  uniqueConnectionId,
} from "./model";

describe("task connection model", () => {
  it("slugs an id from the connector and label without inventing secret material", () => {
    expect(slugConnectionId("jira", "Acme")).toBe("jira-acme");
    expect(slugConnectionId("jira", "jira-acme")).toBe("jira-acme");
    expect(slugConnectionId("gitlab", "GitLab HQ!")).toBe("gitlab-hq");
    expect(uniqueConnectionId("jira-acme", ["jira-acme"])).toBe("jira-acme-2");
  });

  it("lists team names the same way connections already scope sections", () => {
    expect(teamChoices(["Payments", "Platform"], [
      { section: "Payments" },
      { section: " Delivery " },
      { section: "" },
    ])).toEqual(["Delivery", "Payments", "Platform"]);
  });

  it("keeps only declared settings and never sends blank secrets when none are saved", () => {
    const settings = buildSettings(jiraConnector.manifest.settings, {
      site: "https://acme.atlassian.net",
      edition: "cloud",
      ignored: "nope",
    });
    expect(settings).toEqual({ site: "https://acme.atlassian.net", edition: "cloud" });
    expect(JSON.stringify(settings)).not.toContain("ignored");
    expect(buildSecrets(jiraConnector.manifest.secrets, {}, [])).toEqual({});
  });

  it("keeps existing secrets as true unless the user types a replacement", () => {
    const kept = buildSecrets(
      jiraConnector.manifest.secrets,
      { email: "", apiToken: "  ", token: "new-pat" },
      ["email", "apiToken"],
    );
    expect(kept).toEqual({ email: true, apiToken: true, token: "new-pat" });
    expect(JSON.stringify(kept)).not.toContain("saved-secret");
  });

  it("builds a mutation the API already accepts, with key names and no leaked values", () => {
    const parsed = connectionMutation({
      id: "jira-acme",
      connectorId: "jira",
      label: "Acme Jira",
      settings: { site: "https://acme.atlassian.net", edition: "cloud" },
      secretDrafts: { email: "ada@acme.test" },
      secretKeys: ["email", "apiToken"],
      sections: ["Payments"],
      enabled: true,
      manifest: jiraConnector.manifest,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.secrets).toEqual({ email: "ada@acme.test", apiToken: true });
    expect(parsed.body.sections).toEqual(["Payments"]);
    expect(JSON.stringify(parsed.body)).not.toContain("super-secret");
  });
});
