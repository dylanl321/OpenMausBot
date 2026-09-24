import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { json, readBody } from "../harness/http.ts";
import { dispatchRoutes } from "./table.ts";
import { createWorkItemAnswerRoutes } from "./work-item-answer.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(done => server.close(done))));
});

async function serve(status: "needs-input" | "active" = "needs-input") {
  const item = { status, groupId: "topic", threadId: "hub", coordinatorBotId: "chief", revision: 1 };
  const routes = [createWorkItemAnswerRoutes({
    item: id => id === "work" ? item : undefined,
    canSee: () => true,
    answer: (_id, input) => ({ workItem: { ...item, status: "active", detail: input.text, revision: 2 } as never }),
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

describe("POST /api/work-items/:id/answer", () => {
  it("accepts an answer for a needs-input task", async () => {
    const base = await serve();
    const response = await fetch(`${base}/api/work-items/work/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, text: "Use merchant-9" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ workItem: { status: "active", detail: "Use merchant-9", revision: 2 } });
  });

  it("refuses an answer when the task is not waiting", async () => {
    const base = await serve("active");
    const response = await fetch(`${base}/api/work-items/work/answer`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, text: "Use merchant-9" }),
    });
    expect(response.status).toBe(400);
  });
});
