import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { WorkItems } from "../work-items.ts";
import { WorkEvents } from "../work-events.ts";
import { serverFromTitle, WorkCapture } from "./capture.ts";

const input = { scope: "Engineering", identity: "refunds", groupId: "payments", threadId: "hub",
  coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds", acceptanceCriteria: ["Refund test passes"] };

function tool(partial: Partial<RuntimeEvent> & { type: "item.started" | "item.completed"; threadId: string }): RuntimeEvent {
  return { eventId: "e", provider: "claude", createdAt: 10, ...partial } as RuntimeEvent;
}

describe("work capture", () => {
  it("turns a git commit preview into a commit link and a task event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-capture-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure(input);
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Commit the fix" });
      const capture = new WorkCapture({ items, events, publish() {} });
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "bash-1", title: "Bash", summary: "git commit -m refund", createdAt: "20" }));
      expect(item.assignments[0].currentStep?.summary).toBe("git commit -m refund");
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "bash-1", ok: true, output: "[main 3f2a1c9] refund\n 1 file changed\n", createdAt: "30" }));
      expect(item.links?.some(link => link.kind === "commit" && link.externalId === "3f2a1c9" && link.provenance === "observed")).toBe(true);
      const recorded = events.read(item.id);
      expect(recorded.some(event => event.kind === "tool" && event.state === "complete")).toBe(true);
      expect(recorded.some(event => event.kind === "output" && event.linkId)).toBe(true);
      expect(item.assignments[0].currentStep).toBeUndefined();
    } finally { await removeTempDir(directory); }
  });

  it("does not let Plane claim a Jira-sourced update_work_item preview that still names PAY-123", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-capture-plane-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure({ ...input, identity: "jira:jira-acme:PAY-123" });
      items.upsertLink(item, {
        id: "jira-acme:work_item:PAY-123", kind: "work_item", role: "source", title: "Refund failures",
        externalId: "PAY-123", connectorId: "jira", connectionId: "jira-acme", provenance: "synced", updatedAt: 1,
      });
      items.claim(item, { botId: "chief", threadId: "hub", message: "Complete the task" });
      const capture = new WorkCapture({ items, events, publish() {} });
      capture.handle(tool({
        type: "item.started", threadId: "hub", itemType: "tool", itemId: "coord-1", title: "update_work_item",
        input: "{\"work_item_id\":\"$current\",\"status\":\"completed\",\"evidence\":[\"PAY-123\"]}", createdAt: "20",
      }));
      capture.handle(tool({
        type: "item.completed", threadId: "hub", itemType: "tool", itemId: "coord-1", ok: true,
        output: "Updated PAY-123. Task completed.", createdAt: "30",
      }));
      expect(item.links?.some(link => link.connectorId === "plane")).toBe(false);
      expect(item.links?.filter(link => link.kind === "work_item").map(link => link.connectorId)).toEqual(["jira"]);
    } finally { await removeTempDir(directory); }
  });

  it("does not let GitLab claim a JIRA_CREATE_ISSUE preview even when a GitLab-shaped id is present", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-capture-gitlab-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure(input);
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Open the story" });
      const capture = new WorkCapture({ items, events, publish() {} });
      capture.handle(tool({
        type: "item.started", threadId: "worker", itemType: "tool", itemId: "jira-1", title: "JIRA_CREATE_ISSUE",
        input: "{\"project\":\"PAY\",\"summary\":\"Refund failures\"}", createdAt: "20",
      }));
      capture.handle(tool({
        type: "item.completed", threadId: "worker", itemType: "tool", itemId: "jira-1", ok: true,
        output: "Created issue PAY-123\nSee also acme/payments#140", createdAt: "30",
      }));
      expect(item.links?.some(link => link.connectorId === "gitlab")).toBe(false);
      expect(item.links?.some(link => String(link.externalId ?? "").includes("acme/payments#140"))).toBe(false);
      expect(item.links?.some(link => link.connectorId === "jira" && link.externalId === "PAY-123")).toBe(true);
    } finally { await removeTempDir(directory); }
  });

  it("still captures a GitLab MCP create_issue when the server signal is GitLab", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-capture-gl-mcp-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure(input);
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Open the GitLab issue" });
      const capture = new WorkCapture({ items, events, publish() {} });
      capture.handle(tool({
        type: "item.started", threadId: "worker", itemType: "tool", itemId: "gl-1", title: "create_issue",
        server: "gitlab", input: "{\"project\":\"acme/payments\",\"title\":\"Refund failures\"}", createdAt: "20",
      }));
      capture.handle(tool({
        type: "item.completed", threadId: "worker", itemType: "tool", itemId: "gl-1", ok: true,
        output: "{\"iid\":140,\"title\":\"Refund failures\",\"web_url\":\"https://gitlab.com/acme/payments/-/issues/140\"}",
        createdAt: "30",
      }));
      expect(item.links?.some(link => link.connectorId === "gitlab" && link.externalId === "acme/payments#140")).toBe(true);
    } finally { await removeTempDir(directory); }
  });

  it("reads an MCP server name from a namespaced tool title", () => {
    expect(serverFromTitle("mcp__gitlab__create_issue")).toBe("gitlab");
    expect(serverFromTitle("mcp__plane__workitem")).toBe("plane");
    expect(serverFromTitle("update_work_item")).toBeUndefined();
    expect(serverFromTitle("JIRA_CREATE_ISSUE")).toBeUndefined();
  });

  it("closes a running tool event when the process restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-events-"));
    try {
      const events = new WorkEvents(join(directory, "work-events"));
      events.append({
        id: "running-1", workItemId: "task-1", revision: 1, at: 1,
        actor: { type: "bot", botId: "engineer", threadId: "worker" },
        kind: "tool", summary: "git commit -m refund", state: "running", provenance: "observed", itemId: "bash-1",
      });
      const reloaded = new WorkEvents(join(directory, "work-events"));
      expect(reloaded.read("task-1")[0]).toMatchObject({ state: "failed" });
    } finally { await removeTempDir(directory); }
  });
});
