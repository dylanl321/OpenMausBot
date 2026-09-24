import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { bedrockAccessError, bedrockRoutingError, canonicalBedrockModel, type BedrockConfig, type BedrockModelInfo, type BedrockSettings as Settings } from "../../shared/bedrock";

const inputClass = "mt-1 w-full min-w-0 rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[12px] text-ink outline-none focus:border-accent disabled:opacity-50";
const empty: Settings = { apiKeyConfigured: false, apiKeySaved: false, accessKeysConfigured: false, accessKeysSaved: false, sessionTokenConfigured: false };

function editable(settings: Settings): BedrockConfig {
  return { region: settings.region ?? "", profile: settings.profile ?? "", auth: settings.auth ?? "auto",
    apiKeyEnv: settings.apiKeyEnv ?? "", apiKeyHeader: settings.apiKeyHeader ?? "",
    endpoint: settings.endpoint ?? "runtime", api: settings.api ?? "auto", model: settings.model ?? "",
    tools: settings.tools !== false, maxTokens: settings.maxTokens, allowAnthropic: settings.allowAnthropic !== false,
    usOnly: settings.usOnly === true, blockedModels: settings.blockedModels ?? [], url: settings.url ?? "", controlUrl: settings.controlUrl ?? "" };
}

// A catalog belongs to a connection, not just to the Bedrock driver. Access
// policy changes can filter the same catalog locally; routing/auth changes
// must wait for a catalog from the new connection.
function catalogKey(config: BedrockConfig): string {
  return JSON.stringify([config.region, config.profile, config.auth, config.endpoint, config.url, config.controlUrl,
    config.apiKey, config.apiKeyEnv, config.apiKeyHeader, config.accessKeyId, config.secretAccessKey, config.sessionToken]);
}

function modelError(model: BedrockModelInfo, draft: BedrockConfig, region: string): string | null {
  return model.unavailable ?? bedrockAccessError(model.id, draft, [model.provider ?? "", ...model.modelIds ?? []])
    ?? bedrockRoutingError(model.id, draft, region, model.regions.map((destination) => `arn:aws:bedrock:${destination}::foundation-model/model`));
}

interface Probe { ok: boolean; settings?: Settings; message?: string; warning?: string }

