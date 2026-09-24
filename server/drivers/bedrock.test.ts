import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetFoundationModelCommand, GetInferenceProfileCommand, ListFoundationModelsCommand, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import * as credentialProviders from "@aws-sdk/credential-provider-node";
import * as profileProviders from "@aws-sdk/credential-provider-ini";
import { BedrockDriver, bedrockApiForModel, describeBedrockSettings } from "./bedrock.ts";
import { createBedrockConnection } from "./bedrock-connection.ts";
import { createBedrockCatalog } from "./bedrock-catalog.ts";
import { bedrockAccessError, bedrockModelFeatures, bedrockRoutingError, type BedrockConfig } from "../../shared/bedrock.ts";
import { decodeBedrockConfig } from "../bedrock-config.ts";
import { ensureDirs } from "../config.ts";
import { recordEvents } from "../testing/events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { BEDROCK_FIXTURE_KEY, BEDROCK_FIXTURE_SECRET, BEDROCK_FIXTURE_SESSION, BEDROCK_FIXTURE_TOKEN, BEDROCK_MCP_FIXTURE,
  converseAnswer, converseStream, messagesStream, fakeBedrock, foundation, modelArn, profile, profileArn, type FakeBedrockOptions } from "../testing/fake-bedrock.ts";

vi.mock("@aws-sdk/credential-provider-node", { spy: true });
vi.mock("@aws-sdk/credential-provider-ini", { spy: true });

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

async function fixture(config: BedrockConfig = {}, options: FakeBedrockOptions = {}, environment: Record<string, string> = {}) {
  ensureDirs();
  const upstream = await fakeBedrock(options); cleanups.push(upstream.close);
  const input = { region: "us-east-1", apiKey: BEDROCK_FIXTURE_TOKEN, url: upstream.url, controlUrl: upstream.url, ...config };
  const instance = await BedrockDriver.create({ instanceId: "bedrock-fixture", displayName: "Bedrock fixture", config: input, environment, enabled: true });
  cleanups.push(() => instance.dispose());
  const recorder = recordEvents(instance.adapter); cleanups.push(async () => recorder.stop());
  return { ...upstream, instance, recorder, config: input };
}

