import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  TurnImageInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { redactSecretsInText } from "../redact.ts";
import { toolDetailPreview } from "../tool-summary.ts";
import { ChatToolSessionError, mountChatTools, type ChatToolDefinition, type ChatToolSession, type ChatToolResult } from "./chat-mcp-tools.ts";
import { assertImageTransport, chatImageBudget, chatToolImages, chatUserContent, type ChatContentPart, type ChatImagePart } from "./chat-images.ts";
import { createChatToolApproval } from "./chat-tool-approval.ts";
import { ChatProtocolError, ChatReasoningDetails, ChatToolCalls, MAX_CHAT_TOOL_CALLS, object, type ChatToolCall } from "./openai-chat-protocol.ts";
import { appendNative } from "./native.ts";
import { classifyError, computeBackoff, interruptibleDelay, RETRY_MAX_ATTEMPTS } from "./retry.ts";

export interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning_details?: Record<string, unknown>[];
  /** Internal transport data, never spread into a Chat Completions body. */
  images?: TurnImageInput[];
  toolImages?: ChatImagePart[];
  nativeContent?: unknown[];
}

export interface ChatUsage {
  input: number;
  output: number;
  cachedInput?: number;
}
type Usage = ChatUsage;

export interface ChatCompletion {
  text: string;
  reasoning: string;
  usage: Usage | null;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  protocolReasoning: string;
  protocolReasoningDetails: Record<string, unknown>[];
  nativeContent?: unknown[];
}
type Completion = ChatCompletion;

function toolOperationKey(call: ChatToolCall): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    const record = object(value);
    if (record) return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  let argumentsKey = call.function.arguments;
  try { argumentsKey = stable(JSON.parse(argumentsKey)); } catch { /* Validation below returns malformed arguments to the model. */ }
  return `${call.function.name}\0${argumentsKey}`;
}

export interface ChatCompletionRequest {
  messages: OpenAIChatMessage[];
  model: string;
  stream: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void;
  tools: ChatToolDefinition[];
}

/** A provider can share the approval/tool lifecycle while owning its native
 * protocol and authentication. A null native completion selects the existing
 * Chat Completions decoder, using request() for its authenticated transport. */
export interface ChatTransport {
  snapshot(): Promise<ProviderSnapshot>;
  validateModel(model: string): void;
  secrets(): readonly string[];
  complete(request: ChatCompletionRequest): Promise<ChatCompletion | null>;
  request(request: ChatCompletionRequest): Promise<Response>;
  features(model: string): { tools: boolean; images: boolean };
  privateEnvironment?: readonly string[];
}

