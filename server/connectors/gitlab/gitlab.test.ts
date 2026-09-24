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
import { gitlabConnector, verifyGitlabWebhook } from "./index.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readJson = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const captureCall = (name: string): CaptureCall => readJson(`capture/${name}.json`);
const TOKEN = "fixture-gitlab-token";

const user = readJson("user.json");
const project = readJson("project.json");
const mergeRequests = readJson("merge-requests.json") as Record<string, { iid: number }>;
const issues = readJson("issues.json") as Record<string, { iid: number }>;
const approvals = readJson("approvals.json") as Record<string, unknown>;
const commit = readJson("commit.json");
const pipeline = readJson("pipeline.json");
const jobs = readJson("jobs.json");
const discussions = readJson("discussions.json");
const issueDiscussions = readJson("issue-discussions.json");
const webhookMr = readJson("webhook-merge-request.json");
const webhookPipeline = readJson("webhook-pipeline.json");
const webhookPipelineFailed = readJson("webhook-pipeline-failed.json");
const webhookNote = readJson("webhook-note.json");
const webhookIssue = readJson("webhook-issue.json");
const webhookIssueNote = readJson("webhook-issue-note.json");
const events = readJson("events.json");
const pipelines = readJson("pipelines.json");

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!url.startsWith("https://gitlab.com/") && !url.startsWith("https://gitlab.example.test/")) {
    throw new Error(`unexpected fetch ${url}`);
  }
  if (method !== "GET") return Promise.resolve(new Response("method not allowed", { status: 405 }));
  if (url.endsWith("/api/v4/user")) return Promise.resolve(jsonResponse(user));
  if (/\/api\/v4\/projects\/[^/?]+$/.test(url)) return Promise.resolve(jsonResponse(project));
  const approval = /merge_requests\/(\d+)\/approvals/.exec(url);
  if (approval) {
    const body = approvals[approval[1]];
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  if (url.includes("/issues/") && url.includes("/discussions")) return Promise.resolve(jsonResponse(issueDiscussions));
  if (url.includes("/discussions")) return Promise.resolve(jsonResponse(discussions));
  const issue = /\/issues\/(\d+)(?:\?|$)/.exec(url);
  if (issue && !url.includes("?")) {
    const body = issues[issue[1]];
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  if (url.includes("/issues?")) {
    return Promise.resolve(jsonResponse([issues["140"]], 200, { "x-next-page": "" }));
  }
  const mr = /merge_requests\/(\d+)(?:\?|$)/.exec(url);
  if (mr && !url.includes("?")) {
    const body = mergeRequests[mr[1]];
    return Promise.resolve(body ? jsonResponse(body) : new Response("not found", { status: 404 }));
  }
  if (url.includes("/merge_requests?")) {
    return Promise.resolve(jsonResponse([mergeRequests["482"], mergeRequests["484"]], 200, { "x-next-page": "2" }));
  }
  if (url.includes("/repository/commits/")) return Promise.resolve(jsonResponse(commit));
  if (url.includes("/events")) return Promise.resolve(jsonResponse(events));
  if (/\/pipelines\/\d+\/jobs/.test(url)) return Promise.resolve(jsonResponse(jobs));
  if (/\/pipelines\/\d+/.test(url)) return Promise.resolve(jsonResponse(pipeline));
  if (url.includes("/pipelines")) return Promise.resolve(jsonResponse(pipelines));
  return Promise.resolve(new Response("not found", { status: 404 }));
}

function ctx(partial: Partial<ConnectionContext> = {}): ConnectionContext {
  const secrets: Record<string, string> = { token: TOKEN, webhookSecret: "webhook-secret" };
  return {
    connectionId: "gitlab-acme",
    settings: { site: "https://gitlab.com", project: "acme/payments" },
    secret(key) {
      if (!gitlabConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return secrets[key];
    },
    fetch: fixtureFetch,
    log() {},
    ...partial,
  };
}

const connection: StoredConnection = {
  id: "gitlab-acme",
  connectorId: "gitlab",
  label: "Acme GitLab",
  settings: { site: "https://gitlab.com", project: "acme/payments" },
  secrets: { token: TOKEN },
  sections: [],
  enabled: true,
};

function tool(partial: Partial<RuntimeEvent> & { type: "item.started" | "item.completed"; threadId: string }): RuntimeEvent {
  return { eventId: "e", provider: "claude", createdAt: 10, ...partial } as RuntimeEvent;
}

describe("gitlab connector contract", () => {
  connectorContract(gitlabConnector, ctx(), [
    { ref: "acme/payments#140", url: "https://gitlab.com/acme/payments/-/issues/140" },
    { ref: "#140", url: "https://gitlab.com/acme/payments/-/issues/140" },
    { ref: "acme/payments!482", url: "https://gitlab.com/acme/payments/-/merge_requests/482" },
    { ref: "!482", url: "https://gitlab.com/acme/payments/-/merge_requests/482" },
    { ref: "acme/payments@3f2a1c9", url: "https://gitlab.com/acme/payments/-/commit/3f2a1c9" },
    { ref: "acme/payments#pipeline:9001", url: "https://gitlab.com/acme/payments/-/pipelines/9001" },
    { ref: "acme/payments!482:note:10001", url: "https://gitlab.com/acme/payments/-/merge_requests/482#note_10001" },
    { ref: "acme/payments#140:note:10003", url: "https://gitlab.com/acme/payments/-/issues/140#note_10003" },
  ], captureCall("mr-create-mcp"), {
    scope: { project: "acme/payments" },
    cursor: "2026-09-23T00:00:00.000Z",
    webhook: {
      headers: new Headers({ "x-gitlab-token": "webhook-secret" }),
      body: webhookMr,
    },
  });
});

describe("gitlab connector", () => {
  it("maps merge-request, pipeline, commit and review-thread state", async () => {
    const items = await gitlabConnector.fetch(ctx(), [
      { kind: "work_item", externalId: "acme/payments#140" },
      { kind: "work_item", externalId: "#141" },
      { kind: "change_request", externalId: "acme/payments!482" },
      { kind: "change_request", externalId: "!483" },
      { kind: "change_request", externalId: "acme/payments!484" },
      { kind: "change_request", externalId: "acme/payments!485" },
      { kind: "change_request", externalId: "acme/payments!486" },
      { kind: "commit", externalId: "3f2a1c9" },
      { kind: "build", externalId: "acme/payments#pipeline:9001" },
      { kind: "comment", externalId: "acme/payments!482:note:10001" },
      { kind: "comment", externalId: "acme/payments!482:note:10002" },
      { kind: "comment", externalId: "acme/payments#140:note:10003" },
    ]);
    const byId = Object.fromEntries(items.map(item => [item.externalId, item]));
    expect(byId["acme/payments#140"]).toMatchObject({
      kind: "work_item",
      title: "Refund failures",
      state: { label: "opened", category: "todo" },
      details: { labels: "payments", assignee: "Ada", type: "issue" },
    });
    expect(byId["acme/payments#141"]?.state).toEqual({ label: "closed", category: "done" });
    expect(byId["acme/payments!482"]).toMatchObject({
      title: "Round partial refunds",
      state: { label: "opened", category: "in_review" },
      details: { draft: false, conflicts: false, pipeline: "running", pipelineId: 9001, approvals: "1/2" },
    });
    expect(byId["acme/payments!483"]?.state).toEqual({ label: "merged", category: "done" });
    expect(byId["acme/payments!484"]?.state).toEqual({ label: "draft", category: "in_progress" });
    expect(byId["acme/payments!485"]?.state).toEqual({ label: "conflicts", category: "blocked" });
    expect(byId["acme/payments!486"]?.state).toEqual({ label: "closed", category: "cancelled" });
    expect(byId["acme/payments@3f2a1c9"]).toMatchObject({ kind: "commit", title: "Round partial refunds", details: { author: "Engineer", pipeline: "running" } });
    expect(byId["acme/payments#pipeline:9001"]).toMatchObject({
      kind: "build",
      state: { label: "running", category: "in_progress" },
      details: { "stage.build": "success", "stage.test": "running" },
    });
    expect(byId["acme/payments!482:note:10001"]).toMatchObject({
      kind: "comment",
      title: "Please check the rounding.",
      state: { label: "open", category: "in_review" },
      details: { file: "src/refunds.ts", line: 42, mr: "acme/payments!482" },
    });
    expect(byId["acme/payments!482:note:10002"]?.state).toEqual({ label: "resolved", category: "done" });
    expect(byId["acme/payments#140:note:10003"]).toMatchObject({
      kind: "comment",
      title: "Started the refund fix",
      details: { issue: "acme/payments#140" },
    });
  });

  it("queries opened merge requests and accepts a project token on self-managed GitLab", async () => {
    const page = await gitlabConnector.query!(ctx(), "acme/payments");
    expect(page.items.map(item => item.externalId)).toEqual(["acme/payments#140", "acme/payments!482", "acme/payments!484"]);
    expect(page.cursor).toBe("2");
    const urls: string[] = [];
    const headers: string[] = [];
    const selfManaged = ctx({
      settings: { site: "https://gitlab.example.test", project: "acme/payments" },
      fetch: async (input, init) => {
        urls.push(String(input));
        headers.push(String((init?.headers as Record<string, string> | undefined)?.["PRIVATE-TOKEN"] ?? ""));
        return fixtureFetch(input, init);
      },
    });
    expect(await gitlabConnector.test(selfManaged)).toEqual({ ok: true, account: "acme/payments" });
    expect(urls.some(url => url === "https://gitlab.example.test/api/v4/projects/acme%2Fpayments")).toBe(true);
    expect(headers.every(value => value === TOKEN)).toBe(true);
  });

  it("extracts MR, pipeline and review-note refs from GitLab webhooks", async () => {
    expect(verifyGitlabWebhook("webhook-secret", "webhook-secret")).toBe(true);
    expect(verifyGitlabWebhook("webhook-secret", "nope")).toBe(false);
    const headers = new Headers({ "x-gitlab-token": "webhook-secret" });
    expect(await gitlabConnector.webhook!(ctx(), headers, webhookMr)).toEqual([
      { kind: "change_request", externalId: "acme/payments!482" },
      { kind: "build", externalId: "acme/payments#pipeline:9001" },
    ]);
    expect(await gitlabConnector.webhook!(ctx(), headers, webhookPipeline)).toEqual([
      { kind: "build", externalId: "acme/payments#pipeline:9001" },
      { kind: "change_request", externalId: "acme/payments!482" },
    ]);
    expect(await gitlabConnector.webhook!(ctx(), headers, JSON.stringify(webhookNote))).toEqual([
      { kind: "change_request", externalId: "acme/payments!482" },
      { kind: "comment", externalId: "acme/payments!482:note:10001" },
    ]);
    expect(await gitlabConnector.webhook!(ctx(), headers, webhookIssue)).toEqual([
      { kind: "work_item", externalId: "acme/payments#140" },
    ]);
    expect(await gitlabConnector.webhook!(ctx(), headers, webhookIssueNote)).toEqual([
      { kind: "work_item", externalId: "acme/payments#140" },
      { kind: "comment", externalId: "acme/payments#140:note:10003" },
    ]);
    expect(await gitlabConnector.webhook!(ctx(), new Headers({ "x-gitlab-token": "nope" }), webhookMr)).toEqual([]);
  });

  it("captures GitLab MCP and glab previews without truncated ids", () => {
    const create = gitlabConnector.capture[0];
    const glabCreate = gitlabConnector.capture.find(rule => rule.match.command?.toString().includes("mr\\s+create"));
    const note = gitlabConnector.capture.find(rule => rule.eventKind === "comment");
    const glabNote = gitlabConnector.capture.find(rule => rule.match.command?.toString().includes("note|comment"));
    const pipelineRule = gitlabConnector.capture.find(rule => rule.match.command?.toString().includes("ci|pipeline"));
    expect(create.extract(captureCall("mr-create-mcp"))).toMatchObject({ externalId: "acme/payments!482", title: "Round partial refunds" });
    expect(glabCreate?.extract(captureCall("mr-create-glab"))).toMatchObject({ externalId: "acme/payments!482" });
    expect(note?.extract(captureCall("mr-note-mcp"))).toMatchObject({ externalId: "acme/payments!482:note:10001", parentRef: "acme/payments!482" });
    expect(glabNote?.extract(captureCall("mr-note-glab"))).toMatchObject({ externalId: "acme/payments!482:note:10001" });
    expect(note?.extract(captureCall("mr-thread-mcp"))).toMatchObject({
      externalId: "acme/payments!482:note:10001",
      parentRef: "acme/payments!482",
      details: { file: "src/refunds.ts", line: 42 },
    });
    expect(pipelineRule?.extract(captureCall("pipeline-glab"))).toMatchObject({ externalId: "acme/payments#pipeline:9001" });
    const issueCreate = gitlabConnector.capture.find(rule => rule.match.tool?.toString().includes("issue[_-]?create") || rule.produce.kind === "work_item");
    const glabIssue = gitlabConnector.capture.find(rule => rule.match.command?.toString().includes("issue\\s+create"));
    expect(issueCreate?.extract(captureCall("issue-create-mcp"))).toMatchObject({ externalId: "acme/payments#140", title: "Refund failures" });
    expect(glabIssue?.extract(captureCall("issue-create-glab"))).toMatchObject({ externalId: "acme/payments#140" });
    expect(create.extract(captureCall("truncated"))).toBeNull();
    const issueRules = gitlabConnector.capture.filter(rule => rule.produce.kind === "work_item");
    for (const rule of issueRules) {
      if (rule.match.command) {
        expect(rule.match.command.test("glab issue create --repo acme/payments")).toBe(true);
        continue;
      }
      if (rule.match.server) {
        expect(rule.match.server.test("gitlab")).toBe(true);
        expect(rule.match.server.test("jira")).toBe(false);
        expect(rule.match.tool?.test("create_issue")).toBe(true);
        expect(rule.match.tool?.test("JIRA_CREATE_ISSUE")).toBe(false);
      } else {
        expect(rule.match.tool?.test("JIRA_CREATE_ISSUE")).toBe(false);
        expect(rule.match.tool?.test("create_issue")).toBe(false);
        expect(rule.match.tool?.test("GITLAB_CREATE_ISSUE")).toBe(true);
        expect(rule.match.tool?.test("mcp__gitlab__create_issue")).toBe(true);
      }
    }
  });

  it("attaches live merge-request and pipeline state when a task identity resolves", async () => {
    const link = await sourceLinkedItem([connection], "Engineering", "gitlab:gitlab-acme:acme/payments!482", fixtureFetch);
    expect(link).toMatchObject({
      kind: "change_request",
      role: "source",
      externalId: "acme/payments!482",
      title: "Round partial refunds",
      state: { label: "opened", category: "in_review" },
      details: { pipeline: "running", pipelineId: 9001 },
      provenance: "synced",
      connectorId: "gitlab",
      connectionId: "gitlab-acme",
    });
    expect(JSON.stringify(link)).not.toContain(TOKEN);
    expect(JSON.stringify(listConnections([connection]))).not.toContain(TOKEN);
    const parsed = parseConnectionMutation({
      id: "gitlab-acme", connectorId: "gitlab", label: "Acme GitLab",
      settings: { site: "https://gitlab.com", project: "acme/payments" },
      secrets: { token: TOKEN }, sections: [], enabled: true,
    });
    expect(parsed.ok).toBe(true);
    const short = await sourceLinkedItem([connection], "Engineering", "gitlab:gitlab-acme:!482", fixtureFetch);
    expect(short?.externalId).toBe("acme/payments!482");
    const issue = await sourceLinkedItem([connection], "Engineering", "gitlab:gitlab-acme:acme/payments#140", fixtureFetch);
    expect(issue).toMatchObject({
      kind: "work_item",
      externalId: "acme/payments#140",
      title: "Refund failures",
      state: { label: "opened", category: "todo" },
      provenance: "synced",
    });
  });

  it("records a change request with pipeline state and a review thread when a worker opens an MR", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-gitlab-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure({
        scope: "Engineering", identity: "refunds", groupId: "payments", threadId: "hub",
        coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds",
        acceptanceCriteria: ["Refund test passes"],
      });
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Open the merge request" });
      const capture = new WorkCapture({ items, events, publish() {} });
      const created = captureCall("mr-create-glab");
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "glab-1", title: created.title, summary: created.summary, input: created.input, createdAt: "20" }));
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "glab-1", ok: true, output: created.output, createdAt: "30" }));
      expect(item.links?.some(link => link.kind === "change_request" && link.externalId === "acme/payments!482")).toBe(true);
      const [synced] = await gitlabConnector.fetch(ctx(), [{ kind: "change_request", externalId: "acme/payments!482" }]);
      expect(synced.details?.pipeline).toBe("running");
      const thread = captureCall("mr-thread-mcp");
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "glab-2", title: thread.title, input: thread.input, createdAt: "40" }));
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "glab-2", ok: true, output: thread.output, createdAt: "50" }));
      expect(item.links?.some(link => link.kind === "comment" && link.externalId === "acme/payments!482:note:10001" && link.parentId === "local:change_request:acme/payments!482")).toBe(true);
      expect(events.read(item.id).some(event => event.kind === "comment" && event.summary.includes("acme/payments!482"))).toBe(true);
    } finally { await removeTempDir(directory); }
  });

  it("maps project events and failed pipelines, sharing webhook ids", async () => {
    const first = await gitlabConnector.changes!(ctx(), { project: "acme/payments" }, "2026-09-23T00:00:00.000Z");
    expect(first.changes.map(change => change.id)).toEqual([
      "acme/payments#140@open",
      "acme/payments!482@open",
      "acme/payments!482@comment:10001",
      "acme/payments@3f2a1c9d0e1f2345678901234567890abcdef12",
      "acme/payments#pipeline:9001@failed",
    ]);
    expect(first.changes.find(change => change.type === "build.failed")).toMatchObject({
      fields: { mr: "acme/payments!482" },
      item: { kind: "build", externalId: "acme/payments#pipeline:9001" },
    });
    const again = await gitlabConnector.changes!(ctx(), { project: "acme/payments" }, "2026-09-23T00:00:00.000Z");
    expect(again.changes.map(change => change.id)).toEqual(first.changes.map(change => change.id));
    const later = await gitlabConnector.changes!(ctx(), { project: "acme/payments" }, first.cursor);
    expect(later.changes).toEqual([]);
    const headers = new Headers({ "x-gitlab-token": "webhook-secret" });
    const opened = await gitlabConnector.webhookChanges!(ctx(), headers, webhookMr);
    expect(opened.map(change => change.id)).toEqual(["acme/payments!482@open"]);
    const failed = await gitlabConnector.webhookChanges!(ctx(), headers, webhookPipelineFailed);
    expect(failed[0]).toMatchObject({
      id: "acme/payments#pipeline:9001@failed",
      type: "build.failed",
      fields: { mr: "acme/payments!482" },
    });
  });

  it("keeps tokens out of connector logs", async () => {
    const logs: string[] = [];
    const recording = ctx({ log: message => logs.push(message) });
    expect(await gitlabConnector.test(recording)).toMatchObject({ ok: true, account: "acme/payments" });
    await gitlabConnector.fetch(recording, [{ kind: "change_request", externalId: "acme/payments!482" }]);
    await gitlabConnector.query!(recording, "acme/payments");
    await gitlabConnector.changes!(recording, { project: "acme/payments" }, "2026-09-23T00:00:00.000Z");
    const text = logs.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("webhook-secret");
    expect(text).not.toMatch(/PRIVATE-TOKEN|Bearer /i);
  });
});
