// Transcript-replay driver for OpenRouter, Groq, Together, llama.cpp, and
// other endpoints that speak the OpenAI chat-completions contract.
import type { ModelCatalog, ProviderDriver } from "../contracts.ts";
import { createOpenAIChatRuntime } from "./openai-chat.ts";
import { bedrockChatReasoningEffort } from "../../shared/bedrock.ts";

const DRIVER_KIND = "openai-compat";
const DEFAULT_IDLE_TIMEOUT_MS = 180_000;
const idleTimeoutMs = () => {
  const raw = process.env.OPENMAUS_OPENAI_COMPAT_IDLE_TIMEOUT_MS;
  if (!raw) return DEFAULT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1_000 && value <= 2_147_483_647 ? value : DEFAULT_IDLE_TIMEOUT_MS;
};
const DEFAULT_MODELS: ModelCatalog = {
  default: "meta-llama/llama-3.3-70b-instruct",
  options: [
    { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B (OpenRouter)", custom: true },
    { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", custom: true },
  ],
};

export interface OpenAICompatConfig {
  tools?: boolean;
  toolApproval?: "ask" | "always";
  url: string;
  modelUrls?: Record<string, string>;
  apiKeyEnv: string;
  key?: string;
  model?: string;
  provider?: string;
  managedModels?: string[];
}

function isOpenRouterUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

function configuredModelLabel(id: string): string {
  const model = id.split("::").at(-1) ?? id;
  const match = /^(?:us\.)?openai\.gpt-(\d+(?:\.\d+)?)-(sol|luna|terra|astra)$/iu.exec(model);
  return match
    ? `GPT-${match[1]} ${match[2][0].toUpperCase()}${match[2].slice(1).toLowerCase()}`
    : id;
}

function bedrockEndpointRegion(endpoint: string): string | undefined {
  try {
    return /^bedrock-(?:runtime|mantle)(?:-fips)?\.([a-z]{2}(?:-[a-z]+)+-\d+)\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/.exec(new URL(endpoint).hostname)?.[1];
  } catch { return undefined; }
}

function decodeModelUrls(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("modelUrls must be an object");
  }
  const decoded: Record<string, string> = Object.create(null);
  for (const [model, value] of Object.entries(raw)) {
    if (!model.trim() || typeof value !== "string" || !value.trim()) {
      throw new Error("modelUrls must map model ids to URLs");
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid model URL for ${model}`);
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash) {
      throw new Error(`Invalid model URL for ${model}`);
    }
    decoded[model] = value.replace(/\/+$/, "");
  }
  return decoded;
}

function decodeConfig(raw: unknown): OpenAICompatConfig {
  const config = (raw ?? {}) as Record<string, unknown>;
  if (config.tools !== undefined && typeof config.tools !== "boolean") throw new Error("tools must be a boolean");
  if (config.toolApproval !== undefined && config.toolApproval !== "ask" && config.toolApproval !== "always") {
    throw new Error("toolApproval must be ask or always");
  }
  if (config.managedModels !== undefined && (!Array.isArray(config.managedModels) || !config.managedModels.length || config.managedModels.some(model => typeof model !== "string" || !model.trim()))) throw new Error("Invalid managed models.");
  const modelUrls = decodeModelUrls(config.modelUrls);
  const envUrl = process.env.OPENAI_COMPAT_URL;
  return {
    ...(config.tools !== undefined ? { tools: config.tools as boolean } : {}),
    ...(config.toolApproval !== undefined ? { toolApproval: config.toolApproval as "ask" | "always" } : {}),
    ...(config.managedModels ? { managedModels: config.managedModels as string[] } : {}),
    ...(modelUrls ? { modelUrls } : {}),
    url: (typeof config.url === "string" && config.url ? config.url : envUrl || "https://openrouter.ai/api/v1")
      .replace(/\/+$/, ""),
    apiKeyEnv: typeof config.apiKeyEnv === "string" && config.apiKeyEnv
      ? config.apiKeyEnv
      : "OPENAI_COMPAT_API_KEY",
    key: typeof config.key === "string" && config.key ? config.key : undefined,
    model: typeof config.model === "string" && config.model
      ? config.model
      : process.env.OPENAI_COMPAT_MODEL || undefined,
    // An explicit empty override disables inherited routing for an isolated
    // connection (CLI setup uses this). Absent still inherits the global pin.
    provider: typeof config.provider === "string"
      ? config.provider || undefined
      : process.env.OPENAI_COMPAT_PROVIDER || undefined,
  };
}

export const OpenAICompatDriver: ProviderDriver<OpenAICompatConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenAI-compatible (OpenRouter / Groq)",
    supportsMultipleInstances: true,
    access: "custom",
  },
  models: DEFAULT_MODELS,
  install: {
    docsUrl: "https://openrouter.ai/keys",
    signInCommand:
      "add {\"openaiCompat\":{\"key\":\"sk-or-v1-…\"}} to ~/.openmausbot/config.json (or set OPENAI_COMPAT_API_KEY)",
    command: {
      darwin:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      linux:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to ~/.openmausbot/config.json under openaiCompat.key",
      win32:
        "Get a free key at https://openrouter.ai/keys (or https://console.groq.com) then add it to %USERPROFILE%\\.openmausbot\\config.json under openaiCompat.key",
    },
  },
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input) {
    const { config } = input;
    const apiKey =
      config.key ??
      input.environment[config.apiKeyEnv] ??
      input.environment.OPENAI_COMPAT_API_KEY ??
      process.env[config.apiKeyEnv] ??
      process.env.OPENAI_COMPAT_API_KEY ??
      "";
    const urlForModel = (model: string) => (config.modelUrls && Object.hasOwn(config.modelUrls, model)
      ? config.modelUrls[model] : config.url).replace(/\/+$/, "");
    const optionFor = (id: string, label = configuredModelLabel(id)): ModelCatalog["options"][number] => {
      const region = bedrockEndpointRegion(urlForModel(id));
      return { id, label: region ? `${label} · ${region}` : label, custom: true };
    };
    const configuredIds = [...new Set([...(config.model ? [config.model] : []), ...Object.keys(config.modelUrls ?? {})])];
    let catalog: ModelCatalog = config.managedModels
      ? {
          default: config.managedModels[0],
          options: config.managedModels.map(id => optionFor(id)),
        }
      : config.modelUrls || bedrockEndpointRegion(config.url)
      ? { default: config.model ?? configuredIds[0] ?? "", options: configuredIds.map(id => optionFor(id)) }
      : config.model
      ? {
          default: config.model,
          options: DEFAULT_MODELS.options.some((model) => model.id === config.model)
            ? DEFAULT_MODELS.options
            : [{ id: config.model, label: config.model, custom: true }, ...DEFAULT_MODELS.options],
        }
      : DEFAULT_MODELS;

    const fetchModels = async () => {
      if (config.managedModels) return;
      if (!apiKey) return;
      try {
        const response = await fetch(`${config.url}/models`, {
          headers: { authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return;
        const json = await response.json() as { data?: Array<{ id?: unknown; name?: unknown }> } | Array<{ id?: unknown; name?: unknown }>;
        const rows = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : [];
        const seen = new Set<string>();
        const options: ModelCatalog["options"] = [];
        for (const row of rows) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          options.push(optionFor(id, typeof row.name === "string" && row.name.trim() ? row.name : configuredModelLabel(id)));
        }
        if (!options.length) return;
        options.unshift(...configuredIds.filter(id => !options.some(model => model.id === id)).map(id => optionFor(id)));
        catalog = { default: config.model ?? options[0].id, options };
      } catch {
        // Catalog refresh is opportunistic; keep the seeded options.
      }
    };
    if (apiKey) void fetchModels();

    return createOpenAIChatRuntime({
      input,
      driverKind: DRIVER_KIND,
      apiKey,
      apiUrl: urlForModel,
      tools: config.tools,
      approveToolsWithoutPrompt: config.toolApproval === "always",
      models: () => catalog,
      refreshModels: fetchModels,
      requestBody: (model, messages, stream) => ({
        model,
        messages,
        stream,
        stream_options: stream ? { include_usage: true } : undefined,
        ...(bedrockChatReasoningEffort(model) ? { reasoning_effort: bedrockChatReasoningEffort(model) } : {}),
        ...(config.provider && isOpenRouterUrl(urlForModel(model))
          ? { provider: { order: [config.provider], allow_fallbacks: false } }
          : {}),
      }),
      httpErrorLabel: "upstream",
      missingKeyError: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      unavailableReason: `no API key — set ${config.apiKeyEnv} or add it to the instance config`,
      timeoutMs: idleTimeoutMs(),
      reasoning: true,
      billing: "metered",
      includeUsageInCompleted: true,
      nativeLog: {
        source: "openai-compat.chat.completions",
        outgoing: (_turn, messages, model) => ({ model, messageCount: messages.length }),
        incoming: ({ text, reasoning, usage, toolCalls, finishReason }) => ({
          textLength: text.length,
          reasoningLength: reasoning.length,
          toolCallCount: toolCalls.length,
          finishReason,
          usage,
        }),
      },
    });
  },
};
