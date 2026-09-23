import { GetFoundationModelAvailabilityCommand, ListFoundationModelsCommand, ListInferenceProfilesCommand, type FoundationModelSummary } from "@aws-sdk/client-bedrock";
import { bedrockAccessError, bedrockArnRegion, bedrockModelError, bedrockModelFeatures, bedrockRoutingError, canonicalBedrockModel, type BedrockConfig, type BedrockModelFeatures, type BedrockModelInfo } from "../../shared/bedrock.ts";
import type { ModelCatalog } from "../contracts.ts";
import type { BedrockConnection } from "./bedrock-connection.ts";
import { withBedrockAbort } from "./bedrock-connection.ts";

export interface BedrockModel extends BedrockModelInfo {
  features: BedrockModelFeatures;
  /** Backing model identities supplied by AWS, used for access controls. */
  identities: string[];
}

function conversational(id: string): boolean {
  return !/(?:embed|rerank|amazon\.nova(?:-2)?-sonic|twelvelabs\.|stability\.)/i.test(id);
}

const regionsOf = (identities: string[]) => [...new Set(identities.flatMap((id) => bedrockArnRegion(id) ? [bedrockArnRegion(id)!] : []))].sort();

function foundationRow(model: FoundationModelSummary): BedrockModel | null {
  if (!model.modelId || !conversational(model.modelId) || !model.inputModalities?.includes("TEXT") || !model.outputModalities?.includes("TEXT")) return null;
  return {
    id: model.modelId, label: model.modelName || model.modelId, provider: model.providerName,
    identities: [model.modelId, model.modelArn ?? "", model.providerName ?? ""],
    regions: regionsOf([model.modelArn ?? ""]), routing: "regional",
    features: { ...bedrockModelFeatures(model.modelId), images: model.inputModalities.includes("IMAGE"),
      streaming: model.responseStreamingSupported !== false },
  };
}

