// Offline AWS wire fixture. Tests supply synthetic credentials; it never
// forwards requests, and deliberately returns models from multiple regions
// so consumers must honor the source region and profile destinations.
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { FoundationModelSummary, InferenceProfileSummary } from "@aws-sdk/client-bedrock";

export const BEDROCK_FIXTURE_TOKEN = "synthetic-bedrock-token-do-not-use";
export const BEDROCK_FIXTURE_KEY = "AKIAFIXTURE0000000000";
export const BEDROCK_FIXTURE_SECRET = "synthetic-bedrock-secret-do-not-use";
export const BEDROCK_FIXTURE_SESSION = "synthetic-bedrock-session-do-not-use";

export const modelArn = (model: string, region = "us-east-1") => `arn:aws:bedrock:${region}::foundation-model/${model}`;
export const profileArn = (id: string, region = "us-east-1", application = false) => `arn:aws:bedrock:${region}:123456789012:${application ? "application-inference-profile" : "inference-profile"}/${id}`;
export const foundation = (id: string, region = "us-east-1", overrides: Partial<FoundationModelSummary> = {}): FoundationModelSummary => ({
  modelId: id, modelArn: modelArn(id, region), modelName: id, providerName: id.split(".")[0],
  inputModalities: ["TEXT"], outputModalities: ["TEXT"], inferenceTypesSupported: ["ON_DEMAND"], responseStreamingSupported: true, ...overrides,
});
export const profile = (id: string, model: string, destinations = ["us-east-1", "us-west-2"], source = "us-east-1", application = false): InferenceProfileSummary => ({
  inferenceProfileId: id, inferenceProfileArn: profileArn(id, source, application), inferenceProfileName: id,
  status: "ACTIVE", type: application ? "APPLICATION" : "SYSTEM_DEFINED", models: destinations.map((region) => ({ modelArn: modelArn(model, region) })),
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Amazon event-stream framing, including both CRCs, independently encoded
 * here so native tests exercise the SDK's actual HTTP/event decoder. */
export function bedrockFrame(event: string, payload: unknown): Buffer {
  const headers = Buffer.concat(Object.entries({ ":message-type": "event", ":event-type": event, ":content-type": "application/json" }).map(([name, value]) => {
    const key = Buffer.from(name); const text = Buffer.from(value);
    const header = Buffer.alloc(1 + key.length + 1 + 2 + text.length);
    header[0] = key.length; key.copy(header, 1); header[1 + key.length] = 7;
    header.writeUInt16BE(text.length, key.length + 2); text.copy(header, key.length + 4);
    return header;
  }));
  const body = Buffer.from(JSON.stringify(payload));
  const frame = Buffer.alloc(16 + headers.length + body.length);
  frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12); body.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
  return frame;
}

export function converseStream(response: ServerResponse, events: Array<[string, unknown]>) {
  response.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
  for (const [event, body] of events) response.write(bedrockFrame(event, body));
  response.end();
}
export function converseAnswer(response: ServerResponse, text = "Hello from Bedrock.") {
  converseStream(response, [
    ["messageStart", { role: "assistant" }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { text } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["messageStop", { stopReason: "end_turn" }],
    ["metadata", { usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15, cacheReadInputTokens: 2, cacheWriteInputTokens: 3 }, metrics: { latencyMs: 1 } }],
  ]);
}

export function messagesStream(response: ServerResponse, events: Array<{ type: string; [key: string]: unknown }>) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
}

export interface BedrockWireRequest { path: string; url: URL; method?: string; headers: IncomingHttpHeaders; body: Record<string, any> }
export interface FakeBedrockOptions {
  basePath?: string;
  models?: FoundationModelSummary[];
  profiles?: InferenceProfileSummary[];
  unavailable?: string[];
  mantleModels?: string[];
  handle?(request: BedrockWireRequest, response: ServerResponse): boolean | void | Promise<boolean | void>;
}

