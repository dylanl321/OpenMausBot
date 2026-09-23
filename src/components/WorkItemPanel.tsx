import { useState } from "react";
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react";
import type { WorkItem } from "../../shared/work-item";
import { api, openThread, useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";

export function WorkItemPanel({ item }: { item: WorkItem }) {
  const { state, dispatch } = useStore();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const owner = state.bots.find(bot => bot.id === item.coordinatorBotId);
  const assignments = item.assignments.filter(assignment => assignment.revision === item.revision);
  const working = assignments.filter(assignment => ["queued", "running", "waiting"].includes(assignment.status));
  const change = async (reopen: boolean) => {
    setPending(true);
    setError("");
    try {
      await api(`/api/work-items/${item.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: item.revision,
        ...(reopen ? { reopen: true } : { status: "cancelled", detail: t("work.stoppedByUser") }) }) });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setPending(false); }
  };
  return <section aria-label={t("work.summary")} className="mx-5 mb-3 rounded-xl border border-hairline/40 bg-panel p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        {item.status === "active" && <Loader2 size={14} aria-hidden="true" className="animate-spin text-accent" />}
        <span className="font-medium text-ink">{t(`work.status.${item.status}`)}</span>
        <span className="truncate text-ink-secondary">{t("work.owner", { name: owner?.name ?? item.coordinatorBotId })}</span>
      </div>
      <button type="button" disabled={pending} onClick={() => void change(item.status !== "active")}
        className="rounded-md border border-hairline/50 px-2 py-1 text-xs text-ink-secondary hover:bg-raised disabled:opacity-50">
        {item.status === "active" ? t("work.stop") : t("work.reopen")}
      </button>
    </div>
    <p className="mt-2 whitespace-pre-wrap text-ink-secondary">{item.detail || item.objective}</p>
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
    <details className="mt-2">
      <summary role="button" className="cursor-pointer text-ink-secondary">{t("work.brief")}</summary>
      <p className="mt-2 whitespace-pre-wrap text-ink">{item.objective}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-ink-secondary">{item.acceptanceCriteria.map(criterion => <li key={criterion}>{criterion}</li>)}</ul>
    </details>
    {assignments.length > 0 && <details className="mt-2" open={working.length > 0 || undefined}>
      <summary role="button" className="cursor-pointer text-ink-secondary">{t("work.assignments", { count: assignments.length, working: working.length })}</summary>
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
    {(item.artifacts.length > 0 || item.evidence.length > 0 || item.decisions.length > 0) && <details className="mt-2">
      <summary role="button" className="cursor-pointer text-ink-secondary">{t("work.evidence")}</summary>
      <ul className="mt-2 space-y-2 text-xs text-ink-secondary">
        {item.artifacts.map(artifact => <li key={artifact.ref} className="break-all"><ExternalLink size={12} className="mr-1 inline" aria-hidden="true" />{artifact.label}: {artifact.ref}{artifact.revision ? ` (${artifact.revision})` : ""}</li>)}
        {[...item.decisions, ...item.evidence].map((entry, index) => <li key={`${index}:${entry}`} className="whitespace-pre-wrap break-words">{entry}</li>)}
      </ul>
    </details>}
  </section>;
}
