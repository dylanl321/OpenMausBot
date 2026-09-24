import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "./table.ts";
import { createWorkItemLinkRoutes } from "./work-item-links.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

async function serve() {
  const item = { groupId: "topic", threadId: "hub", coordinatorBotId: "chief" };
  const routes = [createWorkItemLinkRoutes({
    item: id => id === "work" ? item : undefined,
    canSee: () => true,
    link: (_id, raw) => {
      const body = raw as { refOrUrl: string; role: "reference" };
      return { id: "claimed:1", kind: "link", role: body.role, title: body.refOrUrl, provenance: "claimed", updatedAt: 1 };
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

describe("POST /api/work-items/:id/links", () => {
  it("records a claimed link on a visible task", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/work-items/work/links`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refOrUrl: "https://example.test/note", role: "reference" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      link: { id: "claimed:1", kind: "link", role: "reference", title: "https://example.test/note", provenance: "claimed", updatedAt: 1 },
    });
  });

  it("hides unknown tasks", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/work-items/missing/links`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refOrUrl: "x", role: "output" }),
    });
    expect(response.status).toBe(404);
  });
});
