import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { Bot } from "../../src/state/store.ts";
import type { WorkItem } from "../../shared/work-item.ts";
import { compactTaskRowModel, matchesSidebarWorkFilter } from "../../src/lib/shared-work-sidebar.ts";
import { runControlOmb } from "../control-omb.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { sessionEnv, type UiHandle } from "./control-omb-ui.ts";
import { REPO_ROOT } from "./preview-fixture.ts";

const enabled = process.env.OMB_UI_E2E === "1";
const evidenceDir = join(REPO_ROOT, ".omb-scratch", "verify-evidence", "shared-work");

it("keeps 10+ tasks across 3 topics as compact unexpanded rows", () => {
  const bots: Bot[] = [{
    id: "chief", name: "Manager", threadId: "chief-chat", title: "", description: "", color: "blue",
    notifications: true, unread: false, modelSelection: { instanceId: "fake", model: "fake" }, messages: [], tasks: [],
  }];
  const rows = ["payments", "onboarding", "pricing"].flatMap((topic) =>
    [0, 1, 2, 3].map((index) => {
      const item: WorkItem = {
        id: `${topic}-${index}`, groupId: topic, threadId: `hub-${topic}-${index}`, title: `${topic} ${index + 1}`,
        objective: "Scan", acceptanceCriteria: ["Done"], coordinatorBotId: "chief", revision: 1,
        status: index === 2 ? "completed" : index === 1 ? "needs-input" : "active", detail: "", decisions: [],
        artifacts: [], evidence: [], assignments: [], createdAt: 1, updatedAt: 2,
        links: [{ id: `${topic}-${index}-src`, kind: "work_item", role: "source", title: topic, externalId: `${topic.slice(0, 3).toUpperCase()}-${index}`,
          provenance: "synced", updatedAt: 2 }],
        criteria: [{ id: "c1", text: "Done", state: index === 2 ? "checked" : "pending", evidence: [] }],
      };
      return compactTaskRowModel(item, bots, false);
    }));
  expect(rows).toHaveLength(12);
  expect(new Set(rows.map(row => row.groupId)).size).toBe(3);
  expect(rows.every(row => row.expanded === false && row.liveStep === undefined)).toBe(true);
  expect(rows.filter(row => matchesSidebarWorkFilter({
    id: row.id, groupId: row.groupId, threadId: `hub-${row.id}`, title: row.id, objective: "", acceptanceCriteria: ["x"],
    coordinatorBotId: "chief", revision: 1, status: row.status, detail: "", decisions: [], artifacts: [], evidence: [],
    assignments: [], createdAt: 1, updatedAt: 2,
  }, bots, "needs_you"))).toHaveLength(3);
  expect(rows.some(row => row.key && row.criteria.total === 1)).toBe(true);
});

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
      const candidates = Object.entries(refs).filter(([, ref]) => ref.role === "button" || ref.role === "menuitem");
      const found = candidates.find(([, ref]) => ref.name === name) ?? candidates.find(([, ref]) => ref.name.endsWith(name));
      expect(found, name).toBeDefined();
      await ui("click", "--ref", "@" + found![0]);
    };
    const engineer = (await api("/api/bots", { name: "Engineer", section: "" })).bot;
    await api(`/api/bots/${info!.botId}`, { chiefOfStaff: true }, "PATCH");
    await api("/api/sidebar-sections", { name: "Crux", botIds: [info!.botId, engineer.id] });
    await api("/api/sidebar-sections", { name: "Operations" });
    await api("/api/bots", { name: "Ops Beacon", section: "Operations" });
    await expect.poll(async () => (await ui("eval", "--js", `Boolean(document.querySelector('[data-sidebar-section-id="section:Crux"] [data-sidebar-bot-row="${info!.botId}"]'))`)).result, { timeout: 10_000 }).toBe(true);
    await click("Actions for Pepper");
    await click("Pin");
    writeFileSync(info!.logPath + ".after-pin.json", JSON.stringify(await ui("snapshot"), null, 2));
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('[data-chief-hero]')?.getAttribute('data-chief-hero')")).result).toBe(info!.botId);
    await expect.poll(async () => (await ui("eval", "--js", "(() => { const action = document.querySelector('[data-chief-hero] button[aria-label=\"Actions for Pepper\"]'); if (action) action.click(); return Boolean(action); })()")).result).toBe(true);
    await click("Unpin");
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('[data-chief-hero]') === null")).result).toBe(true);
    await expect.poll(async () => (await ui("eval", "--js", "(() => { const action = document.querySelector('[data-sidebar-section-id=\"section:Crux\"] button[aria-label=\"Actions for Pepper\"]'); if (action) action.click(); return Boolean(action); })()")).result).toBe(true);
    await click("Pin");
    await ui("eval", "--js", "document.querySelector('[data-section=\"Crux\"] > button').click()");
    expect((await ui("eval", "--js", "document.querySelector('[data-section=\"Crux\"] [aria-label*=\"Chief of Staff\"]') !== null")).result).toBe(true);
    await ui("eval", "--js", "document.querySelector('[data-section=\"Crux\"] > button').click()");
    const gate = join(temporary, "finish-worker");
    writeFileSync(planPath, JSON.stringify({
      [info!.botId]: { turns: [
        { steps: [{ tool: "ensure_work_item", arguments: { topic: "Payments", identity: "fixture:refund", title: "Refund correction", objective: "Fix refunds", acceptance_criteria: ["Boundary cases checked"] } }], reply: "Shared task opened" },
        { steps: [{ arguments: { intent: "work", bot_ids: [engineer.id], request_key: "implement", message: "Implement and check the refund correction" } }], reply: "Assigned" },
        { steps: [{ tool: "update_work_item", arguments: { work_item_id: "$current", expected_revision: "$current", status: "completed", detail: "Refund correction checked", evidence: ["Worker result: boundary cases checked"], completed_criteria: "$current" } }], reply: "Refund correction checked" },
      ] },
      [engineer.id]: { gateFile: gate, progress: "Check refund boundary cases, then confirm.",
        shell: { command: "git commit", output: "[fix-refunds abc123] Refund boundaries" },
        reply: "Refund boundary cases checked in the linked worker thread" },
    }));
    await ui("flag", "--set", "features.showToolCalls=false");
    await screenshot("before-task");
    await ui("type", "--name", "Message Pepper", "--text", "Have Engineer fix and check refunds");
    await ui("press", "--keys", "Enter");
    await expect.poll(snapshot, { timeout: 20_000 }).toContain("Started shared task: Refund correction");
    await click("Started shared task: Refund correction");
    await click("Chat");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Shared task summary");
    expect(await snapshot()).toContain("Stop shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems[0]?.assignments[0]?.status, { timeout: 25_000 }).toBe("running");
    const item = (await api("/api/work-items")).workItems[0];
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Work topic");
    expect((await ui("eval", "--js", "document.querySelector('[data-sidebar-task-row]') === null")).result).toBe(true);
    await click("Browse Payments tasks");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Filter Payments tasks");
    const compactRow = await ui("eval", "--js", `(() => { const row = document.querySelector('[data-sidebar-navigator] [data-sidebar-task-row]'); return { id: row?.getAttribute('data-sidebar-task-row'), tree: row?.getAttribute('data-work-item-tree') }; })()`);
    await screenshot("topic-panel");
    expect((await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(1);
    expect(compactRow.result.tree).toBeNull();
    await click("Done");
    expect((await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(0);
    await click("All");
    expect((await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(1);
    const desktopWidth = (await ui("eval", "--js", "innerWidth")).result;
    await viewport(1440, 900);
    const docked = (await ui("eval", "--js", `(() => { const nav = document.querySelector('[data-sidebar-navigator]').getBoundingClientRect(); const sidebar = document.querySelector('[data-sidebar]').getBoundingClientRect(); return { left: nav.left, width: nav.width, sidebarRight: sidebar.right }; })()`)).result;
    expect(docked.width).toBeGreaterThanOrEqual(310);
    expect(docked.width).toBeLessThanOrEqual(330);
    expect(Math.abs(docked.left - docked.sidebarRight)).toBeLessThan(6);
    await screenshot("topic-panel-docked");
    await viewport(desktopWidth, 900);
    await ui("press", "--keys", "Escape");
    expect((await ui("eval", "--js", "document.querySelector('[data-sidebar-navigator]') === null")).result).toBe(true);
    expect((await ui("eval", "--js", "document.activeElement?.getAttribute('aria-label')")).result).toBe("Browse Payments tasks");
    await click("Browse Payments tasks");
    await ui("eval", "--js", "document.querySelector('main').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    expect((await ui("eval", "--js", "document.querySelector('[data-sidebar-navigator]') === null")).result).toBe(true);
    await click("Browse Payments tasks");
    await ui("eval", "--js", `document.querySelector('[data-sidebar-navigator] [data-sidebar-task-row="${item.id}"]').click()`);
    expect((await ui("eval", "--js", "document.querySelector('[data-sidebar-navigator]') === null")).result).toBe(true);
    await expect.poll(async () => (await ui("eval", "--js", "Boolean(document.activeElement?.closest('main'))")).result, { timeout: 5_000 }).toBe(true);
    await click("Chat");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Shared task summary");
    const groupedWorker = (await ui("eval", "--js", `document.querySelectorAll('[data-sidebar-thread-row="${item.assignments[0].threadId}"]').length`)).result;
    expect(groupedWorker).toBe(0);
    await screenshot("topic-navigator");
    writeFileSync(gate, "finish the isolated worker");
    await expect.poll(async () => (await api("/api/work-items")).workItems.find((candidate: any) => candidate.id === item.id)?.status, { timeout: 25_000 }).toBe("completed");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await api("/api/work-items/ensure", { coordinatorBotId: info!.botId, topic: "Payments", identity: "fixture:follow-up", title: "Follow-up review", objective: "Review findings", acceptanceCriteria: ["Findings reviewed"] });
    await expect.poll(async () => (await api("/api/work-items")).workItems.length).toBe(2);
    await screenshot("shared-task");
    const dimensions = (await ui("eval", "--js", "({ width: innerWidth, height: innerHeight })")).result;
    await viewport(1440, 900);
    await click("Browse Payments tasks");
    expect((await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(2);
    await ui("type", "--name", "Filter Payments tasks", "--text", "Follow-up");
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(1);
    await ui("press", "--keys", "Escape");
    await viewport(390, 844);
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('aside[data-sidebar]').getBoundingClientRect().right")).result,
      { timeout: 5_000 }).toBeLessThanOrEqual(4);
    await click("Open bot list");
    await expect.poll(async () => (await ui("eval", "--js", "Math.abs(document.querySelector('aside[data-sidebar]').getBoundingClientRect().left) < 1")).result, { timeout: 5_000 }).toBe(true);
    await click("Browse Payments tasks");
    expect((await ui("eval", "--js", "document.querySelectorAll('[data-sidebar-navigator] [data-sidebar-task-row]').length")).result).toBe(2);
    await expect.poll(async () => (await ui("eval", "--js", "Math.abs(document.querySelector('[data-sidebar-navigator]').getBoundingClientRect().left) < 1")).result, { timeout: 5_000 }).toBe(true);
    const mobileNav = (await ui("eval", "--js", "(() => { const nav = document.querySelector('[data-sidebar-navigator]').getBoundingClientRect(); return { left: nav.left, width: nav.width }; })()")).result;
    expect(mobileNav.left).toBe(0);
    expect(mobileNav.width).toBe(390);
    await screenshot("topic-panel-mobile");
    await click("Back to sidebar from Payments");
    expect((await ui("eval", "--js", "document.activeElement?.getAttribute('aria-label')")).result).toBe("Browse Payments tasks");
    await ui("press", "--keys", "Escape");
    await expect.poll(async () => (await ui("eval", "--js", "document.querySelector('aside[data-sidebar]').getBoundingClientRect().right <= 4")).result, { timeout: 5_000 }).toBe(true);
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
    const disclosure = Object.entries(refs).find(([, ref]) => ref.name.includes("Specialists (1)"));
    expect(disclosure, "Specialists disclosure").toBeDefined();
    await ui("click", "--ref", "@" + disclosure![0]);
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("Open Engineer's work");
    await click("Open Engineer's work");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Refund boundary cases checked in the linked worker thread");
    await expect.poll(snapshot, { timeout: 10_000 }).toContain("This turn");
    expect(await snapshot()).toContain("Check refund boundary cases, then confirm.");
    expect(await snapshot()).toContain("Raw reply");
    expect(await snapshot()).toContain("Tool log");
    const turnCard = await ui("eval", "--js", `(() => { const card = document.querySelector('[data-bot-turn]'); return { present: Boolean(card), plan: Boolean(card?.querySelector('[data-bot-turn-plan]')), steps: Boolean(card?.querySelector('[data-bot-turn-steps]')) }; })()`);
    expect(turnCard.result).toMatchObject({ present: true, plan: true, steps: true });
    const selected = (await api("/api/bots")).bots.find((bot: any) => bot.id === engineer.id);
    expect(selected.threadId).toBe(item.assignments[0].threadId);
    const settled = (await api("/api/work-items")).workItems.find((candidate: any) => candidate.id === item.id);
    // Reopening a settled task creates a new revision. Hold that coordinator
    // in the disposable engine so Stop is tested while it really runs.
    const coordinatorStarted = join(temporary, "coordinator-started");
    writeFileSync(planPath, JSON.stringify({ [info!.botId]: { gateFile: join(temporary, "reopened-coordinator"), gateEnteredFile: coordinatorStarted, reply: "Reopened task" } }));
    await click("Browse Payments tasks");
    await ui("eval", "--js", `document.querySelector('[data-sidebar-navigator] [data-sidebar-task-row="${item.id}"]').click()`);
    await click("Chat");
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await click("Reopen shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems.find((candidate: any) => candidate.id === item.id), { timeout: 15_000 }).toMatchObject({ status: "active", revision: 2 });
    await expect.poll(() => JSON.parse(readFileSync(join(info.dataDir, "room-handoffs.json"), "utf8"))
      .some((node: any) => node.workItemId === item.id && node.workRevision === 2 && node.status === "running"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => existsSync(coordinatorStarted), { timeout: 15_000 }).toBe(true);
    await click("Stop shared task");
    await expect.poll(async () => (await api("/api/work-items")).workItems.find((candidate: any) => candidate.id === item.id)?.status, { timeout: 15_000 }).toBe("cancelled");
    await expect.poll(async () => (await api("/api/bots")).bots.find((bot: any) => bot.id === info.botId)?.busy,
      { timeout: 15_000 }).toBe(false);
    await expect.poll(snapshot, { timeout: 15_000 }).toContain("Reopen shared task");
    await expect.poll(snapshot, { timeout: 10_000 }).not.toContain("Pepper is working");
    await screenshot("stopped-task");
    const consoleOutput = await ui("console");
    expect(consoleOutput.messages.filter((message: any) => message.type === "error")).toEqual([]);
    const evidencePath = join(evidenceDir, "shared-task.json");
    writeFileSync(evidencePath, JSON.stringify({ fixture: info!, item: settled, stopped: (await api("/api/work-items")).workItems.find((candidate: any) => candidate.id === item.id), groupedWorker, selectedThread: selected.threadId, snapshot: await snapshot() }, null, 2));
    console.log("Shared task UI evidence:", evidencePath);
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temporary);
  }
}, 240_000);
