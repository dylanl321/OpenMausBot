// AWS owns credential resolution/refresh, signing, endpoint partitions and
// the native event-stream codec. No shell commands or global env mutation.
import { BedrockClient, GetCustomModelCommand, GetFoundationModelCommand, GetInferenceProfileCommand, GetProvisionedModelThroughputCommand, type GetInferenceProfileCommandOutput } from "@aws-sdk/client-bedrock";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { fromIni } from "@aws-sdk/credential-provider-ini";
import { Hash } from "@smithy/core/serde";
import { HttpRequest } from "@smithy/core/protocols";
import { loadSharedConfigFiles, memoize } from "@smithy/core/config";
import { SignatureV4 } from "@smithy/signature-v4";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { bedrockAccessError, bedrockArnRegion, bedrockModelError, bedrockRoutingError, type BedrockConfig, type BedrockSettings } from "../../shared/bedrock.ts";
import { redactSecretsInText } from "../redact.ts";
import { ChatProtocolError } from "./openai-chat-protocol.ts";

export const BEDROCK_REQUEST_TIMEOUT_MS = 180_000;
const CATALOG_TIMEOUT_MS = 10_000;

/** Stop/timeout must also bound credential providers (SSO/credential_process
 * and refresh), which do not themselves accept a turn's AbortSignal. */
export async function withBedrockAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Bedrock request cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export interface BedrockConnection {
  region: string;
  regionSource: BedrockSettings["regionSource"];
  profile?: string;
  credentialSource: BedrockSettings["credentialSource"];
  accessKeysConfigured: boolean;
  sessionTokenConfigured: boolean;
  apiKey: string;
  apiKeyMode: boolean;
  control: BedrockClient;
  runtime: BedrockRuntimeClient;
  signal: AbortSignal;
  secrets(): readonly string[];
  ready(signal?: AbortSignal): Promise<void>;
  checkModel(model: string): void;
  authorize(model: string, signal: AbortSignal): Promise<void>;
  request(path: string, options?: { body?: unknown; signal?: AbortSignal; headers?: Record<string, string>; messages?: boolean }): Promise<Response>;
  safeError(error: unknown): Error;
  close(): void;
}

