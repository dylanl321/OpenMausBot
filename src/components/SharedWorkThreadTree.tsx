import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, Loader2, Users } from "lucide-react";
import type { WorkItem } from "../../shared/work-item";
import { openThread, useStore } from "@/state/store";
import { firstChangeRequest, selectedSharedWork, sharedWorkThreads, workItemKey } from "@/lib/shared-work-sidebar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { nowFrom, progressCounts } from "./work/model";
import { KindIcon } from "./work/KindIcon";
import { BotAvatar } from "./Avatar";

export function SharedWorkThreadTree({ item, compact = false, query = "" }: { item: WorkItem; compact?: boolean; query?: string }) {
  const { state, dispatch } = useStore();
  const selected = selectedSharedWork(state)?.id === item.id;
  const hubSelected = selected && state.selectedId === item.groupId;
  const [open, setOpen] = useState(selected || Boolean(query));
  useEffect(() => { if (selected || query) setOpen(true); }, [selected, query]);
  const workers = sharedWorkThreads(item, state.bots);
  const pending = workers.some(({ task }) => task.activity === "waiting-on-you");
  const StatusIcon = item.status === "active" ? Loader2 : item.status === "completed" ? CheckCircle2 : CircleAlert;
  const owner = state.bots.find(bot => bot.id === item.coordinatorBotId);
  const people = [owner, ...workers.map(worker => worker.bot)].filter((bot): bot is NonNullable<typeof owner> => Boolean(bot))
    .filter((bot, index, list) => list.findIndex(candidate => candidate.id === bot.id) === index);
  const key = workItemKey(item);
  const changeRequest = firstChangeRequest(item);
  const counts = progressCounts(item);
  const now = selected ? nowFrom(item) : null;
  return <div data-work-item-tree={item.id} data-sidebar-task-row={item.id} className={cn("my-1 min-w-0 rounded-lg border bg-accent/5", selected ? "border-accent/40" : "border-accent/15")}>
    <div className={cn("flex w-full items-start gap-0.5", compact ? "px-1 py-0.5" : "px-1.5 py-1")}>
      <button type="button" aria-expanded={open} aria-label={t(open ? "work.collapseTask" : "work.expandTask", { title: item.title })}
        onClick={() => setOpen(previous => !previous)} className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary outline-none hover:bg-accent/10 hover:text-ink focus-visible:ring-1 focus-visible:ring-accent/60">
        <ChevronRight size={12} aria-hidden="true" className={cn(open && "rotate-90")} />
      </button>
      <button type="button" title={item.title} aria-current={hubSelected ? "page" : undefined} aria-label={t("work.openHub", { title: item.title })}
        onClick={() => openThread(dispatch, { botId: item.coordinatorBotId, threadId: item.threadId }, state)}
        className={cn("min-w-0 flex-1 rounded-md px-1 text-left outline-none hover:bg-accent/10 focus-visible:ring-1 focus-visible:ring-accent/60", compact ? "py-0.5" : "py-1")}>
        <span className="flex items-center gap-1.5">
          <StatusIcon size={11} aria-hidden="true" className={cn("shrink-0", item.status === "active" && "animate-spin", pending || item.status === "blocked" || item.status === "needs-input" ? "text-warning" : "text-ink-secondary")} />
          {key && <span data-task-key={key} className="shrink-0 rounded border border-hairline/40 bg-raised/60 px-1 text-[10px] font-medium text-ink-secondary">{key}</span>}
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{item.title}</span>
          {people.length > 0 && <span className="flex shrink-0 items-center -space-x-1.5" data-task-avatars>
            {people.slice(0, 3).map(bot => <BotAvatar key={bot.id} bot={bot} size={compact ? 14 : 16} state="happy" animated={false} />)}
            {people.length > 3 && <span className="z-10 flex size-4 items-center justify-center rounded-full border border-hairline/40 bg-raised text-[9px] text-ink-secondary">+{people.length - 3}</span>}
          </span>}
        </span>
        <span className={cn("mt-0.5 flex min-w-0 items-center gap-1 text-[10.5px]", pending || item.status === "blocked" || item.status === "needs-input" ? "text-warning" : "text-ink-secondary")}>
          <span className="shrink-0">{pending ? t("task.waiting") : t(`work.status.${item.status}`)}</span>
          {changeRequest && <>
            <span aria-hidden="true">·</span>
            <KindIcon kind="change_request" size={10} className="shrink-0" />
            <span data-task-cr={changeRequest.id} className="min-w-0 truncate">{changeRequest.externalId ? `!${changeRequest.externalId}` : changeRequest.title}</span>
          </>}
          {counts.criteriaTotal > 0 && <>
            <span aria-hidden="true">·</span>
            <span data-task-criteria className="shrink-0">{t("work.progressCriteria", { done: counts.criteriaDone, total: counts.criteriaTotal })}</span>
          </>}
        </span>
        {now && <span data-task-live-step className="mt-0.5 block truncate text-[10.5px] text-accent">{now.summary}</span>}
      </button>
    </div>
    {open && <div role="group" aria-label={t("work.taskThreads", { title: item.title })} className="mb-1 ml-3 space-y-0.5 border-l border-accent/20 pl-1">
      <button type="button" data-sidebar-thread-row={item.threadId} aria-current={hubSelected ? "page" : undefined} aria-label={t("work.openHub", { title: item.title })}
        onClick={() => openThread(dispatch, { botId: item.coordinatorBotId, threadId: item.threadId }, state)}
        className={cn("flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-accent/60", hubSelected ? "bg-accent/15 text-ink" : "text-ink-secondary hover:bg-accent/10")}>
        <Users size={14} aria-hidden="true" className="shrink-0 text-accent" />
        <span className="min-w-0"><span className="block font-medium">{t("work.sharedChat")}</span><span className="block truncate text-[10px] text-ink-secondary">{owner?.name}</span></span>
      </button>
      {workers.map(({ bot, task, assignment }) => {
        const current = selected && state.selectedId === bot.id && bot.threadId === task.threadId;
        const working = task.busy || task.activity === "working" || assignment?.status === "running";
        const waiting = task.activity === "waiting-on-you";
        const status = waiting ? t("task.waiting") : working ? t("work.status.running") : assignment ? t(`work.status.${assignment.status}`) : t("work.previousWork");
        return <button key={task.threadId} type="button" data-sidebar-thread-row={task.threadId} aria-current={current ? "page" : undefined}
          aria-label={t("work.openTopicWorker", { name: bot.name, title: item.title })} title={`${task.title} · ${status}`}
          onClick={() => openThread(dispatch, { botId: bot.id, threadId: task.threadId }, state)}
          className={cn("flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-accent/60", current ? "bg-accent/15 text-ink" : "text-ink-secondary hover:bg-accent/10")}>
          <BotAvatar bot={bot} size={18} state="happy" animated={false} />
          <span className="min-w-0 flex-1"><span className="block truncate font-medium">{bot.name}</span><span className={cn("block truncate text-[10px]", waiting ? "text-warning" : "text-ink-secondary")}>{status}</span></span>
          {working && !waiting && <Loader2 size={11} aria-hidden="true" className="shrink-0 animate-spin text-success" />}
          {task.unread && <span className="size-1.5 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
        </button>;
      })}
    </div>}
  </div>;
}