describe("Bedrock credentials and AWS wire protocols", () => {
  it("loads the downloaded bearer configuration and sends the required regional chat parameters", async () => {
    const model = "us.openai.gpt-6-luna";
    const f = await fixture({ auth: "bearer", apiKey: "", model, maxTokens: 128 }, {},
      { AWS_BEARER_TOKEN_BEDROCK: `Bearer ${BEDROCK_FIXTURE_TOKEN}` });
    await f.instance.adapter.sendTurn({ threadId: "legacy-bearer", text: "Hello", model });
    expect(await f.recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    const request = f.requests.find(entry => entry.path === "/openai/v1/chat/completions");
    expect(request).toMatchObject({ headers: { authorization: `Bearer ${BEDROCK_FIXTURE_TOKEN}` },
      body: { model, reasoning_effort: "none", max_completion_tokens: 128 } });
    expect(describeBedrockSettings(f.instance, f.config)).toMatchObject({ auth: "api-key", apiKeyConfigured: true, apiKeySaved: false });
    expect(bedrockModelFeatures("us.openai.gpt-6-astra")).toMatchObject({ tools: false, images: true });
  });

  it.each(["converse", "chat-completions", "messages"] as const)("keeps named gateway tokens and URL prefixes through catalog and %s requests", async api => {
    const model = "amazon.nova-lite-v1:0";
    const f = await fixture({ auth: "api-key", apiKey: "", apiKeyEnv: "FIXTURE_BEDROCK_GATEWAY_KEY", apiKeyHeader: "x-gateway-key", controlUrl: "", model, api },
      { basePath: "/bedrock" }, { FIXTURE_BEDROCK_GATEWAY_KEY: BEDROCK_FIXTURE_TOKEN });
    await f.instance.refreshModels!();
    expect(f.instance.models.options.some(option => option.id === model)).toBe(true);
    await f.instance.adapter.sendTurn({ threadId: `gateway-${api}`, text: "Hello", model });
    expect(await f.recorder.until(event => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(f.requests.some(request => request.path === "/bedrock/foundation-models")).toBe(true);
    expect(f.requests.some(request => request.method === "POST")).toBe(true);
    for (const request of f.requests) {
      expect(request.url.pathname).toMatch(/^\/bedrock\//);
      expect(request.headers["x-gateway-key"]).toBe(BEDROCK_FIXTURE_TOKEN);
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it("does not fall back to another account when a named token variable is missing", async () => {
    const connection = await createBedrockConnection({ apiKeyEnv: "FIXTURE_MISSING_BEDROCK_KEY" }, { AWS_BEARER_TOKEN_BEDROCK: BEDROCK_FIXTURE_TOKEN });
    cleanups.push(async () => connection.close());
    await expect(connection.ready()).rejects.toThrow("Bedrock API key");
    expect(() => decodeBedrockConfig({ apiKeyHeader: "host", url: "https://gateway.example/bedrock" })).toThrow("reserved");
    expect(() => decodeBedrockConfig({ apiKeyHeader: "x-api-key" })).toThrow("explicit Bedrock endpoint");
    await expect(createBedrockConnection({ usOnly: true, region: "us-east-1", apiKeyHeader: "x-api-key", url: "https://gateway.example/bedrock" }, {})).rejects.toThrow("regional AWS endpoint");
  });

  it.each(["OMB_BEDROCK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_API_KEY"])("keeps the explicit %s account ahead of ambient token aliases", async variable => {
    vi.stubEnv("OMB_BEDROCK_API_KEY", "ambient-wrong-account");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-wrong-account");
    const f = await fixture({ apiKey: "", model: "amazon.nova-lite-v1:0" }, {}, { [variable]: BEDROCK_FIXTURE_TOKEN });
    await f.instance.generateText!("Check the selected account");
    expect(f.requests[0].headers.authorization).toBe(`Bearer ${BEDROCK_FIXTURE_TOKEN}`);
    const empty = await createBedrockConnection({}, { [variable]: "" });
    cleanups.push(async () => empty.close());
    await expect(empty.ready()).rejects.toThrow(variable);
  });

  it.each([
    ["runtime", "amazon.nova-lite-v1:0", "/model/amazon.nova-lite-v1%3A0/converse-stream"],
    ["runtime", "us.openai.gpt-5.4", "/openai/v1/chat/completions"],
    ["mantle", "openai.gpt-oss-120b", "/v1/chat/completions"],
    ["mantle", "anthropic.claude-sonnet-4-6", "/anthropic/v1/messages"],
    ["mantle", "claude-sonnet-4-6", "/anthropic/v1/messages"],
  ] as const)("streams %s / %s using its actual protocol", async (endpoint, model, path) => {
    const f = await fixture({ endpoint, model });
    await f.instance.adapter.sendTurn({ threadId: "wire", text: "Hello", model });
    const completed = await f.recorder.until((event) => event.type === "turn.completed");
    expect(completed, JSON.stringify(f.recorder.events)).toMatchObject({ ok: true });
    const request = f.requests.find((entry) => entry.path === path);
    expect(request, JSON.stringify(f.requests.map((entry) => entry.path))).toBeDefined();
    if (path === "/anthropic/v1/messages") {
      expect(request!.headers["x-api-key"]).toBe(BEDROCK_FIXTURE_TOKEN);
      expect(request!.headers["anthropic-version"]).toBe("2023-06-01");
      expect(request!.body.max_tokens).toBe(4096);
    } else expect(request!.headers.authorization).toBe(`Bearer ${BEDROCK_FIXTURE_TOKEN}`);
    expect(f.recorder.events).toContainEqual(expect.objectContaining({ type: "content.delta", streamKind: "assistant_text" }));
  });

  it("keeps Mantle provider-native IDs and exposes their image support and output limit", async () => {
    const f = await fixture({ endpoint: "mantle", model: "gpt-5.4", maxTokens: 128 }, {
      mantleModels: ["gpt-5.4", "claude-sonnet-4-6", "gpt-oss-120b"],
    });
    await f.instance.refreshModels!();
    expect(f.instance.models.options.map(({ id, capabilities }) => ({ id, images: capabilities?.images }))).toEqual([
      { id: "gpt-5.4", images: true }, { id: "claude-sonnet-4-6", images: true }, { id: "gpt-oss-120b", images: false },
    ]);
    await f.instance.generateText!("Hello");
    expect(f.requests.at(-1)).toMatchObject({ path: "/v1/chat/completions", body: { model: "gpt-5.4", max_completion_tokens: 128 } });
    expect(f.requests.at(-1)!.body).not.toHaveProperty("max_tokens");
  });

  it("signs native inference and both catalog operations with the selected region and session token", async () => {
    const f = await fixture({ auth: "access-keys", region: "us-west-2", accessKeyId: BEDROCK_FIXTURE_KEY, secretAccessKey: BEDROCK_FIXTURE_SECRET, sessionToken: BEDROCK_FIXTURE_SESSION, model: "qwen.qwen3-32b-v1:0" });
    await f.instance.refreshModels!();
    await f.instance.generateText!("small helper");
    expect(f.requests.some((request) => request.path === "/foundation-models")).toBe(true);
    expect(f.requests.some((request) => request.path === "/inference-profiles")).toBe(true);
    for (const request of f.requests) {
      expect(request.headers.authorization).toContain(`Credential=${BEDROCK_FIXTURE_KEY}/`);
      expect(request.headers.authorization).toContain("/us-west-2/bedrock/aws4_request");
      expect(request.headers["x-amz-security-token"]).toBe(BEDROCK_FIXTURE_SESSION);
      expect(request.headers.authorization).not.toContain(BEDROCK_FIXTURE_SECRET);
    }
  });

  it.each(["runtime", "mantle"] as const)("signs compatible requests with the %s service", async (endpoint) => {
    const model = endpoint === "runtime" ? "us.openai.gpt-5.4" : "openai.gpt-oss-120b";
    const f = await fixture({ endpoint, model, auth: "access-keys", accessKeyId: BEDROCK_FIXTURE_KEY, secretAccessKey: BEDROCK_FIXTURE_SECRET, sessionToken: BEDROCK_FIXTURE_SESSION });
    expect(await f.instance.generateText!("hello")).toBe("Helper response.");
    expect(f.requests[0].headers.authorization).toContain(`/us-east-1/${endpoint === "mantle" ? "bedrock-mantle" : "bedrock"}/aws4_request`);
    expect(f.requests[0].headers["x-amz-security-token"]).toBe(BEDROCK_FIXTURE_SESSION);
  });

  it("prefers a token in automatic mode and can explicitly select a named profile instead", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bedrock-profile-")); cleanups.push(() => removeTempDir(directory));
    const configFile = join(directory, "config"); const credentialsFile = join(directory, "credentials");
    writeFileSync(configFile, "[profile work]\nregion = us-west-2\n[profile europe]\nregion = eu-west-1\n");
    writeFileSync(credentialsFile, `[work]\naws_access_key_id = ${BEDROCK_FIXTURE_KEY}\naws_secret_access_key = ${BEDROCK_FIXTURE_SECRET}\naws_session_token = ${BEDROCK_FIXTURE_SESSION}\n`);
    const environment = { AWS_CONFIG_FILE: configFile, AWS_SHARED_CREDENTIALS_FILE: credentialsFile, AWS_PROFILE: "work", AWS_BEARER_TOKEN_BEDROCK: BEDROCK_FIXTURE_TOKEN };
    const token = await createBedrockConnection({}, environment); cleanups.push(async () => token.close());
    await token.ready();
    expect(token).toMatchObject({ region: "us-west-2", regionSource: "profile", credentialSource: "environment-token", apiKeyMode: true });
    const upstream = await fakeBedrock(); cleanups.push(upstream.close);
    const connection = await createBedrockConnection({ auth: "profile", url: upstream.url }, environment); cleanups.push(async () => connection.close());
    await connection.request("/v1/models");
    expect(connection).toMatchObject({ region: "us-west-2", credentialSource: "profile", apiKeyMode: false });
    expect(upstream.requests[0].headers.authorization).toContain(`Credential=${BEDROCK_FIXTURE_KEY}/`);
    const explicit = await createBedrockConnection({ region: "us-east-2", profile: "europe" }, { ...environment, AWS_REGION: "us-east-1" }); cleanups.push(async () => explicit.close());
    expect(explicit).toMatchObject({ region: "us-east-2", regionSource: "setting" });
    const env = await createBedrockConnection({ profile: "europe" }, { ...environment, AWS_DEFAULT_REGION: "us-east-1" }); cleanups.push(async () => env.close());
    expect(env).toMatchObject({ region: "us-east-1", regionSource: "AWS_DEFAULT_REGION" });
  });

  it("refreshes expiring role credentials and keeps per-connection accounts isolated", async () => {
    let token = "synthetic-role-session-first";
    vi.spyOn(credentialProviders, "defaultProvider").mockReturnValue(async () => ({ accessKeyId: BEDROCK_FIXTURE_KEY, secretAccessKey: BEDROCK_FIXTURE_SECRET, sessionToken: token, expiration: new Date(0) }));
    const f = await fixture({ auth: "aws", apiKey: "", model: "amazon.nova-lite-v1:0" });
    await f.instance.generateText!("one");
    token = "synthetic-role-session-second";
    await f.instance.generateText!("two");
    expect(f.requests.map((request) => request.headers["x-amz-security-token"])).toEqual(["synthetic-role-session-first", "synthetic-role-session-second"]);
    const isolated = await fixture({ apiKey: "synthetic-separate-token", model: "amazon.nova-lite-v1:0" });
    await isolated.instance.generateText!("three");
    expect(isolated.requests[0].headers.authorization).toBe("Bearer synthetic-separate-token");
  });

  it("does not fill a partial per-instance key pair from the ambient account", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "synthetic-wrong-account");
    const f = await fixture({ auth: "access-keys" }, {}, { AWS_ACCESS_KEY_ID: BEDROCK_FIXTURE_KEY });
    expect(await f.instance.snapshot()).toMatchObject({ state: "unavailable", reason: expect.stringContaining("both") });
    expect(f.requests).toEqual([]);
  });

  it("does not fall back to a different account when a named profile fails", async () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", BEDROCK_FIXTURE_KEY);
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", BEDROCK_FIXTURE_SECRET);
    const fallback = vi.spyOn(credentialProviders, "defaultProvider").mockClear();
    const connection = await createBedrockConnection({ region: "us-east-1", auth: "profile", profile: "missing-fixture-profile" }, {});
    cleanups.push(async () => connection.close());
    await expect(connection.ready()).rejects.toThrow("Could not load AWS credentials");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("caches named-profile sessions and refreshes them before expiration", async () => {
    const identity = { accessKeyId: BEDROCK_FIXTURE_KEY, secretAccessKey: BEDROCK_FIXTURE_SECRET,
      sessionToken: "synthetic-first-profile-session", expiration: new Date(Date.now() + 3_600_000) };
    const resolve = vi.fn(async () => ({ ...identity }));
    vi.spyOn(profileProviders, "fromIni").mockReturnValue(resolve);
    const connection = await createBedrockConnection({ region: "us-east-1", auth: "profile", profile: "fixture" }, {});
    cleanups.push(async () => connection.close());
    await connection.ready(); await connection.ready();
    expect(resolve).toHaveBeenCalledTimes(1);
    identity.expiration.setTime(Date.now() + 60_000);
    identity.sessionToken = "synthetic-renewed-profile-session";
    await connection.ready();
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(connection.secrets()).toContain(identity.sessionToken);
  });
});

describe("regional catalogs and access controls", () => {
  it("uses the exact region, handles profile pagination, and excludes non-conversational models", async () => {
    const east = await fixture();
    await east.instance.refreshModels!();
    const ids = east.instance.models.options.map((entry) => entry.id);
    expect(ids).toEqual(["amazon.nova-lite-v1:0", "anthropic.claude-sonnet-4-6", "us.amazon.nova-lite-v1:0", "global.anthropic.claude-sonnet-4-6", "opaque-claude"]);
    expect(east.instance.models.options.every((entry) => !entry.custom)).toBe(true);
    expect(east.requests.filter((request) => request.path === "/inference-profiles")).toHaveLength(2);
    expect(east.requests.some((request) => request.path === "/v1/models")).toBe(false);
    const west = await fixture({ region: "us-west-2" });
    await west.instance.refreshModels!();
    expect(west.instance.models.options.map((entry) => entry.id)).toEqual(["qwen.qwen3-32b-v1:0"]);
    expect(describeBedrockSettings(west.instance, {}).resolvedRegion).toBe("us-west-2");
  });

  it("keeps region-unavailable foundations out of the picker while offering a supported profile", async () => {
    const f = await fixture({}, { unavailable: ["amazon.nova-lite-v1:0"] });
    await f.instance.refreshModels!();
    expect(f.instance.models.options.some((entry) => entry.id === "amazon.nova-lite-v1:0")).toBe(false);
    expect(f.instance.models.options.some((entry) => entry.id === "us.amazon.nova-lite-v1:0")).toBe(true);
    expect(describeBedrockSettings(f.instance, {}).models!.find((entry) => entry.id === "amazon.nova-lite-v1:0")?.unavailable).toContain("us-east-1");
  });

  it("uses Mantle’s catalog and handles partial native discovery without seeding unrelated models", async () => {
    const mantle = await fixture({ endpoint: "mantle" }); await mantle.instance.refreshModels!();
    expect(mantle.instance.models.options.map((entry) => entry.id)).toEqual(["openai.gpt-oss-120b", "moonshot.kimi-k2.5", "anthropic.claude-sonnet-4-6"]);
    expect(mantle.requests.map((entry) => entry.path)).toEqual(["/v1/models"]);
    const partial = await fixture({}, { handle(request, response) {
      if (request.path !== "/foundation-models") return false;
      response.writeHead(403, { "content-type": "application/json", "x-amzn-errortype": "AccessDeniedException" }); response.end('{"message":"synthetic denied"}'); return true;
    } });
    expect(partial.instance.models.options).toEqual([]);
    await partial.instance.refreshModels!();
    expect(partial.instance.models.options.map((entry) => entry.id)).toEqual(["us.amazon.nova-lite-v1:0", "global.anthropic.claude-sonnet-4-6", "opaque-claude"]);
    expect((await partial.instance.snapshot()).warning?.message).toContain("incomplete");
  });

  it("allows Claude by default but excludes it and opaque aliases when disabled", async () => {
    expect(bedrockAccessError("anthropic.claude-sonnet-4-6", {})).toBeNull();
    const f = await fixture({ allowAnthropic: false, blockedModels: ["amazon.nova-lite-v1:0"], model: "opaque-claude" });
    await f.instance.refreshModels!();
    expect(f.instance.models.options).toEqual([]);
    await expect(f.instance.adapter.sendTurn({ threadId: "blocked", model: "us.anthropic.claude-sonnet-4-6", text: "private" })).rejects.toThrow("disabled");
    await expect(f.instance.generateText!("private")).rejects.toThrow("disabled");
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("enforces US destinations for regional, geographic, global and application profiles before inference", async () => {
    const connection = await createBedrockConnection({ usOnly: true, region: "us-east-1", apiKey: BEDROCK_FIXTURE_TOKEN }, {}); cleanups.push(async () => connection.close());
    const send = vi.spyOn(connection.control, "send").mockImplementation(async (command: any) => {
      expect(command).toBeInstanceOf(GetInferenceProfileCommand);
      const id = command.input.inferenceProfileIdentifier;
      return profile(id, "amazon.nova-lite-v1:0", id === "opaque-bad" ? ["us-east-1", "eu-west-1"] : ["us-east-1", "us-west-2"], "us-east-1", id.startsWith("opaque"));
    });
    await expect(connection.authorize("amazon.nova-lite-v1:0", connection.signal)).resolves.toBeUndefined();
    await expect(connection.authorize("us.amazon.nova-lite-v1:0", connection.signal)).resolves.toBeUndefined();
    await expect(connection.authorize("opaque-good", connection.signal)).resolves.toBeUndefined();
    await expect(connection.authorize("opaque-bad", connection.signal)).rejects.toThrow("non-US");
    const count = send.mock.calls.length;
    await expect(connection.authorize("global.amazon.nova-lite-v1:0", connection.signal)).rejects.toThrow("global");
    expect(send.mock.calls).toHaveLength(count);
    send.mockRejectedValue(new Error("Cannot read backing metadata"));
    await expect(connection.authorize("unknown-profile", connection.signal)).rejects.toThrow("could not authorize");
    await expect(createBedrockConnection({ usOnly: true, region: "eu-west-1" }, {})).rejects.toThrow("US AWS region");
    await expect(createBedrockConnection({ usOnly: true, region: "us-east-1", url: "https://proxy.example.test" }, {})).rejects.toThrow("regional AWS endpoint");
    expect(bedrockRoutingError("global.amazon.nova", { usOnly: true }, "us-east-1", [modelArn("amazon.nova")])).toContain("global");
  });

  it("filters US-only catalogs using all backing regions, including opaque profiles", async () => {
    const config = { usOnly: true, region: "us-east-1", apiKey: BEDROCK_FIXTURE_TOKEN };
    const connection = await createBedrockConnection(config, {}); cleanups.push(async () => connection.close());
    vi.spyOn(connection.control, "send").mockImplementation(async (command) => command instanceof ListFoundationModelsCommand
      ? { modelSummaries: [foundation("amazon.nova-lite-v1:0")] }
      : command instanceof ListInferenceProfilesCommand ? { inferenceProfileSummaries: [
        profile("us.amazon.nova-lite-v1:0", "amazon.nova-lite-v1:0"), profile("global.amazon.nova-lite-v1:0", "amazon.nova-lite-v1:0", ["us-east-1"]),
        profile("opaque-bad", "amazon.nova-lite-v1:0", ["eu-west-1"], "us-east-1", true),
      ] } : { regionAvailability: "AVAILABLE" });
    const catalog = createBedrockCatalog(config, connection); await catalog.refresh();
    expect(catalog.models().options.map((entry) => entry.id)).toEqual(["amazon.nova-lite-v1:0", "us.amazon.nova-lite-v1:0"]);
    expect(catalog.info().filter((entry) => entry.accessError)).toHaveLength(2);
  });

  it("keeps US-only traffic on Bedrock endpoints despite ambient endpoint overrides", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL", "https://proxy.example.test");
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "https://bedrock-runtime.eu-west-1.amazonaws.com");
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK", "https://bedrock.eu-west-1.amazonaws.com");
    const connection = await createBedrockConnection({ usOnly: true, region: "us-east-1", apiKey: BEDROCK_FIXTURE_TOKEN }, {});
    cleanups.push(async () => connection.close());
    const destinations: string[] = [];
    for (const client of [connection.runtime, connection.control]) vi.spyOn(client.config.requestHandler, "handle").mockImplementation(async (request) => {
      destinations.push(request.hostname);
      return { response: { statusCode: 200, headers: { "content-type": "application/json" }, body: Readable.from([JSON.stringify({
        output: { message: { role: "assistant", content: [{ text: "US response" }] } }, stopReason: "end_turn", modelSummaries: [],
      })]) } };
    });
    await connection.runtime.send(new ConverseCommand({ modelId: "amazon.nova-lite-v1:0", messages: [{ role: "user", content: [{ text: "Hello" }] }] }));
    await connection.control.send(new ListFoundationModelsCommand({}));
    expect(destinations).toEqual(["bedrock-runtime.us-east-1.amazonaws.com", "bedrock.us-east-1.amazonaws.com"]);
    await expect(createBedrockConnection({ usOnly: true, region: "us-east-1", url: "https://proxy.us-east-1.amazonaws.com" }, {})).rejects.toThrow("regional AWS endpoint");
  });

  it.each(["opaque-gpt", profileArn("opaque-gpt", "us-east-1", true)])("routes GPT profile %s through Chat Completions with the correct output limit", async (model) => {
    const f = await fixture({ model, maxTokens: 128 }, { models: [foundation("openai.gpt-5.4")], profiles: [profile("opaque-gpt", "openai.gpt-5.4", ["us-east-1"], "us-east-1", true)] });
    await f.instance.refreshModels!();
    await f.instance.generateText!("Hello");
    const request = f.requests.at(-1)!;
    expect(request.path).toBe("/openai/v1/chat/completions");
    expect(request.body).toMatchObject({ model, max_completion_tokens: 128 });
    expect(request.body).not.toHaveProperty("max_tokens");
  });

  it("treats short Mantle IDs as regional models, not Runtime inference profiles", async () => {
    const connection = await createBedrockConnection({ endpoint: "mantle", usOnly: true, region: "us-west-2", apiKey: BEDROCK_FIXTURE_TOKEN, allowAnthropic: false }, {});
    cleanups.push(async () => connection.close());
    const send = vi.spyOn(connection.control, "send");
    await expect(connection.authorize("gpt-oss-120b", connection.signal)).resolves.toBeUndefined();
    await expect(connection.authorize("claude-sonnet-4-6", connection.signal)).rejects.toThrow("disabled");
    await expect(connection.authorize("us.amazon.nova-lite-v1:0", connection.signal)).rejects.toThrow("Mantle requires a model ID");
    expect(send).not.toHaveBeenCalled();
  });

  it("resolves unfamiliar namespaces so new geographies cannot masquerade as foundation models", async () => {
    const connection = await createBedrockConnection({ usOnly: true, region: "us-east-1", apiKey: BEDROCK_FIXTURE_TOKEN, allowAnthropic: false }, {});
    cleanups.push(async () => connection.close());
    const send = vi.spyOn(connection.control, "send").mockImplementation(async (command: any) => {
      if (command instanceof GetInferenceProfileCommand) {
        if (command.input.inferenceProfileIdentifier === "ca.amazon.nova-lite-v1:0") return profile("ca.amazon.nova-lite-v1:0", "amazon.nova-lite-v1:0", ["ca-central-1"]);
        throw new Error("Not an inference profile");
      }
      expect(command).toBeInstanceOf(GetFoundationModelCommand);
      if (command.input.modelIdentifier.startsWith("ca.")) throw new Error("Not a foundation model");
      return { modelDetails: foundation(command.input.modelIdentifier, "us-east-1", {
        providerName: command.input.modelIdentifier.includes("blocked") ? "Anthropic" : "New provider",
      }) };
    });
    await expect(connection.authorize("ca.amazon.nova-lite-v1:0", connection.signal)).rejects.toThrow("could not authorize");
    expect(send).toHaveBeenCalledTimes(1);
    await expect(connection.authorize("newprovider.chat-v1", connection.signal)).resolves.toBeUndefined();
    await expect(connection.authorize("newprovider.blocked-v1", connection.signal)).rejects.toThrow("disabled");
  });

  it("validates config and keeps tokens and both AWS keys write-only", async () => {
    expect(() => decodeBedrockConfig({ url: "http://remote.example.test" })).toThrow("HTTPS");
    expect(() => decodeBedrockConfig({ endpoint: "mantle", api: "converse" })).toThrow("Mantle");
    expect(() => decodeBedrockConfig({ region: "us-east-1/../../" })).toThrow("AWS region");
    const f = await fixture({ accessKeyId: BEDROCK_FIXTURE_KEY, secretAccessKey: BEDROCK_FIXTURE_SECRET, sessionToken: BEDROCK_FIXTURE_SESSION });
    const settings = describeBedrockSettings(f.instance, f.config);
    expect(settings).toMatchObject({ apiKeyConfigured: true, apiKeySaved: true, accessKeysSaved: true });
    for (const secret of [BEDROCK_FIXTURE_TOKEN, BEDROCK_FIXTURE_KEY, BEDROCK_FIXTURE_SECRET, BEDROCK_FIXTURE_SESSION]) expect(JSON.stringify(settings)).not.toContain(secret);
  });

  it("routes every current conversational provider family without a Claude-only allowlist", () => {
    for (const model of ["ai21.jamba-1-5-large-v1:0", "amazon.nova-pro-v1:0", "anthropic.claude-sonnet-4-6", "cohere.command-r-plus-v1:0", "deepseek.r1-v1:0", "google.gemma-3-27b-it", "meta.llama4-maverick-17b-instruct-v1:0", "minimax.minimax-m2", "mistral.mistral-large-2407-v1:0", "moonshot.kimi-k2-thinking", "nvidia.nemotron-nano-12b-v2", "openai.gpt-oss-120b-1:0", "qwen.qwen3-32b-v1:0", "writer.palmyra-x5-v1:0", "zai.glm-4.7"]) {
      expect(bedrockApiForModel({}, model)).toBe("converse");
    }
    expect(bedrockApiForModel({}, "global.openai.gpt-5.4")).toBe("chat-completions");
    expect(bedrockApiForModel({}, "xai.grok-4")).toBe("chat-completions");
    expect(bedrockApiForModel({ endpoint: "mantle" }, "anthropic.claude-sonnet-4-6")).toBe("messages");
  });

  it("keeps Llama 3.1+ agent tools while respecting older text-only model limits", () => {
    for (const model of ["meta.llama3-1-8b-instruct-v1:0", "us.meta.llama3-3-70b-instruct-v1:0", "meta.llama3-2-90b-instruct-v1:0"]) {
      expect(bedrockModelFeatures(model)).toMatchObject({ tools: true, system: true });
    }
    for (const model of ["meta.llama3-70b-instruct-v1:0", "anthropic.claude-v2", "amazon.titan-text-express-v1", "deepseek.r1-v1:0"]) {
      expect(bedrockModelFeatures(model)).toMatchObject({ tools: false, images: false });
    }
  });
});

describe("native agent turns", () => {
  it.each(["allow", "deny", "cancel"] as const)("preserves signed reasoning and %s approval before executing a native tool call", async (behavior) => {
    const directory = mkdtempSync(join(tmpdir(), "bedrock-tools-")); cleanups.push(() => removeTempDir(directory));
    const helper = join(directory, "tool.mjs"); const artifact = join(directory, "receipt.txt"); writeFileSync(helper, BEDROCK_MCP_FIXTURE);
    const f = await fixture({}, { handle(request, response) {
      if (!request.path.endsWith("/converse-stream")) return false;
      if (request.body.messages.some((message: any) => message.content.some((block: any) => block.toolResult))) { converseAnswer(response, "Tool result received."); return true; }
      const name = request.body.toolConfig.tools[0].toolSpec.name;
      converseStream(response, [
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Reasoning" } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "synthetic-signed-reasoning" } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "write-1", name } } }],
        ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":' } } }],
        ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '"verified"}' } } }],
        ["contentBlockStop", { contentBlockIndex: 1 }], ["messageStop", { stopReason: "tool_use" }],
      ]); return true;
    } });
    const turnId = await f.instance.adapter.sendTurn({ threadId: "agent", text: "Write receipt", model: "amazon.nova-lite-v1:0", approvalMode: "full", integrations: {
      localComputer: { command: process.execPath, args: [helper], env: { FIXTURE_ARTIFACT: artifact }, scope: "local-computer" },
    } });
    const request = await f.recorder.until((event) => event.type === "request.opened");
    expect(request).toMatchObject({ approvalScope: "local-computer", requiresExplicitApproval: true, allowSession: false });
    expect(existsSync(artifact)).toBe(false);
    if (behavior === "cancel") await f.instance.adapter.interruptTurn("agent", turnId.turnId);
    else await f.instance.adapter.respondToRequest("agent", request.requestId!, { behavior });
    // Denial is a valid conversation outcome: no tool ran, and the model
    // can acknowledge the denial. Cancellation still interrupts the turn.
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: behavior !== "cancel" });
    if (behavior === "allow") expect(readFileSync(artifact, "utf8")).toBe("verified"); else expect(existsSync(artifact)).toBe(false);
    if (behavior !== "cancel") {
      const continuation = f.requests.filter((entry) => entry.path.endsWith("/converse-stream"))[1].body.messages;
      expect(continuation.find((message: any) => message.role === "assistant").content[0]).toEqual({ reasoningContent: { reasoningText: { text: "Reasoning", signature: "synthetic-signed-reasoning" } } });
      expect(continuation.at(-1).content[0].toolResult).toMatchObject({ toolUseId: "write-1", status: behavior === "allow" ? "success" : "error" });
    }
  });

  it("does not execute truncated tool streams and redacts credentials across streamed chunks", async () => {
    const f = await fixture({}, { handle(request, response) {
      if (!request.path.endsWith("/converse-stream")) return false;
      converseStream(response, [
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: BEDROCK_FIXTURE_TOKEN.slice(0, 11) } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: BEDROCK_FIXTURE_TOKEN.slice(11) } }],
        ["contentBlockStop", { contentBlockIndex: 0 }],
        ["contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call-1", name: "unknown_write" } } }],
        ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"value":' } } }],
      ]); return true;
    } });
    await f.instance.adapter.sendTurn({ threadId: "truncated", text: "private", model: "amazon.nova-lite-v1:0" });
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: false });
    expect(f.requests).toHaveLength(1);
    expect(f.recorder.events.some((event) => event.type === "request.opened")).toBe(false);
    expect(JSON.stringify(f.recorder.events)).not.toContain(BEDROCK_FIXTURE_TOKEN);
    expect(f.recorder.events.filter((event) => event.type === "content.delta").map((event) => event.delta).join("")).toBe("[redacted]");
  });

  it("sends images as native content, and omits tools for legacy text models", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bedrock-image-")); cleanups.push(() => removeTempDir(directory));
    const path = join(directory, "image.png"); writeFileSync(path, Buffer.from("iVBORw0KGgo=", "base64"));
    const f = await fixture();
    await f.instance.adapter.sendTurn({ threadId: "vision", text: "Image?", model: "amazon.nova-lite-v1:0", images: [{ path, mime: "image/png", bytes: 8 }] });
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true, usage: { input: 17, output: 3, cachedInput: 2 } });
    expect(f.requests[0].body.messages[0].content).toContainEqual({ image: { format: "png", source: { bytes: "iVBORw0KGgo=" } } });
    const legacy = await fixture({ model: "amazon.titan-text-express-v1" });
    await legacy.instance.generateText!("Hello");
    expect(legacy.requests[0].body.toolConfig).toBeUndefined();
    expect(legacy.requests[0].body.system).toBeUndefined();
  });

  it("encodes profile ARNs on the model route, never an inference-profile runtime route", async () => {
    const model = profileArn("us.amazon.nova-lite-v1:0");
    const f = await fixture({ model }); await f.instance.generateText!("Hello");
    expect(f.requests[0].path).toBe(`/model/${encodeURIComponent(model)}/converse`);
  });

  it.each(["allow", "deny", "cancel"] as const)("preserves Messages thinking and %s approval before executing a tool", async (behavior) => {
    const directory = mkdtempSync(join(tmpdir(), "bedrock-messages-tools-")); cleanups.push(() => removeTempDir(directory));
    const helper = join(directory, "tool.mjs"); const artifact = join(directory, "receipt.txt"); writeFileSync(helper, BEDROCK_MCP_FIXTURE);
    const f = await fixture({ endpoint: "mantle", model: "anthropic.claude-sonnet-4-6" }, { handle(request, response) {
      if (request.path !== "/anthropic/v1/messages" || request.body.messages.some((message: any) => message.content.some((block: any) => block.type === "tool_result"))) return false;
      messagesStream(response, [
        { type: "message_start", message: { usage: { input_tokens: 5, cache_read_input_tokens: 2 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Reasoning" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "synthetic-messages-signature" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "write-1", name: request.body.tools[0].name, input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"value":"messages verified"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } }, { type: "message_stop" },
      ]); return true;
    } });
    const turn = await f.instance.adapter.sendTurn({ threadId: "messages-agent", text: "Write receipt", model: "anthropic.claude-sonnet-4-6", integrations: {
      custom: { receipt: { command: process.execPath, args: [helper], env: { FIXTURE_ARTIFACT: artifact } } },
    } });
    const approval = await f.recorder.until((event) => event.type === "request.opened");
    expect(existsSync(artifact)).toBe(false);
    if (behavior === "cancel") await f.instance.adapter.interruptTurn("messages-agent", turn.turnId);
    else await f.instance.adapter.respondToRequest("messages-agent", approval.requestId!, { behavior });
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: behavior !== "cancel" });
    if (behavior === "allow") expect(readFileSync(artifact, "utf8")).toBe("messages verified"); else expect(existsSync(artifact)).toBe(false);
    if (behavior !== "cancel") {
      const continuation = f.requests.filter((entry) => entry.path === "/anthropic/v1/messages")[1].body.messages;
      expect(continuation.find((message: any) => message.role === "assistant").content[0]).toEqual({ type: "thinking", thinking: "Reasoning", signature: "synthetic-messages-signature" });
      expect(continuation.at(-1).content[0]).toMatchObject({ type: "tool_result", tool_use_id: "write-1", is_error: behavior !== "allow" });
    }
  });

  it("supports the Messages route on Bedrock Runtime too", async () => {
    const f = await fixture({ api: "messages", model: "anthropic.claude-sonnet-4-6" });
    await f.instance.adapter.sendTurn({ threadId: "runtime-messages", text: "Hello", model: "anthropic.claude-sonnet-4-6" });
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(f.requests[0].path).toBe("/anthropic/v1/messages");
    expect(f.requests[0].headers["x-api-key"]).toBe(BEDROCK_FIXTURE_TOKEN);
  });

  it("mounts remote MCP tools and returns image results without exposing authorization tokens", async () => {
    const credential = "synthetic-remote-mcp-credential";
    const pixels = "iVBORw0KGgo=";
    let calls = 0;
    const f = await fixture({}, { handle(request, response) {
      if (request.path === "/mcp") {
        expect(request.headers.authorization).toBe(`Bearer ${credential}`);
        const { id, method } = request.body;
        if (id === undefined) { response.writeHead(204); response.end(); return true; }
        let result: unknown = {};
        if (method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
        if (method === "tools/list") result = { tools: [{ name: "screenshot", description: "Return fixture pixels", inputSchema: { type: "object", properties: {} } }] };
        if (method === "tools/call") { calls++; result = { content: [{ type: "image", mimeType: "image/png", data: pixels }, { type: "text", text: `Returned ${credential}` }] }; }
        response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id, result })); return true;
      }
      if (!request.path.endsWith("/converse-stream") || request.body.messages.some((message: any) => message.content.some((block: any) => block.toolResult))) return false;
      converseStream(response, [
        ["contentBlockStart", { contentBlockIndex: 0, start: { toolUse: { toolUseId: "image-1", name: request.body.toolConfig.tools[0].toolSpec.name } } }],
        ["contentBlockDelta", { contentBlockIndex: 0, delta: { toolUse: { input: "{}" } } }],
        ["contentBlockStop", { contentBlockIndex: 0 }], ["messageStop", { stopReason: "tool_use" }],
      ]); return true;
    } });
    await f.instance.adapter.sendTurn({ threadId: "remote-tools", text: "Inspect fixture pixels", model: "amazon.nova-lite-v1:0",
      integrations: { custom: { remote: { type: "http", url: `${f.url}/mcp`, headers: { Authorization: `Bearer ${credential}` } } } },
    });
    const request = await f.recorder.until((event) => event.type === "request.opened");
    expect(calls).toBe(0);
    await f.instance.adapter.respondToRequest("remote-tools", request.requestId!, { behavior: "allow" });
    expect(await f.recorder.until((event) => event.type === "turn.completed")).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    const result = f.requests.filter((request) => request.path.endsWith("/converse-stream"))[1].body.messages.at(-1).content[0].toolResult;
    expect(result.content).toContainEqual({ image: { format: "png", source: { bytes: pixels } } });
    expect(JSON.stringify(result)).not.toContain(credential);
    expect(JSON.stringify(f.recorder.events)).not.toContain(credential);
  });
});
