import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";

it("interviews in an isolated engine, commits only the reviewed batch, retries and reloads without duplicates or partial writes", async () => {
  const control = mkdtempSync(join(tmpdir(), "omb-setup-wizard-test-"));
  const replyFile = join(control, "reply.json");
  const textDump = join(control, "claude-helper.json");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_TEXT_FILE: replyFile, FAKE_CLAUDE_TEXT_DUMP: textDump },
    undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { dataDir, url, logPath } = fixture.info;
  const evidence: unknown[] = [{ fixture: { url, dataDir, logPath } }];
  let restarted: ChildProcess | undefined;
  let swappedBotsFile = false;
  const botsFile = join(dataDir, "bots.json");
  const savedBotsFile = join(dataDir, "bots-for-failed-write.json");
  const sectionFile = join(dataDir, "section-contexts.json");
  const file = (path: string) => existsSync(path) ? readFileSync(path, "utf8") : null;
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const value = await response.json() as any;
    const request = body && typeof body === "object" ? body as { requestId?: string; draft?: { destination?: unknown } } : undefined;
    evidence.push({ method, path, status: response.status,
      ...(request?.requestId ? { requestId: request.requestId, destination: request.draft?.destination } : {}),
      result: path === "/api/bots" ? { bots: value.bots?.map((bot: any) => ({ id: bot.id, name: bot.name, section: bot.section })) }
        : path === "/api/setup-wizard/assist" ? { kind: value.kind, questions: value.questions, draftBotNames: value.draft?.bots?.map((bot: any) => bot.name), error: value.error }
          : path === "/api/setup-wizard/commit" ? { replayed: value.replayed, section: value.section, botIds: value.bots?.map((bot: any) => bot.id), error: value.error }
            : path.startsWith("/api/threads/") ? value : { sections: value.sections, text: value.text, error: value.error },
    });
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expected);
    return value;
  };
  const assist = (destination: unknown, answers: unknown[] = [], instanceId = "claude") =>
    api("POST", "/api/setup-wizard/assist", { instanceId, destination, goal: "Research the market and explain uncertainty", answers });
  const proposal = (models: { instanceId: string; model: string }[], name = "Research Desk") => ({
    kind: "draft", teamName: name, teamBrief: "Give concise, sourced market briefs.", chiefKey: null,
    bots: [
      { key: "lead", name: "Beacon", title: "Research lead", description: "Plans the brief", soul: "Coordinate evidence gathering and synthesize the result.", modelSelection: models[0], appHints: ["calendar"] },
      { key: "check", name: "Proof", title: "Fact checker", description: "Checks claims", soul: "Verify claims and mark uncertainty.", modelSelection: models[1], appHints: [] },
    ],
  });
  const commit = (draft: unknown, requestId = randomUUID(), expected = 201) =>
    api("POST", "/api/setup-wizard/commit", { requestId, draft }, expected);

  try {
    const options = await api("GET", "/api/setup-wizard/options");
    const claude = options.engines.find((entry: any) => entry.instanceId === "claude");
    const codex = options.engines.find((entry: any) => entry.instanceId === "codex");
    expect(claude?.models.length).toBeGreaterThan(0);
    expect(codex?.models.length).toBeGreaterThan(0);
    const selected = (model: any) => ({ instanceId: model.instanceId, model: model.model });
    const selections = [selected(claude.models.find((model: any) => model.coordination)), selected(codex.models[0])];
    expect(selections[0].model).toBeTruthy();
    const existing = (await api("POST", "/api/bots", { name: "Incumbent", title: "Team lead", section: "Operations",
      modelSelection: selections[0] }, 201)).bot;
    await api("PATCH", `/api/bots/${existing.id}`, { chiefOfStaff: true });
    await api("PUT", "/api/section-context?section=Operations", { text: "Do not change the established team brief." });
    const beforeBots = await api("GET", "/api/bots");
    const beforeSections = await api("GET", "/api/sidebar-sections");
    const beforeRegistry = file(botsFile);
    const beforeBriefs = file(sectionFile);
    const beforeMessages = await api("GET", `/api/threads/${existing.threadId}/messages`);
    const newTeam = { kind: "new", name: "" };

    writeFileSync(replyFile, JSON.stringify({ kind: "questions", questions: ["What sources count?", "What cadence?"] }));
    expect(await assist(newTeam)).toMatchObject({ kind: "questions", questions: ["What sources count?", "What cadence?"] });
    expect(await api("GET", "/api/bots")).toEqual(beforeBots);
    expect(await api("GET", "/api/sidebar-sections")).toEqual(beforeSections);
    expect(file(botsFile)).toBe(beforeRegistry);
    expect(file(sectionFile)).toBe(beforeBriefs);
    const answers = [{ question: "What sources count?", answer: "Primary sources" }, { question: "What cadence?", answer: "Weekly" }];
    writeFileSync(replyFile, JSON.stringify({ kind: "questions", questions: ["One more?", "A fourth question?"] }));
    await api("POST", "/api/setup-wizard/assist", { instanceId: "claude", destination: newTeam,
      goal: "Research the market and explain uncertainty", answers }, 502);
    expect(file(botsFile)).toBe(beforeRegistry);
    writeFileSync(replyFile, JSON.stringify(proposal(selections)));
    const prepared = await assist(newTeam, answers);
    expect(prepared.kind).toBe("draft");
    expect(prepared.draft).toMatchObject({ destination: { kind: "new", name: "Research Desk" },
      chiefKey: "lead", bots: [{ modelSelection: selections[0] }, { modelSelection: selections[1] }] });
    const claudeRun = JSON.parse(readFileSync(textDump, "utf8"));
    expect(claudeRun.prompt).toContain("Primary sources");
    expect(claudeRun.prompt).toContain("Weekly");
    expect(claudeRun.argv).not.toContain("--resume");
    expect(claudeRun.argv).toEqual(expect.arrayContaining(["--tools", "", "--strict-mcp-config", "--setting-sources", "project"]));
    expect(claudeRun.cwd).toContain("omb-claude-text-");
    expect(existsSync(claudeRun.cwd)).toBe(false);
    expect(file(botsFile)).toBe(beforeRegistry);
    expect(file(sectionFile)).toBe(beforeBriefs);
    expect(await api("GET", `/api/threads/${existing.threadId}/messages`)).toEqual(beforeMessages);
    evidence.push({ interview: { asked: 2, answerCount: answers.length, unchangedBeforeReview: true },
      selections, draft: prepared.draft });

    await api("POST", "/api/setup-wizard/assist", { instanceId: "missing", destination: newTeam, goal: "Example" }, 409);
    writeFileSync(replyFile, "__FAIL__");
    await api("POST", "/api/setup-wizard/assist", { instanceId: "claude", destination: newTeam, goal: "Example" }, 502);
    writeFileSync(replyFile, JSON.stringify(proposal(selections)));
    expect(file(botsFile)).toBe(beforeRegistry);

    const codexReply = join(dataDir, "fake-codex-wizard-reply.json");
    writeFileSync(codexReply, JSON.stringify({ ...proposal(selections, "Codex Draft"), bots: proposal(selections).bots.slice(0, 1) }));
    const codexDraft = await assist({ kind: "new", name: "" }, [], "codex");
    expect(codexDraft.draft.bots).toHaveLength(1);
    const codexDump = JSON.parse(readFileSync(join(dataDir, "fake-codex-wizard-dump.json"), "utf8"));
    expect(codexDump.argv).toEqual(expect.arrayContaining(["--ignore-user-config", "exec", "--ephemeral", "--sandbox", "read-only", "--ask-for-approval", "never"]));
    expect(codexDump.argv).toContain("features.apps=false");
    expect(codexDump.argv).toContain("mcp_servers={}");
    expect(codexDump.cwd).toContain("omb-setup-guide-");
    expect(existsSync(codexDump.cwd)).toBe(false);
    expect(codexDump.env.OPENMAUSBOT_URL).toBeUndefined();
    expect(file(botsFile)).toBe(beforeRegistry);
    evidence.push({ codex: { readOnly: true, ephemeral: true, toolSurfacesOff: true, tmpRemoved: true } });

    const draft = { ...prepared.draft, visibility: "admins" };
    const requestId = randomUUID();
    await api("POST", "/api/setup-wizard/commit", { requestId, draft: { ...draft, bots: [{ ...draft.bots[0], approvalMode: "full" }] } }, 400);
    await api("POST", "/api/setup-wizard/commit", { requestId, draft: { ...draft, chiefKey: "missing" } }, 400);
    await api("POST", "/api/setup-wizard/commit", { requestId, draft: { ...draft, bots: [
      { ...draft.bots[0], modelSelection: { instanceId: "claude", model: "retired" } }, draft.bots[1],
    ] } }, 409);
    await api("POST", "/api/setup-wizard/commit", { requestId, draft: { ...draft, visibility: { people: ["   "] } } }, 400);
    expect(file(botsFile)).toBe(beforeRegistry);
    const first = await commit(draft, requestId);
    expect(first).toMatchObject({ requestId, replayed: false, section: "Research Desk", chiefBotId: first.bots[0].id });
    expect(first.bots.map((bot: any) => bot.name)).toEqual(["Beacon", "Proof"]);
    expect(first.bots.every((bot: any) => bot.visibility === "admins" && bot.approvalMode === "ask" &&
      bot.computer === "off" && bot.composio === false && bot.browser === false && bot.autoApprove === false &&
      bot.mcpServers.length === 0 && bot.lastSetupWizardReceipt === undefined)).toBe(true);
    expect((await api("GET", "/api/section-context?section=Research%20Desk")).text).toBe(draft.teamBrief);
    const stored = JSON.parse(readFileSync(botsFile, "utf8"));
    expect(stored.filter((bot: any) => bot.lastSetupWizardReceipt?.requestId === requestId)).toHaveLength(2);
    expect(stored.find((bot: any) => bot.id === first.chiefBotId).chiefOfStaff).toBe(true);
    expect(await api("POST", "/api/setup-wizard/commit", { requestId, draft }, 200)).toMatchObject({
      replayed: true, bots: [{ id: first.bots[0].id }, { id: first.bots[1].id }],
    });
    await api("POST", "/api/setup-wizard/commit", { requestId, draft: { ...draft, teamBrief: "different" } }, 409);

    const inTeamOutput = { ...proposal(selections), bots: [{ ...proposal(selections).bots[0], name: "Newcomer" }], chiefKey: "lead" };
    writeFileSync(replyFile, JSON.stringify(inTeamOutput));
    const addition = await assist({ kind: "existing", section: "Operations" });
    expect(addition.draft).toMatchObject({ destination: { kind: "existing", section: "Operations" }, teamBrief: "", chiefKey: null });
    const secondId = randomUUID();
    const second = await commit({ ...addition.draft, visibility: { people: ["user@example.test"] } }, secondId);
    expect(second.bots).toHaveLength(1);
    expect(second.bots[0]).toMatchObject({ name: "Newcomer", section: "Operations", visibility: { people: ["user@example.test"] }, chiefOfStaff: false });
    expect((await api("GET", "/api/section-context?section=Operations")).text).toBe("Do not change the established team brief.");
    expect((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === existing.id).chiefOfStaff).toBe(true);
    expect(await api("GET", `/api/threads/${existing.threadId}/messages`)).toEqual(beforeMessages);

    await api("POST", "/api/setup-wizard/commit", { requestId: randomUUID(), draft: {
      ...addition.draft, bots: [{ ...addition.draft.bots[0], name: "INCUMBENT" }], visibility: "everyone",
    } }, 409);
    await api("POST", "/api/sidebar-sections", { name: "Will Disappear", botIds: [] }, 200);
    const staleTeam = { ...addition.draft, destination: { kind: "existing", section: "Will Disappear" } };
    await api("DELETE", "/api/sidebar-sections?section=Will%20Disappear");
    await commit(staleTeam, randomUUID(), 409);
    const nameConflict = { ...draft, destination: { kind: "new", name: "Taken" }, chiefKey: null };
    await api("POST", "/api/sidebar-sections", { name: "Taken", botIds: [] }, 200);
    await commit(nameConflict, randomUUID(), 409);

    // Force only the owned fixture's bots.json atomic rename to fail after
    // the new brief was prepared. Restore the exact file before any retry.
    const beforeFailure = file(botsFile);
    const beforeFailureBrief = file(sectionFile);
    renameSync(botsFile, savedBotsFile);
    mkdirSync(botsFile);
    swappedBotsFile = true;
    const failingDraft = { ...draft, destination: { kind: "new", name: "Rolled Back" }, chiefKey: null };
    const failedId = randomUUID();
    await commit(failingDraft, failedId, 500);
    rmdirSync(botsFile); renameSync(savedBotsFile, botsFile); swappedBotsFile = false;
    expect(file(botsFile)).toBe(beforeFailure);
    expect(file(sectionFile)).toBe(beforeFailureBrief);
    expect((await api("GET", "/api/sidebar-sections")).sections).not.toContain("Rolled Back");
    expect((await api("GET", "/api/bots")).bots).toHaveLength(stored.length + 1);
    const recovered = await commit(failingDraft, failedId);
    expect(recovered.bots).toHaveLength(2);
    evidence.push({ committed: [first.bots.map((bot: any) => bot.id), second.bots[0].id],
      rejected: ["extra authority", "unknown Chief", "stale model", "stale team", "conflicting names"], failedWriteRolledBack: true });

    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_CLAUDE_TEXT_FILE: replyFile }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `fixture log: ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const replay = await api("POST", "/api/setup-wizard/commit", { requestId, draft }, 200);
    expect(replay.bots.map((bot: any) => bot.id)).toEqual(first.bots.map((bot: any) => bot.id));
    expect((await api("POST", "/api/setup-wizard/commit", { requestId: failedId, draft: failingDraft }, 200)).bots
      .map((bot: any) => bot.id)).toEqual(recovered.bots.map((bot: any) => bot.id));
    expect((await api("GET", "/api/bots")).bots).toHaveLength(stored.length + 3);
    evidence.push({ restart: { botCount: stored.length + 3, replayed: true, idsPreserved: true } });
  } finally {
    if (swappedBotsFile) { rmdirSync(botsFile); renameSync(savedBotsFile, botsFile); }
    const evidencePath = `${logPath}.setup-wizard.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    await removeTempDir(control);
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);

it("does not advance with a disconnected guide engine, while manual bot creation stays available", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_AUTH: "out" });
  try {
    const { url } = fixture.info;
    const api = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, value: await response.json() as any };
    };
    expect((await api("GET", "/api/setup-wizard/options")).value.engines).toEqual([]);
    const before = (await api("GET", "/api/bots")).value.bots;
    expect((await api("POST", "/api/setup-wizard/assist", { instanceId: "claude", goal: "Help me plan",
      destination: { kind: "existing", section: "" } })).status).toBe(409);
    expect((await api("GET", "/api/bots")).value.bots).toHaveLength(before.length);
    const manual = await api("POST", "/api/bots", { name: "Offline manual bot" });
    expect(manual.status).toBe(201);
    expect(manual.value.bot.name).toBe("Offline manual bot");
    expect((await api("GET", "/api/bots")).value.bots).toHaveLength(before.length + 1);
  } finally { await fixture.close(); }
}, 30_000);
