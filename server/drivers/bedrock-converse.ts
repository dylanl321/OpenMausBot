import { readFile } from "node:fs/promises";
import { ConverseCommand, ConverseStreamCommand, type ContentBlock, type ConverseCommandInput, type ImageBlock, type Message, type TokenUsage, type ToolUseBlock } from "@aws-sdk/client-bedrock-runtime";
import type { BedrockModelFeatures } from "../../shared/bedrock.ts";
import type { ChatCompletion, ChatCompletionRequest, ChatUsage, OpenAIChatMessage } from "./openai-chat.ts";
import { ChatProtocolError, ChatToolCalls, object } from "./openai-chat-protocol.ts";
import { chatImage, chatTextContent } from "./chat-images.ts";
import { BEDROCK_REQUEST_TIMEOUT_MS, withBedrockAbort, type BedrockConnection } from "./bedrock-connection.ts";

export async function bedrockImages(message: OpenAIChatMessage) {
  const images: Array<{ mime: string; data: string }> = [];
  const inline = [...(message.toolImages ?? []), ...(Array.isArray(message.content)
    ? message.content.filter(part => part.type === "image_url") : [])];
  for (const image of inline) {
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.image_url.url);
    if (!match) throw new ChatProtocolError("Bedrock images must be valid inline image data.");
    if (match[2].length > 5_000_000) throw new ChatProtocolError("Bedrock images must be smaller than 3.75 MB. Resize the image and try again.");
    chatImage({ mimeType: match[1], data: match[2] });
    images.push({ mime: match[1], data: match[2] });
  }
  for (const image of message.images ?? []) {
    const bytes = await readFile(image.path);
    if (bytes.length > 3_750_000) throw new ChatProtocolError("Bedrock images must be smaller than 3.75 MB. Resize the image and try again.");
    images.push({ mime: image.mime, data: bytes.toString("base64") });
  }
  return images;
}

function imageBlock(image: { mime: string; data: string }): { image: ImageBlock } {
  return { image: { format: image.mime.slice(6) as "png" | "jpeg" | "gif" | "webp", source: { bytes: Buffer.from(image.data, "base64") } } };
}

export async function converseInput(request: ChatCompletionRequest, features: BedrockModelFeatures): Promise<ConverseCommandInput> {
  const messages: Message[] = [];
  const system: string[] = [];
  for (const message of request.messages) {
    const text = chatTextContent(message.content);
    if (message.role === "system") { if (text) system.push(text); continue; }
    let content: ContentBlock[] = [];
    const images = await bedrockImages(message);
    if (images.length && !features.images) throw new ChatProtocolError("This Bedrock model does not support images.");
    if (message.role === "tool") {
      const result = JSON.parse(text || "{}");
      content = [{ toolResult: { toolUseId: message.tool_call_id!, status: result.ok === false ? "error" : "success",
        content: [{ text: text || "(empty result)" }, ...images.map(imageBlock)],
      } }];
    } else if (message.nativeContent) {
      // Preserve signed reasoning blocks and their original order verbatim.
      content = message.nativeContent as ContentBlock[];
    } else {
      if (text) content.push({ text });
      content.push(...images.map(imageBlock));
      for (const call of message.tool_calls ?? []) content.push({ toolUse: {
        toolUseId: call.id, name: call.function.name, input: JSON.parse(call.function.arguments),
      } });
    }
    if (!content.length) continue;
    const role = message.role === "assistant" ? "assistant" : "user";
    const previous = messages.at(-1);
    if (previous?.role === role) previous.content!.push(...content);
    else messages.push({ role, content });
  }
  if (messages[0]?.role !== "user") messages.unshift({ role: "user", content: [{ text: "Previous conversation:" }] });
  if (system.length && !features.system) messages[0].content!.unshift({ text: system.join("\n\n") });
  return {
    modelId: request.model, messages,
    ...(features.system && system.length ? { system: system.map((text) => ({ text })) } : {}),
    ...(features.tools && request.tools.length ? { toolConfig: { tools: request.tools.map((tool) => ({ toolSpec: {
      name: tool.function.name, description: tool.function.description, inputSchema: { json: tool.function.parameters as NonNullable<ToolUseBlock["input"]> },
    } })) } } : {}),
  };
}

