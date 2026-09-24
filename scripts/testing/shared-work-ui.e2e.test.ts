import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { runControlOmb } from "../control-omb.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { sessionEnv, type UiHandle } from "./control-omb-ui.ts";
import { REPO_ROOT } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";
const evidenceDir = join(REPO_ROOT, ".omb-scratch", "verify-evidence", "shared-work");

(enabled ? it : it.skip)("groups a shared hub and its exact worker under a distinct topic folder with tool calls hidden", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "omb-shared-work-ui-"));
  const planPath = join(temporary, "plan.json");
  writeFileSync(planPath, "{}");
  const child = spawn(process.execPath, ["--experimental-strip-types", "scripts/control-omb.ts", "ui", "launch"], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, FAKE_CLAUDE_ROOM_PLAN: planPath }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); });
  child.stderr.on("data", chunk => { errors += String(chunk); });
  child.on("error", error => { errors += error.message; });
  let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string };
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors);
      try { info = JSON.parse(output); return Boolean(info.ui); } catch { return false; }
    }, { timeout: 180_000 }).toBe(true);
    const api = async (path: string, body?: unknown, method = "POST") => {
      const response = await fetch(info.url + path, body === undefined ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(result));
      return result;
    };
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info.ui, ...args]) as Promise<any>;
    mkdirSync(evidenceDir, { recursive: true });
    const screenshot = (name: string) => ui("screenshot", "--out", join(evidenceDir, name + ".png"));
    const viewport = async (width: number, height: number) => {
      const handle = JSON.parse(readFileSync(info.ui, "utf8")) as UiHandle;
      const { stdout } = await promisify(execFile)(handle.binary, ["set", "viewport", String(width), String(height), "--json"], { env: sessionEnv(handle), timeout: 10_000 });
      expect(JSON.parse(stdout).success).toBe(true);
    };
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const click = async (name: string) => {
      const refs = (await ui("snapshot")).refs as Record<string, { role: string; name: string }>;
      const found = Object.entries(refs).find(([, ref]) => ref.role === "button" && ref.name.endsWith(name));
      expect(found, name).toBeDefined();
      await ui("click", "--ref", "@" + found![0]);
    };
    const engineer = (await api("/api/bots", { name: "Engineer", section: "" })).bot;
    await api(`/api/bots/${info!.botId}`, { chiefOfStaff: true }, "PATCH");
    const gate = join(temporary, "finish-worker");
    writeFileSync(planPath, JSON.stringify({
      [info!.botId]: { turns: [
        { steps: [{ tool: "ensure_work_item", arguments: { topic: "Payments", identity: "fixture:refund", title: "Refund correction", objective: "Fix refunds", acceptance_criteria: ["Boundary cases checked"] } }], reply: "Shared task opened" },
        { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "implement", message: "Implement and check the refund correction" } }], reply: "Assigned" },
        { steps: [{ tool: "update_work_item", arguments: { work_item_id: "$current", expected_revision: "$current", status: "completed", detail: "Refund correction checked", evidence: ["Worker result: boundary cases checked"], completed_criteria: "$current" } }], reply: "Refund correction checked" },
      ] },
      [engineer.id]: { gateFile: gate, reply: "Refund boundary cases checked in the linked worker thread" },
    }));
    await ui("flag", "--set", "features.showToolCalls=false");
    await screenshot("before-task");
    await ui("type", "--name", "Message Pepper", "--text", "Have Engineer fix and check refunds");
    await ui("press", "--keys", "Enter");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Started shared task: Refund correction");
    await click("Started shared task: Refund correction");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Shared task summary");
    expect(await snapshot()).toContain("Stop shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems[0]?.assignments[0]?.status, { timeout: 25_000 }).toBe("running");
    const item = (await api("/api/work-items")).workItems[0];
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Work topic");
    await click("Open Engineer's work on Refund correction");
    await expect.poll(async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === engineer.id)?.threadId, { timeout: 15_000 }).toBe(item.assignments[0].threadId);
    const workerLocation = () => ui("eval", "--js", `(() => { const rows = [...document.querySelectorAll('[data-sidebar-thread-row="${item.assignments[0].threadId}"]')]; return { count: rows.length, topic: rows[0]?.closest('[data-work-topic]')?.getAttribute('data-work-topic'), current: rows[0]?.getAttribute('aria-current') }; })()`);
    await expect.poll(workerLocation, { timeout: 10_000 }).toMatchObject({ result: { count: 1, topic: item.groupId, current: "page" } });
    const groupedWorker = await workerLocation();
    await screenshot("topic-worker");
    await click("Open shared chat for Refund correction");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Shared task summary");
    writeFileSync(gate, "finish the isolated worker");
    await expect.poll(async () => (await api("/api/work-items")).workItems[0]?.status, { timeout: 25_000 }).toBe("completed");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await screenshot("shared-task");
    const dimensions = (await ui("eval", "--js", "({ width: innerWidth, height: innerHeight })")).result;
    await viewport(390, 844);
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('aside[data-sidebar]').getBoundingClientRect().right")).result,
      { timeout: 5_000 }).toBeLessThanOrEqual(0);
    await screenshot("shared-task-mobile");
    const mobileLayout = (await ui("eval", "--js", `({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('body *')].filter(element => { const box = element.getBoundingClientRect(); return box.width && box.right > innerWidth; })
        .slice(0, 35).map(element => ({ tag: element.tagName, className: element.className, label: element.getAttribute('aria-label'), text: element.textContent?.slice(0, 80), right: element.getBoundingClientRect().right })) })`)).result;
    writeFileSync(join(evidenceDir, "mobile-layout.json"), JSON.stringify(mobileLayout, null, 2));
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.width);
    await viewport(dimensions.width, dimensions.height);
    const beforeWorker = await ui("snapshot");
    writeFileSync(info!.logPath + ".shared-task.before-worker.json", JSON.stringify(beforeWorker, null, 2));
    const refs = beforeWorker.refs as Record<string, { role: string; name: string }>;
    const disclosure = Object.entries(refs).find(([, ref]) => ref.name.includes("Specialist work (1)"));
    expect(disclosure, "Specialist work disclosure").toBeDefined();
    await ui("click", "--ref", "@" + disclosure![0]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Open Engineer's task work");
    await click("Open Engineer's task work");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Refund boundary cases checked in the linked worker thread");
    const selected = (await api("/api/bots")).bots.find((bot: any) => bot.id === engineer.id);
    expect(selected.threadId).toBe(item.assignments[0].threadId);
    const settled = (await api("/api/work-items")).workItems[0];
    // Reopening a settled task creates a new revision. Hold that coordinator
    // in the disposable engine so Stop is tested while it really runs.
    const coordinatorStarted = join(temporary, "coordinator-started");
    writeFileSync(planPath, JSON.stringify({ [info!.botId]: { gateFile: join(temporary, "reopened-coordinator"), gateEnteredFile: coordinatorStarted, reply: "Reopened task" } }));
    await click("Open shared chat for Refund correction");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await click("Reopen shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems[0], { timeout: 15_000 }).toMatchObject({ status: "active", revision: 2 });
    await expect.poll(() => JSON.parse(readFileSync(join(info.dataDir, "room-handoffs.json"), "utf8"))
      .some((node: any) => node.workItemId === item.id && node.workRevision === 2 && node.status === "running"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => existsSync(coordinatorStarted), { timeout: 15_000 }).toBe(true);
    await click("Stop shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems[0]?.status, { timeout: 15_000 }).toBe("cancelled");
    await expect.poll(async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === info.botId)?.busy,
      { timeout: 15_000 }).toBe(false);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await expect.poll(snapshot, { timeout: 10_000 }).not.toContain("Pepper is working");
    await screenshot("stopped-task");
    const consoleOutput = await ui("console");
    expect(consoleOutput.messages.filter((message: any) => message.type === "error")).toEqual([]);
    const evidencePath = join(evidenceDir, "shared-task.json");
    writeFileSync(evidencePath, JSON.stringify({ fixture: info!, item: settled, stopped: (await api("/api/work-items")).workItems[0], groupedWorker, selectedThread: selected.threadId, snapshot: await snapshot() }, null, 2));
    console.log("Shared task UI evidence:", evidencePath);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temporary);
  }
}, 240_000);