interface CompletionJson {
  choices?: Array<{
    index?: number;
    message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown; reasoning_details?: unknown; tool_calls?: unknown; function_call?: unknown };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  base_resp?: { status_code?: unknown; status_msg?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** The message of a JSON error body a provider returned with HTTP 200.
 *  MiniMax reports auth, balance, and parameter failures as `base_resp`. */
function providerError(json: CompletionJson): string | null {
  if (typeof json.error === "string") return json.error;
  const error = object(json.error);
  if (error) return typeof error.message === "string" ? error.message : "unknown error";
  const code = json.base_resp?.status_code;
  if (typeof code === "number" && code !== 0) {
    const msg = typeof json.base_resp?.status_msg === "string" ? json.base_resp.status_msg : "";
    return `upstream error ${code}${msg ? `: ${msg}` : ""}`;
  }
  return null;
}

interface NativeLog {
  source: string;
  outgoing(turn: SendTurnInput, messages: OpenAIChatMessage[], model: string): unknown;
  incoming(completion: Completion): unknown;
}

interface RuntimeOptions<Config> {
  input: DriverCreateInput<Config>;
  driverKind: string;
  apiKey: string;
  apiUrl: string | ((model: string) => string);
  models: () => ModelCatalog;
  requestBody(model: string, messages: OpenAIChatMessage[], stream: boolean): Record<string, unknown>;
  httpErrorLabel: string;
  missingKeyError: string;
  unavailableReason: string;
  timeoutMs: number;
  nativeLog: NativeLog;
  refreshModels?: () => Promise<void>;
  generateModel?: () => string;
  reasoning?: boolean;
  contentText?: (content: unknown) => string;
  billing?: "metered";
  includeUsageInCompleted?: boolean;
  noBodyError?: string;
  retryScale?: number;
  /** Explicit text-only mode for endpoints/models that cannot accept tools. */
  tools?: boolean;
  transport?: ChatTransport;
  /** Operator-configured trust for every tool exposed by this instance. */
  approveToolsWithoutPrompt?: boolean;
  /** Opt-in structured images and harness-authorized computer/browser MCP. */
  computerUse?: boolean;
}

const usageFrom = (usage: CompletionJson["usage"]): Usage | null =>
  usage
    ? { input: usage.prompt_tokens ?? 0, output: usage.completion_tokens ?? 0 }
    : null;

const asError = (value: unknown): Error =>
  value instanceof Error ? value : new Error(String(value));

/** Shared runtime for the three providers that speak OpenAI chat completions. */
export function createOpenAIChatRuntime<Config>(options: RuntimeOptions<Config>): ProviderInstance {
  const { input } = options;
  const listeners = new Set<RuntimeEventListener>();
  const active = new Map<string, {
    abort: AbortController;
    turnId: string;
    done: Promise<void>;
    approval: ReturnType<typeof createChatToolApproval>;
  }>();

  const emit = (event: RuntimeEvent) => {
    for (const listener of Array.from(listeners)) listener(event);
  };
  const base = (threadId: string, turnId: string) => ({
    eventId: newEventId(),
    provider: options.driverKind,
    threadId,
    turnId,
    createdAt: new Date().toISOString(),
  });

  const complete = async (
    messages: OpenAIChatMessage[],
    model: string,
    stream: boolean,
    signal?: AbortSignal,
    onDelta?: (delta: string, kind: "assistant_text" | "reasoning_text") => void,
    tools: ChatToolDefinition[] = [],
  ): Promise<Completion> => {
    options.transport?.validateModel(model);
    const request = { messages, model, stream, signal, onDelta, tools };
    const native = await options.transport?.complete(request);
    if (native) return native;
    // Idle timer that is renewed on every received chunk during streaming
    const timeoutController = new AbortController();
    let idleTimer: NodeJS.Timeout | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timeoutController.abort(new DOMException("Streaming idle timeout elapsed", "AbortError"));
      }, options.timeoutMs);
    };

    resetIdleTimer();

