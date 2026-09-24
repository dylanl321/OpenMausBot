import { Loader2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { api, useStore } from "@/state/store";
import { Card } from "../SettingsPrimitives";
import { ProviderMark } from "../work/ProviderMark";
import { loadTaskConnectors, type TaskConnectionListing, type TaskConnectorManifest } from "../work/model";
import { ConnectionEditor } from "./ConnectionEditor";
import { teamChoices, type ConnectionMutation, type ConnectionTestResult } from "./model";

export function TaskConnectionsPanel({
  connectors: connectorsProp,
  connections: connectionsProp,
}: {
  connectors?: TaskConnectorManifest[];
  connections?: TaskConnectionListing[];
} = {}) {
  const { state } = useStore();
  const [loadedConnectors, setConnectors] = useState<TaskConnectorManifest[]>(connectorsProp ?? []);
  const [loadedConnections, setConnections] = useState<TaskConnectionListing[]>(connectionsProp ?? []);
  const connectors = connectorsProp ?? loadedConnectors;
  const connections = connectionsProp ?? loadedConnections;
  const [editor, setEditor] = useState<TaskConnectionListing | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tests, setTests] = useState<Record<string, ConnectionTestResult>>({});

  const teams = useMemo(
    () => teamChoices(state.sections ?? [], [...(state.bots ?? []), ...(state.groups ?? [])]),
    [state.bots, state.groups, state.sections],
  );

  useEffect(() => {
    if (connectorsProp && connectionsProp) return;
    let cancelled = false;
    if (!connectorsProp) {
      void loadTaskConnectors((path) => api(path)).then((list) => {
        if (!cancelled) setConnectors(list);
      });
    }
    if (!connectionsProp) {
      api<{ connections?: TaskConnectionListing[] }>("/api/task-connections").then((body) => {
        if (!cancelled) setConnections(body.connections ?? []);
      }).catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }
    return () => { cancelled = true; };
  }, [connectorsProp, connectionsProp]);

  const replace = (connection: TaskConnectionListing) => {
    setConnections((current) => {
      const index = current.findIndex((item) => item.id === connection.id);
      if (index < 0) return [...current, connection];
      const next = current.slice();
      next[index] = connection;
      return next;
    });
  };

  const save = async (body: ConnectionMutation) => {
    const existing = editor && editor !== "new" ? editor : undefined;
    setBusy("save");
    setError("");
    try {
      const response = existing
        ? await api<{ connection: TaskConnectionListing }>(`/api/task-connections/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
        : await api<{ connection: TaskConnectionListing }>("/api/task-connections", {
          method: "POST",
          body: JSON.stringify(body),
        });
      if (response.connection) replace(response.connection);
      setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (connection: TaskConnectionListing) => {
    setBusy(`toggle:${connection.id}`);
    setError("");
    try {
      const response = await api<{ connection: TaskConnectionListing }>(`/api/task-connections/${connection.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !connection.enabled }),
      });
      if (response.connection) replace(response.connection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const test = async (id: string) => {
    setBusy(`test:${id}`);
    setError("");
    try {
      const result = await api<ConnectionTestResult>(`/api/task-connections/${id}/test`, { method: "POST" });
      setTests((current) => ({ ...current, [id]: result }));
    } catch (cause) {
      setTests((current) => ({
        ...current,
        [id]: { ok: false, error: cause instanceof Error ? cause.message : String(cause) },
      }));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (connection: TaskConnectionListing) => {
    if (!window.confirm(t("taskConnections.deleteConfirm", { name: connection.label }))) return;
    setBusy(`delete:${connection.id}`);
    setError("");
    try {
      await api(`/api/task-connections/${connection.id}`, { method: "DELETE" });
      setConnections((current) => current.filter((item) => item.id !== connection.id));
      setTests((current) => {
        const next = { ...current };
        delete next[connection.id];
        return next;
      });
      if (editor && editor !== "new" && editor.id === connection.id) setEditor(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={t("taskConnections.title")} subtitle={t("taskConnections.subtitle")}>
      <div data-connection-list="">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0" />
          <button
            type="button"
            onClick={() => { setEditor("new"); setError(""); }}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-[12px] font-semibold text-white hover:brightness-110"
          >
            <Plus size={14} />{t("taskConnections.add")}
          </button>
        </div>
        {error && <div role="alert" className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
        {connections.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-hairline/50 p-6 text-center">
            <div className="text-[14px] font-medium text-ink">{t("taskConnections.empty")}</div>
            <p className="mx-auto mt-1 max-w-sm text-[12px] leading-relaxed text-ink-secondary">{t("taskConnections.emptyHelp")}</p>
          </div>
        )}
        <div className="mt-4 space-y-3">
          {connections.map((connection) => {
            const connector = connectors.find((item) => item.id === connection.connectorId);
            const result = tests[connection.id];
            return (
              <article
                key={connection.id}
                className="rounded-xl border border-hairline/40 bg-inset/40 p-3.5"
                aria-label={connection.label}
                data-connection-row={connection.id}
              >
                <div className="flex items-start gap-3">
                  <button type="button" onClick={() => { setEditor(connection); setError(""); }} className="min-w-0 flex-1 text-left">
                    <span className="flex items-center gap-2">
                      <ProviderMark connector={connector} />
                      <span className="truncate text-[13px] font-semibold text-ink">{connection.label}</span>
                      <span className={cn("rounded-full bg-panel px-2 py-0.5 text-[10px]", connection.enabled ? "text-accent" : "text-ink-secondary")}>
                        {connection.enabled ? connector?.name ?? connection.connectorId : t("taskConnections.disabled")}
                      </span>
                    </span>
                    <span className="mt-1 block text-[11.5px] text-ink-secondary">
                      {connection.sections.length ? connection.sections.join(" · ") : t("taskConnections.teamsNone")}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void test(connection.id)}
                      aria-label={t("taskConnections.test")}
                      className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                    >
                      {busy === `test:${connection.id}` ? <Loader2 size={14} className="animate-spin" /> : t("taskConnections.test")}
                    </button>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void toggle(connection)}
                      aria-label={connection.enabled ? t("taskConnections.disable") : t("taskConnections.enable")}
                      className="rounded-md px-2 py-1 text-[11.5px] font-medium text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-40"
                    >
                      {connection.enabled ? t("taskConnections.disable") : t("taskConnections.enable")}
                    </button>
                    <button
                      type="button"
                      disabled={busy != null}
                      onClick={() => void remove(connection)}
                      aria-label={t("taskConnections.delete")}
                      className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-danger disabled:opacity-40"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {result && (
                  <p role={result.ok ? "status" : "alert"} className={cn("mt-2 text-[11.5px]", result.ok ? "text-success" : "text-danger")}>
                    {result.ok ? t("taskConnections.testOk", { account: result.account }) : result.error}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {editor && (
        <ConnectionEditor
          connection={editor === "new" ? undefined : editor}
          connectors={connectors}
          teams={teams}
          existingIds={connections.map((item) => item.id)}
          busy={busy}
          testResult={editor === "new" ? null : tests[editor.id]}
          onClose={() => setEditor(null)}
          onSave={(body) => void save(body)}
          onTest={(id) => void test(id)}
        />
      )}
    </Card>
  );
}
