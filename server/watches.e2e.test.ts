import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RoutineManager } from "./routines.ts";
import { WatchManager } from "./watches.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function bareRepo() {
  const dir = mkdtempSync(join(tmpdir(), "omb-watch-git-"));
  dirs.push(dir);
  const bare = join(dir, "repo.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "--bare", bare]);
  execFileSync("git", ["clone", bare, work]);
  git(work, "config", "user.email", "watch@test");
  git(work, "config", "user.name", "Watch Test");
  writeFileSync(join(work, "README"), "init\n");
  git(work, "add", "README");
  git(work, "commit", "-m", "init");
  git(work, "push", "origin", "HEAD");
  return {
    dir, bare, work,
    push(message: string) {
      writeFileSync(join(work, "README"), `${message}\n`);
      git(work, "add", "README");
      git(work, "commit", "-m", message);
      git(work, "push", "origin", "HEAD");
    },
  };
}

describe("git watch isolated fixture", () => {
  it("runs the routine once per push, never on idle checks, and resumes the cursor", async () => {
    const repo = bareRepo();
    const file = join(repo.dir, "watches.json");
    const routineFile = join(repo.dir, "routines.json");
    let now = 10_000;
    const started: string[] = [];
    const routines = new RoutineManager({
      file: routineFile,
      now: () => now,
      botState: () => "ready",
      createTask: () => ({ threadId: `thread-${started.length + 1}` }),
      startTurn: async (_bot, _thread, prompt) => { started.push(prompt); },
    });
    const routine = routines.create({
      name: "On push",
      prompt: "Review:\n{{changes}}",
      botId: "maus-1",
      schedule: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      enabled: false,
    });
    const options = {
      file,
      now: () => now,
      routine: (id: string) => routines.listRoutines().find((item) => item.id === id) ?? null,
      enqueueRoutine: (input: Parameters<RoutineManager["enqueueWatch"]>[0]) => routines.enqueueWatch(input),
    };
    const watches = new WatchManager(options);
    const watch = watches.create({
      name: "Bare repo",
      source: { type: "git", remote: repo.bare },
      check: { type: "interval", everyMinutes: 5, anchorAt: 0 },
      action: { type: "run_routine", routineId: routine.id },
      startFrom: "now",
    });

    await watches.check(watch.id);
    for (let i = 0; i < 100; i++) await watches.check(watch.id);
    await routines.tick();
    expect(started).toEqual([]);
    expect(watches.get(watch.id)?.stats).toMatchObject({ actions: 0, matches: 0, checks: 101 });

    repo.push("second");
    await watches.check(watch.id);
    await routines.tick();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatch(/commit\.pushed commit /);
    expect(watches.get(watch.id)?.stats.actions).toBe(1);

    const restored = new WatchManager(options);
    await restored.check(watch.id);
    await routines.tick();
    expect(started).toHaveLength(1);

    repo.push("third");
    await restored.check(watch.id);
    await routines.tick();
    expect(started).toHaveLength(2);
    expect(restored.get(watch.id)?.stats.actions).toBe(2);
  });
});
