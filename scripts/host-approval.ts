import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { acquireDataDirLease } from "../server/data-dir-lease.ts";
import { writeFileAtomic } from "../server/atomic.ts";
import { supportsApprovalMode } from "../shared/approval-mode.ts";

type Mode = "full" | "ask";
type Selection = { bot?: string; allBots?: boolean };
type RecordValue = Record<string, unknown>;

function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid approval state or instance configuration");
  return value as RecordValue;
}

function ownedFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Refusing an unowned or non-regular file: ${path}`);
  }
}

export function setHostApproval(dataDir: string, selection: Selection, mode: Mode, confirmed: boolean): string[] {
  if (!isAbsolute(dataDir) || resolve(dataDir) !== dataDir) throw new Error("--data-dir must be an explicit absolute, normalized path");
  if (Boolean(selection.bot) === Boolean(selection.allBots)) throw new Error("Select exactly one --bot or --all-bots");
  if (mode !== "full" && mode !== "ask") throw new Error("--mode must be full or ask");
  if (mode === "full" && !confirmed) throw new Error("Full access requires --confirm-full-access");
  const directory = lstatSync(dataDir);
  if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) {
    throw new Error("The data directory must be owned by the current user");
  }
  const lease = acquireDataDirLease(dataDir);
  try {
    const botsPath = join(dataDir, "bots.json");
    const configPath = join(dataDir, "config.json");
    ownedFile(botsPath);
    ownedFile(configPath);
    const bots: unknown = JSON.parse(readFileSync(botsPath, "utf8"));
    if (!Array.isArray(bots)) throw new Error("Invalid bots.json");
    const instances = object(object(JSON.parse(readFileSync(configPath, "utf8"))).instances);
    const matches = bots.filter((candidate: unknown) => {
      const bot = object(candidate);
      return selection.allBots || bot.id === selection.bot || bot.name === selection.bot;
    });
    if (!matches.length || (!selection.allBots && matches.length !== 1)) throw new Error("Choose exactly one existing bot");
    for (const candidate of matches) {
      const bot = object(candidate);
      if (bot.approvalGrant !== undefined) throw new Error(`Finish the pending approval change for ${bot.name}`);
      if (!Array.isArray(bot.tasks)) throw new Error(`Invalid tasks for ${bot.name}`);
      if (mode === "full") {
        for (const taskValue of [bot, ...bot.tasks]) {
          const task = object(taskValue);
          const selectionValue = object(task.modelSelection ?? bot.modelSelection);
          const instance = instances[selectionValue.instanceId as string];
          const driver = instance && object(instance).driver;
          if (typeof driver !== "string" || !supportsApprovalMode(driver, "full")) {
            throw new Error(`Full access is not implemented for ${bot.name}'s provider`);
          }
        }
      }
    }
    for (const candidate of matches) {
      const bot = object(candidate);
      for (const taskValue of [bot, ...(bot.tasks as unknown[])]) {
        const task = object(taskValue);
        task.approvalMode = mode;
        task.autoApprove = false;
        task.alwaysAllow = [];
      }
    }
    writeFileAtomic(botsPath, JSON.stringify(bots, null, 2), { mode: 0o600 });
    return matches.map((candidate: unknown) => String(object(candidate).name));
  } finally {
    lease.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      "data-dir": { type: "string" },
      bot: { type: "string" },
      "all-bots": { type: "boolean" },
      mode: { type: "string" },
      "confirm-full-access": { type: "boolean" },
    } });
    if (!values["data-dir"] || !values.mode) throw new Error("Specify --data-dir and --mode full|ask");
    const updated = setHostApproval(values["data-dir"], { bot: values.bot, allBots: values["all-bots"] }, values.mode as Mode, values["confirm-full-access"] === true);
    console.log(JSON.stringify({ mode: values.mode, bots: updated }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
