// Claude's Messages API works on Runtime and Mantle. The shared runtime
// still owns approvals and tool execution.
import type { BedrockConfig } from "../../shared/bedrock.ts";
import type { ChatCompletion, ChatCompletionRequest } from "./openai-chat.ts";
import { ChatProtocolError, ChatToolCalls, object } from "./openai-chat-protocol.ts";
import { bedrockImages } from "./bedrock-converse.ts";
import { BEDROCK_REQUEST_TIMEOUT_MS, type BedrockConnection } from "./bedrock-connection.ts";

export async function messagesInput(request: ChatCompletionRequest, maxTokens = 4096) {
  const messages: Array<{ role: string; content: unknown[] }> = [];
  const system: string[] = [];
  for (const message of request.messages) {
    if (message.role === "system") { if (message.content) system.push(message.content); continue; }
    const images = (await bedrockImages(message)).map((image) => ({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } }));
    let content: unknown[];
    if (message.role === "tool") {
      const result = JSON.parse(message.content || "{}");
      content = [{ type: "tool_result", tool_use_id: message.tool_call_id, is_error: result.ok === false,
        content: [{ type: "text", text: message.content || "(empty result)" }, ...images],
      }];
    } else content = message.nativeContent ?? [
      ...(message.content ? [{ type: "text", text: message.content }] : []), ...images,
      ...(message.tool_calls ?? []).map((call) => ({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
    ];
    if (!content.length) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    if (messages.at(-1)?.role === role) messages.at(-1)!.content.push(...content);
    else messages.push({ role, content });
  }
  return { model: request.model, max_tokens: maxTokens, stream: request.stream, messages,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    ...(request.tools.length ? { tools: request.tools.map((tool) => ({
      name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters,
    })) } : {}),
  };
}

function completion(content: Record<string, unknown>[], reason: unknown, usage: Record<string, unknown>): ChatCompletion {
  if (!content.length || typeof reason !== "string") throw new ChatProtocolError("Bedrock Messages returned an incomplete response.");
  const calls = new ChatToolCalls();
  calls.add(content.filter((block) => block.type === "tool_use").map((block) => ({
    id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input) },
  })), false);
  const finishReason = reason === "end_turn" || reason === "stop_sequence" ? "stop" : reason === "tool_use" ? "tool_calls" : reason;
  const count = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0;
  return {
    text: content.filter((block) => block.type === "text").map((block) => typeof block.text === "string" ? block.text : "").join(""),
    reasoning: content.filter((block) => block.type === "thinking").map((block) => typeof block.thinking === "string" ? block.thinking : "").join(""),
    usage: Object.keys(usage).length ? { input: count("input_tokens") + count("cache_read_input_tokens") + count("cache_creation_input_tokens"),
      output: count("output_tokens"), cachedInput: count("cache_read_input_tokens"),
    } : null,
    toolCalls: calls.finish(finishReason, false), finishReason,
    protocolReasoning: "", protocolReasoningDetails: [], nativeContent: content,
  };
}

