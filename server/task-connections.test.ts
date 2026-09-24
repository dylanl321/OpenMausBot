import { describe, expect, it } from "vitest";
import { listConnections, parseConnectionMutation, parseStoredConnections } from "./task-connections.ts";

describe("task connections", () => {
  it("keeps secret values off the listing and refuses an undeclared secret", () => {
    const parsed = parseConnectionMutation({
      id: "fake-acme", connectorId: "fake", label: "Acme",
      settings: { site: "https://fake.example" }, secrets: { token: "super-secret" }, sections: ["Delivery"], enabled: true,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(listConnections([parsed.connection]))).not.toContain("super-secret");
    expect(listConnections([parsed.connection])[0].secretKeys).toEqual(["token"]);
    const kept = parseConnectionMutation({ ...parsed.connection, secrets: { token: true } }, parsed.connection);
    expect(kept.ok && kept.connection.secrets.token).toBe("super-secret");
    expect(parseConnectionMutation({ ...parsed.connection, secrets: { password: "nope" } }).ok).toBe(false);
    expect(parseStoredConnections([{ ...parsed.connection, connectorId: "missing" }])).toEqual([]);
  });
});
