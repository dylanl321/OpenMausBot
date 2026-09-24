import { useEffect, useState } from "react";
import { ChevronRight, Loader2 } from "lucide-react";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkRole, TaskEvent } from "../../../shared/work-links";
import { api, openThread, useStore } from "@/state/store";
import { subscribeWorkLive } from "@/lib/work-live";
import { t } from "@/lib/i18n";
import { BotAvatar } from "../Avatar";
import { CriteriaList } from "./CriteriaList";
import { EventRow } from "./EventRow";
import { LinkCard } from "./LinkCard";
import { LinkChip } from "./LinkChip";
import { LinkItemDialog } from "./LinkItemDialog";
import {
  EVENT_FILTERS,
  currentAssignments,
  displayLinks,
  loadTaskConnectors,
  mergeTaskEvent,
  outputGroups,
  progressCounts,
  visibleEvents,
  type EventFilter,
  type TaskConnectorManifest,
} from "./model";
import { NowCard } from "./NowCard";
import { ProgressStrip } from "./ProgressStrip";
import { TaskAnswer } from "./TaskAnswer";

export function TaskView({ item, events: eventsProp, connectors: connectorsProp }: {
  item: WorkItem; events?: TaskEvent[]; connectors?: TaskConnectorManifest[];
}) {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkError, setLinkError] = useState("");
  const [linkPending, setLinkPending] = useState(false);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [showTools, setShowTools] = useState(false);
  const [loadedEvents, setEvents] = useState<TaskEvent[]>([]);
  const [loadedConnectors, setConnectors] = useState<TaskConnectorManifest[]>([]);
  const events = eventsProp ?? loadedEvents;
  const connectors = connectorsProp ?? loadedConnectors;
  const owner = state.bots.find(bot => bot.id === item.coordinatorBotId);
  const assignments = currentAssignments(item);
  const working = progressCounts(item).assignmentsWorking;
  const links = displayLinks(item);
  const headerLinks = links.filter(link => link.role === "source" || link.kind === "change_request");
  const outputs = outputGroups(links);
  const feed = visibleEvents(events, filter, showTools);

  useEffect(() => {
    if (eventsProp) return;
    let cancelled = false;
    api<{ events: TaskEvent[] }>(`/api/work-items/${item.id}/events`).then(body => {
      if (!cancelled) setEvents(body.events ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [item.id, eventsProp]);

  useEffect(() => {
    if (connectorsProp) return;
    let cancelled = false;
    void loadTaskConnectors(path => api(path)).then(list => { if (!cancelled) setConnectors(list); });
    return () => { cancelled = true; };
  }, [connectorsProp]);

  useEffect(() => subscribeWorkLive(frame => {
    if (frame.kind === "work.event" && frame.event.workItemId === item.id) setEvents(current => mergeTaskEvent(current, frame.event));
  }), [item.id]);

  const change = async (reopen: boolean) => {
    setPending(true);
    setError("");
    try {
      await api(`/api/work-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: item.revision,
        ...(reopen ? { reopen: true } : { status: "cancelled", detail: t("work.stoppedByUser") }) }) });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setPending(false); }
  };

  const submitLink = async (input: { refOrUrl: string; role: LinkRole; title?: string }) => {
    setLinkPending(true);
    setLinkError("");
    try {
      await api(`/api/work-items/${item.id}/links`, { method: "POST", body: JSON.stringify(input) });
      setLinkOpen(false);
    } catch (caught) { setLinkError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setLinkPending(false); }
  };

  return <section aria-label={t("work.summary")} data-task-view={item.id} className="mx-5 mb-3 min-w-0 break-words rounded-xl border border-hairline/40 bg-panel p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {item.status === "active" && <Loader2 size={14} aria-hidden="true" className="animate-spin text-accent" />}
        <span className="font-medium text-ink">{t(`work.status.${item.status}`)}</span>
        {headerLinks.map(link => <LinkChip key={link.id} item={link} connectors={connectors} />)}
        <span className="truncate text-ink-secondary">{t("work.owner", { name: owner?.name ?? item.coordinatorBotId })}</span>
      </div>
      <button type="button" disabled={pending} onClick={() => void change(item.status !== "active")}
        className="rounded-md border border-hairline/50 px-2 py-1 text-xs text-ink-secondary hover:bg-raised disabled:opacity-50">
        {item.status === "active" ? t("work.stop") : t("work.reopen")}
      </button>
    </div>
    {item.status === "needs-input" ? <TaskAnswer item={item} />
      : <p className="mt-2 whitespace-pre-wrap text-ink-secondary">{item.detail || item.objective}</p>}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    <ProgressStrip item={item} />
    <NowCard item={item} events={events} />
    <div className="mt-3 flex min-w-0 flex-col gap-3 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-3">
        <section aria-label={t("work.activity")} className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="mr-1 text-xs font-medium text-ink-secondary">{t("work.activity")}</h3>
            {EVENT_FILTERS.map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === value ? "border-accent/40 bg-accent/10 text-ink" : "border-hairline/40 text-ink-secondary hover:bg-raised"}`}>
              {value === "all" ? t("work.activityAll") : t(`work.event.${value}`)}
            </button>)}
            <button type="button" aria-pressed={showTools} onClick={() => setShowTools(on => !on)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${showTools ? "border-accent/40 bg-accent/10 text-ink" : "border-hairline/40 text-ink-secondary hover:bg-raised"}`}>
              {t("work.showToolCalls")}
            </button>
          </div>
          {feed.length === 0 ? <p className="mt-2 text-xs text-ink-secondary">{t("work.activityEmpty")}</p>
            : <ol className="mt-1 divide-y divide-hairline/20">{feed.map(event => <EventRow key={event.id} event={event} links={links} connectors={connectors} />)}</ol>}
        </section>
        <section aria-label={t("work.outputs")} className="min-w-0">
          <h3 className="text-xs font-medium text-ink-secondary">{t("work.outputs")}</h3>
          {outputs.length === 0 ? <p className="mt-2 text-xs text-ink-secondary">{t("work.outputsEmpty")}</p>
            : outputs.map(group => <div key={group.kind} data-output-kind={group.kind} className="mt-2 min-w-0">
              <h4 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t(`work.kind.${group.kind}`)}</h4>
              <div className="mt-1 space-y-1.5">{group.items.map(link => <LinkCard key={link.id} item={link} connectors={connectors} />)}</div>
            </div>)}
        </section>
        <section aria-label={t("work.criteria")} className="min-w-0">
          <h3 className="mb-2 text-xs font-medium text-ink-secondary">{t("work.criteria")}</h3>
          <CriteriaList item={item} links={links} events={events} connectors={connectors} />
        </section>
        {assignments.length > 0 && <details className="min-w-0" open={working > 0 || undefined}>
          <summary role="button" className="cursor-pointer text-ink-secondary">{t("work.assignments", { count: assignments.length, working })}</summary>
          <ul className="mt-2 space-y-2">{assignments.map(assignment => {
            const bot = state.bots.find(candidate => candidate.id === assignment.botId);
            return <li key={assignment.id} className="rounded-lg bg-raised/40 p-2">
              <button type="button" disabled={!bot} aria-label={t("work.openWorker", { name: bot?.name ?? assignment.botId })}
                onClick={() => openThread(dispatch, { botId: assignment.botId, threadId: assignment.threadId }, state)}
                className="flex w-full items-center gap-2 text-left text-ink hover:text-accent">
                {bot && <BotAvatar bot={bot} size={18} state="happy" />}
                <span>{bot?.name ?? assignment.botId}</span>
                <span className="ml-auto text-xs text-ink-secondary">{t(`work.status.${assignment.status}`)}</span>
                <ChevronRight size={13} aria-hidden="true" />
              </button>
              <p className="mt-1 whitespace-pre-wrap text-xs text-ink-secondary">{assignment.message}</p>
              {assignment.result && <details className="mt-1 text-xs text-ink-secondary">
                <summary role="button" className="cursor-pointer">{t("work.result")}</summary>
                <p className="mt-1 whitespace-pre-wrap">{assignment.result}</p>
              </details>}
            </li>;
          })}</ul>
        </details>}
        {(item.decisions.length > 0 || item.evidence.length > 0) && <details className="min-w-0">
          <summary role="button" className="cursor-pointer text-ink-secondary">{t("work.evidence")}</summary>
          <ul className="mt-2 space-y-2 text-xs text-ink-secondary">
            {item.decisions.length > 0 && <li>
              <p className="font-medium text-ink">{t("work.decisions")}</p>
              <ul className="mt-1 list-disc space-y-1 pl-5">{item.decisions.map(decision => <li key={decision} className="whitespace-pre-wrap break-words">{decision}</li>)}</ul>
            </li>}
            {item.evidence.length > 0 && item.evidence.map(entry => <li key={entry} className="whitespace-pre-wrap break-words">{entry}</li>)}
          </ul>
        </details>}
      </div>
      <aside aria-label={t("work.linked")} className="min-w-0 space-y-2 lg:w-56 lg:shrink-0">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-ink-secondary">{t("work.linked")}</h3>
          <button type="button" onClick={() => { setLinkError(""); setLinkOpen(true); }}
            className="rounded-md border border-hairline/50 px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-raised">{t("work.linkItem")}</button>
        </div>
        {links.length === 0 ? <p className="text-xs text-ink-secondary">{t("work.linkedEmpty")}</p>
          : <ul className="flex flex-col gap-1.5">{links.map(link => <li key={link.id} className="min-w-0"><LinkChip item={link} connectors={connectors} /></li>)}</ul>}
      </aside>
    </div>
    <LinkItemDialog open={linkOpen} pending={linkPending} error={linkError} onClose={() => setLinkOpen(false)} onSubmit={input => void submitLink(input)} />
  </section>;
}
