import { isAnthropicBedrockModel, canonicalBedrockModel, bedrockChatReasoningEffort, type BedrockConfig, type BedrockSettings } from "../../shared/bedrock.ts";
import { decodeBedrockConfig, publicBedrockSettings } from "../bedrock-config.ts";
import type { ProviderDriver, ProviderInstance, ProviderSnapshot } from "../contracts.ts";
import { createOpenAIChatRuntime, type ChatCompletionRequest, type OpenAIChatMessage } from "./openai-chat.ts";
import { createBedrockConnection } from "./bedrock-connection.ts";
import { createBedrockCatalog } from "./bedrock-catalog.ts";
import { bedrockImages, completeConverse } from "./bedrock-converse.ts";
import { completeMessages } from "./bedrock-messages.ts";
import { redactSecretsInText } from "../redact.ts";
import { chatTextContent } from "./chat-images.ts";

/** Prefer native Converse. Closed-weight GPT and xAI catalogs also include
 * models available only through Chat Completions; Mantle Claude uses Messages.
 * An explicit API choice supports new model families without an app update. */
export function bedrockApiForModel(config: BedrockConfig, model: string): "converse" | "chat-completions" | "messages" {
  if (config.api && config.api !== "auto") return config.api;
  if (config.endpoint === "mantle") return isAnthropicBedrockModel(model) ? "messages" : "chat-completions";
  const id = canonicalBedrockModel(model);
  return /^(?:openai\.(?!gpt-oss)|xai\.)/.test(id) ? "chat-completions" : "converse";
}

async function chatMessages(messages: OpenAIChatMessage[]) {
  const result: Record<string, unknown>[] = [];
  let toolImages: Array<{ type: string; image_url: { url: string } }> = [];
  const flush = () => {
    if (toolImages.length) result.push({ role: "user", content: [{ type: "text", text: "Images returned by the tools above:" }, ...toolImages] });
    toolImages = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flush();
    const text = chatTextContent(message.content);
    const images = (await bedrockImages(message)).map((image) => ({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } }));
    if (message.role === "tool") toolImages.push(...images);
    result.push({
      role: message.role,
      content: images.length && message.role !== "tool" ? [
        ...(text ? [{ type: "text", text }] : []), ...images,
      ] : text || null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
      ...(message.reasoning_details?.length ? { reasoning_details: message.reasoning_details } : {}),
    });
  }
  flush();
  return result;
}

interface BedrockInstance extends ProviderInstance { bedrockSettings(): BedrockSettings }

/** An explicit projection; the registry never serializes opaque driver config. */
export function describeBedrockSettings(instance: ProviderInstance | null, raw: unknown): BedrockSettings {
  if (instance && "bedrockSettings" in instance && typeof instance.bedrockSettings === "function") {
    return (instance as BedrockInstance).bedrockSettings();
  }
  try { return publicBedrockSettings(decodeBedrockConfig(raw)); }
  catch { return publicBedrockSettings({}); }
}

