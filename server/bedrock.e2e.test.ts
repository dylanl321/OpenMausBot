import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { BEDROCK_FIXTURE_TOKEN, BEDROCK_MCP_FIXTURE, converseAnswer, converseStream, fakeBedrock } from "./testing/fake-bedrock.ts";

it("saves Bedrock setup, checks regional drafts, and runs native tools and room chat in an isolated workspace", async () => {
  let scenario: "tool" | "chat" = "tool";
  const upstream = await fakeBedrock({ handle(request, response) {
    if (!request.path.endsWith("/converse-stream")) return false;
    const result = request.body.messages.some((message: any) => message.content.some((block: any) => block.toolResult));
    if (scenario === "chat" || result) { converseAnswer(response, result ? "Bedrock receipt created." : "Bedrock room reply."); return true; }
    const name = request.body.toolConfig?.tools.find((tool: any) => tool.toolSpec.description.includes("disposable Bedrock receipt"))?.toolSpec.name;
    converseStream(response, [
      ["contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "fixture-write", name } } }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: '{"value":"native Bedrock verified"}' } } }],
      ["contentBlockStop", { contentBlockIndex: 0 }], ["messageStop", { stopReason: "tool_use" }],
    ]); return true;
  } });
  const fixture = await launchVerificationServer().catch(async (error) => { await upstream.close(); throw error; });
  const evidence: unknown[] = [{ fixture: fixture.info }];
  const api = async (method: string, path: string, body?: unknown, status?: number) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    if (status !== undefined) expect(response.status, JSON.stringify(result)).toBe(status);
    else expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = async (args: string[]) => {
    const result = await runControlOmb([...args, "--url", fixture.info.url]) as any;
    evidence.push({ command: args, result }); return result;
  };
  try {
    const saved = await api("PATCH", "/api/instances/bedrock/bedrock", { apiKey: BEDROCK_FIXTURE_TOKEN, region: "us-east-1", url: upstream.url, controlUrl: upstream.url, allowAnthropic: false, maxTokens: 1024 });
    expect(JSON.stringify(saved)).not.toContain(BEDROCK_FIXTURE_TOKEN);
    expect(saved.instances.find((entry: any) => entry.instanceId === "bedrock")?.bedrock.apiKeyConfigured).toBe(true);
    await api("POST", "/api/instances/bedrock/refresh-models");
    const configPath = join(fixture.info.dataDir, "config.json");
    expect(JSON.parse(readFileSync(configPath, "utf8")).instances.bedrock.config.maxTokens).toBe(1024);
    await api("PATCH", "/api/instances/bedrock/bedrock", { maxTokens: null });
    expect(JSON.parse(readFileSync(configPath, "utf8")).instances.bedrock.config).not.toHaveProperty("maxTokens");
    const before = readFileSync(configPath, "utf8");
    const draft = await api("POST", "/api/instances/bedrock/bedrock/test", { region: "eu-west-1", apiKey: "synthetic-unsaved-token" });
    expect(draft).toMatchObject({ ok: true, settings: { resolvedRegion: "eu-west-1" } });
    expect(draft.settings.models.map((entry: any) => entry.id)).toEqual(["mistral.mistral-large-2407-v1:0", "eu.mistral.mistral-large-2407-v1:0"]);
    expect(JSON.stringify(draft)).not.toContain("synthetic-unsaved-token");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(upstream.requests.every((request) => request.method === "GET")).toBe(true);
    await api("PATCH", "/api/instances/bedrock/bedrock", { apiKey: "bad\nkey" }, 400);
    await api("PATCH", "/api/instances/bedrock/bedrock", { accessKeyId: "synthetic-partial" }, 400);
    expect(readFileSync(configPath, "utf8")).toBe(before);

    const artifact = join(fixture.info.dataDir, "bedrock-receipt.txt");
    const helper = join(fixture.info.dataDir, "bedrock-mcp.mjs"); writeFileSync(helper, BEDROCK_MCP_FIXTURE);
    await api("POST", "/api/mcp/servers", { name: "bedrock-receipt", command: process.execPath, args: [helper], env: { FIXTURE_ARTIFACT: artifact }, enabled: true });
    await api("PATCH", "/api/mcp/servers/bedrock-receipt", { enabled: true });
    const { bot } = await control(["new-bot", "--name", "Bedrock verifier"]);
    await control(["set-model", "--bot", bot.id, "--instance", "bedrock", "--model", "amazon.nova-lite-v1:0"]);
    await api("PATCH", `/api/bots/${bot.id}`, { mcpServers: ["bedrock-receipt"], computer: "off", browser: false });
    await control(["send", "--bot", bot.id, "--text", "Create the disposable Bedrock receipt."]);
    expect((await control(["wait", "--bot", bot.id, "--timeout", "20"])).status).toBe("needs-user");
    expect(existsSync(artifact)).toBe(false);
    await api("PATCH", "/api/instances/bedrock/bedrock", { region: "us-west-2" }, 409);
    const state = await api("GET", "/api/bots");
    const current = state.bots.find((entry: any) => entry.id === bot.id);
    const card = current.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await api("POST", `/api/bots/${bot.id}/respond`, { threadId: bot.activeTaskId, requestId: card.requestId, behavior: "allow" });
    expect((await control(["wait", "--bot", bot.id, "--timeout", "20"])).status).toBe("settled");
    expect(readFileSync(artifact, "utf8")).toBe("native Bedrock verified");
    const transcript = await control(["messages", "--bot", bot.id, "--limit", "15"]);
    expect(JSON.stringify(transcript)).toContain("Bedrock receipt created.");
    evidence.push({ artifact, content: readFileSync(artifact, "utf8") });
    scenario = "chat";
    const { group } = await api("POST", "/api/groups", { name: "Bedrock room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } });
    await control(["send-channel", "--channel", group.id, "--text", "Say hello in this room."]);
    expect((await control(["wait", "--channel", group.id, "--timeout", "20"])).status).toBe("settled");
    expect(JSON.stringify(await control(["messages", "--channel", group.id, "--limit", "10"]))).toContain("Bedrock room reply.");
  } finally {
    const evidencePath = `${fixture.info.logPath}.bedrock.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    console.info(JSON.stringify({ evidencePath }));
    await fixture.close(); await upstream.close();
  }
}, 120_000);