export function BedrockSettings({ instance, className }: { instance: InstanceInfo; className?: string }) {
  const { dispatch, refreshModels } = useStore();
  const [base, setBase] = useState(instance.bedrock ?? empty);
  const [draft, setDraft] = useState(() => editable(instance.bedrock ?? empty));
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probe, setProbe] = useState<(Probe & { key: string }) | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const [blockedText, setBlockedText] = useState(() => (instance.bedrock?.blockedModels ?? []).join("\n"));
  const revision = useRef(0);
  const operation = useRef<AbortController | null>(null);
  const saveLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; operation.current?.abort(); };
  }, []);
  useEffect(() => {
    if (edited || saving || !instance.bedrock) return;
    setBase(instance.bedrock);
    setDraft(editable(instance.bedrock));
    setBlockedText((instance.bedrock.blockedModels ?? []).join("\n"));
  }, [instance.bedrock, edited, saving]);

  const change = (patch: Partial<BedrockConfig>) => {
    revision.current++;
    operation.current?.abort();
    setTesting(false);
    setDraft((value) => ({ ...value, ...patch }));
    if (patch.blockedModels) setBlockedText(patch.blockedModels.join("\n"));
    setEdited(true); setSaved(false); setError("");
  };
  const key = catalogKey(draft);
  const catalog = probe?.ok && probe.key === key ? probe.settings : key === catalogKey(editable(base)) ? base : undefined;
  const region = draft.region || catalog?.resolvedRegion || "";
  const rows = catalog?.models ?? [];
  const visible = rows.filter((model) => `${model.id} ${model.label} ${model.provider ?? ""} ${(model.modelIds ?? []).join(" ")}`.toLowerCase().includes(search.toLowerCase())).slice(0, 100);
  const allowed = rows.filter((model) => !modelError(model, draft, region)).length;
  const body = () => JSON.stringify({ ...draft, maxTokens: draft.maxTokens ?? null });
  const url = `/api/instances/${encodeURIComponent(instance.instanceId)}/bedrock`;

  const test = async () => {
    if (saveLock.current || testing) return;
    const version = ++revision.current;
    const controller = new AbortController();
    operation.current?.abort(); operation.current = controller;
    setTesting(true); setError(""); setProbe(null); setSaved(false);
    try {
      const result = await api(`${url}/test`, { method: "POST", body: body(), signal: controller.signal }) as Probe;
      if (mounted.current && version === revision.current) setProbe({ ...result, key });
    } catch (cause) {
      if (mounted.current && version === revision.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current && version === revision.current) setTesting(false);
    }
  };
  const save = async () => {
    if (saveLock.current) return;
    saveLock.current = true;
    revision.current++; operation.current?.abort(); setTesting(false);
    setSaving(true); setError(""); setSaved(false);
    try {
      const result = await api(url, { method: "PATCH", body: body() }) as { instances: InstanceInfo[] };
      dispatch({ type: "instances", instances: result.instances });
      if (!mounted.current) return;
      const settings = result.instances.find((entry) => entry.instanceId === instance.instanceId)?.bedrock ?? empty;
      // Clear credential inputs only after the write succeeds. A failed save
      // leaves the draft intact, and saved secrets never return from the API.
      setBase(settings); setDraft(editable(settings)); setEdited(false); setProbe(null); setSaved(true);
      setBlockedText((settings.blockedModels ?? []).join("\n"));
      await refreshModels(instance.instanceId).catch(() => {
        if (mounted.current) setError(t("bedrock.savedCatalogFailed"));
      });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saveLock.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <div data-bedrock-settings={instance.instanceId} className={cn("space-y-4 text-[12px]", className)}>
    <p className="leading-relaxed text-ink-secondary">{t("bedrock.intro")}</p>
    <fieldset disabled={saving || instance.readOnly} className="min-w-0 space-y-4">
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-ink-secondary">{t("bedrock.authentication")}
          <select aria-label={t("bedrock.authentication")} className={inputClass} value={draft.auth} onChange={(event) => change({ auth: event.target.value as BedrockConfig["auth"] })}>
            <option value="auto">{t("bedrock.auth.auto")}</option>
            <option value="api-key">{t("bedrock.auth.token")}</option>
            <option value="profile">{t("bedrock.auth.profile")}</option>
            <option value="access-keys">{t("bedrock.auth.keys")}</option>
            <option value="aws">{t("bedrock.auth.chain")}</option>
          </select>
        </label>
        <label className="min-w-0 text-ink-secondary">{t("bedrock.region")}
          <input aria-label={t("bedrock.region")} className={inputClass} value={draft.region} spellCheck={false} placeholder={t("bedrock.region.auto")}
            onChange={(event) => change({ region: event.target.value })} />
        </label>
      </div>
      {(draft.auth === "auto" || draft.auth === "api-key") && <div>
        <label className="text-ink-secondary">{t("bedrock.token")}
          <input aria-label={t("bedrock.token")} type="password" autoComplete="new-password" className={inputClass} value={draft.apiKey ?? ""}
            placeholder={base.apiKeySaved ? t("bedrock.secret.saved") : t("bedrock.token.placeholder")}
            onChange={(event) => change({ apiKey: event.target.value || undefined })} />
        </label>
        <p className="mt-1.5 leading-relaxed text-ink-secondary">{t("bedrock.token.help")}</p>
        {base.apiKeySaved && <label className="mt-2 flex items-center gap-2 text-ink-secondary">
          <input type="checkbox" checked={draft.apiKey === ""} onChange={(event) => change({ apiKey: event.target.checked ? "" : undefined })} />{t("bedrock.token.remove")}
        </label>}
      </div>}
      {(draft.auth === "auto" || draft.auth === "profile" || draft.auth === "aws") && <label className="block text-ink-secondary">{t("bedrock.profile")}
        <input aria-label={t("bedrock.profile")} className={inputClass} value={draft.profile} spellCheck={false} placeholder="AWS_PROFILE / default"
          onChange={(event) => change({ profile: event.target.value })} />
        <span className="mt-1.5 block leading-relaxed">{t("bedrock.profile.help")}</span>
      </label>}
      {draft.auth === "access-keys" && <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        {(["accessKeyId", "secretAccessKey", "sessionToken"] as const).map((field) => <label key={field} className="min-w-0 text-ink-secondary">{t(`bedrock.${field}`)}
          <input aria-label={t(`bedrock.${field}`)} type="password" autoComplete="new-password" className={inputClass} value={draft[field] ?? ""}
            placeholder={base.accessKeysSaved ? t("bedrock.secret.saved") : t("bedrock.secret.environment")}
            onChange={(event) => change({ [field]: event.target.value || undefined })} />
        </label>)}
        <p className="leading-relaxed text-ink-secondary sm:col-span-2">{t("bedrock.keys.help")}</p>
        {base.accessKeysSaved && <label className="flex items-center gap-2 text-ink-secondary sm:col-span-2">
          <input type="checkbox" checked={draft.accessKeyId === ""} onChange={(event) => change(event.target.checked
            ? { accessKeyId: "", secretAccessKey: "", sessionToken: "" } : { accessKeyId: undefined, secretAccessKey: undefined, sessionToken: undefined })} />{t("bedrock.keys.remove")}
        </label>}
      </div>}
      <label className="block text-ink-secondary">{t("bedrock.endpoint")}
        <select aria-label={t("bedrock.endpoint")} className={inputClass} value={draft.endpoint} onChange={(event) => change({ endpoint: event.target.value as BedrockConfig["endpoint"], api: "auto" })}>
          <option value="runtime">{t("bedrock.endpoint.runtime")}</option>
          <option value="mantle">{t("bedrock.endpoint.mantle")}</option>
        </select>
      </label>
      <div className="space-y-2.5 rounded-xl border border-hairline/40 p-3">
        <label className="flex items-start gap-2 text-ink">
          <input type="checkbox" aria-label={t("bedrock.usOnly")} className="mt-0.5" checked={draft.usOnly === true} onChange={(event) => change({ usOnly: event.target.checked })} />
          <span>{t("bedrock.usOnly")}<span className="mt-1 block leading-relaxed text-ink-secondary">{t("bedrock.usOnly.help")}</span></span>
        </label>
        <label className="flex items-center gap-2 text-ink">
          <input type="checkbox" checked={draft.allowAnthropic !== false} onChange={(event) => change({ allowAnthropic: event.target.checked })} />{t("bedrock.allowAnthropic")}
        </label>
      </div>
      <div className="space-y-2" data-bedrock-catalog>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-ink">{t("bedrock.models")}</span>
          <span className="text-ink-secondary" aria-live="polite">{t("bedrock.modelCount", { allowed, total: rows.length })}</span>
        </div>
        {catalog?.resolvedRegion && <p className="break-words leading-relaxed text-ink-secondary" data-bedrock-region>
          {t("bedrock.resolvedRegion", { region: catalog.resolvedRegion, source: t(`bedrock.regionSource.${catalog.regionSource ?? "default"}`) })}
          {catalog.resolvedProfile && ` · ${catalog.resolvedProfile}`}
          {catalog.credentialSource && <span className="block">{probe?.key === key && draft.apiKey && catalog.credentialSource === "saved-token"
            ? t("bedrock.credential.draft-token") : probe?.key === key && draft.accessKeyId && catalog.credentialSource === "saved-keys"
            ? t("bedrock.credential.draft-keys") : t(`bedrock.credential.${catalog.credentialSource}`)}</span>}
        </p>}
        <input aria-label={t("bedrock.search")} className={inputClass} placeholder={t("bedrock.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
        {rows.length ? <div className="max-h-72 overflow-y-auto rounded-lg border border-hairline/40">
          {visible.map((model) => {
            const reason = modelError(model, draft, region);
            const imposed = modelError(model, { ...draft, blockedModels: [] }, region);
            return <label key={model.id} className={cn("flex items-start gap-2 border-b border-hairline/30 px-3 py-2 last:border-0", reason && "text-ink-secondary")}>
              <input type="checkbox" className="mt-1" aria-label={t("bedrock.allowModel", { model: model.id })} checked={!reason} disabled={Boolean(imposed)}
                onChange={(event) => change({ blockedModels: event.target.checked
                  ? (draft.blockedModels ?? []).filter((id) => canonicalBedrockModel(id) !== canonicalBedrockModel(model.id) && !model.modelIds?.includes(canonicalBedrockModel(id)))
                  : [...draft.blockedModels ?? [], model.id] })} />
              <span className="min-w-0 flex-1"><span className="block break-words font-medium">{model.label}</span>
                <span className="block break-all font-mono text-[10px]">{model.id}</span>
                <span className="mt-0.5 block break-words text-[11px] text-ink-secondary">{t(`bedrock.routing.${model.routing}`)}{model.regions.length ? ` · ${model.regions.join(", ")}` : ""}</span>
                {reason && <span className="mt-0.5 block text-[11px] text-ink-secondary">{reason}</span>}
              </span>
            </label>;
          })}
          {!visible.length && <p className="p-3 text-ink-secondary">{t("bedrock.noMatches")}</p>}
        </div> : <p className="rounded-lg bg-inset p-3 leading-relaxed text-ink-secondary">{t(catalog?.catalogLoaded ? "bedrock.noModels" : "bedrock.loadModels")}</p>}
        {rows.length > 100 && <p className="text-ink-secondary">{t("bedrock.searchMore")}</p>}
      </div>
      <details className="rounded-xl border border-hairline/40 p-3">
        <summary className="cursor-pointer font-medium text-ink-secondary">{t("bedrock.advanced")}</summary>
        <div className="mt-3 space-y-3">
          <label className="block text-ink-secondary">{t("bedrock.model")}
            <input aria-label={t("bedrock.model")} className={inputClass} value={draft.model} spellCheck={false} onChange={(event) => change({ model: event.target.value })} />
            <span className="mt-1 block leading-relaxed">{t("bedrock.model.help")}</span>
          </label>
          <label className="block text-ink-secondary">{t("bedrock.api")}
            <select aria-label={t("bedrock.api")} className={inputClass} value={draft.api} onChange={(event) => change({ api: event.target.value as BedrockConfig["api"] })}>
              <option value="auto">{t("bedrock.api.auto")}</option>
              {draft.endpoint !== "mantle" && <option value="converse">Converse</option>}
              <option value="chat-completions">Chat Completions</option>
              <option value="messages">Messages</option>
            </select>
          </label>
          <label className="block text-ink-secondary">{t("bedrock.maxTokens")}
            <input type="number" min={1} max={1000000} aria-label={t("bedrock.maxTokens")} className={inputClass} value={draft.maxTokens ?? ""}
              placeholder={t("bedrock.maxTokens.default")} onChange={(event) => change({ maxTokens: event.target.value ? Number(event.target.value) : undefined })} />
          </label>
          <label className="flex items-center gap-2 text-ink-secondary"><input type="checkbox" checked={draft.tools !== false} onChange={(event) => change({ tools: event.target.checked })} />{t("bedrock.tools")}</label>
          <label className="block text-ink-secondary">{t("bedrock.blockedModels")}
            <textarea aria-label={t("bedrock.blockedModels")} className={cn(inputClass, "font-mono")} rows={3} value={blockedText}
              onChange={(event) => { change({ blockedModels: event.target.value.split("\n").map((id) => id.trim()).filter(Boolean) }); setBlockedText(event.target.value); }} />
          </label>
          {(["url", "controlUrl"] as const).map((field) => <label key={field} className="block text-ink-secondary">{t(`bedrock.${field}`)}
            <input aria-label={t(`bedrock.${field}`)} className={inputClass} value={draft[field]} spellCheck={false} placeholder="https://…" onChange={(event) => change({ [field]: event.target.value })} />
          </label>)}
          {(["apiKeyEnv", "apiKeyHeader"] as const).map(field => <label key={field} className="block text-ink-secondary">{t(`bedrock.${field}`)}
            <input aria-label={t(`bedrock.${field}`)} className={inputClass} value={draft[field]} spellCheck={false} onChange={event => change({ [field]: event.target.value })} />
          </label>)}
          <p className="text-ink-secondary">{t("bedrock.gateway.help")}</p>
        </div>
      </details>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={() => void test()} disabled={testing} className="inline-flex items-center gap-1.5 rounded-lg bg-control px-3 py-2 font-semibold text-ink hover:bg-raised-hover disabled:opacity-50">
          {testing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}{t(testing ? "bedrock.loading" : "bedrock.test")}
        </button>
        <button type="button" onClick={() => void save()} disabled={!edited || saving} className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 font-semibold text-white hover:brightness-110 disabled:opacity-50">
          {saving && <Loader2 size={13} className="animate-spin" />}{t(saving ? "bedrock.saving" : "common.save")}
        </button>
      </div>
    </fieldset>
    <div aria-live="polite" className="space-y-1 leading-relaxed">
      {saved && <p role="status" className="text-success">{t("bedrock.saved")}</p>}
      {probe?.key === key && edited && <p className="text-ink-secondary">{t("bedrock.draft")}</p>}
      {probe?.key === key && probe.message && <p role={probe.ok ? "status" : "alert"} className={probe.ok ? "text-ink-secondary" : "text-danger"}>{probe.message}</p>}
      {probe?.key === key && probe.warning && <p className="text-warning">{probe.warning}</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </div>;
}
