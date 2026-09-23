import { z } from "zod";
import { bedrockModelError, type BedrockConfig, type BedrockSettings } from "../shared/bedrock.ts";

const optionalSetting = z.string().trim().max(2048).optional();
const singleLine = (value: string) => ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const credential = z.string().trim().max(16384).refine(singleLine, "Credentials must be a single line.").optional();

function validEndpoint(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && local))
      && !url.username && !url.password && !url.search && !url.hash && /^\/?$/.test(url.pathname);
  } catch { return false; }
}

export const bedrockConfigSchema = z.object({
  region: optionalSetting.refine((value) => !value || /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(value), "Use an AWS region such as us-east-1."),
  profile: optionalSetting.refine((value) => !value || singleLine(value), "Use an AWS profile name."),
  auth: z.enum(["auto", "api-key", "profile", "access-keys", "aws"]).optional(),
  apiKey: credential,
  accessKeyId: credential,
  secretAccessKey: credential,
  sessionToken: credential,
  endpoint: z.enum(["runtime", "mantle"]).optional(),
  api: z.enum(["auto", "converse", "chat-completions", "messages"]).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).nullish().transform((value) => value ?? undefined),
  model: optionalSetting.superRefine((value, context) => {
    const error = value && bedrockModelError(value);
    if (error) context.addIssue({ code: "custom", message: error });
  }),
  tools: z.boolean().optional(),
  allowAnthropic: z.boolean().optional(),
  usOnly: z.boolean().optional(),
  blockedModels: z.array(z.string().trim().min(1).max(2048)).max(2000).optional(),
  url: optionalSetting.refine((value) => !value || validEndpoint(value), "Use an HTTPS endpoint origin (HTTP is allowed only on loopback)."),
  controlUrl: optionalSetting.refine((value) => !value || validEndpoint(value), "Use an HTTPS control-plane endpoint origin (HTTP is allowed only on loopback)."),
}).strict();

export function decodeBedrockConfig(raw: unknown): BedrockConfig {
  const parsed = bedrockConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`Bedrock settings: ${parsed.error.issues[0]?.message ?? "invalid configuration"}`);
  if (parsed.data.endpoint === "mantle" && parsed.data.api === "converse") {
    throw new Error("Bedrock Mantle uses Chat Completions or Messages. Select automatic API selection.");
  }
  return parsed.data;
}

/** A null token limit clears a saved limit. Keep that deletion in the decoded
 * patch, then omit undefined properties at the JSON persistence boundary. */
export function mergeBedrockConfig(config: unknown, patch: BedrockConfig): BedrockConfig {
  const merged = decodeBedrockConfig({ ...config as Record<string, unknown>, ...patch });
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}

export function publicBedrockSettings(config: BedrockConfig): BedrockSettings {
  return {
    region: config.region ?? "", profile: config.profile ?? "", auth: config.auth ?? "auto",
    endpoint: config.endpoint ?? "runtime", api: config.api ?? "auto", model: config.model ?? "",
    ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
    tools: config.tools !== false, apiKeyConfigured: Boolean(config.apiKey), apiKeySaved: Boolean(config.apiKey),
    accessKeysConfigured: Boolean(config.accessKeyId && config.secretAccessKey),
    accessKeysSaved: Boolean(config.accessKeyId && config.secretAccessKey), sessionTokenConfigured: Boolean(config.sessionToken),
    allowAnthropic: config.allowAnthropic !== false, blockedModels: config.blockedModels ?? [],
    usOnly: config.usOnly === true,
    url: config.url ?? "", controlUrl: config.controlUrl ?? "",
  };
}
