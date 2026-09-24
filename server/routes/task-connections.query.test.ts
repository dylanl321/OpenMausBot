import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "./table.ts";
import { createTaskConnectionRoutes } from "./task-connections.ts";
import type { StoredConnection } from "../connectors/types.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

const connection: StoredConnection = {
  id: "fake-acme", connectorId: "fake", label: "Fake",
  settings: { site: "https://fake.example" }, secrets: { token: "tok" }, sections: [], enabled: true,
};

async function serve(connections: StoredConnection[] = [connection]) {
  const routes = [createTaskConnectionRoutes({
    load: () => connections,
    save() {},
    sectionForGroup: id => id === "payments" ? "Delivery" : undefined,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, {
      req, res, url, path: url.pathname, method: req.method ?? "GET",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody,
    });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("GET /api/task-connections/:id/query", () => {
  it("lists fake-connector items for a board query", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/task-connections/fake-acme/query?query=all&groupId=payments`);
    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ externalId: string; kind: string }> };
    expect(body.items.some(item => item.externalId === "PAY-2")).toBe(true);
    expect(body.items.some(item => item.externalId === "PAY-1")).toBe(true);
  });

  it("hides a missing group", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/task-connections/fake-acme/query?query=all&groupId=missing`);
    expect(response.status).toBe(404);
  });
});
