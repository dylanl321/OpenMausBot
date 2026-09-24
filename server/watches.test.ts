import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager } from "./routines.ts";
import { WatchManager } from "./watches.ts";
import { parseTeamBackup } from "../shared/team-backup.ts";
import type { SourceChange } from "../shared/watches.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "omb-watches-"));
  dirs.push(dir);
  return dir;
}

function change(overrides: Partial<SourceChange> = {}): SourceChange {
  return {
    id: "evt-1",
    type: "item.created",
    connectionId: "webhook:wh-1",
    item: { kind: "work_item", title: "PAY-140", externalId: "PAY-140", updatedAt: 1 },
    fields: { project: "PAY" },
    at: 1,
    ...overrides,
  };
}

function gitHeads(map: Record<string, string>): string {
  return Object.entries(map).map(([ref, sha]) => `${sha}\t${ref}`).join("\n");
}

describe("watch cursors and dedupe", () => {
  it("baselines startFrom now, then acts once per new head and ignores idle polls", async () => {
    const dir = tempDir();
    let heads = { "refs/heads/main": "a".repeat(40) };
    const acted: string[][] = [];
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => 1_000,
      execGit: async () => gitHeads(heads),
      record: (_watch, changes) => { acted.push(changes.map((item) => item.id)); },
    });
    const watch = watches.create({
      name: "Repo heads",
      source: { type: "git", remote: "/tmp/repo.git" },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "record" },
      startFrom: "now",
    });
    await watches.check(watch.id);
    expect(acted).toEqual([]);
    expect(watches.get(watch.id)?.stats).toMatchObject({ checks: 1, matches: 0, actions: 0, runsAvoided: 1 });

    await watches.check(watch.id);
    await watches.check(watch.id);
    expect(acted).toEqual([]);
    expect(watches.get(watch.id)?.stats.runsAvoided).toBe(3);

    heads = { "refs/heads/main": "b".repeat(40) };
    await watches.check(watch.id);
    expect(acted).toEqual([[`refs/heads/main@${"b".repeat(40)}`]]);
    expect(watches.get(watch.id)?.stats).toMatchObject({ matches: 1, actions: 1 });

    await watches.check(watch.id);
    expect(acted).toHaveLength(1);
  });

  it("does not replay a committed cursor after restart", async () => {
    const dir = tempDir();
    const file = join(dir, "watches.json");
    let heads = { "refs/heads/main": "a".repeat(40) };
    const acted: number[] = [];
    const options = {
      file,
      now: () => 2_000,
      execGit: async () => gitHeads(heads),
      record: () => { acted.push(1); },
    };
    const first = new WatchManager(options);
    const watch = first.create({
      name: "Repo heads",
      source: { type: "git", remote: "/tmp/repo.git" },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "record" },
    });
    await first.check(watch.id);
    heads = { "refs/heads/main": "b".repeat(40) };
    await first.check(watch.id);
    expect(acted).toHaveLength(1);

    const restored = new WatchManager(options);
    expect(JSON.parse(readFileSync(file, "utf8")).cursors[watch.id].heads["refs/heads/main"]).toBe("b".repeat(40));
    await restored.check(watch.id);
    expect(acted).toHaveLength(1);

    heads = { "refs/heads/main": "c".repeat(40) };
    await restored.check(watch.id);
    expect(acted).toHaveLength(2);
  });

  it("dedupes webhook deliveries by change id", async () => {
    const dir = tempDir();
    const acted: string[] = [];
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => 3_000,
      record: (_watch, changes) => { acted.push(...changes.map((item) => item.id)); },
    });
    const watch = watches.create({
      name: "Hook",
      source: { type: "webhook", webhookId: "wh-1", fieldMap: { id: "$.delivery", type: "$.event", title: "$.title" } },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "record" },
    });
    const payload = { delivery: "d-1", event: "item.created", title: "PAY-140" };
    await watches.ingestWebhook({ webhookId: "wh-1", deliveryId: "d-1", payload });
    await watches.ingestWebhook({ webhookId: "wh-1", deliveryId: "d-1", payload });
    expect(acted).toEqual(["d-1"]);
    expect(watches.get(watch.id)?.stats).toMatchObject({ matches: 1, actions: 1 });
  });
});

