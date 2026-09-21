import { createHash, createHmac } from "node:crypto";

import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";

const DRIVER_KIND = "bedrock";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_MODELS: ModelCatalog = {
  default: "amazon.nova-lite-v1:0",
  options: [
    { id: "amazon.nova-lite-v1:0", label: "Amazon Nova Lite", custom: true },
    { id: "amazon.nova-pro-v1:0", label: "Amazon Nova Pro", custom: true },
    { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet", custom: true },
    { id: "meta.llama3-3-70b-instruct-v1:0", label: "Llama 3.3 70B Instruct", custom: true },
  ],
};

export interface BedrockConfig {
  region: string;
  model?: string;
}

interface BedrockCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

interface ConverseMessage {
  role: "user" | "assistant";
  content: Array<{ text: string }>;
}

interface Usage {
  input: number;
  output: number;
}

interface BedrockCompletion {
  text: string;
  usage: Usage | null;
}

interface BedrockResponse {
  output?: {
    message?: {
      content?: Array<{ text?: unknown }>;
    };
  };
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
  };
  message?: unknown;
  error?: unknown;
  __type?: unknown;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function timestamp(now: Date) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function credentialsFrom(environment: Record<string, string>): BedrockCredentials {
  const accessKeyId = environment.AWS_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = environment.AWS_SECRET_ACCESS_KEY?.trim() || "";
  const sessionToken = environment.AWS_SESSION_TOKEN?.trim() || undefined;
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function hasCredentials(credentials: BedrockCredentials): boolean {
  return Boolean(credentials.accessKeyId && credentials.secretAccessKey);
}

function regionFrom(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || DEFAULT_REGION;
}

function catalogFor(config: BedrockConfig): ModelCatalog {
  if (!config.model || DEFAULT_MODELS.options.some((option) => option.id === config.model)) return DEFAULT_MODELS;
  return {
    default: config.model,
    options: [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
  };
}

function normalizeHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalPathSegment(segment: string): string {
  return segment
    .split(/(%[0-9A-Fa-f]{2})/g)
    .filter(Boolean)
    .map((part) => /^%[0-9A-Fa-f]{2}$/.test(part) ? part.toUpperCase() : encodeRfc3986(part))
    .join("");
}

function canonicalUri(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => canonicalPathSegment(segment))
    .join("/");
}

export function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join("&");
}

function signedHeadersFor(
  method: "GET" | "POST",
  url: URL,
  region: string,
  body: string,
  credentials: BedrockCredentials,
  now = new Date(),
): Record<string, string> {
  const { amzDate, dateStamp } = timestamp(now);
  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${normalizeHeaderValue(headers[name]!)}`).join("\n");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method,
    canonicalUri(url),
    canonicalQuery(url),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${region}/bedrock/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(
        hmac(`AWS4${credentials.secretAccessKey}`, dateStamp),
        region,
      ),
      "bedrock",
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function safeText(text: string, secrets: string[]): string {
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[redacted]");
  return redactSecretsInText(safe);
}

function safeError(value: unknown, secrets: string[]): string {
  const text = value instanceof Error ? value.message : String(value);
  return safeText(text, secrets).slice(0, 2_000);
}

function awsDomainSuffix(region: string): string {
  return region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
}

function converseUrl(region: string, model: string): URL {
  return new URL(`https://bedrock-runtime.${region}.${awsDomainSuffix(region)}/model/${encodeURIComponent(model)}/converse`);
}

function messagesFor(turn: Pick<SendTurnInput, "text" | "transcript">): ConverseMessage[] {
  const transcript = (turn.transcript ?? [])
    .filter((message): message is { role: "user" | "assistant"; text: string } =>
      (message.role === "user" || message.role === "assistant") && Boolean(message.text.trim()))
    .map((message) => ({ role: message.role, content: [{ text: message.text }] }));
  const last = transcript.at(-1);
  if (last?.role === "user" && last.content[0]?.text === turn.text) return transcript;
  return [...transcript, { role: "user", content: [{ text: turn.text }] }];
}

function decodeResponse(json: BedrockResponse): BedrockCompletion {
  const parts = Array.isArray(json.output?.message?.content) ? json.output?.message?.content : [];
  const text = parts
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("");
  const input = typeof json.usage?.inputTokens === "number" ? json.usage.inputTokens : null;
  const output = typeof json.usage?.outputTokens === "number" ? json.usage.outputTokens : null;
  return {
    text,
    usage: input === null && output === null ? null : { input: input ?? 0, output: output ?? 0 },
  };
}

function parseJsonBody(text: string): BedrockResponse | null {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as BedrockResponse;
  } catch {
    return null;
  }
}

