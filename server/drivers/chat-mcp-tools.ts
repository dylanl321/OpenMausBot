// Per-turn MCP transport for the shared Chat Completions runtime. Approval is
// owned by the caller; only registered, schema-validated calls reach this file.
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import { stripControlPlaneEnv } from "../config.ts";
import type { McpServerSpec, SendTurnInput } from "../contracts.ts";
import { RemoteMcpClient } from "../mcp-http.ts";
import { augmentedPath } from "../env-path.ts";
import { killCliTree, spawnCli } from "../procs.ts";
import { chatImage, type ChatImagePart } from "./chat-images.ts";
import { ChatBoxClient } from "./chat-box-tools.ts";

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ChatToolResult { text: string; ok: boolean; images?: ChatImagePart[] }
/** The transport cannot safely continue this turn. A dispatched operation may
 * already have taken effect, so callers must not retry it through a new round. */
export class ChatToolSessionError extends Error {}
export interface ChatToolSession {
  definitions: ChatToolDefinition[];
  validate(name: string, args: unknown): void;
  approvalScope(name: string): "local-computer" | undefined;
  execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ChatToolResult>;
  close(): Promise<void>;
}

type Server = { command: string; args: string[]; env: Record<string, string> };
type BoxDescriptor = NonNullable<NonNullable<SendTurnInput["integrations"]>["computer"]>;
const STARTUP_MS = 8_000;
const CALL_MS = 10 * 60_000;
const FRAME_BYTES = 2 * 1024 * 1024;
const OUTPUT_BYTES = 50 * 1024;
const TOOL_COUNT = 128;
const MAX_PAGES = 100;
const SCHEMA_BYTES = 64 * 1024;
const CATALOG_BYTES = 1024 * 1024;
const MAX_FRAMES = 10_000;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function aborted(): Error { return new Error("MCP operation cancelled"); }

/** These servers are a chat-runtime bot's tools, the counterpart of an engine
 * CLI's children: the operator's control-plane secrets never ride along. What
 * the server entry itself names is a deliberate grant and is applied last. */
