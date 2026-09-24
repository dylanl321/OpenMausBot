import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SourceChange, Watch } from "../shared/watches.ts";
import { applyWatchToWork, ensureTasksFromChanges, watchLinkMatches } from "./watch-actions.ts";
import { fakeConnector } from "./testing/fake-connector.ts";
import { WatchManager } from "./watches.ts";
import { WorkEvents } from "./work-events.ts";
import { WorkItems } from "./work-items.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-watch-actions-"));
  dirs.push(dir);
  return dir;
}

function change(overrides: Partial<SourceChange> = {}): SourceChange {
  return {
    id: "PAY-8@created",
    type: "item.created",
    connectionId: "jira-acme",
    item: {
      kind: "work_item",
      title: "Export receipts",
      externalId: "PAY-140",
      connectorId: "jira",
      connectionId: "jira-acme",
      state: { label: "To Do", category: "todo" },
      details: { labels: "bot-ready", description: "Ship labelled receipt export." },
      updatedAt: 1,
    },
    actor: { name: "Ada", isBot: false },
    fields: { labels: ["bot-ready"] },
    at: 1,
    ...overrides,
  };
}

function watch(overrides: Partial<Watch> = {}): Watch {
  return {
    id: "w1",
    name: "Ready stories",
    source: { type: "connection", connectionId: "jira-acme" },
    events: ["item.created", "item.labeled"],
    check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
    action: { type: "ensure_task", topic: "Payments", coordinatorBotId: "chief", criteriaFrom: "item" },
    startFrom: "now",
    enabled: true,
    nextCheckAt: 1,
    createdAt: 1,
    updatedAt: 1,
    stats: { checks: 0, changesSeen: 0, matches: 0, actions: 0, runsAvoided: 0 },
    ...overrides,
  };
}

describe("ensure_task", () => {
  it("creates exactly one shared task from a labelled story and does not start a coordinator turn", async () => {
    const dir = tempDir();
    const items = new WorkItems(join(dir, "work-items.json"));
    const started: string[] = [];
    const created = await ensureTasksFromChanges({
      watch: watch(),
      changes: [change(), change({ id: "PAY-140@changelog:1:labels", type: "item.labeled" })],
      action: { type: "ensure_task", topic: "Payments", coordinatorBotId: "chief", criteriaFrom: "item" },
      items,
      scopeOf: () => "Engineering",
      resolveCoordinator: () => ({ id: "chief", name: "Chief", color: "green", section: "Engineering" }),
      resolveTopic: () => ({ groupId: "payments", threadId: "hub" }),
      onCreated: (item) => { started.push(item.id); },
    });
    expect(created.created).toHaveLength(1);
    expect(created.reused).toEqual([]);
    expect(created.started).toBe(false);
    const item = items.records.get(created.created[0]!)!;
    expect(item.identity).toBe("jira:jira-acme:PAY-140");
    expect(item.objective).toBe("Ship labelled receipt export.");
    expect(item.acceptanceCriteria).toEqual(["Ship labelled receipt export."]);
    expect(item.rootId).toBeUndefined();
    expect(item.links?.[0]).toMatchObject({ kind: "work_item", role: "source", externalId: "PAY-140" });
    const again = await ensureTasksFromChanges({
      watch: watch(),
      changes: [change({ id: "PAY-140@created-again" })],
      action: { type: "ensure_task", topic: "Payments", coordinatorBotId: "chief" },
      items,
      scopeOf: () => "Engineering",
      resolveCoordinator: () => ({ id: "chief", name: "Chief", color: "green" }),
      resolveTopic: () => ({ groupId: "payments", threadId: "other" }),
    });
    expect(again.created).toEqual([]);
    expect(again.reused).toEqual([item.id]);
    expect(started).toHaveLength(1);
  });

  it("polls the fake connector feed into exactly one task and skips the bot transition", async () => {
    const dir = tempDir();
    const items = new WorkItems(join(dir, "work-items.json"));
    const ctx = {
      connectionId: "fake-acme",
      settings: { site: "https://fake.example" },
      secret: () => "token",
      fetch: async () => new Response(JSON.stringify({ account: "fake" })),
      log() {},
    };
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => 8_000,
      connectionChanges: (_id, scope, cursor) => fakeConnector.changes!(ctx, scope, cursor),
      ensureTask: async (current, changes, action) => {
        await ensureTasksFromChanges({
          watch: current,
          changes,
          action,
          items,
          scopeOf: () => "Engineering",
          resolveCoordinator: () => ({ id: "chief", name: "Chief", color: "green" }),
          resolveTopic: () => ({ groupId: "payments", threadId: "hub" }),
        });
      },
    });
    const created = watches.create({
      name: "Ready stories",
      source: { type: "connection", connectionId: "fake-acme" },
      events: ["item.created", "item.state_changed"],
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "ensure_task", topic: "Payments", coordinatorBotId: "chief", criteriaFrom: "item" },
      startFrom: "backfill",
    });
    await watches.check(created.id);
    const records = [...items.records.values()];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      identity: "fake:fake-acme:PAY-8",
      title: "Ready story",
    });
    expect(records[0]!.rootId).toBeUndefined();
    expect(records[0]!.objective).toContain("labelled payments story");
    await watches.check(created.id);
    expect(items.records.size).toBe(1);
  });
});