function bedrockErrorMessage(body: BedrockResponse | null, includeTopLevelMessage: boolean): string | null {
  if (!body) return null;
  if (includeTopLevelMessage && typeof body.message === "string" && body.message.trim()) return body.message;
  if (body.error && typeof body.error === "object" && !Array.isArray(body.error)) {
    const message = (body.error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  if (typeof body.__type === "string" && body.__type.trim()) return body.__type;
  return null;
}

async function callBedrock(
  model: string,
  turn: Pick<SendTurnInput, "system" | "text" | "transcript">,
  config: BedrockConfig,
  credentials: BedrockCredentials,
  secrets: string[],
  maxTokens?: number,
  signal?: AbortSignal,
): Promise<BedrockCompletion> {
  const url = converseUrl(config.region, model);
  const body = JSON.stringify({
    messages: messagesFor(turn),
    ...(turn.system ? { system: [{ text: turn.system }] } : {}),
    ...(maxTokens ? { inferenceConfig: { maxTokens } } : {}),
  });
  const response = await fetch(url, {
    method: "POST",
    headers: signedHeadersFor("POST", url, config.region, body, credentials),
    body,
    signal,
  });
  const raw = await response.text();
  const json = parseJsonBody(raw);
  const bodyMessage = bedrockErrorMessage(json, !response.ok);
  if (!response.ok) {
    const detail = bodyMessage ?? raw.slice(0, 200);
    throw new Error(`Bedrock HTTP ${response.status}${detail ? `: ${safeText(detail, secrets)}` : ""}`);
  }
  if (bodyMessage) throw new Error(`Bedrock HTTP ${response.status}: ${safeText(bodyMessage, secrets)}`);
  if (!json) throw new Error("Bedrock returned no JSON response");
  return decodeResponse(json);
}

function missingCredentialReason(config: BedrockConfig): string {
  return `missing AWS credentials for Bedrock — set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for region ${regionFrom(config.region)}`;
}

function snapshotFailure(message: string): ProviderSnapshot | null {
  return /\bBedrock HTTP (400|401|403|404)\b/.test(message)
    ? { state: "unavailable", reason: message }
    : null;
}

export function decodeBedrockConfig(raw: unknown): BedrockConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  const model = typeof config.model === "string" && config.model.trim()
    ? config.model.trim()
    : undefined;
  return {
    region: regionFrom(config.region),
    ...(model ? { model } : {}),
  };
}

function createBedrockRuntime(input: DriverCreateInput<BedrockConfig>): ProviderInstance {
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
  }>();
  const credentials = credentialsFrom(input.environment);
  const catalog = catalogFor(input.config);
  const secrets = [credentials.accessKeyId, credentials.secretAccessKey, credentials.sessionToken ?? ""];
  let snapshotCache: ProviderSnapshot | null = null;
  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: DRIVER_KIND,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const sendTurn = async (turn: SendTurnInput) => {
    if (!hasCredentials(credentials)) throw new Error(missingCredentialReason(input.config));
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    const turnId = newId();
    const abort = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    active.set(turn.threadId, { abort, turnId, done });
    const model = turn.model || catalog.default;
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });
    void (async () => {
      let ok = false;
      let stopReason: string | null = null;
      let usage: Usage | undefined;
      let failure: string | undefined;
      try {
        const completion = await callBedrock(model, turn, input.config, credentials, secrets, undefined, abort.signal);
        if (completion.usage) {
          usage = completion.usage;
          emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...completion.usage });
        }
        const reply = completion.text.trim();
        if (!reply) throw new Error("provider returned an empty response");
        emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply, secrets) });
        ok = true;
        snapshotCache = { state: "available", authenticated: true, version: null, billing: "metered" };
      } catch (error) {
        stopReason = abort.signal.aborted ? "interrupted" : "error";
        failure = safeError(error, secrets);
        if (!abort.signal.aborted) snapshotCache = snapshotFailure(failure) ?? snapshotCache;
      } finally {
        if (abort.signal.aborted) {
          ok = false;
          stopReason = "interrupted";
        }
        if (failure && !abort.signal.aborted) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: failure, terminal: true });
        }
        active.delete(turn.threadId);
        emit({
          ...base(turn.threadId, turnId),
          type: "turn.completed",
          ok,
          stopReason,
          cost: null,
          ...(usage ? { usage } : {}),
        });
        resolveDone();
      }
    })();
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    if (!hasCredentials(credentials)) return { state: "unavailable", reason: missingCredentialReason(input.config) };
    return snapshotCache ?? {
      state: "available",
      authenticated: false,
      version: null,
      billing: "metered",
      warning: {
        title: "Validation deferred until first use",
        message: "Bedrock runtime access is checked when this instance handles its first request.",
      },
    };
  };

  return {
    instanceId: input.instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    models: catalog,
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: { sessionModelSwitch: "in-session" },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const current = active.get(threadId);
        if (!current || (turnId && current.turnId !== turnId)) return;
        current.abort.abort();
        await current.done;
      },
      respondToRequest: async () => "unavailable",
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const running = [...active.values()];
        for (const turn of running) turn.abort.abort();
        await Promise.all(running.map((turn) => turn.done));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt, { signal } = {}) => {
      if (!hasCredentials(credentials)) throw new Error(missingCredentialReason(input.config));
      try {
        // Helper calls are instance-scoped summaries/titles, so they stay on
        // the instance's configured default instead of taking a per-turn model.
        const completion = await callBedrock(
          catalog.default,
          { text: prompt },
          input.config,
          credentials,
          secrets,
          undefined,
          signal,
        );
        if (!completion.text.trim()) throw new Error("provider returned an empty response");
        snapshotCache = { state: "available", authenticated: true, version: null, billing: "metered" };
        return completion.text.trim();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        snapshotCache = snapshotFailure(safeError(error, secrets)) ?? snapshotCache;
        throw error;
      }
    },
    dispose: async () => {
      const running = [...active.values()];
      for (const turn of running) turn.abort.abort();
      await Promise.all(running.map((turn) => turn.done));
      listeners.clear();
    },
  };
}

export const BedrockDriver: ProviderDriver<BedrockConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Amazon Bedrock",
    supportsMultipleInstances: true,
    access: "custom",
  },
  install: {
    docsUrl: "https://docs.aws.amazon.com/bedrock/",
  },
  decodeConfig: decodeBedrockConfig,
  defaultConfig: () => decodeBedrockConfig({}),
  models: DEFAULT_MODELS,
  async create(input) {
    return createBedrockRuntime(input);
  },
};