export function chatMcpEnvironment(serverEnv: Record<string, string>, source: NodeJS.ProcessEnv = process.env, privateEnvironment: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, PATH: augmentedPath() };
  stripControlPlaneEnv(env);
  for (const key of ["OMB_BEDROCK_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "BEDROCK_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", ...privateEnvironment]) delete env[key];
  return { ...env, ...serverEnv };
}

class ChatMcpClient {
  private readonly frameBytes: number;
  private child: ReturnType<typeof spawnCli>;
  private buffer = "";
  private nextId = 1;
  private frames = 0;
  private initialized = false;
  private toolsChanged = false;
  private closed = false;
  private closing?: Promise<void>;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(server: Server, images = false, privateEnvironment: readonly string[] = []) {
    this.frameBytes = images ? 32 * 1024 * 1024 : FRAME_BYTES;
    try {
      // The desktop shell inherits Finder's bare PATH, where `npx`-style
      // servers cannot find `node` and exit at once. Widen it the way the
      // Claude and Codex drivers do; a PATH the user set on the server wins.
      this.child = spawnCli(server.command, server.args, {
        stdio: ["pipe", "pipe", "pipe"], env: chatMcpEnvironment(server.env, process.env, privateEnvironment),
      });
    } catch { throw new Error("MCP server could not start; check its command and installation"); }
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Stderr may contain credentials; drain without recording or returning it.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail(new Error("MCP server could not start; check its command and installation")));
    this.child.on("exit", () => this.fail(new Error("MCP server exited before the session closed")));
    this.child.stdin.on("error", () => this.fail(new Error("MCP server input closed")));
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
    // Capture rejection here; mount/execute finally await close and surface it.
    void this.close().catch(() => {});
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const entry of this.pending.values()) entry.reject(new Error("MCP session closed"));
    this.pending.clear();
    this.buffer = "";
    // Confirm within the codebase-default grace: Windows reaps the tree via
    // taskkill /T, which can exceed shorter budgets on a loaded machine.
    this.closing = killCliTree(this.child, 5_000).then((stopped) => {
      if (!stopped) throw new Error("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return this.closing;
  }

  private write(frame: unknown): void {
    if (this.closed || !this.child.stdin.writable || this.child.stdin.destroyed) throw new Error("MCP session closed");
    const encoded = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(encoded) > this.frameBytes) throw new Error("MCP request exceeds the frame limit");
    this.child.stdin.write(encoded);
  }

  private onData(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (++this.frames > MAX_FRAMES) return this.fail(new Error("MCP session exceeded the response frame count limit"));
      if (Buffer.byteLength(line) > this.frameBytes) return this.fail(new Error("MCP response exceeds the frame limit"));
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); }
      catch { return this.fail(new Error("MCP server returned invalid JSON")); }
      if (!object(message) || message.jsonrpc !== "2.0") return this.fail(new Error("MCP server returned an invalid RPC envelope"));
      if (typeof message.method === "string") {
        if (message.id === undefined && message.method === "notifications/tools/list_changed") {
          this.toolsChanged = true;
          continue;
        }
        if (typeof message.id === "number" || typeof message.id === "string") {
          try { this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method not supported" } }); }
          catch { return this.fail(new Error("MCP server input closed")); }
        }
        continue;
      }
      if (typeof message.id !== "number") return this.fail(new Error("MCP server returned an invalid response ID"));
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      if ("error" in message) entry.reject(new Error("MCP request failed; inspect the configured integration"));
      else if (!("result" in message)) entry.reject(new Error("MCP response has no result"));
      else entry.resolve(message.result);
    }
    if (Buffer.byteLength(this.buffer) > this.frameBytes) this.fail(new Error("MCP response exceeds the frame limit"));
  }

  async call(method: string, params: unknown, signal: AbortSignal, timeout: number): Promise<unknown> {
    if (signal.aborted) { await this.close(); throw aborted(); }
    if (this.closed) throw new Error("MCP session closed");
    const id = this.nextId++;
    try {
      return await new Promise((resolve, reject) => {
        const finish = (error?: Error, value?: unknown) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          this.pending.delete(id);
          if (error) reject(error); else resolve(value);
        };
        const cancel = () => {
          try { this.write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "Cancelled" } }); }
          catch { /* cleanup owns transport failure */ }
          finish(aborted());
        };
        const timer = setTimeout(() => finish(new Error("MCP request timed out; execution outcome may be uncertain")), timeout);
        timer.unref();
        signal.addEventListener("abort", cancel, { once: true });
        this.pending.set(id, { resolve: (value) => finish(undefined, value), reject: (error) => finish(error) });
        try { this.write({ jsonrpc: "2.0", id, method, params }); }
        catch { finish(new Error("MCP request could not be sent")); }
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async tools(signal: AbortSignal): Promise<unknown[]> {
    const deadline = Date.now() + STARTUP_MS;
    const remaining = () => {
      if (Date.now() >= deadline) throw new Error("MCP startup timed out");
      return deadline - Date.now();
    };
    if (!this.initialized) {
      const initialized = await this.call("initialize", {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "openmausbot-chat", version: "1" },
      }, signal, remaining());
      if (!object(initialized)) throw new Error("MCP initialization returned an invalid result");
      if (signal.aborted) throw aborted();
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      this.initialized = true;
    }
    this.toolsChanged = false;
    const tools: unknown[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.call("tools/list", cursor ? { cursor } : {}, signal, remaining());
      if (!object(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid result");
      tools.push(...result.tools);
      if (tools.length > TOOL_COUNT) throw new Error("MCP tool count exceeds the 128-tool limit");
      if (result.nextCursor === undefined) return tools;
      if (typeof result.nextCursor !== "string" || !result.nextCursor || cursors.has(result.nextCursor)) throw new Error("MCP tools/list returned an invalid pagination cursor");
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new Error("MCP tools/list exceeded the pagination limit");
  }

  takeToolsChanged(): boolean {
    const changed = this.toolsChanged;
    this.toolsChanged = false;
    return changed;
  }
}

// A schema is a contract, so conversion that drops constraints is not safe.
// Ajv validates the original schema even when a provider needs its top-level
// composition constraints in the description. It does so without coercing values,
// applying defaults, removing fields, or fetching external references.
const validatorOptions = {
  strict: true, allErrors: false, coerceTypes: false, useDefaults: false,
  removeAdditional: false, validateFormats: true, ownProperties: true, logger: false as const,
  // These are style diagnostics, not unsupported validation keywords. Valid
  // schemas may require undeclared names, use untyped composition branches,
  // or describe an open tuple. Ajv still enforces every constraint.
  strictRequired: false, strictTypes: false, strictTuples: false,
};
function compileSchema(schema: Record<string, unknown>): ValidateFunction {
  const dialect = schema.$schema;
  if (dialect !== undefined && dialect !== "http://json-schema.org/draft-07/schema#" && dialect !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("MCP tool schema uses an unsupported dialect; use JSON Schema draft-07 or 2020-12");
  }
  // One compiler per schema also prevents external IDs from resolving against
  // unrelated tools or retaining schemas after the turn has closed.
  const compiler = dialect === "https://json-schema.org/draft/2020-12/schema"
    ? new Ajv2020(validatorOptions) : new Ajv(validatorOptions);
  // ajv-formats is CommonJS and exports the plugin as both module.exports
  // and .default; the latter also matches its NodeNext declaration.
  formats.default(compiler);
  compiler.addFormat("uint32", { type: "number", validate: value => Number.isInteger(value) && value >= 0 && value <= 4294967295 });
  compiler.addFormat("uint64", { type: "number", validate: value => Number.isSafeInteger(value) && value >= 0 });
  try { return compiler.compile(schema); }
  catch { throw new Error("MCP tool schema could not be validated; check its constraints, formats, and references"); }
}

function boundedText(value: string): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= OUTPUT_BYTES) return value;
  let end = OUTPUT_BYTES;
  while ((bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString()}\n[MCP result truncated at 50KB; request less output.]`;
}

export async function mountChatTools(integrations: SendTurnInput["integrations"], signal: AbortSignal,
  settings: { extended?: boolean; computerUse?: boolean; images?: boolean; privateEnvironment?: readonly string[] } | boolean = {},
): Promise<ChatToolSession> {
  const options = typeof settings === "boolean" ? { computerUse: settings, images: settings } : settings;
  const computerUse = Boolean(options.computerUse || options.extended);
  const servers: Array<[string, McpServerSpec | BoxDescriptor, ("local-computer" | undefined)?]> = [];
  if (computerUse && integrations?.computer) servers.push(["computer", integrations.computer]);
  if (computerUse && integrations?.localComputer) servers.push(["computer", integrations.localComputer, integrations.localComputer.scope]);
  if (computerUse && integrations?.browser) servers.push(["browser", integrations.browser]);
  if (integrations?.agents) servers.push(["agents", integrations.agents]);
  if (integrations?.composio) servers.push(["composio", integrations.composio]);
  if (options.extended) {
    if (integrations?.phone) servers.push(["phone", integrations.phone]);
  }
  // Native transports can also mount remote MCP descriptors. Other chat
  // providers retain their existing stdio-only custom server contract.
  for (const [name, server] of Object.entries(integrations?.custom ?? {})) {
    if ("command" in server || options.extended) servers.push([name, server]);
  }
  if (servers.length > 32) throw new Error("MCP server count exceeds the 32-server limit");
  type Client = Pick<ChatMcpClient, "call" | "close" | "tools"> & { takeToolsChanged?(): boolean };
  const clients: Client[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    signal.removeEventListener("abort", cancel);
    closing = Promise.allSettled(clients.map((client) => client.close())).then((results) => {
      if (results.some((result) => result.status === "rejected")) throw new ChatToolSessionError("MCP server shutdown could not be confirmed; execution outcome may be uncertain");
    });
    return closing;
  };
  const cancel = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const definitions: ChatToolDefinition[] = [];
  const registered = new Map<string, { client: Client; name: string; schema: ValidateFunction; scope?: "local-computer" }>();
  const mounted: Array<{ server: string; client: Client; tools: unknown[]; scope?: "local-computer" }> = [];
  // A newly discovered name must not steal a name a pending call already
  // references, even when two servers' normalized names collide.
  const names = new Map<Client, Map<string, string>>();
  const reservedNames = new Set<string>();
  const rebuildCatalog = () => {
    const nextDefinitions: ChatToolDefinition[] = [];
    const nextRegistered = new Map<string, { client: Client; name: string; schema: ValidateFunction; scope?: "local-computer" }>();
    for (const { server, client, tools, scope } of mounted) {
      const originalNames = new Set<string>();
      for (const tool of tools) {
        if (!object(tool) || typeof tool.name !== "string" || !tool.name.trim() || originalNames.has(tool.name)) throw new Error("MCP server advertised an invalid or duplicate tool name");
        originalNames.add(tool.name);
        if (nextDefinitions.length >= TOOL_COUNT) throw new Error("MCP tool count exceeds the 128-tool limit");
        if (!object(tool.inputSchema) || tool.inputSchema.type !== "object") throw new Error("MCP tools require an object input schema");
        if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > SCHEMA_BYTES) throw new Error("MCP tool schema exceeds the 64KB limit");
        const schema = compileSchema(tool.inputSchema);
        const parameters = { ...tool.inputSchema };
        const constraints: Record<string, unknown> = {};
        if (computerUse) {
          for (const key of ["anyOf", "oneOf", "allOf", "not"]) {
            if (key in parameters) { constraints[key] = parameters[key]; delete parameters[key]; }
          }
        }
        const description = (typeof tool.description === "string" ? tool.description : "Configured MCP tool") +
          (Object.keys(constraints).length ? " Additional argument constraints (validated before execution): " + JSON.stringify(constraints) : "");
        const base = `${server}_${tool.name}`.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "mcp_tool";
        const clientNames = names.get(client) ?? new Map<string, string>();
        names.set(client, clientNames);
        let name = clientNames.get(tool.name);
        if (!name) {
          name = base;
          for (let index = 2; reservedNames.has(name); index += 1) { const suffix = `_${index}`; name = base.slice(0, 64 - suffix.length) + suffix; }
          clientNames.set(tool.name, name);
          reservedNames.add(name);
        }
        nextRegistered.set(name, { client, name: tool.name, schema, scope });
        nextDefinitions.push({ type: "function", function: { name, description, parameters } });
        if (Buffer.byteLength(JSON.stringify(nextDefinitions)) > CATALOG_BYTES) throw new Error("MCP tool catalog exceeds the 1MB limit");
      }
    }
    definitions.splice(0, definitions.length, ...nextDefinitions);
    registered.clear();
    for (const [name, tool] of nextRegistered) registered.set(name, tool);
  };
  try {
    if (signal.aborted) throw aborted();
    // Start independent servers concurrently; consume results in config order
    // so names and collision suffixes remain stable across startup timings.
    const mounts = await Promise.allSettled(servers.map(async ([name, descriptor, scope]) => {
      if (signal.aborted || closed) throw aborted();
      const client: Client = "boxId" in descriptor ? new ChatBoxClient(descriptor)
        : "command" in descriptor ? new ChatMcpClient(descriptor, options.images, options.privateEnvironment) : remoteChatClient(descriptor);
      clients.push(client);
      return { name, client, scope, tools: await client.tools(signal) };
    }));
    for (const mount of mounts) {
      if (mount.status === "rejected") throw mount.reason;
      mounted.push({ server: mount.value.name, client: mount.value.client, tools: mount.value.tools, scope: mount.value.scope });
    }
    rebuildCatalog();
    if (signal.aborted || closed) throw aborted();
  } catch (error) { await close(); throw error; }
  const validate = (name: string, args: unknown) => {
    if (closed || signal.aborted) throw new ChatToolSessionError("MCP session closed");
    const tool = registered.get(name);
    if (!tool) throw new Error("The requested tool was not advertised for this turn");
    if (!object(args) || !tool.schema(args)) throw new Error("Tool arguments do not match the advertised input schema; use its required fields and types");
  };
  return {
    definitions, validate, close,
    approvalScope: (name) => registered.get(name)?.scope,
    async execute(name, args, callSignal) {
      validate(name, args);
      if (callSignal.aborted) { await close(); throw aborted(); }
      const tool = registered.get(name)!;
      try {
        const result = await tool.client.call("tools/call", { name: tool.name, arguments: args }, AbortSignal.any([signal, callSignal]), CALL_MS);
        if (signal.aborted || callSignal.aborted) throw aborted();
        // Lazy MCP servers announce newly mounted tools after a discovery
        // call. Refresh before the next model completion so those tools are
        // actually available in the same turn.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (tool.client.takeToolsChanged?.()) {
          const mount = mounted.find((candidate) => candidate.client === tool.client);
          if (!mount) throw new Error("MCP catalog owner is unavailable");
          mount.tools = await tool.client.tools(AbortSignal.any([signal, callSignal]));
          rebuildCatalog();
        }
        if (!object(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== "boolean")) throw new Error("MCP tool returned an invalid result; execution outcome may be uncertain");
        const parts: string[] = [];
        const images: ChatImagePart[] = [];
        let unsupported = 0;
        for (const item of result.content) {
          if (!object(item) || typeof item.type !== "string" || (item.type === "text" && typeof item.text !== "string")) throw new Error("MCP tool returned invalid content; execution outcome may be uncertain");
          if (item.type === "text") parts.push(item.text as string);
          else if (options.images && item.type === "image") images.push(chatImage(item));
          else unsupported += 1;
        }
        if (result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
        if (unsupported) parts.unshift(`[${unsupported} unsupported MCP content item(s) omitted. The operation may have taken effect, but its full result cannot be represented; inspect its state before retrying.]`);
        return { text: boundedText(parts.join("\n") || (images.length ? "Screenshot captured." : "(empty result)")), ok: result.isError !== true && unsupported === 0,
          ...(images.length ? { images } : {}),
        };
      } catch (error) {
        await close();
        throw new ChatToolSessionError(error instanceof Error ? error.message : "MCP transport failed; execution outcome may be uncertain");
      }
    },
  };
}

/** Reuse the harness's bounded HTTP/SSE client. A failed call is never
 * replayed: its operation may already have taken effect. */
function remoteChatClient(descriptor: Exclude<McpServerSpec, Server>): Pick<ChatMcpClient, "call" | "close" | "tools"> {
  const client = new RemoteMcpClient(descriptor);
  return {
    close: () => client.close(),
    call: (method, params, signal, timeout) => client.request(method, params, AbortSignal.any([signal, AbortSignal.timeout(timeout)])),
    async tools(signal) {
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(STARTUP_MS)]);
      await client.initialize("OpenMausBot", bounded);
      const rows: unknown[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await client.request("tools/list", cursor ? { cursor } : {}, bounded);
        if (!object(result) || !Array.isArray(result.tools)) throw new Error("MCP tools/list returned an invalid result");
        rows.push(...result.tools);
        if (rows.length > TOOL_COUNT) throw new Error("MCP tool count exceeds the 128-tool limit");
        if (result.nextCursor === undefined) return rows;
        if (typeof result.nextCursor !== "string" || !result.nextCursor || seen.has(result.nextCursor)) throw new Error("MCP tools/list returned an invalid pagination cursor");
        cursor = result.nextCursor;
        seen.add(cursor);
      }
      throw new Error("MCP tools/list exceeded the pagination limit");
    },
  };
}
