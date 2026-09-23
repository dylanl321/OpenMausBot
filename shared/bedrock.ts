/** Bedrock settings shared by the server and its setup form. Credentials
 * never appear in the public settings returned to the renderer. */
export interface BedrockConfig {
  region?: string;
  profile?: string;
  auth?: "auto" | "api-key" | "profile" | "access-keys" | "aws";
  apiKey?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: "runtime" | "mantle";
  api?: "auto" | "converse" | "chat-completions" | "messages";
  model?: string;
  maxTokens?: number;
  tools?: boolean;
  /** Access policy is enforced again before every inference request. */
  allowAnthropic?: boolean;
  blockedModels?: string[];
  /** Only US endpoints and inference destinations; global profiles are denied. */
  usOnly?: boolean;
  /** Optional private/VPC endpoints; HTTP is allowed only on loopback. */
  url?: string;
  controlUrl?: string;
}

export interface BedrockModelInfo {
  id: string;
  label: string;
  provider?: string;
  regions: string[];
  routing: "regional" | "geographic" | "global" | "application" | "manual";
  modelIds?: string[];
  /** A discovered model may be unavailable or excluded by the access policy. */
  unavailable?: string;
  accessError?: string;
}

export interface BedrockSettings extends Omit<BedrockConfig, "apiKey" | "accessKeyId" | "secretAccessKey" | "sessionToken"> {
  apiKeyConfigured: boolean;
  apiKeySaved: boolean;
  accessKeysConfigured: boolean;
  accessKeysSaved: boolean;
  sessionTokenConfigured: boolean;
  resolvedRegion?: string;
  regionSource?: "setting" | "AWS_REGION" | "AWS_DEFAULT_REGION" | "profile" | "default";
  resolvedProfile?: string;
  credentialSource?: "saved-token" | "environment-token" | "saved-keys" | "environment-keys" | "profile" | "aws-chain";
  models?: BedrockModelInfo[];
  catalogLoaded?: boolean;
}

export interface BedrockModelFeatures {
  tools: boolean;
  images: boolean;
  streaming: boolean;
  system: boolean;
}

export const BEDROCK_ANTHROPIC_DISABLED = "Anthropic and Claude access is disabled in this Bedrock connection’s settings.";

/** Apply to IDs, ARNs, provider names and catalog labels. Decoding is only
 * for detecting prohibited names; encoded identifiers are never accepted. */
export function isAnthropicBedrockModel(value: string): boolean {
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  return /anthropic|claude/i.test(decoded);
}

export function bedrockModelError(model: string): string | null {
  if (!model || model.length > 2048 || model !== model.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9.:/_-]*$/.test(model)) {
    return "Use a Bedrock model ID, inference profile ID, or model ARN.";
  }
  return null;
}

/** The same model can be named directly, through a foundation-model ARN,
 * or through a geographic inference profile. Blocking it covers all three. */
export function canonicalBedrockModel(model: string): string {
  return model.toLowerCase().replace(/^arn:[^:]+:bedrock:[^:]+:[^:]*:(?:foundation-model|inference-profile)\//, "")
    .replace(/^(?:us|eu|apac|au|jp|global)\./, "");
}

export function bedrockAccessError(model: string, config: Pick<BedrockConfig, "allowAnthropic" | "blockedModels">,
  identities: readonly string[] = [],
): string | null {
  const names = [model, ...identities];
  if (config.allowAnthropic === false && names.some(isAnthropicBedrockModel)) return BEDROCK_ANTHROPIC_DISABLED;
  const blocked = new Set((config.blockedModels ?? []).map(canonicalBedrockModel));
  if (names.some((name) => blocked.has(canonicalBedrockModel(name)))) return "This model is disabled in this Bedrock connection’s settings.";
  return null;
}

export function bedrockArnRegion(model: string): string | undefined {
  return /^arn:[^:]+:bedrock:([^:]+):/.exec(model)?.[1];
}

export function bedrockRoutingError(model: string, config: Pick<BedrockConfig, "usOnly">,
  region: string, identities: readonly string[] = [],
): string | null {
  if (!config.usOnly) return null;
  if (!region.startsWith("us-")) return "US-only inference requires a US AWS region.";
  for (const name of [model, ...identities]) {
    const id = name.replace(/^arn:[^:]+:bedrock:[^:]+:[^:]*:[^/]+\//, "");
    if (/^(?:global|eu|apac|au|jp)\./i.test(id)) return "US-only inference excludes global and non-US inference profiles.";
    const destination = bedrockArnRegion(name);
    if (destination && !destination.startsWith("us-")) return "US-only inference excludes models and profiles with non-US destinations.";
  }
  return null;
}

/** Catalog metadata overrides these conservative compatibility hints.
 * Older text models still work, without being sent unsupported fields. */
export function bedrockModelFeatures(model: string): BedrockModelFeatures {
  const id = model.toLowerCase().replace(/^arn:[^:]+:bedrock:[^:]+:[^:]*:foundation-model\//, "")
    .replace(/^(?:us|eu|apac|au|jp|global)\./, "")
    // Mantle also exposes provider-native IDs without a namespace.
    .replace(/^claude-/, "anthropic.claude-").replace(/^gpt-/, "openai.gpt-")
    .replace(/^grok-/, "xai.grok-").replace(/^kimi-/, "moonshot.kimi-");
  const legacyText = /^(?:amazon\.titan-text|ai21\.j2-|anthropic\.claude-(?:v[12]|instant)|cohere\.command(?:-light)?-text|meta\.llama(?:2-|3-(?:8b|70b)-)|mistral\.(?:mistral-7b|mixtral-8x7b))/.test(id);
  return {
    tools: !legacyText && !/^(?:meta\.llama3-2-(?:1b|3b)-|deepseek\.r1|ai21\.jamba-instruct)/.test(id),
    images: !legacyText && /^(?:anthropic\.claude|amazon\.nova-(?:lite|pro|premier)|amazon\.nova-2-(?:lite|pro|premier)|meta\.llama(?:3-2-(?:11b|90b)|4)|mistral\.(?:pixtral|ministral)|google\.gemma-3|qwen\.(?:qwen3-vl|qwen3\.5)|moonshot\.kimi-k[23]|nvidia\..*vl|writer\.palmyra-vision|openai\.gpt-(?:[5-9])|xai\.grok)/.test(id),
    streaming: !id.startsWith("ai21.j2-"),
    system: !legacyText,
  };
}