describe("watch budgets, quiet hours, and batching", () => {
  it("records matches during quiet hours without acting", async () => {
    const dir = tempDir();
    const acted: number[] = [];
    const notices: string[] = [];
    const noon = new Date(2026, 8, 24, 12, 0, 0).getTime();
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => noon,
      record: () => { acted.push(1); },
      raiseAttention: (_watch, reason) => { notices.push(reason); },
    });
    watches.create({
      name: "Quiet",
      source: { type: "webhook", webhookId: "wh-1" },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "record" },
      limits: { quietHours: "09:00-17:00" },
    });
    await watches.ingestWebhook({
      webhookId: "wh-1",
      deliveryId: "d-2",
      payload: { title: "alert" },
    });
    expect(acted).toEqual([]);
    expect(notices[0]).toMatch(/Quiet hours/);
  });

  it("stops acting once the daily budget is hit", async () => {
    const dir = tempDir();
    const acted: number[] = [];
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => 4_000,
      record: () => { acted.push(1); },
    });
    watches.create({
      name: "Budget",
      source: { type: "webhook", webhookId: "wh-1" },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "record" },
      limits: { maxActionsPerDay: 1 },
    });
    await watches.ingestWebhook({ webhookId: "wh-1", deliveryId: "a", payload: { n: 1 } });
    await watches.ingestWebhook({ webhookId: "wh-1", deliveryId: "b", payload: { n: 2 } });
    expect(acted).toHaveLength(1);
  });
});

describe("onlyIfChanged gate", () => {
  it("skips scheduled routine runs until the watch sees a match, then consumes it", async () => {
    const dir = tempDir();
    let now = Date.parse("2026-09-13T08:00:00Z");
    const started: string[] = [];
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => now,
    });
    const watch = watches.create({
      name: "Stories",
      source: { type: "webhook", webhookId: "wh-1" },
      check: { type: "interval", everyMinutes: 5, anchorAt: now },
      action: { type: "record" },
    });
    const routines = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => now,
      botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }),
      startTurn: async (_bot, _thread, prompt) => { started.push(prompt); },
      watchHasUnconsumedMatches: (watchId, consumerId) => watches.hasUnconsumedMatches(watchId, consumerId),
      watchConsumeMatches: (watchId, consumerId) => watches.consumeMatches(watchId, consumerId),
      onWatchUnchanged: (watchId) => watches.recordUnchanged(watchId),
    });
    const routine = routines.create({
      name: "Triage",
      prompt: "Triage new stories",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: now },
      onlyIfChanged: watch.id,
    });
    now = routine.nextRunAt!;
    await routines.tick();
    expect(started).toEqual([]);
    expect(watches.get(watch.id)?.stats.runsAvoided).toBe(1);

    await watches.ingestWebhook({
      webhookId: "wh-1",
      deliveryId: "story-1",
      payload: change({ id: "story-1" }),
    });
    now = routines.listRoutines()[0]!.nextRunAt!;
    await routines.tick();
    expect(started).toEqual(["Triage new stories"]);

    now = routines.listRoutines()[0]!.nextRunAt!;
    await routines.tick();
    expect(started).toHaveLength(1);
  });

  it("clears onlyIfChanged on update when the patch sends null", () => {
    const dir = tempDir();
    const routines = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => 1,
      botState: () => "ready",
      createTask: () => ({ threadId: "t" }),
      startTurn: async () => {},
    });
    const routine = routines.create({
      name: "Triage",
      prompt: "Triage",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      onlyIfChanged: "watch-1",
    });
    expect(routines.update(routine.id, { onlyIfChanged: null })?.onlyIfChanged).toBeUndefined();
  });
});

