import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { BEDROCK_FIXTURE_KEY, BEDROCK_FIXTURE_SECRET, BEDROCK_FIXTURE_TOKEN, fakeBedrock } from "../../server/testing/fake-bedrock.ts";
import { runControlOmb } from "../control-omb.ts";
import { REPO_ROOT } from "./preview-fixture.ts";
import { UI_TOOLS_DIR, sessionEnv, type UiHandle } from "./control-omb-ui.ts";

const enabled = process.env.OMB_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
const evidenceDir = join(REPO_ROOT, ".omb-scratch", "verify-evidence", "bedrock");
let child: ChildProcess | undefined;
afterAll(async () => { await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); });

(enabled ? it : it.skip)("lists regional models, saves hidden credentials and policy, rejects stale catalogs, and selects a model in the real UI", async () => {
  const upstream = await fakeBedrock();
  let info: { ui: string; url: string; botId: string; dataDir: string; logPath: string } | undefined;
  const evidence: unknown[] = [];
  mkdirSync(evidenceDir, { recursive: true });
  const ui = (verb: string, ...args: string[]) => runControlOmb(["ui", verb, "--ui", info!.ui, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  const input = (name: string) => `document.querySelector(${JSON.stringify(`[aria-label="${name}"]`)})`;
  const fill = async (name: string, text: string) => {
    await click(name); await evaluate(`${input(name)}.select(); true`);
    await ui("press", "--keys", "Backspace");
    if (text) await ui("type", "--name", name, "--text", text);
  };
  const select = (name: string, value: string) => evaluate(`${input(name)}.value=${JSON.stringify(value)}; ${input(name)}.dispatchEvent(new Event('change', {bubbles:true})); true`);
  const catalog = () => evaluate("document.querySelector('[data-bedrock-catalog]')?.innerText ?? ''");
  const settings = async () => (await fetch(`${info!.url}/api/instances/bedrock/bedrock`).then((response) => response.json())) as any;
  const save = async () => {
    await click("Save");
    await expect.poll(() => evaluate("[...document.querySelectorAll('[data-bedrock-settings] [role=status]')].some(e=>e.textContent.includes('settings saved'))"), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => evaluate("[...document.querySelectorAll('[data-bedrock-settings] button')].some(e=>e.textContent.includes('Saving'))"), { timeout: 15_000 }).toBe(false);
  };
  const load = async () => {
    await click("Test connection / load models");
    await expect.poll(() => evaluate("[...document.querySelectorAll('[data-bedrock-settings] button')].some(e=>e.textContent.includes('Loading models'))"), { timeout: 15_000 }).toBe(false);
  };
  const screenshot = async (name: string) => {
    const path = join(evidenceDir, `${name}.png`);
    await ui("screenshot", "--out", path); evidence.push({ screenshot: path });
  };
  const viewport = async (width: number, height: number) => {
    const handle = JSON.parse(readFileSync(info!.ui, "utf8")) as UiHandle;
    const { stdout } = await promisify(execFile)(handle.binary, ["set", "viewport", String(width), String(height), "--json"], { env: sessionEnv(handle), timeout: 10_000 });
    expect(JSON.parse(stdout).success).toBe(true);
  };
  try {
    let stdout = ""; let stderr = "";
    child = spawn(process.execPath, ["--experimental-strip-types", join(REPO_ROOT, "scripts/control-omb.ts"), "ui", "launch"], { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    await expect.poll(() => {
      if (child!.exitCode !== null) throw new Error(stderr);
      try { info = JSON.parse(stdout); return Boolean(info?.ui); } catch { return false; }
    }, { timeout: 180_000, interval: 250 }).toBe(true);
    evidence.push({ fixture: info });
    for (const name of ["You", "Settings", "Engines"]) await click(name);
    await evaluate("document.querySelector('[data-engine-card=bedrock] summary').click(); true");
    await expect.poll(() => evaluate(`${input("Bedrock token")}.type`)).toBe("password");
    await fill("Bedrock token", BEDROCK_FIXTURE_TOKEN);
    await fill("AWS region", "us-east-1");
    await evaluate("document.querySelector('[data-bedrock-settings] details summary').click(); true");
    await fill("Runtime endpoint override (optional)", upstream.url);
    await fill("Control-plane endpoint override (optional)", upstream.url);
    await load();
    expect(await catalog()).toContain("5 of 5 allowed");
    expect(await catalog()).toContain("Region: us-east-1");
    expect(await catalog()).not.toContain("mistral.mistral-large-2407-v1:0");
    expect(await evaluate("document.querySelector('[data-bedrock-settings]').innerText")).toContain("Unsaved settings");
    expect((await settings()).settings.apiKeyConfigured).toBe(false);

    await click("Allow Anthropic and Claude models");
    expect(await catalog()).toContain("2 of 5 allowed");
    expect(await evaluate(`${input("Allow model opaque-claude")}.disabled`)).toBe(true);
    await click("Allow model amazon.nova-lite-v1:0");
    expect(await catalog()).toContain("0 of 5 allowed");
    await click("Allow model us.amazon.nova-lite-v1:0");
    expect(await catalog()).toContain("2 of 5 allowed");
    await click("US-only models and inference");
    await click("Allow Anthropic and Claude models");
    expect(await catalog()).toContain("4 of 5 allowed");
    expect(await evaluate(`${input("Allow model global.anthropic.claude-sonnet-4-6")}.disabled`)).toBe(true);
    await fill("AWS region", "eu-west-1");
    expect(await catalog()).toContain("0 of 0 allowed");
    await load();
    expect(await evaluate("document.querySelector('[data-bedrock-settings] [role=alert]')?.innerText")).toContain("US AWS region");
    await click("US-only models and inference");
    await load();
    expect(await catalog()).toContain("2 of 2 allowed");
    expect(await catalog()).toContain("Region: eu-west-1");
    expect(await catalog()).not.toContain("amazon.nova-lite");

    // Delay one test response in this disposable browser; ignore AbortSignal
    // deliberately so the revision guard, not fetch cancellation, is proven.
    await evaluate(`(() => { const original=window.fetch.bind(window); window.bedrockFetch=original;
      window.fetch=(url,init)=>String(url).endsWith('/bedrock/test') ? new Promise(resolve=>{
        window.releaseBedrockCatalog=()=>resolve(Response.json({ok:true,settings:{resolvedRegion:'eu-west-1',models:[{id:'stale-model',label:'stale-model',regions:['eu-west-1'],routing:'regional'}]}}));
      }) : original(url,init); return true; })()`);
    await click("Test connection / load models");
    await expect.poll(() => evaluate("typeof window.releaseBedrockCatalog")).toBe("function");
    await fill("AWS region", "us-east-1");
    await evaluate("window.releaseBedrockCatalog(); window.fetch=window.bedrockFetch; true");
    expect(await catalog()).not.toContain("stale-model");
    expect(await catalog()).toContain("0 of 0 allowed");
    await load(); await click("Allow Anthropic and Claude models");
    await save();
    expect((await settings()).settings).toMatchObject({ resolvedRegion: "us-east-1", apiKeySaved: true, allowAnthropic: false });
    expect(await evaluate(`${input("Bedrock token")}.value`)).toBe("");
    expect(JSON.stringify(await settings())).not.toContain(BEDROCK_FIXTURE_TOKEN);
    await evaluate("document.querySelector('[data-bedrock-settings] details').open=false; document.querySelector('[data-engine-card=bedrock]').scrollIntoView({block:'start'}); true");
    await screenshot("settings-us");
    await evaluate("document.querySelector('[data-bedrock-catalog]').previousElementSibling.scrollIntoView({block:'start'}); true");
    await screenshot("model-access");
    const dimensions = await evaluate("({ width: innerWidth, height: innerHeight })");
    await viewport(390, 844);
    await evaluate("document.querySelector('[data-bedrock-catalog]').previousElementSibling.scrollIntoView({block:'start'}); true");
    expect(await evaluate("document.documentElement.scrollWidth <= innerWidth")).toBe(true);
    expect(await evaluate("document.querySelector('[data-bedrock-settings]').getBoundingClientRect().right <= innerWidth")).toBe(true);
    await screenshot("model-access-mobile");
    await viewport(dimensions.width, dimensions.height);

    await evaluate(`(() => { const original=window.fetch.bind(window); window.bedrockFetch=original;
      window.fetch=(url,init)=>String(url).endsWith('/bedrock') && init?.method==='PATCH'
        ? Promise.resolve(Response.json({error:'Synthetic save rejected'},{status:503})) : original(url,init); return true; })()`);
    await fill("Bedrock token", "synthetic-draft-replacement"); await click("Save");
    await expect.poll(() => evaluate("document.querySelector('[data-bedrock-settings] [role=alert]')?.innerText")).toBe("Synthetic save rejected");
    expect(await evaluate(`${input("Bedrock token")}.value`)).toBe("synthetic-draft-replacement");
    expect(readFileSync(join(info!.dataDir, "config.json"), "utf8")).not.toContain("synthetic-draft-replacement");
    await evaluate("window.fetch=window.bedrockFetch; true");
    await fill("Bedrock token", "");
    await select("Authentication", "access-keys");
    await fill("AWS access key ID", BEDROCK_FIXTURE_KEY);
    await fill("AWS secret access key", BEDROCK_FIXTURE_SECRET);
    await load(); await save();
    expect(await evaluate(`${input("AWS secret access key")}.value`)).toBe("");
    expect(JSON.stringify(await settings())).not.toContain(BEDROCK_FIXTURE_SECRET);

    // Named profiles and profile-derived regions use files under the fixture's
    // home, not the operator's AWS files or a live account.
    const aws = join(info!.dataDir, ".aws"); mkdirSync(aws, { recursive: true });
    writeFileSync(join(aws, "config"), "[profile fixture]\nregion=us-west-2\n", { mode: 0o600 });
    writeFileSync(join(aws, "credentials"), `[fixture]\naws_access_key_id=${BEDROCK_FIXTURE_KEY}\naws_secret_access_key=${BEDROCK_FIXTURE_SECRET}\n`, { mode: 0o600 });
    await select("Authentication", "profile"); await fill("AWS profile name", "fixture"); await fill("AWS region", "");
    await load();
    expect(await catalog()).toContain("Region: us-west-2 · AWS profile");
    expect(await catalog()).toContain("1 of 1 allowed");
    expect(await catalog()).toContain("qwen.qwen3-32b-v1:0");
    await save();
    await click("Close settings");
    await click("Claude Sonnet 5"); await click("Amazon Bedrock");
    expect(await evaluate("document.querySelector('[data-model-picker-content]').innerText")).toContain("us-west-2 · Runtime");
    expect(await evaluate("document.querySelector('[data-model-picker-content]').innerText")).not.toContain("amazon.nova-lite");
    expect(await evaluate("document.querySelector('[data-model-picker-content]').innerText")).not.toContain("Local models");
    await screenshot("model-picker");
    await click("qwen.qwen3-32b-v1:0 qwen Default");
    await expect.poll(async () => {
      const result = await fetch(`${info!.url}/api/bots`).then((response) => response.json()) as any;
      return result.bots.find((bot: any) => bot.id === info!.botId)?.tasks.some((task: any) => task.modelSelection?.instanceId === "bedrock" && task.modelSelection.model === "qwen.qwen3-32b-v1:0");
    }, { timeout: 10_000 }).toBe(true);
    await ui("type", "--name", "Message Pepper", "--text", "Verify the selected regional model."); await ui("press", "--keys", "Enter");
    evidence.push(await ui("wait-settle", "--timeout", "30"));
    expect(await evaluate("document.body.innerText")).toContain("Hello from Bedrock.");
    expect(upstream.requests.some((request) => request.path === "/model/qwen.qwen3-32b-v1%3A0/converse-stream")).toBe(true);
    const consoleOutput = await ui("console");
    expect(consoleOutput.messages.filter((message: any) => message.type === "error")).toEqual([]);
  } finally {
    if (info) {
      evidence.push(await ui("snapshot").catch((error) => ({ error: String(error) })));
      await screenshot("final").catch(() => {});
    }
    writeFileSync(join(evidenceDir, "ui.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidenceDir }));
    await waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }); await upstream.close();
  }
}, 240_000);
