import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Routine } from "@/lib/routines";
import type { WebhookTrigger } from "@/lib/webhooks";
import type {
  SourceChangeType,
  Watch,
  WatchAction,
  WatchDryRunResult,
  WatchFilter,
  WatchInput,
  WatchSource,
} from "@/lib/watches";
import { api, type Bot, type Group } from "@/state/store";
import { ProviderMark } from "../work/ProviderMark";
import type { TaskConnectionListing, TaskConnectorManifest } from "../work/model";
import { WatchFilterBuilder } from "./WatchFilterBuilder";
import { WatchScopeFields } from "./WatchScopeFields";
import {
  GIT_WATCH_MANIFEST,
  WEBHOOK_WATCH_MANIFEST,
  actionHelp,
  actionLabel,
  connectorForSource,
  defaultEventsFor,
  defaultInterval,
  eventLabel,
  gitWatchFields,
  type WatchDraft,
  type WatchSourceKind,
  watchManifest,
} from "./model";

const ACTIONS: WatchAction["type"][] = ["record", "notify", "task_update", "ensure_task", "run_routine"];

function scopeFromSource(source?: WatchSource): Record<string, string | number | boolean | undefined> {
  if (source?.type === "git") return { remote: source.remote, cwd: source.cwd };
  if (source?.type === "connection") return { ...source.scope };
  return {};
}

