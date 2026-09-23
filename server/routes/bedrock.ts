import { decodeBedrockConfig, mergeBedrockConfig } from "../bedrock-config.ts";
import { BedrockDriver, describeBedrockSettings } from "../drivers/bedrock.ts";
import type { BedrockConfig } from "../../shared/bedrock.ts";
import type { InstanceConfig, ProviderInstance } from "../contracts.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BedrockRouteDeps {
  entry(id: string): InstanceConfig | undefined;
  instance(id: string): ProviderInstance | null;
  editable(id: string): boolean;
  save(id: string, patch: BedrockConfig): Promise<unknown>;
}

export function createBedrockRoutes(deps: BedrockRouteDeps): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const match = /^\/api\/instances\/([\w.-]+)\/bedrock(\/test)?$/.exec(path);
    if (!match || !["GET", "PATCH", "POST"].includes(method)) return PASS;
    const id = match[1];
    const entry = deps.entry(id);
    if (!entry || entry.driver !== "bedrock") return json(res, 404, { error: "No such Bedrock connection." });
    if (!deps.editable(id)) return json(res, 403, { error: "This connection is managed by your organization." });
    res.setHeader("cache-control", "no-store");
    if (method === "GET" && !match[2]) return json(res, 200, { settings: describeBedrockSettings(deps.instance(id), entry.config) });
    if ((method === "POST") !== Boolean(match[2]) || method === "GET") return json(res, 405, { error: "Method not allowed." });
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return json(res, 415, { error: "content-type must be application/json" });
    let patch: BedrockConfig;
    try {
      patch = decodeBedrockConfig(await readBody(req, 256 * 1024));
      if ((patch.accessKeyId !== undefined) !== (patch.secretAccessKey !== undefined)
        || Boolean(patch.accessKeyId) !== Boolean(patch.secretAccessKey)) throw new Error("Set or remove both AWS access keys together.");
      if (patch.accessKeyId !== undefined && patch.sessionToken === undefined) patch.sessionToken = "";
    }
    catch (error) { return json(res, 400, { error: error instanceof Error ? error.message : "Invalid Bedrock settings." }); }
    if (method === "PATCH") {
      try { return json(res, 200, { instances: await deps.save(id, patch) }); }
      catch (error) {
        const status = (error as { status?: number })?.status ?? 400;
        return json(res, status, { error: error instanceof Error ? error.message : "Bedrock settings could not be saved." });
      }
    }
    // A test uses a disposable connection with the draft settings. Catalog
    // access never sends a prompt, changes saved credentials, or invokes a model.
    let temporary: ProviderInstance | undefined;
    try {
      const config = mergeBedrockConfig(entry.config, patch);
      temporary = await BedrockDriver.create({ instanceId: `${id}-test`, displayName: entry.displayName,
        environment: entry.environment ?? {}, enabled: true, config,
      });
      const status = await temporary.snapshot();
      if (status.state !== "available") return json(res, 200, { ok: false, message: status.reason });
      await temporary.refreshModels?.();
      const settings = describeBedrockSettings(temporary, config);
      const refreshed = await temporary.snapshot();
      return json(res, 200, { ok: true, settings, warning: refreshed.warning?.message,
        message: "Model catalog reached. Inference permission is checked when you send a message.",
      });
    } catch (error) {
      return json(res, 200, { ok: false, message: error instanceof Error ? error.message : "Could not reach Bedrock." });
    } finally { await temporary?.dispose(); }
  };
}
