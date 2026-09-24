import { describe, expect, it } from "vitest";
import { CONNECTORS, connectorById, connectorsFor, includeTestConnectors } from "./registry.ts";

describe("connector registry", () => {
  it("keeps the fake connector for tests and omits it from production", () => {
    expect(includeTestConnectors()).toBe(true);
    expect(CONNECTORS.some(connector => connector.manifest.id === "fake")).toBe(true);
    expect(connectorById("fake")?.manifest.id).toBe("fake");
    expect(connectorsFor({}).map(connector => connector.manifest.id)).toEqual(["jira", "gitlab", "plane"]);
    expect(connectorsFor({ NODE_ENV: "production" }).map(connector => connector.manifest.id)).not.toContain("fake");
    expect(connectorsFor({ VITEST: "true" }).some(connector => connector.manifest.id === "fake")).toBe(true);
  });
});