export async function fakeBedrock(options: FakeBedrockOptions = {}) {
  const requests: BedrockWireRequest[] = [];
  const models = options.models ?? [foundation("amazon.nova-lite-v1:0", "us-east-1", { inputModalities: ["TEXT", "IMAGE"] }),
    foundation("anthropic.claude-sonnet-4-6", "us-east-1", { inputModalities: ["TEXT", "IMAGE"] }),
    foundation("qwen.qwen3-32b-v1:0", "us-west-2"), foundation("mistral.mistral-large-2407-v1:0", "eu-west-1"),
    foundation("amazon.titan-embed-text-v2:0", "us-east-1", { outputModalities: ["EMBEDDING"] })];
  const profiles = options.profiles ?? [
    profile("us.amazon.nova-lite-v1:0", "amazon.nova-lite-v1:0"),
    profile("global.anthropic.claude-sonnet-4-6", "anthropic.claude-sonnet-4-6", ["us-east-1", "eu-west-1"]),
    profile("opaque-claude", "anthropic.claude-sonnet-4-6", ["us-east-1"], "us-east-1", true),
    profile("eu.mistral.mistral-large-2407-v1:0", "mistral.mistral-large-2407-v1:0", ["eu-west-1"], "eu-west-1"),
  ];
  const server = createServer(async (req, res) => {
    const json = (body: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url ?? "/", "http://fixture.invalid");
      let source = ""; for await (const chunk of req) source += chunk;
      const request: BedrockWireRequest = { path: url.pathname, url, method: req.method, headers: req.headers, body: source ? JSON.parse(source) : {} };
      requests.push(request);
      if (await options.handle?.(request, res)) return;
      const path = options.basePath ? request.path.slice(options.basePath.length) : request.path;
      if (path === "/foundation-models") return json({ modelSummaries: models });
      if (path.startsWith("/foundation-model/")) {
        const id = decodeURIComponent(path.slice("/foundation-model/".length));
        const model = models.find((entry) => entry.modelId === id || entry.modelArn === id);
        return model ? json({ modelDetails: model }) : json({ message: "Unknown fixture foundation model" }, 404);
      }
      if (path.startsWith("/foundation-model-availability/")) return json({ regionAvailability: options.unavailable?.includes(decodeURIComponent(path.split("/").at(-1)!)) ? "NOT_AVAILABLE" : "AVAILABLE" });
      if (path === "/inference-profiles") {
        const page = url.searchParams.get("nextToken") ? 1 : 0;
        return json({ inferenceProfileSummaries: page ? profiles.slice(2) : profiles.slice(0, 2), ...(page || profiles.length <= 2 ? {} : { nextToken: "page-2" }) });
      }
      if (path.startsWith("/inference-profiles/")) {
        const id = decodeURIComponent(path.slice("/inference-profiles/".length));
        const found = profiles.find((entry) => entry.inferenceProfileId === id || entry.inferenceProfileArn === id);
        return found ? json(found) : json({ message: "Unknown fixture profile" }, 404);
      }
      if (path === "/v1/models") return json({ data: (options.mantleModels ?? ["openai.gpt-oss-120b", "moonshot.kimi-k2.5", "anthropic.claude-sonnet-4-6"]).map((id) => ({ id })) });
      if (path.endsWith("/converse-stream")) { converseAnswer(res); return; }
      if (path.endsWith("/converse")) return json({ output: { message: { role: "assistant", content: [{ text: "Helper response." }] } }, stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
      if (path.endsWith("/chat/completions")) {
        if (!request.body.stream) return json({ choices: [{ message: { content: "Helper response." }, finish_reason: "stop" }] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"choices":[{"index":0,"delta":{"content":"Hello from Bedrock chat."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'); return;
      }
      if (path === "/anthropic/v1/messages") {
        if (!request.body.stream) return json({ content: [{ type: "text", text: "Helper response." }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 2 } });
        const events = [
          { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Bedrock Messages." } },
          { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }, { type: "message_stop" },
        ];
        messagesStream(res, events); return;
      }
      json({ message: `Unknown fixture endpoint: ${path}` }, 404);
    } catch { if (!res.headersSent) json({ message: "Invalid fixture request" }, 400); else res.destroy(); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bedrock fixture did not listen");
  return { url: `http://127.0.0.1:${address.port}${options.basePath ?? ""}`, requests, models, profiles,
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

// The only side effect is one fixed artifact path supplied by the test.
export const BEDROCK_MCP_FIXTURE = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  if (request.method === "initialize") result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
  else if (request.method === "tools/list") result = { tools: [{ name: "write", description: "Write a disposable Bedrock receipt", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }] };
  else if (request.method === "tools/call") { writeFileSync(process.env.FIXTURE_ARTIFACT, request.params.arguments.value); result = { content: [{ type: "text", text: "receipt written" }] }; }
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
});
`;