const stopReason = (reason: string | undefined): string | null => {
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return reason ?? null;
};

function usageFrom(usage?: TokenUsage): ChatUsage | null {
  if (!usage) return null;
  return {
    // Converse reports uncached input separately from cache reads/writes.
    // The shared ledger's input counter includes all input tokens.
    input: (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0),
    output: usage.outputTokens ?? 0,
    ...(usage.cacheReadInputTokens !== undefined ? { cachedInput: usage.cacheReadInputTokens } : {}),
  };
}

export function converseCompletion(content: ContentBlock[], reason: string | undefined, usage?: TokenUsage): ChatCompletion {
  if (!Array.isArray(content) || !content.length || !reason) throw new ChatProtocolError("Bedrock returned an incomplete conversation response.");
  let text = "";
  let reasoning = "";
  const calls = new ChatToolCalls();
  const toolCalls = content.flatMap((block) => {
    if (typeof block.text === "string") text += block.text;
    if (block.reasoningContent?.reasoningText?.text) reasoning += block.reasoningContent.reasoningText.text;
    return block.toolUse ? [{ id: block.toolUse.toolUseId, type: "function", function: {
      name: block.toolUse.name, arguments: JSON.stringify(block.toolUse.input),
    } }] : [];
  });
  calls.add(toolCalls, false);
  const finishReason = stopReason(reason);
  return { text, reasoning, usage: usageFrom(usage), toolCalls: calls.finish(finishReason, false), finishReason,
    protocolReasoning: "", protocolReasoningDetails: [], nativeContent: content,
  };
}

/** SDK event frames are not SSE. Require a complete message and complete
 * content blocks before permitting tool execution; a dropped stream fails. */
