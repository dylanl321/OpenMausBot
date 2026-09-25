import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";
import { UI_TOOLS_DIR } from "./control-omb-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = Boolean(binary) || process.env.OMB_UI_E2E === "1";
if (!enabled) console.log("skipping Setup Guide UI: set OMB_UI_E2E=1 for the pinned browser");

(enabled ? it : it.skip)("interviews and revises in the real renderer, traps focus and leaves manual and template flows reachable", async () => {
  const temp = mkdtempSync(join(tmpdir(), "omb-setup-guide-ui-"));
  const replyFile = join(temp, "guide-reply.json");
  let child: ChildProcess | undefined;
  let info: { ui: string; url: string; botId: string; logPath: string } | undefined;
  try {
    let stdout = "", stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
      cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_TEXT_FILE: replyFile }, stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => { stdout += String(chunk); });
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.on("error", error => { stderr += String(error); });
    await expect.poll(() => {
      if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`UI launch failed: ${stderr}`);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: binary ? 180_000 : 600_000, interval: 250 }).toBe(true);
    const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
    const click = async (name: string) => {
      try { return await ui("click", "--name", name); }
      catch (cause) { throw new Error(`Click ${name}: ${String(cause)}\n${(await ui("snapshot")).snapshot}`); }
    };
    const type = (name: string, value: string) => ui("type", "--name", name, "--text", value);
    const press = (keys: string) => ui("press", "--keys", keys);
    const evalInPage = async (source: string) => (await ui("eval", "--js", source)).result;
    const snapshot = async () => (await ui("snapshot")).snapshot as string;
    const api = async (path: string) => (await fetch(info!.url + path).then(response => response.json())) as any;
    const initial = (await api("/api/bots?messages=0")).bots;
    const options = await api("/api/setup-wizard/options");
    const model = options.engines.find((engine: any) => engine.instanceId === "claude")?.models.find((item: any) => item.coordination);
    expect(model?.model).toBeTruthy();
    const selection = { instanceId: model.instanceId, model: model.model };
    const makeReply = (leadName: string, soul: string) => ({ kind: "draft", teamName: "", teamBrief: "",
      bots: [{ key: "lead", name: leadName, title: "Lead", description: "Research lead", soul,
        modelSelection: selection, appHints: ["calendar"] },
      { key: "check", name: "Proof", title: "Reviewer", description: "Checks claims", soul: "Verify the evidence.",
        modelSelection: selection, appHints: [] }], chiefKey: null });

    // The network failure is scoped to this browser's community-catalog
    // request. It must not turn off bundled teams or manual creation.
    await evalInPage(`(() => { const original = window.fetch.bind(window); window.setupGuideOriginalFetch = original; window.fetch = (input, init) =>
      String(input) === '/api/team-library/catalog'
        ? Promise.resolve(new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'content-type': 'application/json' } }))
        : original(input, init); return true; })()`);
    await press("Control+n");
    await expect.poll(snapshot, { timeout: 12_000 }).toContain("Set up with AI");
    await click("Set up with AI");
    await expect.poll(snapshot).toContain('dialog "Setup Guide"');
    await expect.poll(snapshot).toContain("Community catalog is unavailable");
    await expect.poll(() => evalInPage("[...document.querySelectorAll('[aria-labelledby=setup-guide-title] select')].at(-1)?.value"), { timeout: 12_000 })
      .toBe("claude");
    expect(await snapshot()).toContain("Research desk");
    await press("Escape");
    await expect.poll(snapshot).not.toContain('dialog "Setup Guide"');
    expect(await evalInPage("document.activeElement?.textContent.trim()")).toBe("Set up with AI");
    await click("Set up with AI");
    await type("What should the bot or team help you do?", "Research markets with verified sources.");
    await expect.poll(() => evalInPage("[...document.querySelectorAll('[aria-labelledby=setup-guide-title] select')].at(-1)?.value"), { timeout: 12_000 })
      .toBe("claude");
    writeFileSync(replyFile, "__FAIL__");
    await click("Draft setup");
    await expect.poll(snapshot).toContain("fake one-shot text failed");
    expect((await api("/api/bots?messages=0")).bots).toHaveLength(initial.length);

    writeFileSync(replyFile, JSON.stringify({ kind: "questions", questions: ["What sources matter?"] }));
    await click("Draft setup");
    await expect.poll(snapshot).toContain("What sources matter?");
    expect(await evalInPage("document.activeElement.closest('label')?.textContent.trim()"))
      .toContain("What sources matter?");
    await type("What sources matter?", "Primary sources");
    writeFileSync(replyFile, JSON.stringify({ kind: "questions", questions: ["How often should it report?"] }));
    await click("Continue");
    await expect.poll(snapshot).toContain("How often should it report?");
    expect(await evalInPage("document.activeElement.closest('label')?.textContent.trim()"))
      .toContain("How often should it report?");
    await type("How often should it report?", "Weekly");
    writeFileSync(replyFile, JSON.stringify(makeReply("Beacon", "Write a clear market brief.")));
    await click("Continue");
    await expect.poll(snapshot).toContain("Review your draft");
    expect((await api("/api/bots?messages=0")).bots).toHaveLength(initial.length);

    await evalInPage(`(() => { const input = document.querySelector('[aria-label="Bot 1"] input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'My Beacon'); input.dispatchEvent(new Event('input', { bubbles: true })); return input.value; })()`);
    await expect.poll(snapshot).toContain("My Beacon");
    await type("Ask for a revision", "Make the lead's instructions shorter.");
    writeFileSync(replyFile, JSON.stringify(makeReply("Suggested Lead", "Summarize evidence briefly.")));
    await click("Propose revision");
    await expect.poll(snapshot).toContain("Proposed revision ready for review");
    await click("Apply revision");
    expect(await evalInPage("document.querySelector('[aria-label=\"Bot 1\"] input')?.value")).toBe("My Beacon");
    expect(await evalInPage("[...document.querySelectorAll('[aria-label=\"Bot 1\"] textarea')].at(-1)?.value"))
      .toBe("Summarize evidence briefly.");
    const otherModel = options.modelEngines.find((engine: any) => engine.instanceId === "claude")?.models
      .find((item: any) => item.model !== selection.model);
    expect(otherModel?.model).toBeTruthy();
    await evalInPage(`(() => { const select = document.querySelector('[aria-label="Proof model"]');
      const option = [...select.options].find(entry => entry.value === ${JSON.stringify(`${otherModel.instanceId}\u0000${otherModel.model}`)});
      if (!option) throw new Error('Exact model choice is missing from the picker');
      select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; })()`);
    await evalInPage(`(() => { const select = [...document.querySelectorAll('label')]
      .find(node => node.textContent.includes('Admin-web visibility'))?.querySelector('select');
      select.value = 'admins'; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; })()`);
    await evalInPage("document.querySelector('[aria-label=\"Close Setup Guide\"]').focus(); true");
    await press("Shift+Tab");
    expect(await evalInPage("document.activeElement.closest('[role=dialog]')?.getAttribute('aria-labelledby')"))
      .toBe("setup-guide-title");
    expect(await evalInPage("document.activeElement.textContent.trim()")).toContain("Create 2 bots");
    const screenshot = join(ROOT, ".omb-scratch", "verify-evidence", "setup-wizard-review.png");
    await ui("screenshot", "--out", screenshot);
    await click("Create 2 bots");
    await expect.poll(async () => (await api("/api/bots?messages=0")).bots.length, { timeout: 15_000 }).toBe(initial.length + 2);
    const created = (await api("/api/bots?messages=0")).bots.filter((bot: any) => !initial.some((older: any) => older.id === bot.id));
    expect(created.map((bot: any) => bot.name).sort()).toEqual(["My Beacon", "Proof"]);
    expect(created.find((bot: any) => bot.name === "Proof").modelSelection).toMatchObject({ instanceId: otherModel.instanceId, model: otherModel.model });
    expect(created.every((bot: any) => bot.visibility === "admins" && bot.approvalMode === "ask")).toBe(true);
    expect(created.filter((bot: any) => bot.chiefOfStaff)).toHaveLength(1);
    await expect.poll(snapshot).not.toContain('dialog "Setup Guide"');
    await expect.poll(snapshot).not.toContain('dialog "New Bot"');

    // The other entry points remain available. Escape from the Team dialog's
    // guide returns to that dialog; Templates still has its direct Load path.
    await click("New or share");
    await click("Create team");
    await expect.poll(snapshot).toContain("Set up with AI");
    await click("Set up with AI");
    await expect.poll(snapshot).toContain('dialog "Setup Guide"');
    await press("Escape");
    await expect.poll(snapshot).toContain('dialog "Create team"');
    expect(await evalInPage("document.activeElement?.textContent.trim()")).toBe("Set up with AI");
    expect((await api("/api/bots?messages=0")).bots).toHaveLength(initial.length + 2);
    await press("Escape");
    await click("New or share");
    await click("Templates");
    await expect.poll(snapshot).toContain("Describe a team with Setup Guide");
    expect(await snapshot()).toContain("Import");
    await click("Describe a team with Setup Guide");
    await expect.poll(snapshot).toContain('dialog "Setup Guide"');
    await press("Escape");
    await expect.poll(snapshot).toContain('dialog "Templates"');
    await click("Close templates");

    const teamResponse = await fetch(info!.url + "/api/sidebar-sections", { method: "POST", headers: { "content-type": "application/json", origin: info!.url },
      body: JSON.stringify({ name: "Existing work", botIds: [] }) });
    expect(teamResponse.status).toBe(200);
    await evalInPage("location.reload(); true");
    await expect.poll(snapshot).toContain('button "Existing work"');
    await evalInPage(`(() => { const section = [...document.querySelectorAll('[data-section]')]
      .find(node => node.dataset.section === 'Existing work');
      section.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 250 })); return true; })()`);
    await click("Add bots");
    await expect.poll(snapshot).toContain("Set up with AI");
    await click("Set up with AI");
    expect(await evalInPage("[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelector('select')?.value"))
      .toBe("existing");
    expect(await evalInPage("[...document.querySelectorAll('[role=dialog]')].at(-1)?.querySelectorAll('select')[1]?.value"))
      .toBe("Existing work");
    await press("Escape");
    await expect.poll(snapshot).toContain('dialog "Add bots"');
    await click("Close team dialog");

    const manifest = { format: "openmaus.team", version: 2, team: { name: "Community test", description: "Test a safe persona",
      members: [{ name: "Reader", title: "Source checker", soul: "Cite facts", approvalMode: "full", credentials: "must-not-import" }] } };
    await evalInPage(`(() => { window.setupGuideOriginalFetch = window.fetch.bind(window); window.fetch = (input, init) => {
      const path = String(input);
      const reply = body => Promise.resolve(new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
      if (path === '/api/team-library/catalog') return reply({ repositoryUrl: '', teams: [{ slug: 'community-test', name: 'Community test',
        summary: 'Fixture persona', category: 'Research', members: 1, skills: [], requires: { apps: [] } }] });
      if (path === '/api/team-library/teams/community-test') return reply(${JSON.stringify(manifest)});
      return window.setupGuideOriginalFetch(input, init);
    }; return true; })()`);
    await click("New or share"); await click("Templates");
    await expect.poll(snapshot).toContain('button "Load"');
    await click("Load");
    await expect.poll(snapshot).toContain("Draft with Setup Guide");
    expect(await snapshot()).toContain("Add team");
    await click("Draft with Setup Guide");
    expect(await evalInPage("document.querySelector('[data-guide-goal]')?.value")).toBe("Test a safe persona");
    expect((await api("/api/bots?messages=0")).bots).toHaveLength(initial.length + 2);
    await press("Escape");
    await expect.poll(snapshot).toContain("Add team");
    await click("Close templates");
    console.info(JSON.stringify({ fixture: info, screenshot, before: initial.length, created: created.map((bot: any) => bot.id),
      noPreCommitChanges: true, offlineCatalogFallback: true, focusWrap: true, manualAndTemplateEntryPoints: true,
      existingTeamEntryPoint: true, communityPersonaOnly: true }));
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 });
    await removeTempDir(temp);
    if (info) expect(existsSync(info.ui)).toBe(false);
  }
}, 720_000);
