import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

import { acquireDataDirLease } from "../server/data-dir-lease.ts";
import { setHostApproval } from "./host-approval.ts";

let dataDir: string;
let botsPath: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "omb-host-approval-"));
  botsPath = join(dataDir, "bots.json");
  writeFileSync(botsPath, JSON.stringify([
    { id: "pm", name: "PM", approvalMode: "auto", modelSelection: { instanceId: "codex-bedrock" }, tasks: [
      { threadId: "one", approvalMode: "auto", modelSelection: { instanceId: "codex-bedrock" } },
      { threadId: "two", approvalMode: "ask", modelSelection: { instanceId: "codex-bedrock" } },
    ] },
    { id: "manager", name: "Manager", approvalMode: "ask", modelSelection: { instanceId: "bedrock" }, tasks: [
      { threadId: "three", approvalMode: "ask", modelSelection: { instanceId: "bedrock" } },
    ] },
  ]), { mode: 0o600 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: {
    "codex-bedrock": { driver: "codex" }, bedrock: { driver: "bedrock" },
  } }), { mode: 0o600 });
});

afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

it("requires explicit consent and exclusively owned offline data", () => {
  const before = readFileSync(botsPath, "utf8");
  expect(() => setHostApproval(dataDir, { allBots: true }, "full", false)).toThrow("--confirm-full-access");
  const lease = acquireDataDirLease(dataDir);
  try {
    expect(() => setHostApproval(dataDir, { allBots: true }, "full", true)).toThrow("already using this data directory");
  } finally {
    lease.release();
  }
  expect(readFileSync(botsPath, "utf8")).toBe(before);
});

it("grants only the selected bot and all its existing threads, and can revoke the grant", () => {
  expect(setHostApproval(dataDir, { bot: "PM" }, "full", true)).toEqual(["PM"]);
  const [pm, manager] = JSON.parse(readFileSync(botsPath, "utf8"));
  expect(pm.approvalMode).toBe("full");
  expect(pm.tasks.map((task: { approvalMode: string }) => task.approvalMode)).toEqual(["full", "full"]);
  expect(manager.approvalMode).toBe("ask");
  expect(setHostApproval(dataDir, { bot: "pm" }, "ask", false)).toEqual(["PM"]);
  expect(JSON.parse(readFileSync(botsPath, "utf8"))[0].tasks.every((task: { approvalMode: string }) => task.approvalMode === "ask")).toBe(true);
});

it("supports an explicitly confirmed fleet grant including Bedrock and rejects unknown providers atomically", () => {
  const initial = readFileSync(botsPath, "utf8");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { "codex-bedrock": { driver: "codex" }, bedrock: { driver: "unmapped" } } }));
  expect(() => setHostApproval(dataDir, { allBots: true }, "full", true)).toThrow("not implemented");
  expect(readFileSync(botsPath, "utf8")).toBe(initial);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ instances: { "codex-bedrock": { driver: "codex" }, bedrock: { driver: "bedrock" } } }));
  expect(setHostApproval(dataDir, { allBots: true }, "full", true)).toEqual(["PM", "Manager"]);
  expect(JSON.parse(readFileSync(botsPath, "utf8")).every((bot: { approvalMode: string }) => bot.approvalMode === "full")).toBe(true);
});