export const BedrockDriver: ProviderDriver<BedrockConfig> = {
  driverKind: "bedrock",
  metadata: { displayName: "Amazon Bedrock", supportsMultipleInstances: true },
  install: { docsUrl: "https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html" },
  models: { default: "", options: [] },
  defaultConfig: () => ({}),
  decodeConfig: decodeBedrockConfig,
  async create(input) {
    const config = decodeBedrockConfig(input.config);
    const connection = await createBedrockConnection(config, input.environment);
    const catalog = createBedrockCatalog(config, connection);
    let startedDiscovery = false;
    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!input.enabled) return { state: "unavailable", reason: "This Bedrock connection is disabled." };
      try { await connection.ready(); }
      catch (error) { return { state: "unavailable", authenticated: false, reason: connection.safeError(error).message }; }
      if (!startedDiscovery) { startedDiscovery = true; void catalog.refresh().catch(() => {}); }
      const warning = catalog.warning();
      return { state: "available", authenticated: true, billing: "metered", version: null,
        ...(warning ? { warning: { title: "Model discovery needs attention", message: warning } } : {}),
      };
    };
    const refreshModels = async () => { startedDiscovery = true; await catalog.refresh(); };
    const requestChat = async (request: ChatCompletionRequest) => {
      await connection.authorize(request.model, request.signal ?? connection.signal);
      const effort = bedrockChatReasoningEffort(catalog.apiModel(request.model));
      const body = {
        model: request.model, messages: await chatMessages(request.messages), stream: request.stream,
        ...(effort ? { reasoning_effort: effort } : {}),
        ...(request.stream ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools.length && catalog.features(request.model).tools ? { tools: request.tools } : {}),
        ...(config.maxTokens ? (/^(?:openai\.)?gpt-[5-9]/.test(canonicalBedrockModel(catalog.apiModel(request.model)))
          ? { max_completion_tokens: config.maxTokens } : { max_tokens: config.maxTokens }) : {}),
      };
      return connection.request(config.endpoint === "mantle" ? "/v1/chat/completions" : "/openai/v1/chat/completions", { body, signal: request.signal });
    };
    const runtime = createOpenAIChatRuntime({
      input, driverKind: "bedrock", apiKey: connection.apiKey, apiUrl: "", models: catalog.models, refreshModels,
      generateModel: () => config.model || catalog.models().default,
      requestBody: (model, messages, stream) => ({ model, messages, stream }),
      tools: config.tools, reasoning: true, billing: "metered", includeUsageInCompleted: true,
      timeoutMs: 180_000, retryScale: 1,
      missingKeyError: "Configure Bedrock credentials in Settings → Engines.",
      unavailableReason: "Configure Bedrock credentials in Settings → Engines.", httpErrorLabel: "Bedrock",
      nativeLog: { source: "bedrock", outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage }) => ({ textLength: text.length, reasoningLength: reasoning.length, usage }),
      },
      transport: {
        snapshot, secrets: connection.secrets, features: catalog.features,
        privateEnvironment: config.apiKeyEnv ? [config.apiKeyEnv] : [],
        validateModel: (model) => {
          if (!input.enabled) throw new Error("This Bedrock connection is disabled.");
          connection.checkModel(model);
          catalog.checkModel(model);
        },
        request: requestChat,
        complete: async (request) => {
          const api = bedrockApiForModel(config, catalog.apiModel(request.model));
          if (api === "messages") return completeMessages(connection, request, config);
          if (api === "converse") return completeConverse(connection, request, catalog.features(request.model), config.maxTokens);
          return null;
        },
      },
    });
    const generateText: NonNullable<ProviderInstance["generateText"]> = async (prompt, options) => {
      try {
        const result = await runtime.generateText!(prompt, options);
        if (!result.trim()) throw new Error("Bedrock returned an empty helper response.");
        let safe = result;
        for (const secret of connection.secrets()) safe = safe.split(secret).join("[redacted]");
        return redactSecretsInText(safe);
      } catch (error) { throw connection.safeError(error); }
    };
    const instance: BedrockInstance = {
      ...runtime,
      get models() { return catalog.models(); },
      generateText,
      reviewPermission: (prompt, signal) => generateText(prompt, { signal }),
      bedrockSettings: () => ({ ...publicBedrockSettings(config), resolvedRegion: connection.region, regionSource: connection.regionSource,
        resolvedProfile: connection.profile, credentialSource: connection.credentialSource,
        apiKeyConfigured: Boolean(connection.apiKey), accessKeysConfigured: connection.accessKeysConfigured,
        sessionTokenConfigured: connection.sessionTokenConfigured, models: catalog.info(), catalogLoaded: catalog.loaded(),
      }),
      async dispose() { connection.close(); await runtime.dispose(); },
    };
    return instance;
  },
};
