// One-shot, tool-free Codex drafting. This is deliberately separate from the
// conversational app-server driver: no bot, workspace, MCP integration or
// native session is created for the temporary Setup Guide.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { managedCodexArgs, type CodexConfig } from "./drivers/codex.ts";
import { augmentedPath } from "./env-path.ts";
import { killCliTree, spawnCli } from "./procs.ts";

const MAX_OUTPUT = 128_000;
const GUIDE_TIMEOUT_MS = 50_000;

/** These settings are per-child only. --ignore-user-config keeps personal MCP
 * servers out; the explicit switches also disable bundled Apps, tools,
 * browser/computer use, search, hooks and plugins. The read-only sandbox is
 * defense in depth, not a substitute for removing tool surfaces.
 * https://developers.openai.com/codex/cli/reference
 * https://developers.openai.com/codex/config-reference */
export const CODEX_GUIDE_CONFIG = [
  "features.apps=false", "apps._default.enabled=false", "features.shell_tool=false",
  "features.unified_exec=false", "features.multi_agent=false", "features.hooks=false",
  "features.browser_use=false", "features.browser_use_external=false", "features.computer_use=false",
  "features.plugins=false", 'web_search="disabled"', "mcp_servers={}",
  'plugins={ "browser@openai-bundled" = { enabled = false }, "computer-use@openai-bundled" = { enabled = false }, "unified-computer-use@openai-bundled" = { enabled = false } }',
] as const;

/** No inherited workspace credentials, harness MCP tokens, API keys, shell
 * hooks or runtime configuration. The configured Codex home is used only for
 * authentication; --ignore-user-config prevents its config from mounting. */
function guideEnvironment(config: CodexConfig, instanceEnvironment: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const value = instanceEnvironment[key] ?? process.env[key];
    if (value) env[key] = value;
  }
  env.PATH = augmentedPath();
  const codexHome = instanceEnvironment.CODEX_HOME ?? process.env.CODEX_HOME;
  if (codexHome) env.CODEX_HOME = codexHome;
  if (config.managed) {
    if (!instanceEnvironment.OPENMAUSBOT_COMPANY_API_KEY || !instanceEnvironment.CODEX_HOME) {
      throw new Error("Company Codex drafting is unavailable until its managed account is connected");
    }
    env.OPENMAUSBOT_COMPANY_API_KEY = instanceEnvironment.OPENMAUSBOT_COMPANY_API_KEY;
  }
  // The verification server's own synthetic CLI accepts only these fixture
  // paths. They never cause a production provider to mount an integration.
  if (process.env.OMB_DATA_DIR && instanceEnvironment.FAKE_CODEX_WIZARD_REPLY_FILE) {
    env.FAKE_CODEX_WIZARD_REPLY_FILE = instanceEnvironment.FAKE_CODEX_WIZARD_REPLY_FILE;
    env.FAKE_CODEX_WIZARD_DUMP = instanceEnvironment.FAKE_CODEX_WIZARD_DUMP;
    env.FAKE_CODEX_WIZARD_HANG = instanceEnvironment.FAKE_CODEX_WIZARD_HANG;
    env.FAKE_CODEX_WIZARD_HELP_MISSING = instanceEnvironment.FAKE_CODEX_WIZARD_HELP_MISSING;
  }
  return env;
}

function runCli(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  input: string, signal: AbortSignal, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnCli>;
    try { child = spawnCli(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) { reject(error); return; }
    let done = false, stopping = false, stdout = "", stderr = "";
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(stdout);
    };
    const stop = (reason: string) => {
      if (stopping || done) return;
      stopping = true;
      void killCliTree(child, 500).then(stopped => finish(new Error(stopped ? reason : `${reason}; the Codex child could not be stopped`)),
        () => finish(new Error(`${reason}; the Codex child could not be stopped`)));
    };
    const onAbort = () => stop("Codex Setup Guide was cancelled");
    const timer = setTimeout(() => stop("Codex Setup Guide timed out"), timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT) stop("Codex Setup Guide output was too large");
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_096); });
    child.on("error", error => finish(error));
    child.on("close", code => {
      if (stopping) return;
      finish(code === 0 ? undefined : new Error(`Codex Setup Guide failed${code === null ? "" : ` (exit ${code})`}; check the selected account and CLI`));
    });
    if (signal.aborted) onAbort();
    else { signal.addEventListener("abort", onAbort, { once: true }); child.stdin.end(input); }
  });
}

/** Only versions that advertise every isolation flag can run the prompt.
 * A missing/unknown switch fails closed, instead of launching an ordinary
 * Codex turn with personal tools or a writable workspace. */
function assertGuideFlags(globalHelp: string, execHelp: string): void {
  for (const flag of ["--ignore-user-config", "--ask-for-approval", "--config"]) {
    if (!globalHelp.includes(flag) && !execHelp.includes(flag)) throw new Error(`Codex Setup Guide requires CLI support for ${flag}; update Codex first`);
  }
  for (const flag of ["--ephemeral", "--sandbox", "--cd", "--skip-git-repo-check", "--output-last-message"]) {
    if (!execHelp.includes(flag)) throw new Error(`Codex Setup Guide requires CLI support for ${flag}; update Codex first`);
  }
}

export async function generateCodexSetupDraft(input: {
  cli: string;
  config: CodexConfig;
  environment?: Record<string, string>;
  model: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  if (input.model.includes("::")) throw new Error("This Codex model needs a custom provider route; choose another connected drafting engine");
  input.signal.throwIfAborted();
  const cwd = mkdtempSync(join(tmpdir(), "omb-setup-guide-"));
  const outputPath = join(cwd, "reply.json");
  try {
    const env = guideEnvironment(input.config, input.environment);
    // Do not leave a second help probe running against a directory that the
    // first failing probe's finally block is about to remove.
    const globalHelp = await runCli(input.cli, ["--help"], cwd, env, "", input.signal, 5_000);
    const execHelp = await runCli(input.cli, ["exec", "--help"], cwd, env, "", input.signal, 5_000);
    assertGuideFlags(globalHelp, execHelp);
    const args = ["--ignore-user-config", ...CODEX_GUIDE_CONFIG.flatMap(value => ["-c", value]),
      ...(input.config.managed ? managedCodexArgs(input.config.managed) : []),
      "exec", "--ephemeral", "--sandbox", "read-only", "--ask-for-approval", "never",
      "--skip-git-repo-check", "--cd", cwd, "--model", input.model,
      "--output-last-message", outputPath, "-"];
    await runCli(input.cli, args, cwd, env, input.prompt, input.signal, GUIDE_TIMEOUT_MS);
    input.signal.throwIfAborted();
    const reply = readFileSync(outputPath, "utf8");
    if (Buffer.byteLength(reply, "utf8") > MAX_OUTPUT) throw new Error("Codex Setup Guide output was too large");
    return reply;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
