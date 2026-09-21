import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { recordEvents } from "../testing/events.ts";
import { BedrockDriver, decodeBedrockConfig } from "./bedrock.ts";

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
    expect(BedrockDriver.defaultConfig()).toEqual({ region: "us-east-1" });
    expect(decodeBedrockConfig({ region: "eu-west-1", model: "custom.model" })).toEqual({ region: "eu-west-1", model: "custom.model" });
  });

  it("reports unavailable without AWS credentials", async () => {
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
      authenticated: true,
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

  it("adds a custom configured model to the picker catalog", async () => {
    const instance = await BedrockDriver.create({
      instanceId: "bedrock-custom",
      displayName: "Bedrock",
      enabled: true,
      config: { region: "us-west-2", model: "acme.model-v1" },
      environment: { AWS_ACCESS_KEY_ID: "AKIAFIXTURE", AWS_SECRET_ACCESS_KEY: "fixture-secret" },
    });
    expect(instance.models.default).toBe("acme.model-v1");
    expect(instance.models.options[0]).toEqual({ id: "acme.model-v1", label: "acme.model-v1", custom: true });
    await instance.dispose();
  });

  it("sends a converse request and reports the reply", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-lite-v1%3A0/converse");
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
