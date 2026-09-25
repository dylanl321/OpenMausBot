import { Loader2, Pause, Play, Plus, Radar, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Watch } from "@/lib/watches";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { api, useStore } from "@/state/store";
import { ProviderMark } from "../work/ProviderMark";
import { loadTaskConnectors, type TaskConnectionListing, type TaskConnectorManifest } from "../work/model";
import { WatchEditor } from "./WatchEditor";
import {
  GIT_WATCH_MANIFEST,
  WEBHOOK_WATCH_MANIFEST,
  actionLabel,
  connectorForSource,
  relativeTime,
  type WatchDraft,
  watchSourceSummary,
} from "./model";

export function WatchesPanel({
  createRequest,
  convertDraft,
  onCreateHandled,
  onConvertHandled,
}: {
  createRequest: number;
  convertDraft?: WatchDraft | null;
  onCreateHandled: () => void;
  onConvertHandled: () => void;
}) {
  const { state, dispatch } = useStore();
  const canManage = useOwnerOrAdmin();
  const [editor, setEditor] = useState<Watch | WatchDraft | "new" | null>(null);
  const [connectors, setConnectors] = useState<TaskConnectorManifest[]>([]);
  const [connections, setConnections] = useState<TaskConnectionListing[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadTaskConnectors((path) => api(path)).then((list) => {
      if (!cancelled) setConnectors(list);
    });
    api<{ connections?: TaskConnectionListing[] }>("/api/task-connections").then((body) => {
      if (!cancelled) setConnections(body.connections ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (createRequest > 0) {
      if (canManage === true) setEditor("new");
      onCreateHandled();
    }
  }, [createRequest, onCreateHandled, canManage]);

  useEffect(() => {
    if (convertDraft) {
      if (canManage === true) setEditor(convertDraft);
      onConvertHandled();
    }
  }, [convertDraft, onConvertHandled, canManage]);

  const manifests = useMemo(
    () => [...connectors, GIT_WATCH_MANIFEST, WEBHOOK_WATCH_MANIFEST],
    [connectors],
  );
  const visibleBots = state.bots.filter((bot) => !bot.hidden);

  const toggle = async (watch: Watch) => {
    setWorking(watch.id);
    setError("");
    try {
      const response = await api<{ watch: Watch }>(`/api/watches/${watch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !watch.enabled }),
      });
      dispatch({ type: "watchPatched", watch: response.watch });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const remove = async (watch: Watch) => {
    if (!window.confirm(t("watches.deleteConfirm", { name: watch.name }))) return;
    setWorking(watch.id);
    setError("");
    try {
      await api(`/api/watches/${watch.id}`, { method: "DELETE" });
      dispatch({ type: "watchDeleted", watchId: watch.id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const loading = state.watchesLoadState === "loading" && state.watches.length === 0;
  const failed = state.watchesLoadState === "error";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-watches-panel="">
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[17px] font-semibold text-ink">{t("watches.title")}</h2>
            <p className="mt-1 max-w-xl text-[12px] leading-relaxed text-ink-secondary">{t("watches.lede")}</p>
          </div>
          {canManage === true ? <button
            type="button"
            onClick={() => setEditor("new")}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"
          >
            <Plus size={14} />{t("watches.new")}
          </button> : canManage === false ? <p className="max-w-xs text-right text-[12px] leading-relaxed text-ink-secondary">{t("watches.adminOnly")}</p> : null}
        </div>
        {error && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{error}</div>}
        {failed && <div role="alert" className="rounded-lg bg-danger/10 p-3 text-[12px] text-danger">{t("watches.loadError")}</div>}
        {loading && <p role="status" className="flex items-center gap-2 p-3 text-[12px] text-ink-secondary"><Loader2 size={14} className="animate-spin" />{t("watches.loading")}</p>}
        {!loading && !failed && state.watches.length === 0 && (
          <div className="rounded-xl border border-dashed border-hairline/50 p-8 text-center">
            <Radar size={22} className="mx-auto mb-3 text-accent/80" />
            <div className="text-[14px] font-medium text-ink">{t("watches.empty")}</div>
            <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-ink-secondary">{t("watches.emptyHelp")}</p>
          </div>
        )}
        <div className="space-y-3" aria-label={t("watches.list")}>
          {state.watches.map((watch) => {
            const source = watchSourceSummary(watch, connections, manifests, state.webhooks);
            const connector = connectorForSource(watch.source, connections, manifests);
            return (
              <article key={watch.id} className="rounded-xl border border-hairline/40 bg-card p-3.5" aria-label={watch.name} data-watch-id={watch.id}>
                <div className="flex items-start gap-3">
                  <button type="button" disabled={canManage !== true} onClick={() => setEditor(watch)} className="min-w-0 flex-1 text-left disabled:cursor-default">
                    <span className="flex items-center gap-2">
                      <ProviderMark connector={connector} />
                      <span className="truncate text-[13px] font-semibold text-ink">{watch.name}</span>
                      <span className={cn("rounded-full bg-inset px-2 py-0.5 text-[10px]", watch.enabled ? "text-accent" : "text-ink-secondary")}>
                        {watch.enabled ? t("watches.status.active") : t("watches.status.paused")}
                      </span>
                    </span>
                    <span className="mt-1 block text-[11.5px] text-ink-secondary">{source.name} · {source.detail}</span>
                  </button>
                  {canManage === true && <div className="flex shrink-0 items-center gap-1">
                    <button type="button" disabled={working === watch.id} onClick={() => void toggle(watch)} aria-label={watch.enabled ? t("watches.pause") : t("watches.resume")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
                      {watch.enabled ? <Pause size={14} /> : <Play size={14} />}
                    </button>
                    <button type="button" disabled={working === watch.id} onClick={() => void remove(watch)} aria-label={t("watches.delete")} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger">
                      <Trash2 size={14} />
                    </button>
                  </div>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-5">
                  <div>
                    <dt className="text-ink-secondary">{t("watches.stat.lastCheck")}</dt>
                    <dd className="mt-0.5 text-ink">{relativeTime(watch.stats.lastCheckAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-secondary">{t("watches.stat.changesSeen")}</dt>
                    <dd className="mt-0.5 text-ink">{watch.stats.changesSeen}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-secondary">{t("watches.stat.matches")}</dt>
                    <dd className="mt-0.5 text-ink">{watch.stats.matches}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-secondary">{t("watches.stat.actions")}</dt>
                    <dd className="mt-0.5 text-ink">{watch.stats.actions}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-secondary">{t("watches.stat.runsAvoided")}</dt>
                    <dd className="mt-0.5 font-medium text-accent">{watch.stats.runsAvoided}</dd>
                  </div>
                </dl>
                <div className="mt-2 text-[11px] text-ink-secondary">{actionLabel(watch.action.type)}</div>
                {watch.stats.lastError && <p className="mt-2 text-[11.5px] text-danger">{watch.stats.lastError}</p>}
              </article>
            );
          })}
        </div>
      </div>
      {editor && canManage === true && (
        <WatchEditor
          watch={typeof editor === "object" && "id" in editor ? editor : undefined}
          draft={typeof editor === "object" && !("id" in editor) ? editor : undefined}
          bots={visibleBots}
          connections={connections}
          connectors={connectors}
          webhooks={state.webhooks}
          routines={state.routines}
          groups={state.groups}
          onClose={() => setEditor(null)}
          onSaved={(saved) => dispatch({ type: "watchPatched", watch: saved })}
        />
      )}
    </div>
  );
}