export async function completeConverse(connection: BedrockConnection, request: ChatCompletionRequest,
  features: BedrockModelFeatures,
  maxTokens?: number,
): Promise<ChatCompletion> {
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
    const input = await converseInput(request, features);
    if (maxTokens) input.inferenceConfig = { maxTokens };
    signal.throwIfAborted();
    if (!request.stream || !features.streaming) {
      const result = await withBedrockAbort(connection.runtime.send(new ConverseCommand(input), { abortSignal: signal }), signal);
      return converseCompletion(result.output?.message?.content ?? [], result.stopReason, result.usage);
    }
    const response = await withBedrockAbort(connection.runtime.send(new ConverseStreamCommand(input), { abortSignal: signal }), signal);
    if (!response.stream) throw new ChatProtocolError("Bedrock returned no conversation stream.");
    const blocks = new Map<number, { block: ContentBlock; input?: string; stopped: boolean }>();
    let reason: string | undefined;
    let usage: TokenUsage | undefined;
    let size = 0;
    const indexOf = (index: number | undefined) => {
      if (!Number.isInteger(index) || index! < 0 || index! >= 256) throw new ChatProtocolError("Bedrock returned an invalid content-block index.");
      return index!;
    };
    for await (const event of response.stream) {
      signal.throwIfAborted(); touch();
      const exception = Object.entries(event).find(([key]) => key.endsWith("Exception"));
      if (exception) throw new Error(`Bedrock ${exception[0]}: ${String(object(exception[1])?.message ?? "stream failed")}`);
      if (event.contentBlockStart) {
        const index = indexOf(event.contentBlockStart.contentBlockIndex);
        if (blocks.has(index) || reason) throw new ChatProtocolError("Bedrock repeated a content block.");
        const tool = event.contentBlockStart.start?.toolUse;
        blocks.set(index, { block: tool ? { toolUse: { toolUseId: tool.toolUseId, name: tool.name, input: {} } } : { text: "" }, input: tool ? "" : undefined, stopped: false });
      }
      if (event.contentBlockDelta) {
        const index = indexOf(event.contentBlockDelta.contentBlockIndex);
        const delta = event.contentBlockDelta.delta;
        // Bedrock emits text/reasoning deltas without a start frame. Tool
        // deltas always need the start carrying their name and ID.
        let entry = blocks.get(index);
        if (!entry && (delta?.text !== undefined || delta?.reasoningContent)) {
          entry = { block: { text: "" }, stopped: false }; blocks.set(index, entry);
        }
        if (!entry || entry.stopped || reason || !delta) throw new ChatProtocolError("Bedrock returned a delta outside an active content block.");
        size += JSON.stringify(delta).length;
        if (size > 8 * 1024 * 1024) throw new ChatProtocolError("Bedrock response exceeded the size limit.");
        if (delta.text !== undefined) {
          if (entry.block.toolUse || entry.block.reasoningContent) throw new ChatProtocolError("Bedrock changed a content block’s type.");
          entry.block = { text: (entry.block.text ?? "") + delta.text };
          request.onDelta?.(delta.text, "assistant_text");
        } else if (delta.toolUse) {
          if (!entry.block.toolUse) throw new ChatProtocolError("Bedrock omitted a tool-call start.");
          entry.input = (entry.input ?? "") + (delta.toolUse.input ?? "");
          if (entry.input.length > 256_000) throw new ChatProtocolError("Bedrock tool arguments exceeded the size limit.");
        } else if (delta.reasoningContent) {
          if (entry.block.toolUse || entry.block.text) throw new ChatProtocolError("Bedrock changed a content block’s type.");
          const part = delta.reasoningContent;
          const previous = entry.block.reasoningContent;
          if (part.redactedContent) {
            if (previous?.reasoningText) throw new ChatProtocolError("Bedrock changed a reasoning block’s type.");
            entry.block = { reasoningContent: { redactedContent: Buffer.concat([previous?.redactedContent ?? new Uint8Array(), part.redactedContent]) } };
          } else {
            if (previous?.redactedContent) throw new ChatProtocolError("Bedrock changed a reasoning block’s type.");
            entry.block = { reasoningContent: { reasoningText: {
              text: (previous?.reasoningText?.text ?? "") + (part.text ?? ""),
              ...(part.signature !== undefined || previous?.reasoningText?.signature !== undefined
                ? { signature: (previous?.reasoningText?.signature ?? "") + (part.signature ?? "") } : {}),
            } } };
            if (part.text) request.onDelta?.(part.text, "reasoning_text");
          }
        } else throw new ChatProtocolError("Bedrock returned an unsupported content delta.");
      }
      if (event.contentBlockStop) {
        const entry = blocks.get(indexOf(event.contentBlockStop.contentBlockIndex));
        if (!entry || entry.stopped) throw new ChatProtocolError("Bedrock closed an unknown content block.");
        if (entry.block.toolUse) {
          let input: unknown;
          try { input = JSON.parse(entry.input || "{}"); } catch { throw new ChatProtocolError("Bedrock returned incomplete tool arguments."); }
          if (!object(input)) throw new ChatProtocolError("Bedrock tool arguments must be an object.");
          entry.block.toolUse.input = input as ToolUseBlock["input"];
        }
        entry.stopped = true;
      }
      if (event.messageStop) {
        if (reason) throw new ChatProtocolError("Bedrock repeated the message stop.");
        reason = event.messageStop.stopReason;
      }
      if (event.metadata) usage = event.metadata.usage;
    }
    signal.throwIfAborted();
    if (!reason || [...blocks.values()].some((entry) => !entry.stopped)) throw new ChatProtocolError("Bedrock stream ended before the response was complete.");
    return converseCompletion([...blocks].sort(([a], [b]) => a - b).map(([, entry]) => entry.block), reason, usage);
  } catch (error) { throw connection.safeError(error); }
  finally { clearTimeout(timer!); }
}