export async function createBedrockConnection(config: BedrockConfig, environment: Record<string, string>): Promise<BedrockConnection> {
  const env = { ...process.env, ...environment };
  const explicitProfile = config.profile?.trim() || env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || undefined;
  const profile = explicitProfile || (config.auth === "profile" ? "default" : undefined);
  let profileRegion: string | undefined;
  if (!config.region && !env.AWS_REGION && !env.AWS_DEFAULT_REGION) {
    try {
      const files = await loadSharedConfigFiles({ configFilepath: env.AWS_CONFIG_FILE, filepath: env.AWS_SHARED_CREDENTIALS_FILE, ignoreCache: true });
      profileRegion = files.configFile[profile ?? "default"]?.region;
    } catch { throw new Error("Could not read the AWS profile’s region. Check the shared AWS config file or set a region in Bedrock settings."); }
  }
  const regionSettings = [
    [config.region?.trim(), "setting"], [env.AWS_REGION, "AWS_REGION"], [env.AWS_DEFAULT_REGION, "AWS_DEFAULT_REGION"],
    [profileRegion, "profile"], ["us-east-1", "default"],
  ] as const;
  const [region, regionSource] = regionSettings.find(([value]) => Boolean(value)) as readonly [string, NonNullable<BedrockSettings["regionSource"]>];
  // Environment-derived regions receive the same validation as saved ones.
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) throw new Error("Bedrock needs a valid AWS region, such as us-east-1.");
  const routingError = bedrockRoutingError("", config, region);
  if (routingError) throw new Error(routingError);
  for (const endpoint of [config.url, config.controlUrl]) {
    if (!endpoint) continue;
    const host = new URL(endpoint).hostname;
    const awsHost = /\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/.test(host);
    const hostRegion = host.split(".").find((part) => /^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(part));
    if (awsHost && hostRegion && hostRegion !== region) throw new Error("The Bedrock endpoint region must match the selected AWS region.");
    const bedrockHost = /^(?:bedrock(?:-runtime|-mantle)?(?:-fips)?\.[a-z0-9-]+|vpce-[a-z0-9-]+\.bedrock(?:-runtime|-mantle)?(?:-fips)?\.[a-z0-9-]+\.vpce)\.(?:amazonaws\.com(?:\.cn)?|api\.aws)$/.test(host);
    if (config.usOnly && (!bedrockHost || hostRegion !== region)) {
      throw new Error("US-only inference requires a regional AWS endpoint, including for endpoint overrides.");
    }
  }
  const apiKey = config.apiKey || env.OMB_BEDROCK_API_KEY || env.AWS_BEARER_TOKEN_BEDROCK || "";
  const apiKeyMode = config.auth === "api-key" || ((!config.auth || config.auth === "auto") && Boolean(apiKey));
  const savedKeys = Boolean(config.accessKeyId || config.secretAccessKey);
  const instanceKeys = Object.hasOwn(environment, "AWS_ACCESS_KEY_ID") || Object.hasOwn(environment, "AWS_SECRET_ACCESS_KEY");
  const useSavedKeys = savedKeys && config.auth !== "aws";
  const useKeys = config.auth === "access-keys" || ((!config.auth || config.auth === "auto") && !profile && (savedKeys || instanceKeys))
    || (config.auth === "aws" && !profile && instanceKeys);
  const keyId = useSavedKeys ? config.accessKeyId : instanceKeys ? environment.AWS_ACCESS_KEY_ID : env.AWS_ACCESS_KEY_ID;
  const secretKey = useSavedKeys ? config.secretAccessKey : instanceKeys ? environment.AWS_SECRET_ACCESS_KEY : env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = useSavedKeys ? config.sessionToken : instanceKeys ? environment.AWS_SESSION_TOKEN : env.AWS_SESSION_TOKEN;
  const credentialSource: BedrockSettings["credentialSource"] = apiKeyMode ? (config.apiKey ? "saved-token" : "environment-token")
    : useKeys ? (useSavedKeys ? "saved-keys" : "environment-keys") : profile ? "profile"
    : env.AWS_ACCESS_KEY_ID ? "environment-keys" : "aws-chain";
  const stop = new AbortController();
  const secrets = new Set<string>([apiKey, config.accessKeyId, config.secretAccessKey, config.sessionToken,
    env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY, env.AWS_SESSION_TOKEN].filter((value): value is string => Boolean(value)));
  const providerOptions = {
    profile, filepath: env.AWS_SHARED_CREDENTIALS_FILE, configFilepath: env.AWS_CONFIG_FILE,
    timeout: 1_000, maxRetries: 0, clientConfig: { region },
  };
  // A named profile owns its account. Its failure must not fall through to
  // another workload role. fromIni still supports SSO, assumed roles,
  // credential_process and credential_source within that selected profile.
  const provider = profile ? memoize(fromIni(providerOptions),
    (identity) => Boolean(identity.expiration && identity.expiration.getTime() - Date.now() < 300_000),
    (identity) => Boolean(identity.expiration),
  ) : defaultProvider(providerOptions);
  const credentials = async () => {
    // Per-instance static credentials must form a complete pair. Never fill
    // a missing half from a different account's ambient environment.
    let identity;
    if (useKeys) {
      if (!keyId || !secretKey) throw new Error("Set both an AWS access key ID and secret access key for this Bedrock connection.");
      identity = { accessKeyId: keyId, secretAccessKey: secretKey,
        ...(sessionToken ? { sessionToken } : {}),
      };
    } else {
      identity = await provider();
    }
    for (const value of [identity.accessKeyId, identity.secretAccessKey, identity.sessionToken]) if (value) secrets.add(value);
    return identity;
  };
  const auth = apiKeyMode ? {
    token: async () => {
      if (!apiKey) throw new Error("Add a Bedrock API key in Settings → Engines, or set AWS_BEARER_TOKEN_BEDROCK.");
      return { token: apiKey };
    },
    // Selecting exactly one scheme prevents fallback to another account.
    httpAuthSchemeProvider: () => [{ schemeId: "smithy.api#httpBearerAuth" }],
  } : {
    credentials,
    httpAuthSchemeProvider: () => [{ schemeId: "aws.auth#sigv4", signingProperties: { name: "bedrock", region },
      propertiesExtractor: (client: unknown, context: unknown) => ({ signingProperties: { config: client, context } }),
    }],
  };
  const control = new BedrockClient({ region, ...auth, endpoint: config.controlUrl || undefined, ignoreConfiguredEndpointUrls: true, maxAttempts: 2,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: CATALOG_TIMEOUT_MS },
  });
  const runtime = new BedrockRuntimeClient({ region, ...auth, endpoint: config.url || undefined, ignoreConfiguredEndpointUrls: true, maxAttempts: 1,
    // The SDK defaults to HTTP/2 for bidirectional audio. Conversation APIs
    // support HTTP/1.1, including private gateways and local test endpoints.
    requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: BEDROCK_REQUEST_TIMEOUT_MS }),
  });
  const domain = region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com";
  const root = config.url?.replace(/\/+$/, "") || (config.endpoint === "mantle"
    ? `https://bedrock-mantle.${region}.api.aws` : `https://bedrock-runtime.${region}.${domain}`);
  const signer = new SignatureV4({ credentials, region, service: config.endpoint === "mantle" ? "bedrock-mantle" : "bedrock", sha256: Hash.bind(null, "sha256") });
  const combine = (signal?: AbortSignal, timeout = CATALOG_TIMEOUT_MS) => AbortSignal.any([stop.signal, AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  const checkPolicy = (model: string, identities: string[] = []) => {
    const error = bedrockModelError(model) ?? bedrockAccessError(model, config, identities) ?? bedrockRoutingError(model, config, region, identities);
    if (error) throw new Error(error);
  };
  const checkModel = (model: string) => {
    checkPolicy(model);
    if (config.endpoint === "mantle" && (model.startsWith("arn:") || /^(?:us|eu|apac|au|jp|global)\./i.test(model))) {
      throw new Error("Bedrock Mantle requires a model ID from its regional catalog; inference profiles and model ARNs use Bedrock Runtime.");
    }
    const arnRegion = bedrockArnRegion(model);
    if (arnRegion && arnRegion !== region) throw new Error(`This model ARN belongs to ${arnRegion}. Select that region or an inference profile available in ${region}.`);
  };
  const safeError = (error: unknown): Error => {
    const name = error instanceof Error ? error.name : "Error";
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) message = message.split(secret).join("[redacted]");
    if (/CredentialsProviderError|TokenProviderError/.test(name)) message = "Could not load AWS credentials. Check the AWS profile or workload role; renew an expired SSO session with aws sso login.";
    else if (/ExpiredToken|UnrecognizedClient|InvalidSignature|InvalidBearerToken/.test(name)) message = "Bedrock credentials were rejected or expired. Refresh the AWS session or replace the Bedrock API key.";
    else if (/AccessDenied/.test(name)) message = "Bedrock access denied. Check the selected region, model access and IAM permissions.";
    const safeMessage = redactSecretsInText(message).slice(0, 2_000);
    const result = error instanceof ChatProtocolError ? new ChatProtocolError(safeMessage) : new Error(safeMessage);
    result.name = name;
    return result;
  };

  // Opaque application profiles and provisioned/custom models cannot be
  // checked by substring. Resolve their backing models before sending any
  // prompt when an access restriction is enabled. A lookup failure denies.
  const authorize = async (model: string, signal: AbortSignal, seen = new Set<string>()): Promise<void> => {
    if (!seen.size) checkModel(model);
    else checkPolicy(model);
    // Mantle serves models in its endpoint's region and has no inference
    // profiles. Short catalog IDs must not be mistaken for Runtime aliases.
    if (config.endpoint === "mantle") return;
    if (config.allowAnthropic !== false && !config.blockedModels?.length && !config.usOnly) return;
    if (seen.has(model) || seen.size >= 8) throw new Error("Cannot verify this model’s Bedrock access policy: cyclic or excessively nested model references.");
    seen.add(model);
    const arn = /^arn:[^:]+:bedrock:[^:]+:[^:]*:([^/]+)\/(.+)$/.exec(model);
    const kind = arn?.[1];
    const geographic = /^(?:us|eu|apac|au|jp|global)\./i.test(model);
    // Only known foundation-provider namespaces are transparent IDs. An
    // unfamiliar geography (for example ca.amazon...) must not bypass a
    // destination check just because its identifier contains a dot. New
    // provider namespaces still work, through AWS foundation metadata below.
    if (!arn && /^(?:ai21|amazon|anthropic|cohere|deepseek|google|meta|minimax|mistral|moonshot|nvidia|openai|qwen|writer|xai|zai)\./i.test(model)) return;
    if (kind === "foundation-model") { checkPolicy(arn![2]); return; }
    const bounded = combine(signal);
    try {
      let references: string[] = [];
      if (kind === "inference-profile" || kind === "application-inference-profile" || !arn) {
        let profileDetails: GetInferenceProfileCommandOutput | undefined;
        try {
          profileDetails = await withBedrockAbort(control.send(new GetInferenceProfileCommand({ inferenceProfileIdentifier: model }), { abortSignal: bounded }), bounded);
        } catch (error) {
          if (arn || geographic || !model.includes(".") || bounded.aborted) throw error;
          const result = await withBedrockAbort(control.send(new GetFoundationModelCommand({ modelIdentifier: model }), { abortSignal: bounded }), bounded);
          const details = result.modelDetails;
          checkPolicy(model, [details?.modelId ?? "", details?.modelArn ?? "", details?.providerName ?? ""]);
          if (details?.modelArn) references = [details.modelArn];
        }
        if (profileDetails) {
          checkPolicy(model, [profileDetails.inferenceProfileArn ?? "", profileDetails.inferenceProfileId ?? ""]);
          if (config.usOnly && profileDetails.type === "SYSTEM_DEFINED" && !profileDetails.inferenceProfileId?.startsWith("us.")) {
            throw new Error("US-only inference requires a US geographic inference profile.");
          }
          references = (profileDetails.models ?? []).flatMap((entry) => entry.modelArn ? [entry.modelArn] : []);
        }
      } else if (kind === "provisioned-model") {
        const result = await withBedrockAbort(control.send(new GetProvisionedModelThroughputCommand({ provisionedModelId: model }), { abortSignal: bounded }), bounded);
        if (result.modelArn) references = [result.modelArn];
      } else if (kind === "custom-model") {
        const result = await withBedrockAbort(control.send(new GetCustomModelCommand({ modelIdentifier: model }), { abortSignal: bounded }), bounded);
        if (result.baseModelArn) references = [result.baseModelArn];
      }
      if (!references.length) throw new Error("Cannot verify this model’s Bedrock access policy. Choose a foundation model or grant access to its backing-model metadata.");
      for (const reference of new Set(references)) await authorize(reference, bounded, new Set(seen));
    } catch (error) {
      if (bounded.aborted) throw bounded.reason;
      throw new Error(`Bedrock access policy could not authorize this model: ${safeError(error).message}`);
    }
  };

  return {
    region, regionSource, profile, credentialSource, apiKey, apiKeyMode, control, runtime, signal: stop.signal,
    accessKeysConfigured: Boolean(keyId && secretKey), sessionTokenConfigured: Boolean(sessionToken),
    secrets: () => [...secrets], checkModel, authorize, safeError,
    async ready(signal) {
      const bounded = combine(signal, 5_000);
      try {
        if (apiKeyMode) {
          if (!apiKey) throw new Error("Add a Bedrock API key in Settings → Engines, or set AWS_BEARER_TOKEN_BEDROCK.");
        } else await withBedrockAbort(credentials(), bounded);
      } catch (error) { throw safeError(error); }
    },
    async request(path, options = {}) {
      const bounded = AbortSignal.any([stop.signal, options.signal ?? AbortSignal.timeout(BEDROCK_REQUEST_TIMEOUT_MS)]);
      const url = new URL(`${root}${path}`);
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const method = body === undefined ? "GET" : "POST";
      let headers: Record<string, string> = { "content-type": "application/json", ...options.headers };
      if (apiKeyMode) {
        if (!apiKey) throw new Error("Add a Bedrock API key in Settings → Engines.");
        headers[options.messages ? "x-api-key" : "authorization"] = options.messages ? apiKey : `Bearer ${apiKey}`;
      } else {
        const query: Record<string, string> = Object.fromEntries(url.searchParams);
        const signed = await withBedrockAbort(signer.sign(new HttpRequest({
          protocol: url.protocol, hostname: url.hostname, port: url.port ? Number(url.port) : undefined,
          method, path: url.pathname, query, headers: { ...headers, host: url.host }, body,
        })), bounded);
        headers = signed.headers;
      }
      try {
        return await fetch(url, { method, headers, body, signal: bounded, redirect: "error" });
      } catch (error) { throw safeError(error); }
    },
    close() { stop.abort(); control.destroy(); runtime.destroy(); },
  };
}