export async function completeMessages(connection: BedrockConnection, request: ChatCompletionRequest, config: BedrockConfig): Promise<ChatCompletion> {
  const timeout = new AbortController();
  const signal = AbortSignal.any([connection.signal, timeout.signal, ...(request.signal ? [request.signal] : [])]);
  let timer: ReturnType<typeof setTimeout>;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(new Error("Bedrock response timed out while waiting for data.")), BEDROCK_REQUEST_TIMEOUT_MS);
    timer.unref();
  };
  touch();
  try {
    await connection.authorize(request.model, signal);
    const response = await connection.request("/anthropic/v1/messages", { body: await messagesInput(request, config.maxTokens), signal,
      messages: true, headers: { "anthropic-version": "2023-06-01" },
    });
    if (!response.ok) throw new Error(`Bedrock Messages HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    if (!request.stream || response.headers.get("content-type")?.includes("application/json")) {
      const result = object(await response.json());
      if (!result || !Array.isArray(result.content) || result.content.some((block: unknown) => !object(block))) throw new ChatProtocolError("Bedrock Messages returned an invalid response.");
      return completion(result.content as Record<string, unknown>[], result.stop_reason, object(result.usage) ?? {});
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ChatProtocolError("Bedrock Messages returned no stream.");
    const decoder = new TextDecoder();
    const blocks = new Map<number, { value: Record<string, unknown>; input: string; stopped: boolean }>();
    let reason: unknown;
    let usage: Record<string, unknown> = {};
    let stopped = false;
    let buffer = "";
    let size = 0;
    const consume = (frame: string) => {
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (!data) return;
      let event: Record<string, unknown>;
      try { const raw = JSON.parse(data); if (!object(raw)) throw new Error(); event = raw; }
      catch { throw new ChatProtocolError("Bedrock Messages returned an invalid streaming event."); }
      if (event.type === "error") throw new ChatProtocolError(`Bedrock Messages: ${String(object(event.error)?.message ?? "stream failed")}`);
      if (event.type === "message_start") { usage = object(object(event.message)?.usage) ?? {}; return; }
      if (event.type === "message_delta") { reason = object(event.delta)?.stop_reason; usage = { ...usage, ...object(event.usage) }; return; }
      if (event.type === "message_stop") { stopped = true; return; }
      if (event.type === "ping") return;
      const index = event.index;
      if (!Number.isInteger(index) || Number(index) < 0 || Number(index) >= 256) throw new ChatProtocolError("Bedrock Messages returned an invalid block index.");
      if (event.type === "content_block_start") {
        const block = object(event.content_block);
        if (blocks.has(Number(index)) || !block) throw new ChatProtocolError("Bedrock Messages repeated or omitted a content block.");
        blocks.set(Number(index), { value: { ...block }, input: "", stopped: false }); return;
      }
      const entry = blocks.get(Number(index));
      if (!entry || entry.stopped) throw new ChatProtocolError("Bedrock Messages returned a delta outside an active block.");
      if (event.type === "content_block_stop") {
        if (entry.value.type === "tool_use" && entry.input) {
          try { entry.value.input = JSON.parse(entry.input); } catch { throw new ChatProtocolError("Bedrock Messages returned incomplete tool arguments."); }
          if (!object(entry.value.input)) throw new ChatProtocolError("Bedrock Messages tool arguments must be an object.");
        }
        entry.stopped = true; return;
      }
      const delta = object(event.delta);
      if (event.type !== "content_block_delta" || !delta) throw new ChatProtocolError("Bedrock Messages returned an unsupported event.");
      if (delta.type === "input_json_delta" && entry.value.type === "tool_use" && typeof delta.partial_json === "string") {
        entry.input += delta.partial_json;
        if (entry.input.length > 256_000) throw new ChatProtocolError("Bedrock tool arguments exceeded the size limit.");
      } else if (delta.type === "text_delta" && entry.value.type === "text" && typeof delta.text === "string") {
        entry.value.text = String(entry.value.text ?? "") + delta.text; request.onDelta?.(delta.text, "assistant_text");
      } else if (delta.type === "thinking_delta" && entry.value.type === "thinking" && typeof delta.thinking === "string") {
        entry.value.thinking = String(entry.value.thinking ?? "") + delta.thinking; request.onDelta?.(delta.thinking, "reasoning_text");
      } else if (delta.type === "signature_delta" && entry.value.type === "thinking" && typeof delta.signature === "string") {
        entry.value.signature = String(entry.value.signature ?? "") + delta.signature;
      } else throw new ChatProtocolError("Bedrock Messages changed a content block’s type.");
    };
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        signal.throwIfAborted(); touch();
        size += value.byteLength;
        if (size > 8 * 1024 * 1024) throw new ChatProtocolError("Bedrock response exceeded the size limit.");
        buffer += decoder.decode(value, { stream: true });
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          consume(buffer.slice(0, match.index).replace(/\r\n/g, "\n"));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
    } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); }
    signal.throwIfAborted();
    if (!stopped || [...blocks.values()].some((entry) => !entry.stopped)) throw new ChatProtocolError("Bedrock Messages stream ended before the response was complete.");
    return completion([...blocks].sort(([a], [b]) => a - b).map(([, entry]) => entry.value), reason, usage);
  } catch (error) { throw connection.safeError(error); }
  finally { clearTimeout(timer!); }
}
