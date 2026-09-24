import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { Switch } from "../SettingsPrimitives";
import { ProviderMark } from "../work/ProviderMark";
import type { TaskConnectionListing, TaskConnectorManifest } from "../work/model";
import { ConnectionSecretFields, ConnectionSettingFields } from "./ConnectionFields";
import {
  connectionMutation,
  slugConnectionId,
  uniqueConnectionId,
  type ConnectionMutation,
  type ConnectionTestResult,
} from "./model";

export function ConnectionEditor({
  connection,
  connectors,
  teams,
  existingIds,
  busy,
  testResult,
  onClose,
  onSave,
  onTest,
}: {
  connection?: TaskConnectionListing;
  connectors: TaskConnectorManifest[];
  teams: string[];
  existingIds: string[];
  busy?: string | null;
  testResult?: ConnectionTestResult | null;
  onClose: () => void;
  onSave: (body: ConnectionMutation) => void;
  onTest?: (id: string) => void;
}) {
  const [connectorId, setConnectorId] = useState(connection?.connectorId ?? "");
  const [label, setLabel] = useState(connection?.label ?? "");
  const [id, setId] = useState(connection?.id ?? "");
  const [idTouched, setIdTouched] = useState(Boolean(connection));
  const [settings, setSettings] = useState<Record<string, string | number | boolean | undefined>>(
    () => ({ ...connection?.settings }),
  );
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [sections, setSections] = useState<string[]>(() => [...(connection?.sections ?? [])]);
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const manifest = useMemo(
    () => connectors.find((item) => item.id === connectorId),
    [connectorId, connectors],
  );

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    (dialog.querySelector<HTMLElement>("[data-initial-focus]") ?? focusable()[0] ?? dialog).focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    dialog.addEventListener("keydown", onKey);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      if (previousFocus?.getClientRects().length) previousFocus.focus();
    };
  }, []);

  const selectConnector = (next: string) => {
    setConnectorId(next);
    setSettings({});
    setSecretDrafts({});
    if (!idTouched) setId(uniqueConnectionId(slugConnectionId(next, label), existingIds));
  };

  const changeLabel = (next: string) => {
    setLabel(next);
    if (!connection && !idTouched && connectorId) {
      setId(uniqueConnectionId(slugConnectionId(connectorId, next), existingIds));
    }
  };

  const save = () => {
    const parsed = connectionMutation({
      id: connection?.id ?? id,
      connectorId,
      label,
      settings,
      secretDrafts,
      secretKeys: connection?.secretKeys,
      sections,
      enabled,
      manifest,
    });
    if (!parsed.ok) {
      setError(t(
        parsed.error === "connector"
          ? "taskConnections.editor.chooseConnector"
          : parsed.error === "label"
            ? "taskConnections.editor.labelMissing"
            : "taskConnections.editor.idInvalid",
      ));
      return;
    }
    setError("");
    onSave(parsed.body);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={connection ? t("taskConnections.editor.edit") : t("taskConnections.editor.new")}
        data-connection-editor=""
        data-connection-connector={manifest?.id ?? ""}
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="text-[17px] font-semibold text-ink">{connection ? t("taskConnections.editor.edit") : t("taskConnections.editor.new")}</div>
            <div className="mt-1 text-[12px] text-ink-secondary">{t("taskConnections.editor.lede")}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("taskConnections.editor.close")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {!connection && (
            <div>
              <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.connector")}</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {connectors.map((connector) => {
                  const selected = connector.id === connectorId;
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => selectConnector(connector.id)}
                      className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left", selected ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}
                    >
                      <ProviderMark connector={connector} />
                      <span className="truncate text-[12.5px] font-medium text-ink">{connector.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {manifest && (
            <>
              <label className="block">
                <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.label")}</span>
                <input
                  data-initial-focus=""
                  value={label}
                  onChange={(event) => changeLabel(event.target.value)}
                  placeholder={t("taskConnections.editor.labelHint")}
                  className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
                />
              </label>

              {!connection && (
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.id")}</span>
                  <input
                    aria-label={t("taskConnections.editor.id")}
                    value={id}
                    onChange={(event) => {
                      setIdTouched(true);
                      setId(event.target.value);
                    }}
                    className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70"
                  />
                  <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("taskConnections.editor.idHelp")}</span>
                </label>
              )}

              <div>
                <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.settings")}</div>
                <ConnectionSettingFields
                  fields={manifest.settings ?? []}
                  values={settings}
                  onChange={(key, value) => setSettings((current) => ({ ...current, [key]: value }))}
                />
              </div>

              <div>
                <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.secrets")}</div>
                <ConnectionSecretFields
                  secrets={manifest.secrets ?? []}
                  drafts={secretDrafts}
                  savedKeys={connection?.secretKeys ?? []}
                  onChange={(key, value) => setSecretDrafts((current) => ({ ...current, [key]: value }))}
                />
              </div>

              <fieldset>
                <legend className="mb-1.5 text-[11.5px] font-medium text-ink-secondary">{t("taskConnections.editor.teams")}</legend>
                <p className="mb-2 text-[11px] leading-relaxed text-ink-secondary">{t("taskConnections.editor.teamsHelp")}</p>
                <div className="flex max-h-40 flex-col gap-2 overflow-y-auto" data-connection-teams="">
                  {teams.map((team) => (
                    <label key={team} className="flex items-center gap-2 text-[13px] text-ink" data-connection-team={team}>
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={sections.includes(team)}
                        onChange={(event) => setSections((current) => event.target.checked
                          ? [...current, team]
                          : current.filter((name) => name !== team))}
                      />
                      {team}
                    </label>
                  ))}
                  {!teams.length && <p className="text-[12px] text-ink-secondary">{t("taskConnections.editor.teamsAll")}</p>}
                </div>
              </fieldset>

              <div className="flex items-center justify-between gap-3 rounded-xl border border-hairline/50 bg-inset px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-ink">{t("taskConnections.editor.enabled")}</div>
                </div>
                <Switch
                  checked={enabled}
                  aria-label={t("taskConnections.editor.enabled")}
                  onClick={() => setEnabled((current) => !current)}
                />
              </div>
            </>
          )}

          {error && <div role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</div>}
          {testResult && (
            <div
              role={testResult.ok ? "status" : "alert"}
              className={cn("rounded-lg px-3 py-2 text-[12px]", testResult.ok ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}
            >
              {testResult.ok ? t("taskConnections.testOk", { account: testResult.account }) : testResult.error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-hairline/40 px-5 py-3">
          <div>
            {connection && onTest && (
              <button
                type="button"
                disabled={busy != null}
                onClick={() => onTest(connection.id)}
                className="flex items-center gap-1.5 rounded-lg border border-hairline/60 px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-raised disabled:opacity-40"
              >
                {busy === `test:${connection.id}` ? <Loader2 size={14} className="animate-spin" /> : null}
                {busy === `test:${connection.id}` ? t("taskConnections.testing") : t("taskConnections.test")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-[12.5px] text-ink-secondary hover:text-ink">{t("common.cancel")}</button>
            <button
              type="button"
              disabled={busy === "save" || !manifest}
              onClick={save}
              className="rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white disabled:opacity-40"
            >
              {busy === "save" ? t("taskConnections.editor.saving") : t("taskConnections.editor.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
