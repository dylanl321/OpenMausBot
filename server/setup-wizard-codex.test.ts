import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { CodexDriver } from "./drivers/codex.ts";
import { generateCodexSetupDraft } from "./setup-wizard-codex.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const cli = fileURLToPath(new URL("./testing/fake-codex-app-server.ts", import.meta.url));

it("runs a one-shot Codex draft with no inherited workspace credentials, writable cwd or tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-guide-codex-test-"));
  const previousDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = dir; // marks only this synthetic CLI as a verification child
  try {
    const reply = join(dir, "reply.json");
    const dump = join(dir, "dump.json");
    writeFileSync(reply, '{"kind":"questions","questions":["What outcome?"]}');
    const result = await generateCodexSetupDraft({ cli, config: CodexDriver.decodeConfig({ cli }), model: "gpt-fake-default",
      prompt: "Draft a small team", signal: new AbortController().signal,
      environment: { FAKE_CODEX_WIZARD_REPLY_FILE: reply, FAKE_CODEX_WIZARD_DUMP: dump,
        ANTHROPIC_API_KEY: "must-not-inherit", OPENAI_API_KEY: "must-not-inherit", GITHUB_TOKEN: "must-not-inherit" } });
    expect(JSON.parse(result)).toMatchObject({ kind: "questions" });
    const launched = JSON.parse(readFileSync(dump, "utf8"));
    expect(launched.prompt).toBe("Draft a small team");
    expect(launched.argv).toEqual(expect.arrayContaining(["--ignore-user-config", "exec", "--ephemeral", "--sandbox", "read-only", "--ask-for-approval", "never"]));
    expect(launched.argv).toContain("features.apps=false");
    expect(launched.argv).toContain("features.shell_tool=false");
    expect(launched.argv).toContain("mcp_servers={}");
    expect(launched.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(launched.env.OPENAI_API_KEY).toBeUndefined();
    expect(launched.env.GITHUB_TOKEN).toBeUndefined();
    expect(existsSync(launched.cwd)).toBe(false);
    expect(() => process.kill(launched.pid, 0)).toThrow();
  } finally {
    if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = previousDataDir;
    await removeTempDir(dir);
  }
}, 12_000);

it("fails closed when an isolation flag is missing, and bounds cancellation of a hung child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-guide-codex-stop-"));
  const previousDataDir = process.env.OMB_DATA_DIR;
  process.env.OMB_DATA_DIR = dir;
  try {
    const reply = join(dir, "reply.json");
    const dump = join(dir, "dump.json");
    writeFileSync(reply, "{}");
    const config = CodexDriver.decodeConfig({ cli });
    const base = { cli, config, model: "gpt-fake-default", prompt: "Do not execute tools",
      environment: { FAKE_CODEX_WIZARD_REPLY_FILE: reply, FAKE_CODEX_WIZARD_DUMP: dump } };
    await expect(generateCodexSetupDraft({ ...base, environment: { ...base.environment, FAKE_CODEX_WIZARD_HELP_MISSING: "1" },
      signal: new AbortController().signal })).rejects.toThrow("--ephemeral");
    expect(existsSync(dump)).toBe(false);
    const controller = new AbortController();
    const started = Date.now();
    const hanging = generateCodexSetupDraft({ ...base,
      environment: { ...base.environment, FAKE_CODEX_WIZARD_HANG: "1" }, signal: controller.signal });
    await expect.poll(() => existsSync(dump), { timeout: 4_000 }).toBe(true);
    const launched = JSON.parse(readFileSync(dump, "utf8"));
    controller.abort();
    await expect(hanging).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(launched.cwd)).toBe(false);
    expect(() => process.kill(launched.pid, 0)).toThrow();
  } finally {
    if (previousDataDir === undefined) delete process.env.OMB_DATA_DIR;
    else process.env.OMB_DATA_DIR = previousDataDir;
    await removeTempDir(dir);
  }
}, 12_000);
