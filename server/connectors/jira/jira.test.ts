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
import { ignoreOwnBotWrite } from "../../../shared/watches.ts";
import { connectorContract } from "../contract-suite.ts";
import type { CaptureCall, ConnectionContext, StoredConnection } from "../types.ts";
import { jiraConnector, jiraWebhookSignature, verifyJiraWebhook } from "./index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readJson = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const captureCall = (name: string): CaptureCall => readJson(`capture/${name}.json`);
const TOKEN = "fixture-api-token";
const EMAIL = "bot@example.test";

const myself = readJson("myself.json");
const bulk = readJson("bulkfetch.json") as { issues: Array<{ key: string }> };
const searchJql = readJson("search-jql.json");
const searchChanges = readJson("search-jql-changes.json");
const dcSearch = readJson("dc-search.json");
const webhookBody = readJson("webhook-issue-updated.json");
const webhookCreated = readJson("webhook-issue-created.json");
const webhookTransition = readJson("webhook-issue-transition.json");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!url.startsWith("https://acme.atlassian.net") && !url.startsWith("https://jira.example.test")) {
    throw new Error(`unexpected fetch ${url}`);
  }
  if (url.includes("/myself") && method === "GET") return Promise.resolve(jsonResponse(myself));
  if (url.includes("/issue/bulkfetch") && method === "POST") {
    const keys = new Set((JSON.parse(String(init?.body ?? "{}")).issueIdsOrKeys ?? []).map((key: string) => String(key).toUpperCase()));
    return Promise.resolve(jsonResponse({ issues: bulk.issues.filter(issue => keys.has(issue.key)) }));
  }
  if (url.includes("/search/jql") && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { jql?: string; expand?: string };
    if (String(body.expand ?? "").includes("changelog") || String(body.jql ?? "").includes("updated >")) {
      return Promise.resolve(jsonResponse(searchChanges));
    }
    return Promise.resolve(jsonResponse(searchJql));
  }
  if (url.includes("/rest/api/2/search") && method === "GET") {
    if (url.includes("expand=changelog") || url.includes("updated+%3E") || url.includes("updated >")) {
      return Promise.resolve(jsonResponse(searchChanges));
    }
    return Promise.resolve(jsonResponse(dcSearch));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function ctx(partial: Partial<ConnectionContext> = {}): ConnectionContext {
  const secrets: Record<string, string> = { email: EMAIL, apiToken: TOKEN, token: "fixture-dc-pat", webhookSecret: "webhook-secret" };
  return {
    connectionId: "jira-acme",
    settings: { site: "https://acme.atlassian.net", edition: "cloud" },
    secret(key) {
      if (!jiraConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return secrets[key];
    },
    fetch: fixtureFetch,
    log() {},
    ...partial,
  };
}

const connection: StoredConnection = {
  id: "jira-acme",
  connectorId: "jira",
  label: "Acme Jira",
  settings: { site: "https://acme.atlassian.net", edition: "cloud" },
  secrets: { email: EMAIL, apiToken: TOKEN },
  sections: [],
  enabled: true,
};

function tool(partial: Partial<RuntimeEvent> & { type: "item.started" | "item.completed"; threadId: string }): RuntimeEvent {
  return { eventId: "e", provider: "claude", createdAt: 10, ...partial } as RuntimeEvent;
}

describe("jira connector contract", () => {
  connectorContract(jiraConnector, ctx(), [
    { ref: "PAY-123", url: "https://acme.atlassian.net/browse/PAY-123" },
    { ref: "PAY-123", url: "https://acme.atlassian.net/jira/software/projects/PAY/boards/1?selectedIssue=PAY-123" },
    { ref: "PAY-123:10001", url: "https://acme.atlassian.net/browse/PAY-123?focusedCommentId=10001" },
  ], { title: "fake.issue", output: "Created PAY-1", ok: true }, {
    scope: { query: "project = PAY AND labels = bot-ready" },
    cursor: "2026-09-23T00:00:00.000Z",
    webhook: {
      headers: new Headers({ "x-hub-signature": jiraWebhookSignature("webhook-secret", JSON.stringify(webhookCreated)) }),
      body: webhookCreated,
    },
  });
});

describe("jira connector", () => {
  it("maps Jira status categories and per-connection review/blocked names", async () => {
    const items = await jiraConnector.fetch(ctx(), [
      { kind: "work_item", externalId: "PAY-123" },
      { kind: "work_item", externalId: "PAY-1" },
      { kind: "work_item", externalId: "PAY-140" },
      { kind: "work_item", externalId: "PAY-201" },
      { kind: "work_item", externalId: "PAY-202" },
      { kind: "work_item", externalId: "PAY-203" },
      { kind: "work_item", externalId: "PAY-204" },
      { kind: "comment", externalId: "PAY-123:10001" },
    ]);
    const byId = Object.fromEntries(items.map(item => [item.externalId, item]));
    expect(byId["PAY-123"]).toMatchObject({ title: "Refund failures", state: { label: "In Progress", category: "in_progress" } });
    expect(byId["PAY-1"]?.state?.category).toBe("todo");
    expect(byId["PAY-140"]?.state?.category).toBe("done");
    expect(byId["PAY-201"]?.state?.category).toBe("in_review");
    expect(byId["PAY-202"]?.state?.category).toBe("in_progress");
    expect(byId["PAY-203"]?.state?.category).toBe("blocked");
    expect(byId["PAY-204"]?.state?.category).toBe("cancelled");
    expect(byId["PAY-123:10001"]).toMatchObject({ kind: "comment", title: "Started the refund fix" });
    const mapped = await jiraConnector.fetch(ctx({ settings: { site: "https://acme.atlassian.net", edition: "cloud", inReview: "Ready for QA" } }), [
      { kind: "work_item", externalId: "PAY-202" },
    ]);
    expect(mapped[0].state).toEqual({ label: "Ready for QA", category: "in_review" });
  });

  it("queries Jira Cloud with JQL and Data Center with a PAT", async () => {
    const cloud = await jiraConnector.query!(ctx(), "project = PAY");
    expect(cloud.items.map(item => item.externalId)).toEqual(["PAY-123", "PAY-140"]);
    expect(cloud.cursor).toBe("page-2");
    const urls: string[] = [];
    const schemes: string[] = [];
    const dc = ctx({
      settings: { site: "https://jira.example.test/jira", edition: "datacenter" },
      fetch: async (input, init) => {
        urls.push(String(input));
        const headers = init?.headers as Record<string, string> | undefined;
        schemes.push((headers?.authorization ?? "").split(" ")[0] ?? "");
        return fixtureFetch(input, init);
      },
    });
    expect(await jiraConnector.test(dc)).toEqual({ ok: true, account: "jira.example.test" });
    const page = await jiraConnector.query!(dc, "project = PAY");
    expect(page.items[0]).toMatchObject({ externalId: "PAY-123", title: "Refund failures" });
    expect(urls.some(url => url.includes("/rest/api/2/myself"))).toBe(true);
    expect(urls.some(url => url.includes("/rest/api/2/search"))).toBe(true);
    expect(schemes.every(scheme => scheme === "Bearer")).toBe(true);
  });

  it("refuses an explicitly unfinished short cloud page and inconsistent Data Center offsets", async () => {
    await expect(jiraConnector.query!(ctx({ fetch: async () => jsonResponse({
      issues: [bulk.issues[0]], isLast: false,
    }) }), "project = PAY")).rejects.toThrow(/pagination/);
    const dc = { site: "https://jira.example.test", edition: "datacenter" };
    await expect(jiraConnector.query!(ctx({ settings: dc, fetch: async () => jsonResponse({
      issues: [], total: null, startAt: 0,
    }) }), "project = PAY")).rejects.toThrow(/incomplete page/);
    await expect(jiraConnector.query!(ctx({ settings: dc, fetch: async () => jsonResponse({
      issues: [], total: 50, startAt: 0,
    }) }), "project = PAY", "50")).rejects.toThrow(/inconsistent pagination/);
  });

  it("extracts issue and comment refs from signed webhooks and Atlassian's HMAC vector", async () => {
    expect(verifyJiraWebhook(
      "It's a Secret to Everybody",
      "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9",
      "Hello World!",
    )).toBe(true);
    expect(verifyJiraWebhook("It's a Secret to Everybody", "sha256=deadbeef", "Hello World!")).toBe(false);
    const raw = JSON.stringify(webhookBody);
    const headers = new Headers({ "x-hub-signature": jiraWebhookSignature("webhook-secret", raw) });
    expect(await jiraConnector.webhook!(ctx(), headers, raw)).toEqual([
      { kind: "work_item", externalId: "PAY-123" },
      { kind: "comment", externalId: "PAY-123:10001" },
    ]);
    expect(await jiraConnector.webhook!(ctx(), new Headers({ "x-hub-signature": "sha256=nope" }), raw)).toEqual([]);
  });

  it("captures comment, transition, create and assign previews without truncated ids", () => {
    const comment = jiraConnector.capture[0];
    const transition = jiraConnector.capture.find(rule => rule.eventKind === "state_change");
    const assign = jiraConnector.capture.find(rule => rule.match.tool?.toString().includes("assign"));
    const create = jiraConnector.capture.find(rule => rule.match.tool?.toString().includes("CREATE_ISSUE"));
    expect(comment.extract(captureCall("comment-mcp"))).toMatchObject({ externalId: "PAY-123:10001", parentRef: "PAY-123" });
    expect(comment.extract(captureCall("comment-composio"))).toMatchObject({ externalId: "PAY-123:10001" });
    expect(transition?.extract(captureCall("transition"))).toMatchObject({ externalId: "PAY-123", details: { status: "In Review" } });
    expect(create?.extract(captureCall("create"))).toMatchObject({ externalId: "PAY-140" });
    expect(assign?.extract(captureCall("assign"))).toMatchObject({ externalId: "PAY-123" });
    expect(comment.extract(captureCall("truncated"))).toBeNull();
  });

  it("attaches live Jira status when a task identity resolves to a connection", async () => {
    const link = await sourceLinkedItem([connection], "Engineering", "jira:jira-acme:PAY-123", fixtureFetch);
    expect(link).toMatchObject({
      kind: "work_item",
      role: "source",
      externalId: "PAY-123",
      title: "Refund failures",
      state: { label: "In Progress", category: "in_progress" },
      provenance: "synced",
      connectorId: "jira",
      connectionId: "jira-acme",
    });
    expect(JSON.stringify(link)).not.toContain(TOKEN);
    expect(JSON.stringify(listConnections([connection]))).not.toContain(TOKEN);
    const parsed = parseConnectionMutation({
      id: "jira-acme", connectorId: "jira", label: "Acme Jira",
      settings: { site: "https://acme.atlassian.net", edition: "cloud" },
      secrets: { email: EMAIL, apiToken: TOKEN }, sections: [], enabled: true,
    });
    expect(parsed.ok).toBe(true);
  });

  it("records a comment event when a bot comments through a Jira MCP tool", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-jira-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure({
        scope: "Engineering", identity: "jira:jira-acme:PAY-123", groupId: "payments", threadId: "hub",
        coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds",
        acceptanceCriteria: ["Refund test passes"],
      });
      items.upsertLink(item, {
        id: "jira-acme:work_item:PAY-123", kind: "work_item", role: "source", title: "Refund failures",
        externalId: "PAY-123", connectorId: "jira", connectionId: "jira-acme", provenance: "synced", updatedAt: 1,
      });
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Comment on the story" });
      const capture = new WorkCapture({ items, events, publish() {} });
      const preview = captureCall("comment-mcp");
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "jira-1", title: preview.title, input: preview.input, createdAt: "20" }));
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "jira-1", ok: true, output: preview.output, createdAt: "30" }));
      expect(item.links?.some(link => link.kind === "comment" && link.externalId === "PAY-123:10001" && link.parentId === "jira-acme:work_item:PAY-123")).toBe(true);
      expect(events.read(item.id).some(event => event.kind === "comment" && event.summary.includes("PAY-123"))).toBe(true);
    } finally { await removeTempDir(directory); }
  });

  it("emits changelog diffs and shares webhook ids with the poll feed", async () => {
    const first = await jiraConnector.changes!(ctx(), { query: "project = PAY AND labels = bot-ready" }, "2026-09-23T00:00:00.000Z");
    expect(first.changes.map(change => change.id)).toEqual([
      "PAY-140@created",
      "PAY-123@changelog:10100:status",
    ]);
    expect(first.changes[0]).toMatchObject({
      type: "item.created",
      item: { externalId: "PAY-140", state: { category: "todo" } },
      fields: { labels: ["bot-ready", "payments"] },
      actor: { isBot: false },
    });
    expect(first.changes[1]).toMatchObject({
      type: "item.state_changed",
      before: { state: "todo", stateLabel: "To Do" },
      actor: { name: "Payments bot", isBot: true },
    });
    const again = await jiraConnector.changes!(ctx(), { query: "project = PAY AND labels = bot-ready" }, "2026-09-23T00:00:00.000Z");
    expect(again.changes.map(change => change.id)).toEqual(first.changes.map(change => change.id));
    const later = await jiraConnector.changes!(ctx(), { query: "project = PAY" }, first.cursor);
    expect(later.changes).toEqual([]);
    const createdHeaders = new Headers({ "x-hub-signature": jiraWebhookSignature("webhook-secret", JSON.stringify(webhookCreated)) });
    const hooked = await jiraConnector.webhookChanges!(ctx(), createdHeaders, webhookCreated);
    expect(hooked.map(change => change.id)).toEqual(["PAY-140@created"]);
    const botHeaders = new Headers({ "x-hub-signature": jiraWebhookSignature("webhook-secret", JSON.stringify(webhookTransition)) });
    const botWrite = await jiraConnector.webhookChanges!(ctx(), botHeaders, webhookTransition);
    expect(botWrite.map(change => change.id)).toEqual(["PAY-123@changelog:10100:status"]);
    expect(botWrite[0]).toMatchObject({
      id: "PAY-123@changelog:10100:status",
      type: "item.state_changed",
      actor: { isBot: true },
    });
  });

  it("uses minute-resolution inclusive JQL while filtering by the exact cursor", async () => {
    let queriedJql = "";
    const connection = ctx({
      settings: { site: "https://jira.example.test", edition: "datacenter" },
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/myself")) return Promise.resolve(jsonResponse({ ...myself, timeZone: "UTC" }));
        if (url.pathname.endsWith("/rest/api/2/search")) {
          queriedJql = url.searchParams.get("jql") ?? "";
          if (!queriedJql.includes('updated >= "2026-09-23 14:00"')) {
            return Promise.resolve(jsonResponse({ errorMessages: ["Invalid Jira date"] }, 400));
          }
          const sameMinute = structuredClone(searchChanges.issues[0]);
          sameMinute.fields.updated = "2026-09-23T14:00:45.000+0000";
          return Promise.resolve(jsonResponse({ issues: [sameMinute, ...searchChanges.issues.slice(1)] }));
        }
        return fixtureFetch(input, init);
      },
    });
    const cursor = "2026-09-23T14:00:31.000Z";
    const result = await jiraConnector.changes!(connection, { project: "PAY" }, cursor);
    expect(queriedJql).toContain('updated >= "2026-09-23 14:00"');
    expect(queriedJql).not.toContain("14:00:31");
    expect(result.changes.some(change => change.type === "item.updated" && change.item.externalId === "PAY-140")).toBe(true);
    expect(result.changes.every(change => change.at > Date.parse(cursor))).toBe(true);
  });

  it("uses the Jira account timezone to catch updates missed by a UTC JQL date", async () => {
    let queriedJql = "";
    const updatedIssue = structuredClone(searchChanges.issues[0]);
    updatedIssue.fields.updated = "2026-09-24T19:40:55.000+0000";
    updatedIssue.fields.comment = { comments: [{ id: "2031542", created: updatedIssue.fields.updated, body: "PO disposition" }] };
    const connection = ctx({
      settings: { site: "https://jira.example.test", edition: "datacenter" },
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/myself")) return Promise.resolve(jsonResponse({ ...myself, timeZone: "America/New_York" }));
        if (url.pathname.endsWith("/rest/api/2/search")) {
          queriedJql = url.searchParams.get("jql") ?? "";
          return Promise.resolve(jsonResponse({ issues: queriedJql.includes('updated >= "2026-09-24 15:35"') ? [updatedIssue] : [] }));
        }
        return fixtureFetch(input, init);
      },
    });
    const result = await jiraConnector.changes!(connection, { project: "PAY" }, "2026-09-24T19:35:00.000Z");
    expect(queriedJql).toContain('updated >= "2026-09-24 15:35"');
    expect(result.changes).toMatchObject([{ id: "PAY-140@comment:2031542", type: "comment.added" }]);
  });

  it("attributes a Jira comment to its author rather than the issue assignee", async () => {
    const updatedIssue = structuredClone(searchChanges.issues[0]);
    updatedIssue.fields.updated = "2026-09-24T19:40:55.000+0000";
    updatedIssue.fields.assignee = { ...myself };
    updatedIssue.fields.comment = { comments: [
      { id: "201", created: updatedIssue.fields.updated, author: { displayName: "Decision owner", accountId: "person:other" } },
      { id: "202", created: updatedIssue.fields.updated, author: { ...myself } },
    ] };
    const connection = ctx({
      settings: { site: "https://jira.example.test", edition: "datacenter" },
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/myself")) return Promise.resolve(jsonResponse({ ...myself, timeZone: "America/New_York" }));
        if (url.pathname.endsWith("/rest/api/2/search")) return Promise.resolve(jsonResponse({ issues: [updatedIssue] }));
        return fixtureFetch(input, init);
      },
    });
    const result = await jiraConnector.changes!(connection, { project: "PAY" }, "2026-09-24T19:35:00.000Z");
    const people = result.changes.filter(change => !ignoreOwnBotWrite(change));
    expect(people).toMatchObject([{ id: "PAY-140@comment:201", actor: { name: "Decision owner", isBot: false } }]);
    expect(result.changes.find(change => change.id === "PAY-140@comment:202")?.actor?.isBot).toBe(true);
  });

  it.each([
    { timeZone: "America/New_York", cursor: "2026-01-24T19:35:00.000Z", expected: "2026-01-24 14:35" },
    { timeZone: undefined, cursor: "2026-09-24T19:35:00.000Z", expected: "2026-09-24 05:35" },
    { timeZone: "invalid/timezone", cursor: "2026-09-24T19:35:00.000Z", expected: "2026-09-24 05:35" },
  ])("bounds Jira JQL dates in $timeZone at $cursor", async ({ timeZone, cursor, expected }) => {
    let queriedJql = "";
    const connection = ctx({
      settings: { site: "https://jira.example.test", edition: "datacenter" },
      fetch: (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/myself")) return Promise.resolve(jsonResponse({ ...myself, timeZone }));
        if (url.pathname.endsWith("/rest/api/2/search")) {
          queriedJql = url.searchParams.get("jql") ?? "";
          return Promise.resolve(jsonResponse({ issues: [] }));
        }
        return fixtureFetch(input, init);
      },
    });
    await jiraConnector.changes!(connection, { project: "PAY" }, cursor);
    expect(queriedJql).toContain(`updated >= "${expected}"`);
  });

  it("keeps tokens and basic credentials out of connector logs", async () => {
    const logs: string[] = [];
    const recording = ctx({ log: message => logs.push(message) });
    expect(await jiraConnector.test(recording)).toMatchObject({ ok: true, account: "acme.atlassian.net" });
    await jiraConnector.fetch(recording, [{ kind: "work_item", externalId: "PAY-123" }]);
    await jiraConnector.query!(recording, "project = PAY");
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
    expect(text).not.toMatch(/Basic |Bearer /);
    expect(text).not.toContain("webhook-secret");
  });
});
