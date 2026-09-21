import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { BedrockDriver, canonicalQuery, decodeBedrockConfig } from "./bedrock.ts";

describe("BedrockDriver", () => {
  const saved = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    sessionToken: process.env.AWS_SESSION_TOKEN,
    region: process.env.AWS_REGION,
    defaultRegion: process.env.AWS_DEFAULT_REGION,
    model: process.env.AWS_BEDROCK_MODEL,
  };

  beforeEach(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_BEDROCK_MODEL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      const name =
        key === "accessKeyId" ? "AWS_ACCESS_KEY_ID"
          : key === "secretAccessKey" ? "AWS_SECRET_ACCESS_KEY"
            : key === "sessionToken" ? "AWS_SESSION_TOKEN"
              : key === "region" ? "AWS_REGION"
                : key === "defaultRegion" ? "AWS_DEFAULT_REGION"
                  : "AWS_BEDROCK_MODEL";
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("registers with the bedrock kind", () => {
    expect(BedrockDriver.driverKind).toBe("bedrock");
    expect(BedrockDriver.metadata.displayName).toBe("Amazon Bedrock");
  });

  it("defaults to us-east-1 and honors explicit config overrides", () => {
    expect(BedrockDriver.defaultConfig()).toEqual({ region: "us-east-1", apiKeyEnv: "BEDROCK_API_KEY", apiKeyHeader: "x-api-key" });
    expect(decodeBedrockConfig({
      region: "eu-west-1",
      model: "custom.model",
      auth: "api-key",
      url: "https://mantel.example/bedrock/",
      apiKeyEnv: "MANTEL_API_KEY",
      apiKeyHeader: "authorization",
    })).toEqual({
      region: "eu-west-1",
      model: "custom.model",
      auth: "api-key",
      url: "https://mantel.example/bedrock",
      apiKeyEnv: "MANTEL_API_KEY",
      apiKeyHeader: "authorization",
    });
  });

  it("leaves region unset in decoded config when the instance should resolve it later", () => {
    expect(decodeBedrockConfig({})).toEqual({ apiKeyEnv: "BEDROCK_API_KEY", apiKeyHeader: "x-api-key" });
  });

  it("rejects non-https custom Bedrock endpoints", () => {
    expect(() => decodeBedrockConfig({ url: "http://mantel.example/bedrock" })).toThrow(/https/u);
  });

  it("rejects invalid API-key header names", () => {
    expect(() => decodeBedrockConfig({ apiKeyHeader: "x-api-key\nother" })).toThrow(/header name/u);
  });

  it("canonicalizes SigV4 query strings with RFC 3986 encoding", () => {
    const url = new URL("https://example.test/?b=1&a=hello world&c=!*'()");
    expect(canonicalQuery(url)).toBe("a=hello%20world&b=1&c=%21%2A%27%28%29");
  });

  it("reports unavailable without Bedrock credentials", async () => {
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1" },
      environment: {},
    });
    await expect(instance.snapshot()).resolves.toMatchObject({ state: "unavailable" });
    await instance.dispose();
  });

  it("accepts an API key without AWS credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-api-key",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", auth: "api-key", apiKeyEnv: "BEDROCK_API_KEY", apiKeyHeader: "x-api-key" },
      environment: { BEDROCK_API_KEY: "bedrock-key" },
    });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("sends native Bedrock requests with API-key auth when explicitly configured", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.nova-lite-v1:0/converse");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("bedrock-key");
      expect(headers.get("authorization")).toBeNull();
      return Response.json({
        output: { message: { content: [{ text: "api key path" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-api-key-request",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", auth: "api-key", apiKeyEnv: "BEDROCK_API_KEY", apiKeyHeader: "x-api-key" },
      environment: { BEDROCK_API_KEY: "bedrock-key" },
    });

    await expect(instance.generateText?.("Hello")).resolves.toBe("api key path");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("resolves the Bedrock region from instance environment when config omits it", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://bedrock-runtime.eu-central-1.amazonaws.com/model/amazon.nova-lite-v1:0/converse");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/Credential=AKIAFIXTURE\/\d{8}\/eu-central-1\/bedrock\/aws4_request/u);
      return Response.json({
        output: { message: { content: [{ text: "env region" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-env-region",
      displayName: "Bedrock",
      enabled: true,
      config: {},
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        AWS_REGION: "eu-central-1",
      },
    });

    await expect(instance.generateText?.("Hello")).resolves.toBe("env region");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("defaults custom endpoints to AWS signing unless API-key mode is explicit", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://mantel.example/bedrock/model/amazon.nova-lite-v1:0/converse");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE\//u);
      expect(headers.get("x-api-key")).toBeNull();
      return Response.json({
        output: { message: { content: [{ text: "aws default" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-custom-url",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", url: "https://mantel.example/bedrock" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });
    await expect(instance.generateText?.("Hello")).resolves.toBe("aws default");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("defers validation until a real runtime request runs", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
      warning: expect.objectContaining({ message: expect.stringContaining("first request") }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("marks the snapshot unavailable after a real runtime failure", async () => {
    const fetchMock = vi.fn(async () => new Response("AccessDeniedException", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });

    await expect(instance.generateText?.("Hello")).rejects.toThrow(/Bedrock HTTP 403/);
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("Bedrock HTTP 403"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("marks the snapshot unavailable after a failed chat turn", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: "Model access denied" }, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "thread-fail", text: "Hello" });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "error" });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "runtime.error", message: expect.stringContaining("Model access denied") }),
    );
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("Model access denied"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    recorder.stop();
    await instance.dispose();
  });

  it("adds a custom configured model or inference profile identifier to the picker catalog", async () => {
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-custom",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2", model: "us.acme.inference-profile-v1" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });
    expect(instance.models.default).toBe("us.acme.inference-profile-v1");
    expect(instance.models.options[0]).toEqual({ id: "us.acme.inference-profile-v1", label: "us.acme.inference-profile-v1", custom: true });
    await instance.dispose();
  });

  it("sends a converse request and reports the reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-lite-v1:0/converse");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(
        "AWS4-HMAC-SHA256 Credential=AKIAFIXTURE/20260102/us-west-2/bedrock/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, " +
        "Signature=f50d4710df4db8b2690d0c75c9778211890e1e3a23e75e6854d3b6af0c49ab96",
      );
      expect(headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
      expect(headers.get("x-amz-security-token")).toBe("fixture-session");
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [
          { role: "assistant", content: [{ text: "Earlier answer" }] },
          { role: "user", content: [{ text: "Hello Bedrock" }] },
        ],
        system: [{ text: "You are helpful." }],
      });
      return Response.json({
        output: { message: { content: [{ text: "Hi from Bedrock" }] } },
        usage: { inputTokens: 11, outputTokens: 7 },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        AWS_SESSION_TOKEN: "fixture-session",
      },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread-1",
      text: "Hello Bedrock",
      system: "You are helpful.",
      transcript: [{ role: "assistant", text: "Earlier answer" }],
    });
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: true, usage: { input: 11, output: 7 } });
    expect(recorder.events).toContainEqual(
      expect.objectContaining({ type: "item.completed", itemType: "assistant_text", text: "Hi from Bedrock" }),
    );
    recorder.stop();
    await instance.dispose();
  });

  it("supports a custom Bedrock-compatible endpoint with API-key auth", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://mantel.example/bedrock/model/mantel.chat-v1/converse");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("mantel-key");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      return Response.json({
        output: { message: { content: [{ text: "Hi from Mantel" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "mantel",
      displayName: "Mantel",
      enabled: true,
      config: {
        region: "us-east-1",
        auth: "api-key",
        model: "mantel.chat-v1",
        url: "https://mantel.example/bedrock/",
        apiKeyEnv: "MANTEL_API_KEY",
        apiKeyHeader: "x-api-key",
      },
      environment: { MANTEL_API_KEY: "mantel-key" },
    });

    await expect(instance.generateText?.("Hello Mantel")).resolves.toBe("Hi from Mantel");
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("prefers AWS signing on native Bedrock unless API-key mode is explicit", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE\//u);
      expect(headers.get("x-api-key")).toBeNull();
      return Response.json({
        output: { message: { content: [{ text: "aws path" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-native",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        BEDROCK_API_KEY: "bedrock-key",
      },
    });

    await expect(instance.generateText?.("Hello")).resolves.toBe("aws path");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("honors explicit AWS auth for a custom endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://mantel.example/bedrock/model/custom-model/converse");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFIXTURE\//u);
      expect(headers.get("x-api-key")).toBeNull();
      return Response.json({
        output: { message: { content: [{ text: "signed custom endpoint" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-custom-aws",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", url: "https://mantel.example/bedrock", model: "custom-model", auth: "aws" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
      },
    });

    await expect(instance.generateText?.("Hello")).resolves.toBe("signed custom endpoint");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("uses the inference-profile Bedrock path for inference profile identifiers", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/inference-profile/us.acme.inference-profile-v1/converse");
      return Response.json({
        output: { message: { content: [{ text: "profile path" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-profile-path",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2", model: "us.acme.inference-profile-v1" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
      },
    });

    await expect(instance.generateText?.("Hello")).resolves.toBe("profile path");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await instance.dispose();
  });

  it("rejects a successful response with an invalid Bedrock body shape", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ usage: { inputTokens: 1, outputTokens: 1 } })));
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-invalid-shape",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", auth: "api-key" },
      environment: { BEDROCK_API_KEY: "bedrock-key" },
    });

    await expect(instance.generateText?.("Hello")).rejects.toThrow("Bedrock returned an invalid response shape");
    await instance.dispose();
  });

  it("surfaces top-level provider messages from successful error payloads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ message: "Model warming up" })));
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-top-level-message",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-east-1", auth: "api-key" },
      environment: { BEDROCK_API_KEY: "bedrock-key" },
    });

    await expect(instance.generateText?.("Hello")).rejects.toThrow("Bedrock HTTP 200: Model warming up");
    await instance.dispose();
  });

  it("does not duplicate the active prompt when the transcript already includes it", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        messages: [
          { role: "user", content: [{ text: "Hello once" }] },
        ],
      });
      return Response.json({
        output: { message: { content: [{ text: "ok" }] } },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
      },
    });
    const recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({
      threadId: "thread-dedupe",
      text: "Hello once",
      transcript: [{ role: "user", text: "Hello once" }],
    });
    await recorder.until((event) => event.type === "turn.completed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    recorder.stop();
    await instance.dispose();
  });

  it("reports an interrupted turn when the request is aborted", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const instance = await BedrockDriver.create({
      instanceId: "bedrock",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2" },
      environment: {
        AWS_ACCESS_KEY_ID: "AKIAFIXTURE",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
      },
    });
    const recorder = recordEvents(instance.adapter);

    const { turnId } = await instance.adapter.sendTurn({ threadId: "thread-2", text: "cancel me" });
    await instance.adapter.interruptTurn("thread-2", turnId);
    const completed = await recorder.until((event) => event.type === "turn.completed");

    expect(completed).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(recorder.events).not.toContainEqual(expect.objectContaining({ type: "runtime.error" }));
    recorder.stop();
    await instance.dispose();
  });
});