    try {
      const activeSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      const apiUrl = typeof options.apiUrl === "function" ? options.apiUrl(model) : options.apiUrl;
      const response = options.transport
        ? await options.transport.request({ ...request, signal: activeSignal })
        : await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        ...(messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url")) ? { redirect: "error" as const } : {}),
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          ...options.requestBody(model, messages, stream),
          ...(tools.length ? { tools } : {}),
        }),
        signal: activeSignal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`${options.httpErrorLabel} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      }

      if (!stream || response.headers.get("content-type")?.includes("application/json")) {
        const json = await response.json() as CompletionJson;
        const bodyError = providerError(json);
        if (bodyError) throw new ChatProtocolError(`provider returned a completion error: ${bodyError.slice(0, 200)}`);
        const message = json.choices?.[0]?.message;
        if (!message || !object(message) || !["content", "reasoning_content", "reasoning", "reasoning_details", "tool_calls", "function_call"].some((key) => key in message)) {
          throw new ChatProtocolError("provider returned no completion message");
        }
        if (message?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        const calls = new ChatToolCalls();
        calls.add(message?.tool_calls, false);
        const details = new ChatReasoningDetails();
        details.add(message.reasoning_details);
        const reasoning = message.reasoning_content ?? message.reasoning;
        const finishReason = json.choices?.[0]?.finish_reason ?? null;
        activeSignal.throwIfAborted();
        return {
          text: options.contentText ? options.contentText(message?.content) : typeof message?.content === "string" ? message.content : "",
          reasoning: options.reasoning && typeof reasoning === "string"
            ? reasoning
            : "",
          usage: usageFrom(json.usage),
          toolCalls: calls.finish(finishReason, false),
          finishReason,
          protocolReasoning: typeof reasoning === "string" ? reasoning : "",
          protocolReasoningDetails: details.blocks,
        };
      }

      if (!response.body) {
        throw new Error(options.noBodyError ?? `${options.httpErrorLabel} returned no response body`);
      }
      let text = "";
      let reasoning = "";
      let protocolReasoning = "";
      let usage: Usage | null = null;
      let finishReason: string | null = null;
      let malformedFrame = false;
      let sawChoice = false;
      const calls = new ChatToolCalls();
      const details = new ChatReasoningDetails();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeDataLine = (line: string, atEof = false): boolean => {
        if (!line.startsWith("data:")) return false;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return true;
        let chunk: CompletionJson;
        try {
          chunk = JSON.parse(data) as CompletionJson;
        } catch {
          // A tail left in the buffer when the socket closed is an INCOMPLETE
          // frame, not a bad one: a stop, an abort or a dropped connection all
          // end mid-frame. Only a properly newline-terminated frame that will
          // not parse means the provider actually sent something malformed.
          // Counting the tail here turned a stopped turn into a hard,
          // non-retryable failure (`calls.finish(finishReason, malformedFrame)`).
          if (!atEof) malformedFrame = true;
          return false;
        }
        const chunkError = providerError(chunk);
        if (chunkError) throw new ChatProtocolError(`provider returned a streaming completion error: ${chunkError.slice(0, 200)}`);
        const choice = chunk.choices?.find((row) => row.index === undefined || row.index === 0);
        const delta = choice?.delta;
        if (object(delta)) sawChoice = true;
        if (delta?.function_call) throw new ChatProtocolError("legacy function_call is unsupported; use structured tool_calls");
        calls.add(delta?.tool_calls, true);
        details.add(delta?.reasoning_details);
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const reasoningPart = delta?.reasoning_content ?? delta?.reasoning;
        if (typeof reasoningPart === "string") protocolReasoning += reasoningPart;
        const reasoningDelta = options.reasoning && typeof reasoningPart === "string"
          ? reasoningPart
          : "";
        const contentDelta = options.contentText ? options.contentText(delta?.content) : typeof delta?.content === "string" ? delta.content : "";
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          onDelta?.(contentDelta, "assistant_text");
        }
        if (chunk.usage) usage = usageFrom(chunk.usage);
        return false;
      };
      try {
        readLoop: for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            const line = buffer.trim();
            if (line && line !== "data: [DONE]") consumeDataLine(line, true);
            // MiniMax's api.minimax.io/v1 closes the connection after the
            // finish_reason chunk and never sends `[DONE]`.
            if (buffer.trim() === "data: [DONE]" || finishReason) break;
            if (!sawChoice) {
              let body: CompletionJson | undefined;
              try { body = JSON.parse(buffer) as CompletionJson; } catch { body = undefined; }
              const bodyError = body ? providerError(body) : null;
              if (bodyError) throw new ChatProtocolError(`provider returned a completion error: ${bodyError.slice(0, 200)}`);
            }
            throw new ChatProtocolError("Stream ended before completion");
          }
          resetIdleTimer();
          buffer += decoder.decode(value, { stream: true });
          if (buffer.length > 2_000_000) throw new ChatProtocolError("provider stream frame exceeded the size limit");
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (consumeDataLine(line)) break readLoop;
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      activeSignal.throwIfAborted();
      if (!sawChoice) throw new ChatProtocolError("provider returned no streaming completion choice");
      return { text, reasoning, usage, toolCalls: calls.finish(finishReason, malformedFrame), finishReason, protocolReasoning, protocolReasoningDetails: details.blocks };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  const messagesFor = (turn: SendTurnInput): OpenAIChatMessage[] => [
    ...(turn.system ? [{ role: "system" as const, content: turn.system }] : []),
    ...(turn.transcript ?? []).map((message) => ({
      role: message.role,
      content: message.text,
    })),
    { role: "user", content: options.computerUse || options.transport ? chatUserContent(turn) : turn.text },
  ];

  const sendTurn = async (turn: SendTurnInput) => {
    if (!options.transport && !options.apiKey) throw new Error(options.missingKeyError);
    if (active.has(turn.threadId)) throw new Error("a turn is already running on this thread");
    const model = turn.model || options.models().default;
    const apiUrl = typeof options.apiUrl === "function" ? options.apiUrl(model) : options.apiUrl;
    if (options.computerUse && !options.transport && (turn.images?.length || turn.integrations?.computer || turn.integrations?.localComputer || turn.integrations?.browser)) assertImageTransport(apiUrl);

    const turnId = newId();
    const abort = new AbortController();
    const messages = messagesFor(turn);
    const retainImages = chatImageBudget();
    for (const message of messages) retainImages(message.content);
    options.transport?.validateModel(model);
    const secrets = [options.apiKey, ...options.transport?.secrets() ?? [], turn.integrations?.computer?.token,
      turn.integrations?.computer?.control?.token].filter((value): value is string => Boolean(value));
    for (const integration of Object.values(turn.integrations ?? {})) {
      const entries = object(integration);
      const specs = entries && "command" in entries ? [entries] : Object.values(entries ?? {}).map(object);
      for (const spec of specs) {
        for (const [key, value] of Object.entries({ ...object(spec?.env), ...object(spec?.headers) })) {
          if (/key|token|password|secret|authorization/i.test(key) && typeof value === "string" && value) {
            secrets.push(value);
            if (/authorization/i.test(key) && /^(?:Bearer|Basic)\s+\S+$/i.test(value)) secrets.push(value.replace(/^\S+\s+/, ""));
          }
        }
      }
    }
    const safeText = (text: string) => {
      let safe = text;
      for (const secret of [...secrets, ...options.transport?.secrets() ?? []]) if (secret) safe = safe.split(secret).join("[redacted]");
      return redactSecretsInText(safe);
    };
    const preview = (value: unknown) => toolDetailPreview(JSON.parse(JSON.stringify(value, (_key, part) =>
      typeof part === "string" ? safeText(part) : part)));
    const native = (dir: "out" | "in", msg: unknown) => appendNative(turn.threadId, {
      dir, source: options.nativeLog.source,
      msg: JSON.parse(JSON.stringify(msg, (_key, part) => typeof part === "string" ? safeText(part) : part)),
    });
    const approval = createChatToolApproval({
      signal: abort.signal,
      open: (ask) => emit({
        ...base(turn.threadId, turnId), type: "request.opened", requestType: "permission",
        requestId: ask.id, tool: ask.tool, summary: ask.summary, allowSession: false,
        ...(ask.scope ? { approvalScope: ask.scope, requiresExplicitApproval: true } : {}),
      }),
      resolved: (ask, allowed, source) => emit({
        ...base(turn.threadId, turnId), type: "request.resolved", requestId: ask.id,
        behavior: allowed ? "allow" : "deny", source,
        ...(ask.scope ? { approvalScope: ask.scope } : {}),
      }),
    });
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    active.set(turn.threadId, { abort, turnId, done, approval });
    emit({ ...base(turn.threadId, turnId), type: "turn.started" });
    emit({ ...base(turn.threadId, turnId), type: "session.started", sessionId: null, model });

    void (async () => {
      let tools: ChatToolSession | undefined;
      const usage: Usage = { input: 0, output: 0 };
      let hasUsage = false;
      let ok = false;
      let stopReason: string | null = null;
      let failure: string | undefined;
      let toolFailed = false;
      let toolProtocolFailed = false;
      let emptyFinalAllowed = false;
      let emptyResponseRetries = 0;
      const denials: string[] = [];
      const seenCalls = new Map<string, Set<string>>();
      const usedCallIds = new Set<string>();
      try {
        const features = options.transport?.features(model);
        if (turn.images?.length && features?.images === false) throw new ChatProtocolError("This model does not support image input. Choose a vision model or remove the images.");
        tools = await mountChatTools(options.tools === false || features?.tools === false ? undefined : turn.integrations, abort.signal,
          options.transport ? { extended: true, images: features?.images === true, privateEnvironment: options.transport.privateEnvironment }
            : { computerUse: options.computerUse, images: options.computerUse });
        for (let round = 0; round < 16; round++) {
          abort.signal.throwIfAborted();
          native("out", options.nativeLog.outgoing(turn, messages, model));
          let attempt = 0;
          let completion: Completion;
          for (;;) {
            let streamed = false;
            const pending = { assistant_text: "", reasoning_text: "" };
            const delta = (text: string, streamKind: keyof typeof pending, flush = false) => {
              let combined = pending[streamKind] + text;
              // Mask complete matches before holding a suffix: otherwise a key
              // such as "abab" could be split at its own repeated prefix.
              const currentSecrets = [...secrets, ...options.transport?.secrets() ?? []];
              for (const secret of currentSecrets) if (secret) combined = combined.split(secret).join("[redacted]");
              let hold = 0;
              // A configured credential can straddle chunks. Hold any suffix
              // that could be its prefix until the next chunk disambiguates it.
              if (!flush) for (const secret of currentSecrets) {
                for (let length = Math.min(secret.length - 1, combined.length); length > hold; length--) {
                  if (combined.endsWith(secret.slice(0, length))) { hold = length; break; }
                }
              }
              pending[streamKind] = hold ? combined.slice(-hold) : "";
              const visible = safeText(hold ? combined.slice(0, -hold) : combined);
              if (visible) emit({ ...base(turn.threadId, turnId), type: "content.delta", streamKind, delta: visible });
            };
            try {
              completion = await complete(messages, model, true, abort.signal, (text, streamKind) => {
                streamed = true;
                delta(text, streamKind);
              }, tools.definitions);
              delta("", "assistant_text", true);
              delta("", "reasoning_text", true);
              break;
            } catch (value) {
              const error = asError(value);
              const verdict = classifyError(error);
              // Once a call has been handled, never replay it through a turn retry.
              if (options.retryScale === undefined || abort.signal.aborted || streamed || seenCalls.size ||
                  error instanceof ChatProtocolError || !verdict.transient || attempt >= RETRY_MAX_ATTEMPTS - 1) throw error;
              const delayMs = computeBackoff(attempt++);
              emit({ ...base(turn.threadId, turnId), type: "turn.retrying", attempt, delayMs, reason: verdict.reason });
              await interruptibleDelay(delayMs * options.retryScale, abort.signal).promise;
              abort.signal.throwIfAborted();
            }
          }
          native("in", options.nativeLog.incoming(completion));
          if (completion.usage) {
            usage.input += completion.usage.input;
            usage.output += completion.usage.output;
            if (completion.usage.cachedInput !== undefined) usage.cachedInput = (usage.cachedInput ?? 0) + completion.usage.cachedInput;
            hasUsage = true;
            emit({ ...base(turn.threadId, turnId), type: "thread.token-usage.updated", ...usage });
          }
          // Reasoning on a tool-call round belongs to the protocol, not a final reply.
          const reply = completion.text.trim() ? completion.text : completion.toolCalls.length ? "" : completion.reasoning;
          if (reply.trim()) emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "assistant_text", text: safeText(reply) });
          abort.signal.throwIfAborted();
          if (!completion.toolCalls.length) {
            if (completion.finishReason && completion.finishReason !== "stop") {
              throw new ChatProtocolError(`provider did not finish the response (${completion.finishReason})`);
            }
            if (toolProtocolFailed) {
              stopReason = "tool_error";
              throw new ChatProtocolError("The provider requested an invalid tool operation. See the tool result for details.");
            }
            if (!reply.trim()) {
              // Coordination and proposal tools explicitly tell the model to
              // end the turn. GPT-5.6 represents that as a blank stop frame;
              // the successful tool receipt is the turn's useful result.
              if (emptyFinalAllowed && !toolFailed) {
                ok = true;
                break;
              }
              // Other blank stops are intermittently emitted by compatible
              // endpoints, including when a model interprets "do not reply
              // until done" as permission to stop before doing any work.
              // Ask it to continue. Completed effects are represented in the
              // transcript and the call fingerprint guard still rejects an
              // exact tool replay.
              if (emptyResponseRetries < 2) {
                emptyResponseRetries += 1;
                messages.push({
                  role: "user",
                  content: seenCalls.size
                    ? "Continue the original request using completed tool results. Do not repeat completed operations. Return a final answer only when the requested completion condition is satisfied or a precise external blocker remains."
                    : "Continue working on the original request now. Use the available tools as needed. Return a final answer only when the requested completion condition is satisfied or a precise external blocker remains.",
                });
                continue;
              }
              if (toolFailed) {
                stopReason = "tool_error";
                throw new ChatProtocolError("One or more tool operations failed or were denied, and the provider returned no final answer. See the tool results.");
              }
              throw new ChatProtocolError("provider returned an empty response");
            }
            ok = true;
            break;
          }
          if (!tools.definitions.length) throw new ChatProtocolError("provider returned tool calls, but no tools are available for this turn");
          // Some compatible providers restart their call counter for each
          // completion and return call_0 again. Duplicate IDs inside one batch
          // remain invalid, as does a true replay of the same operation. A
          // recycled ID for a different operation is namespaced before it is
          // added to the continuation transcript.
          const batchIds = new Set<string>();
          const toolCalls = completion.toolCalls.map((call) => {
            if (completion.nativeContent && usedCallIds.has(call.id)) {
              throw new ChatProtocolError("native provider reused a tool-call ID; refusing to change its signed continuation");
            }
            if (batchIds.has(call.id)) {
              throw new ChatProtocolError("provider returned duplicate tool-call IDs in one operation batch");
            }
            batchIds.add(call.id);
            const fingerprint = toolOperationKey(call);
            const previous = seenCalls.get(call.id) ?? new Set<string>();
            if (previous.has(fingerprint)) {
              throw new ChatProtocolError("provider repeated a previously executed tool operation");
            }
            previous.add(fingerprint);
            seenCalls.set(call.id, previous);
            let id = call.id;
            for (let suffix = 2; usedCallIds.has(id); suffix += 1) id = `${call.id}_${suffix}`;
            usedCallIds.add(id);
            return id === call.id ? call : { ...call, id };
          });
          if (usedCallIds.size > MAX_CHAT_TOOL_CALLS) throw new ChatProtocolError("tool-call limit reached");
          messages.push({ role: "assistant", content: completion.text || null, tool_calls: toolCalls,
            ...(completion.protocolReasoning ? { reasoning_content: completion.protocolReasoning } : {}),
            ...(completion.protocolReasoningDetails.length ? { reasoning_details: completion.protocolReasoningDetails } : {}),
            ...(completion.nativeContent ? { nativeContent: completion.nativeContent } : {}),
          });
          const screenshotParts: ChatContentPart[] = [];
          for (const call of toolCalls) {
            abort.signal.throwIfAborted();
            let result: ChatToolResult;
            let started = false;
            let fatal: Error | undefined;
            try {
              let args: unknown;
              try { args = JSON.parse(call.function.arguments); }
              catch { throw new ChatProtocolError("tool arguments are not complete JSON"); }
              if (!object(args)) throw new ChatProtocolError("tool arguments must be a JSON object");
              tools.validate(call.function.name, args);
              const inputPreview = preview(args);
              // Full access is the person's explicit grant to answer every
              // prompt. This runtime has no provider reviewer to hand it to,
              // so it is honoured here: without it every single tool call on
              // an OpenAI-compatible engine stops for a card, and a Chief's
              // delegated Full access cannot help either.
              const scope = tools.approvalScope(call.function.name);
              // Full access never grants authority over the user's host
              // desktop. Preserve the harness's explicit local scope gate.
              const allowed = ((options.approveToolsWithoutPrompt || turn.approvalMode === "full") && scope !== "local-computer")
                || await approval.ask(call.function.name, inputPreview ?? "This tool has no arguments.", scope);
              abort.signal.throwIfAborted();
              emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id,
                title: call.function.name, ...(inputPreview ? { input: inputPreview } : {}),
              });
              started = true;
              if (allowed) {
                result = await tools.execute(call.function.name, args as Record<string, unknown>, abort.signal);
                if (result.images?.length) {
                  try {
                    if (!options.transport) assertImageTransport(apiUrl);
                    retainImages(result.images);
                  } catch (error) {
                    throw new ChatToolSessionError(asError(error).message);
                  }
                }
              } else {
                denials.push(call.function.name);
                result = { ok: false, text: "Permission denied or expired; the tool was not executed." };
              }
            } catch (error) {
              if (error instanceof ChatToolSessionError) fatal = error;
              else if (!started) toolProtocolFailed = true;
              result = { ok: false, text: abort.signal.aborted
                ? "Tool interrupted; an operation already dispatched may have taken effect. Verify its state before retrying."
                : safeText(asError(error).message).slice(0, 2_000) };
            }
            if (!started) emit({ ...base(turn.threadId, turnId), type: "item.started", itemType: "tool", itemId: call.id, title: call.function.name });
            const text = safeText(result.text);
            const output = preview({ ok: result.ok, result: text });
            emit({ ...base(turn.threadId, turnId), type: "item.completed", itemType: "tool", itemId: call.id, ok: result.ok, output });
            if (!result.ok) toolFailed = true;
            if (result.ok && /\bend (?:your|this) turn\b/i.test(text)) emptyFinalAllowed = true;
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: result.ok, result: text }),
              ...(options.transport && result.images?.length ? { toolImages: result.images } : {}),
            });
            if (!options.transport) screenshotParts.push(...chatToolImages(call.id, result.images));
            abort.signal.throwIfAborted();
            if (fatal) throw fatal;
          }
          if (screenshotParts.length) messages.push({ role: "user", content: screenshotParts });
        }
        if (!ok) throw new ChatProtocolError("model-call limit reached before a final response");
      } catch (value) {
        stopReason = abort.signal.aborted ? "interrupted" : stopReason ?? "error";
        failure = safeText(asError(value).message).slice(0, 2_000);
      } finally {
        approval.close();
        let cleanupFailed = false;
        try { await tools?.close(); }
        catch {
          ok = false;
          stopReason = "error";
          cleanupFailed = true;
          failure = "Tool processes could not be stopped; their execution state is uncertain.";
        }
        if (abort.signal.aborted) { ok = false; stopReason = "interrupted"; }
        if (failure && (!abort.signal.aborted || cleanupFailed)) {
          emit({ ...base(turn.threadId, turnId), type: "runtime.error", message: failure, terminal: !abort.signal.aborted });
        }
        active.delete(turn.threadId);
        emit({ ...base(turn.threadId, turnId), type: "turn.completed", ok, stopReason, cost: null,
          ...(hasUsage && (options.includeUsageInCompleted || seenCalls.size) ? { usage } : {}),
          ...(denials.length ? { denials } : {}),
        });
        resolveDone();
      }
    })();
    return { turnId };
  };

  return {
    instanceId: input.instanceId,
    driverKind: options.driverKind,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return options.models();
    },
    ...(options.refreshModels ? { refreshModels: options.refreshModels } : {}),
    snapshot: options.transport?.snapshot ?? (async () => options.apiKey
      ? { state: "available", authenticated: true, version: null, ...(options.billing ? { billing: options.billing } : {}) }
      : { state: "unavailable", reason: options.unavailableReason }),
    adapter: {
      provider: options.driverKind,
      capabilities: { sessionModelSwitch: "in-session", customMcp: options.tools !== false, agentsMcp: options.tools !== false, composioMcp: options.tools !== false,
        ...(options.transport || options.computerUse ? { images: true, nativeImageInput: true, computerMcp: options.tools !== false,
          cloudComputerMcp: options.tools !== false, localComputerMcp: options.tools !== false, browserMcp: options.tools !== false } : {}),
        ...(options.transport ? { phoneMcp: options.tools !== false } : {}),
      },
      sendTurn,
      interruptTurn: async (threadId, turnId) => {
        const turn = active.get(threadId);
        if (!turn || (turnId && turn.turnId !== turnId)) return;
        turn.abort.abort();
        await turn.done;
      },
      respondToRequest: async (threadId, requestId, decision) =>
        active.get(threadId)?.approval.answer(requestId, decision.behavior) ?? "unavailable",
      hasSession: (threadId) => active.has(threadId),
      stopAll: async () => {
        const turns = [...active.values()];
        for (const turn of turns) turn.abort.abort();
        await Promise.all(turns.map((turn) => turn.done));
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    generateText: async (prompt, { signal } = {}) => {
      const model = options.generateModel?.() ?? options.models().default;
      const { text, reasoning, toolCalls } = await complete([{ role: "user", content: prompt }], model, false, signal);
      if (toolCalls.length) throw new ChatProtocolError("provider returned tool calls to a text-only helper");
      return text.trim() ? text : reasoning;
    },
    dispose: async () => {
      const turns = [...active.values()];
      for (const turn of turns) turn.abort.abort();
      await Promise.all(turns.map((turn) => turn.done));
      listeners.clear();
    },
  };
}
