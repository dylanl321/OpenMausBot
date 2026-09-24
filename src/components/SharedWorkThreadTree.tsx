import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, CircleAlert, FolderKanban, Loader2, Users } from "lucide-react";
import type { WorkItem } from "../../shared/work-item";
import { openThread, useStore } from "@/state/store";
import { selectedSharedWork, sharedWorkThreads } from "@/lib/shared-work-sidebar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { BotAvatar } from "./Avatar";

export function SharedWorkThreadTree({ item, compact = false, query = "" }: { item: WorkItem; compact?: boolean; query?: string }) {
  const { state, dispatch } = useStore();
  const selected = selectedSharedWork(state)?.id === item.id;
  const hubSelected = selected && state.selectedId === item.groupId;
  const [open, setOpen] = useState(selected || item.status === "active" || Boolean(query));
  useEffect(() => { if (selected || query) setOpen(true); }, [selected, query]);
  const workers = sharedWorkThreads(item, state.bots);
  const pending = workers.some(({ task }) => task.activity === "waiting-on-you");
  const StatusIcon = item.status === "active" ? Loader2 : item.status === "completed" ? CheckCircle2 : CircleAlert;
  const owner = state.bots.find(bot => bot.id === item.coordinatorBotId);
  return <div data-work-item-tree={item.id} className={cn("my-1 min-w-0 rounded-lg border bg-accent/5", selected ? "border-accent/40" : "border-accent/15")}>
    <button type="button" title={item.title} aria-expanded={open} aria-label={t(open ? "work.collapseTask" : "work.expandTask", { title: item.title })}
      onClick={() => setOpen(previous => !previous)} className={cn("flex w-full items-start gap-1.5 rounded-lg px-2 text-left outline-none hover:bg-accent/10 focus-visible:ring-1 focus-visible:ring-accent/60", compact ? "py-1" : "py-2")}>
      <ChevronRight size={12} aria-hidden="true" className={cn("mt-1 shrink-0", open && "rotate-90")} />
      <FolderKanban size={15} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-semibold text-ink">{item.title}</span>
        <span className={cn("mt-0.5 flex items-center gap-1 text-[10.5px]", pending || item.status === "blocked" || item.status === "needs-input" ? "text-warning" : "text-ink-secondary")}>
          <StatusIcon size={10} aria-hidden="true" className={cn(item.status === "active" && "animate-spin")} />
          {pending ? t("task.waiting") : t(`work.status.${item.status}`)}
          <span aria-hidden="true">·</span>{t(workers.length === 0 ? "work.singleThread" : "work.threadCount", { count: workers.length + 1 })}
        </span>
      </span>
    </button>
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