describe("record / task_update", () => {
  it("attaches a failed pipeline to the linked MR and wakes the coordinator once", () => {
    const dir = tempDir();
    const items = new WorkItems(join(dir, "work-items.json"));
    const events = new WorkEvents(join(dir, "work-events"));
    const { item } = items.ensure({
      scope: "Engineering", identity: "refunds", groupId: "payments", threadId: "hub",
      coordinatorBotId: "chief", title: "Refunds", objective: "Fix refunds",
      acceptanceCriteria: ["Green pipeline"],
    });
    items.upsertLink(item, {
      id: "gitlab-acme:change_request:acme/payments!482",
      kind: "change_request",
      role: "output",
      title: "Round partial refunds",
      externalId: "acme/payments!482",
      connectorId: "gitlab",
      connectionId: "gitlab-acme",
      details: { pipelineId: 9001 },
      provenance: "observed",
      updatedAt: 1,
    });
    items.settle(item, "blocked", "Waiting on CI");
    const failed: SourceChange = {
      id: "acme/payments#pipeline:9001@failed",
      type: "build.failed",
      connectionId: "gitlab-acme",
      item: {
        kind: "build",
        title: "pipeline 9001",
        externalId: "acme/payments#pipeline:9001",
        connectorId: "gitlab",
        connectionId: "gitlab-acme",
        state: { label: "failed", category: "blocked" },
        details: { mr: "acme/payments!482" },
        updatedAt: 2,
      },
      fields: { mr: "acme/payments!482" },
      at: 2,
    };
    expect(watchLinkMatches(item.links![0]!, failed)).toBe(true);
    const wokenIds: string[] = [];
    const first = applyWatchToWork({
      items,
      events,
      changes: [failed],
      bumpInput: true,
      onWake: (record) => { wokenIds.push(record.id); },
    });
    expect(first.attached).toBe(1);
    expect(first.woken).toEqual([item.id]);
    expect(wokenIds).toEqual([item.id]);
    expect(item.links?.some(link => link.kind === "build" && link.externalId === "acme/payments#pipeline:9001")).toBe(true);
    expect(events.read(item.id).some(event => event.summary.includes("build.failed"))).toBe(true);
    expect(item.revision).toBe(2);
    expect(() => applyWatchToWork({ items, events, changes: [failed], bumpInput: true })).not.toThrow();
    const second = applyWatchToWork({ items, events, changes: [failed], bumpInput: true });
    expect(second.woken).toEqual([]);
  });
});