export function WatchEditor({
  watch,
  draft,
  bots,
  connections,
  connectors,
  webhooks,
  routines,
  groups,
  onClose,
  onSaved,
}: {
  watch?: Watch;
  draft?: WatchDraft;
  bots: Bot[];
  connections: TaskConnectionListing[];
  connectors: TaskConnectorManifest[];
  webhooks: WebhookTrigger[];
  routines: Routine[];
  groups: Group[];
  onClose: () => void;
  onSaved: (watch: Watch) => void;
}) {
  const seed = watch ?? draft;
  const [name, setName] = useState(seed?.name ?? "");
  const [source, setSource] = useState<WatchSource | undefined>(seed?.source);
  const [scope, setScope] = useState<Record<string, string | number | boolean | undefined>>(() => scopeFromSource(seed?.source));
  const [events, setEvents] = useState<SourceChangeType[]>(() => seed?.events ?? defaultEventsFor(watchManifest(seed?.source, connections, connectors)));
  const [action, setAction] = useState<WatchAction>(seed?.action ?? { type: "record" });
  const [everyMinutes, setEveryMinutes] = useState(
    seed?.check?.type === "interval" ? seed.check.everyMinutes : 5,
  );
  const [filter, setFilter] = useState<WatchFilter | undefined>(watch?.filter ?? draft?.filter);
  const [startFrom, setStartFrom] = useState<"now" | "backfill">(watch?.startFrom ?? draft?.startFrom ?? "now");
  const [enabled, setEnabled] = useState(watch?.enabled ?? true);
  const [maxActions, setMaxActions] = useState(watch?.limits?.maxActionsPerDay != null ? String(watch.limits.maxActionsPerDay) : "");
  const [quietHours, setQuietHours] = useState(watch?.limits?.quietHours ?? "");
  const [batchWindow, setBatchWindow] = useState(watch?.batch ? String(watch.batch.windowSeconds) : "");
  const [batchMax, setBatchMax] = useState(watch?.batch ? String(watch.batch.max) : "");
  const [fieldMapText, setFieldMapText] = useState(() => {
    if (watch?.source.type === "webhook" && watch.source.fieldMap) {
      return Object.entries(watch.source.fieldMap).map(([key, path]) => `${key}=${path}`).join("\n");
    }
    return "";
  });
  const [payloadText, setPayloadText] = useState("");
  const [dryRun, setDryRun] = useState<WatchDryRunResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const manifest = watchManifest(source, connections, connectors);
  const sourceKind: WatchSourceKind | null = source?.type ?? null;
  const enabledConnections = connections.filter((item) => item.enabled);
  const topics = groups.filter((group) => !group.dm);

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

  const selectSource = (next: WatchSource, nextManifest?: TaskConnectorManifest) => {
    setSource(next);
    setScope(scopeFromSource(next));
    setEvents(defaultEventsFor(nextManifest ?? connectorForSource(next, connections, connectors)));
    setDryRun(null);
  };

  const buildSource = (): WatchSource | undefined => {
    if (!source) return undefined;
    if (source.type === "git") {
      const remote = String(scope.remote ?? "").trim();
      const cwd = String(scope.cwd ?? "").trim();
      return { type: "git", remote, ...(cwd ? { cwd } : {}) };
    }
    if (source.type === "webhook") {
      if (!source.webhookId) return undefined;
      const fieldMap = Object.fromEntries(fieldMapText.split("\n").flatMap((line) => {
        const cut = line.indexOf("=");
        if (cut < 1) return [];
        const key = line.slice(0, cut).trim();
        const path = line.slice(cut + 1).trim();
        return key && path ? [[key, path]] : [];
      }));
      return { type: "webhook", webhookId: source.webhookId, ...(Object.keys(fieldMap).length ? { fieldMap } : {}) };
    }
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(scope)) {
      if (value === undefined || value === "") continue;
      cleaned[key] = value;
    }
    return { type: "connection", connectionId: source.connectionId, ...(Object.keys(cleaned).length ? { scope: cleaned } : {}) };
  };

  const buildInput = (): WatchInput | null => {
    const nextSource = buildSource();
    if (!nextSource) return null;
    const limits = {
      ...(maxActions.trim() ? { maxActionsPerDay: Number(maxActions) } : {}),
      ...(quietHours.trim() ? { quietHours: quietHours.trim() } : {}),
    };
    const batch = batchWindow.trim() && batchMax.trim()
      ? { windowSeconds: Number(batchWindow), max: Number(batchMax) }
      : null;
    return {
      name: name.trim() || t("watches.untitled"),
      source: nextSource,
      events,
      filter: filter ?? null,
      check: defaultInterval(Number(everyMinutes) || 5),
      batch,
      action,
      limits: limits.maxActionsPerDay || limits.quietHours ? limits : null,
      startFrom,
      enabled,
    };
  };

  const runDry = async (backfill = false) => {
    const input = buildInput();
    if (!input) {
      setError(source?.type === "webhook" ? t("watches.editor.chooseWebhook") : t("watches.editor.chooseSource"));
      return;
    }
    setTesting(true);
    setError("");
    try {
      let payload: unknown;
      if (input.source.type === "webhook" && payloadText.trim()) {
        payload = JSON.parse(payloadText);
      }
      const result = await api<WatchDryRunResult>(watch ? `/api/watches/${watch.id}/dry-run` : "/api/watches/dry-run", {
        method: "POST",
        body: JSON.stringify({
          ...input,
          sinceDays: 7,
          backfill,
          ...(payload !== undefined ? { payload } : {}),
        }),
      });
      setDryRun(result);
      if (result.error) setError(result.error);
    } catch (cause) {
      setDryRun(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const input = buildInput();
    if (!input) {
      setError(source?.type === "webhook" ? t("watches.editor.chooseWebhook") : t("watches.editor.chooseSource"));
      return;
    }
    if (startFrom === "backfill" && (dryRun == null || dryRun.error)) {
      await runDry(true);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await api<{ watch: Watch }>(watch ? `/api/watches/${watch.id}` : "/api/watches", {
        method: watch ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      onSaved(response.watch);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const scopeFields = useMemo(() => {
    if (sourceKind === "git") return gitWatchFields();
    return manifest?.watch?.scopes ?? [];
  }, [manifest, sourceKind]);
  const eventChoices = manifest?.watch?.events ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-5 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={watch ? t("watches.editor.edit") : t("watches.editor.new")}
        data-watch-editor=""
        data-watch-source-kind={sourceKind ?? ""}
        data-watch-connector={manifest && sourceKind === "connection" ? manifest.id : sourceKind ?? ""}
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-hairline/60 bg-panel shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-hairline/40 px-5 py-4">
          <div>
            <div className="text-[17px] font-semibold text-ink">{watch ? t("watches.editor.edit") : t("watches.editor.new")}</div>
            <div className="mt-1 text-[12px] text-ink-secondary">{t("watches.editor.lede")}</div>
          </div>
          <button type="button" onClick={onClose} aria-label={t("watches.editor.close")} className="rounded-lg p-2 text-ink-secondary hover:bg-raised hover:text-ink"><X size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.name")}</span>
            <input
              data-initial-focus=""
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("watches.editor.nameHint")}
              className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
          </label>

          <div>
            <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.source")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {enabledConnections.map((connection) => {
                const connector = connectors.find((item) => item.id === connection.connectorId);
                const selected = source?.type === "connection" && source.connectionId === connection.id;
                return (
                  <button
                    key={connection.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectSource({ type: "connection", connectionId: connection.id }, connector)}
                    className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left", selected ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}
                  >
                    <ProviderMark connector={connector} />
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-medium text-ink">{connector?.name ?? connection.connectorId}</span>
                      <span className="block truncate text-[11px] text-ink-secondary">{connection.label}</span>
                    </span>
                  </button>
                );
              })}
              <button
                type="button"
                aria-pressed={sourceKind === "git"}
                onClick={() => selectSource({ type: "git", remote: String(scope.remote ?? "") }, GIT_WATCH_MANIFEST)}
                className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left", sourceKind === "git" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}
              >
                <ProviderMark connector={GIT_WATCH_MANIFEST} />
                <span>
                  <span className="block text-[12.5px] font-medium text-ink">{t("watches.source.git")}</span>
                  <span className="block text-[11px] text-ink-secondary">{t("watches.source.gitHelp")}</span>
                </span>
              </button>
              <button
                type="button"
                aria-pressed={sourceKind === "webhook"}
                onClick={() => selectSource({ type: "webhook", webhookId: "" }, WEBHOOK_WATCH_MANIFEST)}
                className={cn("flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left", sourceKind === "webhook" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}
              >
                <ProviderMark connector={WEBHOOK_WATCH_MANIFEST} />
                <span>
                  <span className="block text-[12.5px] font-medium text-ink">{t("watches.source.webhook")}</span>
                  <span className="block text-[11px] text-ink-secondary">{t("watches.source.webhookHelp")}</span>
                </span>
              </button>
            </div>
          </div>

          {sourceKind === "webhook" && (
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.webhook")}</span>
              <select
                aria-label={t("watches.editor.webhook")}
                value={source?.type === "webhook" ? source.webhookId : ""}
                onChange={(event) => setSource({ type: "webhook", webhookId: event.target.value })}
                className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70"
              >
                <option value="">{t("watches.choose")}</option>
                {webhooks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
          )}

          {source && (
            <WatchScopeFields
              fields={scopeFields}
              values={scope}
              onChange={(key, value) => setScope((current) => ({ ...current, [key]: value }))}
            />
          )}

          {eventChoices.length > 0 && (
            <div>
              <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.events")}</div>
              <div className="flex flex-wrap gap-1.5">
                {eventChoices.map((event) => {
                  const on = events.includes(event);
                  return (
                    <button
                      key={event}
                      type="button"
                      data-watch-event={event}
                      aria-pressed={on}
                      onClick={() => setEvents((current) => on ? current.filter((item) => item !== event) : [...current, event])}
                      className={cn("rounded-full border px-2.5 py-1 text-[11.5px]", on ? "border-accent/60 bg-accent/10 text-ink" : "border-hairline/50 text-ink-secondary hover:text-ink")}
                    >
                      {eventLabel(event)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.action")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ACTIONS.map((type) => (
                <button
                  key={type}
                  type="button"
                  aria-pressed={action.type === type}
                  onClick={() => setAction(type === "notify" ? { type, botId: bots[0]?.id } : type === "run_routine" ? { type, routineId: routines[0]?.id ?? "" } : type === "ensure_task" ? { type, criteriaFrom: "item" } : { type })}
                  className={cn("rounded-xl border px-3 py-2.5 text-left", action.type === type ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}
                >
                  <span className="block text-[12.5px] font-medium text-ink">{actionLabel(type)}</span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{actionHelp(type)}</span>
                </button>
              ))}
            </div>
            {action.type === "notify" && (
              <label className="mt-3 block">
                <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.notifyBot")}</span>
                <select aria-label={t("watches.editor.notifyBot")} value={action.botId ?? ""} onChange={(event) => setAction({ type: "notify", botId: event.target.value || undefined })} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70">
                  <option value="">{t("watches.choose")}</option>
                  {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                </select>
              </label>
            )}
            {action.type === "run_routine" && (
              <label className="mt-3 block">
                <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.routine")}</span>
                <select aria-label={t("watches.editor.routine")} value={action.routineId} onChange={(event) => setAction({ type: "run_routine", routineId: event.target.value })} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70">
                  <option value="">{t("watches.choose")}</option>
                  {routines.map((routine) => <option key={routine.id} value={routine.id}>{routine.name}</option>)}
                </select>
              </label>
            )}
            {action.type === "ensure_task" && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.topic")}</span>
                  <select aria-label={t("watches.editor.topic")} value={action.topic ?? ""} onChange={(event) => setAction({ ...action, topic: event.target.value || undefined })} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70">
                    <option value="">{t("watches.editor.topicAuto")}</option>
                    {topics.map((group) => <option key={group.id} value={group.name}>{group.name}</option>)}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.coordinator")}</span>
                  <select aria-label={t("watches.editor.coordinator")} value={action.coordinatorBotId ?? ""} onChange={(event) => setAction({ ...action, coordinatorBotId: event.target.value || undefined })} className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70">
                    <option value="">{t("watches.choose")}</option>
                    {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
                  </select>
                </label>
              </div>
            )}
          </div>

          <label className="block">
            <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.checkEvery")}</span>
            <div className="flex items-center gap-2">
              <input
                aria-label={t("watches.editor.checkEvery")}
                type="number"
                min={1}
                max={24 * 60}
                value={everyMinutes}
                onChange={(event) => setEveryMinutes(Number(event.target.value) || 5)}
                className="w-24 rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70"
              />
              <span className="text-[12px] text-ink-secondary">{t("watches.editor.minutes")}</span>
            </div>
            <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("watches.editor.checkHelp")}</span>
          </label>

          <div>
            <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.startFrom")}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button type="button" aria-pressed={startFrom === "now"} onClick={() => setStartFrom("now")} className={cn("rounded-xl border px-3 py-2.5 text-left", startFrom === "now" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                <span className="block text-[12.5px] font-medium text-ink">{t("watches.editor.fromNow")}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{t("watches.editor.fromNowHelp")}</span>
              </button>
              <button type="button" aria-pressed={startFrom === "backfill"} onClick={() => { setStartFrom("backfill"); if (!dryRun) void runDry(true); }} className={cn("rounded-xl border px-3 py-2.5 text-left", startFrom === "backfill" ? "border-accent/70 bg-accent/10" : "border-hairline/50 bg-inset hover:bg-raised/60")}>
                <span className="block text-[12.5px] font-medium text-ink">{t("watches.editor.backfill")}</span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{t("watches.editor.backfillHelp")}</span>
              </button>
            </div>
          </div>

          {sourceKind === "webhook" && (
            <label className="block">
              <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.sampleEvent")}</span>
              <textarea
                aria-label={t("watches.editor.sampleEvent")}
                value={payloadText}
                onChange={(event) => setPayloadText(event.target.value)}
                rows={4}
                placeholder='{"id":"evt-1","type":"item.created"}'
                className="w-full resize-y rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent/70"
              />
            </label>
          )}

          <div className="rounded-xl border border-hairline/45 bg-inset/35 px-3.5 py-3" data-watch-dry-run="">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void runDry(false)} disabled={testing || !source} className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40">
                {testing && <Loader2 size={13} className="animate-spin" />}
                {t("watches.dryRun.action")}
              </button>
              <span className="text-[11.5px] text-ink-secondary">{t("watches.dryRun.help")}</span>
            </div>
            {dryRun && !dryRun.error && (
              <div className="mt-2 text-[12.5px] text-ink" data-watch-dry-run-count={dryRun.matchCount}>
                {t("watches.dryRun.result", { count: dryRun.matchCount, seen: dryRun.seen })}
                {dryRun.matches[0] && <span className="mt-1 block text-[11.5px] text-ink-secondary">{dryRun.matches[0].item.title}</span>}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-ink">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t("watches.editor.enabled")}
          </label>

          <details className="rounded-xl border border-hairline/45 bg-inset/45 px-4 py-3">
            <summary className="cursor-pointer text-[12.5px] font-medium text-ink">{t("watches.editor.advanced")}</summary>
            <div className="mt-4 space-y-4">
              <div>
                <div className="mb-2 text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.filters")}</div>
                <WatchFilterBuilder filter={filter} onChange={setFilter} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.maxActions")}</span>
                  <input aria-label={t("watches.editor.maxActions")} type="number" min={1} max={1000} value={maxActions} onChange={(event) => setMaxActions(event.target.value)} placeholder="20" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.quietHours")}</span>
                  <input aria-label={t("watches.editor.quietHours")} value={quietHours} onChange={(event) => setQuietHours(event.target.value)} placeholder="22:00-07:00" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.batchWindow")}</span>
                  <input aria-label={t("watches.editor.batchWindow")} type="number" min={1} max={3600} value={batchWindow} onChange={(event) => setBatchWindow(event.target.value)} placeholder="120" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.batchMax")}</span>
                  <input aria-label={t("watches.editor.batchMax")} type="number" min={1} max={100} value={batchMax} onChange={(event) => setBatchMax(event.target.value)} placeholder="10" className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70" />
                </label>
              </div>
              {sourceKind === "webhook" && (
                <label className="block">
                  <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{t("watches.editor.fieldMap")}</span>
                  <textarea aria-label={t("watches.editor.fieldMap")} value={fieldMapText} onChange={(event) => setFieldMapText(event.target.value)} rows={3} placeholder={"type=$.event\nfields.project=$.project.key"} className="w-full resize-y rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 font-mono text-[12px] text-ink outline-none focus:border-accent/70" />
                  <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{t("watches.editor.fieldMapHelp")}</span>
                </label>
              )}
            </div>
          </details>
          {error && <div className="rounded-xl border border-danger/30 bg-danger/10 px-3.5 py-3 text-[12px] text-danger">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-hairline/40 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink">{t("watches.editor.cancel")}</button>
          <button type="button" disabled={saving || !source} onClick={() => void save()} className="flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-40">
            {saving && <Loader2 size={14} className="animate-spin" />}
            {watch ? t("watches.editor.save") : t("watches.editor.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