describe("watch backups", () => {
  it("exports run_routine by name, resets startFrom, and remaps on import without cursors", async () => {
    const dir = tempDir();
    let heads = { "refs/heads/main": "a".repeat(40) };
    const source = new WatchManager({
      file: join(dir, "from.json"),
      now: () => 9_000,
      execGit: async () => gitHeads(heads),
    });
    const watch = source.create({
      name: "New stories",
      source: { type: "git", remote: "/tmp/repo.git" },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "run_routine", routineId: "r-old" },
    });
    await source.check(watch.id);
    heads = { "refs/heads/main": "b".repeat(40) };
    await source.check(watch.id);
    expect(source.get(watch.id)?.stats.matches).toBe(1);
    const portable = source.exportForBackup((id) => id === "r-old" ? "Daily" : undefined);
    expect(portable[0]).toMatchObject({
      name: "New stories",
      startFrom: "now",
      action: { type: "run_routine", routineName: "Daily" },
    });
    const document = parseTeamBackup({
      format: "openmaus.backup", version: 1, name: "Watches", exportedAt: 1,
      bots: [{
        key: "bot-1", name: "Mira", title: "", description: "", color: "green",
        chiefOfStaff: false, hidden: false, playbooks: [],
        activeTask: "main", tasks: [{ key: "main", title: "Chat", createdAt: 1, activeLeafId: null, messages: [] }],
      }],
      groups: [],
      routines: [{
        name: "Daily", prompt: "Report", target: "bot", botId: "bot-1",
        runOn: "maus", schedule: { type: "interval", everyMinutes: 5, anchorAt: 0 },
        durationMinutes: 30, onlyIfChanged: "New stories",
      }],
      watches: portable,
    });
    expect(document.watches?.[0]?.action).toEqual({ type: "run_routine", routineName: "Daily" });
    const dest = new WatchManager({ file: join(dir, "to.json"), now: () => 9_000 });
    const imported = dest.importPortable(document.watches ?? [], (name) => name === "Daily" ? "r-new" : undefined);
    expect(imported[0].id).not.toBe(watch.id);
    expect(imported[0].action).toEqual({ type: "run_routine", routineId: "r-new" });
    expect(imported[0].stats).toMatchObject({ checks: 0, matches: 0, actions: 0 });
    expect(imported[0].startFrom).toBe("now");
  });
});

describe("run_routine through RoutineManager", () => {
  it("enqueues a watch-triggered run with interpolated changes and dedupes the delivery", async () => {
    const dir = tempDir();
    const started: string[] = [];
    const routines = new RoutineManager({
      file: join(dir, "routines.json"),
      now: () => 5_000,
      botState: () => "ready",
      createTask: () => ({ threadId: "thread-1" }),
      startTurn: async (_bot, _thread, prompt) => { started.push(prompt); },
    });
    const routine = routines.create({
      name: "Triage",
      prompt: "Triage:\n{{changes}}",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      enabled: false,
    });
    const watches = new WatchManager({
      file: join(dir, "watches.json"),
      now: () => 5_000,
      routine: (id) => routines.listRoutines().find((item) => item.id === id) ?? null,
      enqueueRoutine: (input) => routines.enqueueWatch(input),
    });
    watches.create({
      name: "Hook",
      source: { type: "webhook", webhookId: "wh-1", fieldMap: { id: "$.id", type: "$.type", title: "$.title", externalId: "$.id" } },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "run_routine", routineId: routine.id },
    });
    await watches.ingestWebhook({
      webhookId: "wh-1",
      deliveryId: "PAY-140",
      payload: { id: "PAY-140", type: "item.created", title: "Ready stories" },
    });
    await routines.tick();
    expect(started[0]).toContain("item.created Ready stories (PAY-140)");
    expect(routines.listRuns()[0]).toMatchObject({ triggerSource: "watch", watchId: watches.list()[0]!.id });
    const again = routines.enqueueWatch({
      watchId: watches.list()[0]!.id,
      watchName: "Hook",
      routineId: routine.id,
      routineName: "Triage",
      prompt: "again",
      botId: "maus-1",
      runOn: "maus",
      deliveryId: routines.listRuns()[0]!.deliveryId!,
      receivedAt: 5_000,
    });
    expect(again.id).toBe(routines.listRuns()[0]!.id);
  });
});