export function createBedrockCatalog(config: BedrockConfig, connection: BedrockConnection) {
  const row = (id: string): BedrockModel => ({ id, label: id, identities: [id], features: bedrockModelFeatures(id),
    regions: [connection.region], routing: "regional" });
  // Never seed a region with a static list from another region or endpoint.
  let foundation: BedrockModel[] = [];
  let profiles: BedrockModel[] = [];
  let loaded = false;
  let warning: string | undefined;
  let inFlight: Promise<void> | undefined;

  const all = (): BedrockModel[] => {
    const rows = [...foundation, ...profiles];
    if (config.model && !rows.some((entry) => entry.id === config.model)) rows.unshift({ ...row(config.model), routing: "manual",
      label: `${config.model} (manual; region not verified)`, regions: regionsOf([config.model]),
    });
    return [...new Map(rows.map((entry) => [entry.id, entry])).values()];
  };
  const accessError = (entry: BedrockModel) => bedrockAccessError(entry.id, config, entry.identities)
    ?? bedrockRoutingError(entry.id, config, connection.region, entry.identities);
  const allowed = (entry: BedrockModel) => !entry.unavailable && !accessError(entry);
  const find = (model: string) => {
    const rows = [...foundation, ...profiles];
    return rows.find((entry) => entry.id === model) ?? rows.find((entry) => entry.identities.includes(model))
      ?? rows.find((entry) => canonicalBedrockModel(entry.id) === canonicalBedrockModel(model))
      ?? all().find((entry) => entry.id === model);
  };
  const features = (model: string): BedrockModelFeatures => {
    const found = find(model);
    return { ...(found?.features ?? bedrockModelFeatures(model)), ...(config.tools === false ? { tools: false } : {}) };
  };
  const models = (): ModelCatalog => {
    const options = all().filter(allowed).map((entry) => ({
      id: entry.id, label: entry.label, provider: entry.provider,
      capabilities: { tools: config.tools !== false && entry.features.tools, images: entry.features.images },
    }));
    return { default: options.some((entry) => entry.id === config.model) ? config.model! : options[0]?.id ?? "", options };
  };

  async function refresh() {
    const signal = AbortSignal.any([connection.signal, AbortSignal.timeout(30_000)]);
    await connection.ready(signal);
    if (config.endpoint === "mantle") {
      // Runtime has no /models operation. Mantle's list is a different
      // catalog with different IDs, and pagination stays on this endpoint.
      const rows: BedrockModel[] = [];
      const seen = new Set<string>();
      let after = "";
      for (let page = 0; page < 100; page++) {
        const response = await connection.request(`/v1/models${after ? `?after=${encodeURIComponent(after)}` : ""}`, { signal });
        if (!response.ok) throw new Error(`Bedrock Mantle model discovery failed (HTTP ${response.status}). Check model-list permissions and the selected region.`);
        const result = await response.json() as { data?: Array<{ id?: unknown; owned_by?: unknown; name?: unknown }>; has_more?: boolean; last_id?: unknown };
        if (!Array.isArray(result.data)) throw new Error("Bedrock Mantle returned an invalid model catalog.");
        for (const entry of result.data) {
          if (typeof entry.id !== "string" || bedrockModelError(entry.id) || !conversational(entry.id)) continue;
          const provider = typeof entry.owned_by === "string" ? entry.owned_by : undefined;
          rows.push({ ...row(entry.id), provider, label: typeof entry.name === "string" ? entry.name : entry.id,
            identities: [entry.id, provider ?? ""],
          });
        }
        if (rows.length > 10_000) throw new Error("Bedrock Mantle model catalog exceeded the model limit.");
        if (!result.has_more) { foundation = rows; profiles = []; loaded = true; warning = undefined; return; }
        const next = typeof result.last_id === "string" ? result.last_id : result.data.at(-1)?.id;
        if (typeof next !== "string" || !next || seen.has(next)) throw new Error("Bedrock Mantle returned an invalid catalog cursor.");
        seen.add(next); after = next;
      }
      throw new Error("Bedrock Mantle model catalog exceeded the page limit.");
    }

    // A caller can be allowed to invoke models without both list actions.
    // Refresh the successful source; keep prior data for a failed source and
    // show the partial result explicitly instead of claiming a full catalog.
    let availabilityWarning: string | undefined;
    const results = await Promise.allSettled([
      (async () => {
        const response = await withBedrockAbort(connection.control.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), { abortSignal: signal }), signal);
        const models = response.modelSummaries ?? [];
        const metadata = models.flatMap((model) => { const entry = foundationRow(model); return entry ? [entry] : []; });
        const invocable = new Set(models.filter((model) => model.inferenceTypesSupported?.includes("ON_DEMAND")).map((model) => model.modelId));
        const rows = metadata.filter((entry) => invocable.has(entry.id) && (!entry.regions.length || entry.regions.includes(connection.region)));
        // Availability is regional too. Listing may succeed for a model that
        // can only be reached through an inference profile in this region.
        // Tokens/IAM policies without this read action still get the list,
        // explicitly marked as not fully checked; discovery never invokes.
        let cursor = 0;
        let denied = false;
        await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (cursor < rows.length && !denied && !signal.aborted) {
            const entry = rows[cursor++];
            try {
              const availability = await withBedrockAbort(connection.control.send(new GetFoundationModelAvailabilityCommand({ modelId: entry.id }), { abortSignal: signal }), signal);
              if (availability.regionAvailability === "NOT_AVAILABLE") entry.unavailable = `Direct inference is unavailable in ${connection.region}; use an available inference profile.`;
            } catch (error) {
              availabilityWarning = "Regional availability checks are incomplete. Inference access has not been verified.";
              if (/AccessDenied|Unauthorized|UnknownOperation/.test((error as Error)?.name ?? "")) denied = true;
            }
          }
        }));
        return { metadata, rows };
      })(),
      (async () => {
        const rows: BedrockModel[] = [];
        const seen = new Set<string>();
        let nextToken: string | undefined;
        for (let page = 0; page < 100; page++) {
          const response = await withBedrockAbort(connection.control.send(new ListInferenceProfilesCommand({ nextToken }), { abortSignal: signal }), signal);
          for (const profile of response.inferenceProfileSummaries ?? []) {
            if (profile.status !== "ACTIVE") continue;
            const id = profile.inferenceProfileId || profile.inferenceProfileArn;
            const references = (profile.models ?? []).flatMap((model) => model.modelArn ? [model.modelArn] : []);
            if (!id || !references.length || !references.some(conversational)) continue;
            const profileRegion = bedrockArnRegion(profile.inferenceProfileArn ?? "");
            if (profileRegion && profileRegion !== connection.region) continue;
            rows.push({ id, label: profile.inferenceProfileName || id, identities: [id, profile.inferenceProfileArn ?? "", ...references],
              features: bedrockModelFeatures(references[0]),
              regions: regionsOf(references), routing: profile.type === "APPLICATION" ? "application" : /^global\./i.test(id) ? "global" : "geographic",
            });
          }
          if (rows.length > 10_000) throw new Error("Bedrock inference profiles exceeded the model limit.");
          if (!response.nextToken) return rows;
          if (seen.has(response.nextToken)) throw new Error("Bedrock returned an invalid inference-profile cursor.");
          nextToken = response.nextToken; seen.add(nextToken);
        }
        throw new Error("Bedrock inference profiles exceeded the page limit.");
      })(),
    ]);
    const [fm, ip] = results;
    if (fm.status === "fulfilled") foundation = fm.value.rows;
    if (ip.status === "fulfilled") {
      const metadata = fm.status === "fulfilled" ? fm.value.metadata : foundation;
      profiles = ip.value.map((entry) => {
        const backing = metadata.find((model) => entry.identities.some((id) => canonicalBedrockModel(id) === model.id));
        return backing ? { ...entry, provider: backing.provider, features: backing.features } : entry;
      });
    }
    const failures = results.flatMap((result) => result.status === "rejected" ? [connection.safeError(result.reason).message] : []);
    warning = failures.length ? `Model discovery is incomplete. ${failures.join(" ")}` : availabilityWarning;
    if (failures.length === 2) throw new Error(warning);
    loaded = true;
  }

  return {
    models, all, features,
    checkModel(model: string) {
      const entry = find(model);
      if (!entry) return;
      const error = (entry.id === model ? entry.unavailable : undefined) ?? accessError(entry);
      if (error) throw new Error(error);
    },
    apiModel: (model: string) => find(model)?.identities.find((id) => id.includes(":foundation-model/")) ?? model,
    info: (): BedrockModelInfo[] => all().map((entry) => ({
      id: entry.id, label: entry.label, provider: entry.provider, regions: entry.regions, routing: entry.routing,
      modelIds: [...new Set(entry.identities.filter((id) => id.includes(":foundation-model/")).map(canonicalBedrockModel))],
      unavailable: entry.unavailable, accessError: accessError(entry) ?? undefined,
    })),
    loaded: () => loaded,
    warning: () => warning,
    refresh(): Promise<void> {
      if (inFlight) return inFlight;
      inFlight = refresh().catch((error) => {
        warning = connection.safeError(error).message;
        throw connection.safeError(error);
      }).finally(() => { inFlight = undefined; });
      return inFlight;
    },
  };
}
