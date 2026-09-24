import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../../shared/runtime-events.ts";
import { listConnections, parseConnectionMutation, sourceLinkedItem } from "../../task-connections.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { WorkEvents } from "../../work-events.ts";
import { WorkItems } from "../../work-items.ts";
import { WorkCapture } from "../capture.ts";
import { connectorContract } from "../contract-suite.ts";
import type { CaptureCall, ConnectionContext, StoredConnection } from "../types.ts";
import { planeConnector } from "./index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readJson = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const captureCall = (name: string): CaptureCall => readJson(`capture/${name}.json`);
const API_KEY = "fixture-plane-api-key";

const projects = readJson("projects.json");
const workItems = readJson("work-items.json") as Record<string, { id: string; name: string }>;
const comments = readJson("comments.json") as Record<string, { id: string }>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function byId(id: string) {
  return Object.values(workItems).find(item => item.id === id);
}

function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!url.startsWith("https://api.plane.so/") && !url.startsWith("https://plane.example.test/")) {
    throw new Error(`unexpected fetch ${url}`);
  }
  if (method !== "GET") return Promise.resolve(new Response("method not allowed", { status: 405 }));
  if (/\/projects\/?(\?|$)/.test(url) && !url.includes("/work-items/")) return Promise.resolve(jsonResponse(projects));
  const comment = /\/comments\/([0-9a-f-]+)\//.exec(url);
  if (comment) {
    const body = comments[comment[1]];
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  const byKey = /\/work-items\/([A-Z]+-\d+)\//i.exec(url);
  if (byKey) {
    const body = workItems[byKey[1].toUpperCase()];
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  const byUuid = /\/work-items\/([0-9a-f-]{36})\/?(\?|$)/.exec(url);
  if (byUuid && !url.includes("?")) {
    const body = byId(byUuid[1]);
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  if (url.includes("/work-items?") || /\/work-items\/\?/.test(url)) {
    const listed = url.includes("pql=")
      ? Object.values(workItems)
      : [workItems["PAY-123"], workItems["PAY-201"]];
    return Promise.resolve(jsonResponse({
      next_cursor: "20:1:0",
      next_page_results: true,
      results: listed,
    }));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function ctx(partial: Partial<ConnectionContext> = {}): ConnectionContext {
  const secrets: Record<string, string> = { apiKey: API_KEY };
  return {
    connectionId: "plane-acme",
    settings: { site: "https://api.plane.so", workspace: "acme", project: "PAY" },
    secret(key) {
      if (!planeConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return secrets[key];
    },
    fetch: fixtureFetch,
    log() {},
    ...partial,
  };
}

const connection: StoredConnection = {
  id: "plane-acme",
  connectorId: "plane",
  label: "Acme Plane",
  settings: { site: "https://api.plane.so", workspace: "acme", project: "PAY" },
  secrets: { apiKey: API_KEY },
  sections: [],
  enabled: true,
};

function tool(partial: Partial<RuntimeEvent> & { type: "item.started" | "item.completed"; threadId: string }): RuntimeEvent {
  return { eventId: "e", provider: "claude", createdAt: 10, ...partial } as RuntimeEvent;
}

describe("plane connector contract", () => {
  connectorContract(planeConnector, ctx(), [
    { ref: "PAY-123", url: "https://app.plane.so/acme/browse/PAY-123" },
    { ref: "PAY-123:f3e29f26-708d-40f0-9209-7e0de44abc49", url: "https://app.plane.so/acme/browse/PAY-123#f3e29f26-708d-40f0-9209-7e0de44abc49" },
  ], captureCall("create"));
});

describe("plane connector", () => {
  it("maps Plane state groups to status categories", async () => {
    const items = await planeConnector.fetch(ctx(), [
      { kind: "work_item", externalId: "PAY-1" },
      { kind: "work_item", externalId: "PAY-123" },
      { kind: "work_item", externalId: "PAY-140" },
      { kind: "work_item", externalId: "PAY-201" },
      { kind: "work_item", externalId: "PAY-202" },
      { kind: "work_item", externalId: "PAY-203" },
      { kind: "comment", externalId: "PAY-123:f3e29f26-708d-40f0-9209-7e0de44abc49" },
    ]);
    const byExternal = Object.fromEntries(items.map(item => [item.externalId, item]));
    expect(byExternal["PAY-1"]?.state).toEqual({ label: "Backlog", category: "todo" });
    expect(byExternal["PAY-123"]).toMatchObject({
      title: "Refund failures",
      state: { label: "In Progress", category: "in_progress" },
      details: { priority: "high", assignee: "Ada", project: "PAY" },
    });
    expect(byExternal["PAY-140"]?.state).toEqual({ label: "Done", category: "done" });
    expect(byExternal["PAY-201"]?.state).toEqual({ label: "Todo", category: "todo" });
    expect(byExternal["PAY-202"]?.state).toEqual({ label: "Cancelled", category: "cancelled" });
    expect(byExternal["PAY-203"]?.state).toEqual({ label: "In Review", category: "in_review" });
    expect(byExternal["PAY-123:f3e29f26-708d-40f0-9209-7e0de44abc49"]).toMatchObject({
      kind: "comment",
      title: "Started the refund fix",
      details: { issue: "PAY-123" },
    });
  });

  it("queries a project and accepts a self-hosted site with an API key", async () => {
    const page = await planeConnector.query!(ctx(), "PAY");
    expect(page.items.map(item => item.externalId)).toEqual(["PAY-123", "PAY-201"]);
    expect(page.cursor).toBe("20:1:0");
    const urls: string[] = [];
    const headers: string[] = [];
    const selfManaged = ctx({
      settings: { site: "https://plane.example.test", workspace: "acme", project: "PAY" },
      fetch: async (input, init) => {
        urls.push(String(input));
        headers.push(String((init?.headers as Record<string, string> | undefined)?.["X-API-Key"] ?? ""));
        return fixtureFetch(input, init);
      },
    });
    expect(await planeConnector.test(selfManaged)).toEqual({ ok: true, account: "acme" });
    expect(urls.some(url => url === "https://plane.example.test/api/v1/workspaces/acme/projects/?per_page=1")).toBe(true);
    expect(headers.every(value => value === API_KEY)).toBe(true);
  });

  it("returns an idempotent updated_at change feed", async () => {
    const first = await planeConnector.changes!(ctx(), { project: "PAY" }, "2026-09-23T00:00:00.000Z");
    expect(first.changes.map(change => change.item.externalId)).toEqual(["PAY-201", "PAY-203", "PAY-123"]);
    expect(first.changes[0]?.type).toBe("item.created");
    expect(first.changes.at(-1)).toMatchObject({
      type: "item.updated",
      item: { externalId: "PAY-123", state: { category: "in_progress" } },
    });
    expect(first.cursor).toBe("2026-09-23T14:22:00.000Z");
    const again = await planeConnector.changes!(ctx(), { project: "PAY" }, "2026-09-23T00:00:00.000Z");
    expect(again.changes.map(change => change.id)).toEqual(first.changes.map(change => change.id));
    expect(again.cursor).toBe(first.cursor);
    const later = await planeConnector.changes!(ctx(), { project: "PAY" }, first.cursor);
    expect(later.changes).toEqual([]);
    expect(later.cursor).toBe(first.cursor);
  });

  it("captures Plane MCP create, comment and update previews without truncated ids", () => {
    const create = planeConnector.capture[0];
    const comment = planeConnector.capture.find(rule => rule.eventKind === "comment");
    const update = planeConnector.capture.find(rule => rule.eventKind === "state_change");
    expect(create.extract(captureCall("create"))).toMatchObject({ externalId: "PAY-140", title: "Export receipts" });
    expect(comment?.extract(captureCall("comment"))).toMatchObject({
      externalId: "PAY-123:f3e29f26-708d-40f0-9209-7e0de44abc49",
      parentRef: "PAY-123",
    });
    expect(update?.extract(captureCall("update"))).toMatchObject({ externalId: "PAY-123" });
    expect(create.extract(captureCall("truncated"))).toBeNull();
  });

  it("attaches live Plane status when a task identity resolves", async () => {
    const link = await sourceLinkedItem([connection], "Engineering", "plane:plane-acme:PAY-123", fixtureFetch);
    expect(link).toMatchObject({
      kind: "work_item",
      role: "source",
      externalId: "PAY-123",
      title: "Refund failures",
      state: { label: "In Progress", category: "in_progress" },
      provenance: "synced",
      connectorId: "plane",
      connectionId: "plane-acme",
    });
    expect(JSON.stringify(link)).not.toContain(API_KEY);
    expect(JSON.stringify(listConnections([connection]))).not.toContain(API_KEY);
    const parsed = parseConnectionMutation({
      id: "plane-acme", connectorId: "plane", label: "Acme Plane",
      settings: { site: "https://api.plane.so", workspace: "acme", project: "PAY" },
      secrets: { apiKey: API_KEY }, sections: [], enabled: true,
    });
    expect(parsed.ok).toBe(true);
  });

  it("records a comment event when a bot comments through a Plane MCP tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-plane-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure({
        scope: "Engineering", identity: "plane:plane-acme:PAY-123", groupId: "payments", threadId: "hub",
        coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds",
        acceptanceCriteria: ["Refund test passes"],
      });
      items.upsertLink(item, {
        id: "plane-acme:work_item:PAY-123", kind: "work_item", role: "source", title: "Refund failures",
        externalId: "PAY-123", connectorId: "plane", connectionId: "plane-acme", provenance: "synced", updatedAt: 1,
      });
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Comment on the story" });
      const capture = new WorkCapture({ items, events, publish() {} });
      const preview = captureCall("comment");
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "plane-1", title: preview.title, input: preview.input, createdAt: "20" }));
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "plane-1", ok: true, output: preview.output, createdAt: "30" }));
      expect(item.links?.some(link => link.kind === "comment" && link.externalId === "PAY-123:f3e29f26-708d-40f0-9209-7e0de44abc49" && link.parentId === "plane-acme:work_item:PAY-123")).toBe(true);
      expect(events.read(item.id).some(event => event.kind === "comment" && event.summary.includes("PAY-123"))).toBe(true);
    } finally { await removeTempDir(directory); }
  });

  it("keeps API keys out of connector logs", async () => {
    const logs: string[] = [];
    const recording = ctx({ log: message => logs.push(message) });
    expect(await planeConnector.test(recording)).toMatchObject({ ok: true, account: "acme" });
    await planeConnector.fetch(recording, [{ kind: "work_item", externalId: "PAY-123" }]);
    await planeConnector.query!(recording, "PAY");
    await planeConnector.changes!(recording, { project: "PAY" }, "2026-09-23T00:00:00.000Z");
    const text = logs.join("\n");
    expect(text).not.toContain(API_KEY);
    expect(text).not.toMatch(/X-API-Key|Bearer /i);
  });
});
