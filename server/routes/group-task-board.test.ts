import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "./table.ts";
import { createGroupTaskBoardRoutes } from "./group-task-board.ts";
import type { StoredConnection } from "../connectors/types.ts";
import type { GroupRecord } from "../store.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

const connection: StoredConnection = {
  id: "fake-acme", connectorId: "fake", label: "Fake",
  settings: { site: "https://fake.example" }, secrets: { token: "tok" }, sections: [], enabled: true,
};

async function serve() {
  const group: GroupRecord = {
    id: "payments", threadId: "hub", name: "Payments", memberIds: ["chief"],
    defaultResponder: { kind: "member", botId: "chief" }, bulletin: "", unread: false, createdAt: 1,
  };
  const routes = [createGroupTaskBoardRoutes({
    group: id => id === group.id ? group : undefined,
    connections: () => [connection],
    save: (_id, taskBoard) => {
      if (taskBoard) group.taskBoard = taskBoard;
      else delete group.taskBoard;
      return group;
    },
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

describe("PATCH /api/groups/:id/task-board", () => {
  it("saves and clears a topic connection query", async () => {
    const base = await serve();
    const saved = await fetch(`${base}/api/groups/payments/task-board`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId: "fake-acme", query: "all" }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ taskBoard: { connectionId: "fake-acme", query: "all" } });
    const listed = await fetch(`${base}/api/groups/payments/task-board`);
    const listing = await listed.json() as { connections: Array<{ id: string }>; taskBoard: { query: string } };
    expect(listing.connections.map(connection => connection.id)).toContain("fake-acme");
    expect(listing.taskBoard.query).toBe("all");
    const cleared = await fetch(`${base}/api/groups/payments/task-board`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(await cleared.json()).toMatchObject({ taskBoard: null });
  });
});
