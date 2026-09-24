import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Bot, Group, GroupDefaultResponder } from "@/state/store";
import { api, useStore } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkKind, SyncedItem } from "../../../shared/work-links";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { firstChangeRequest, workItemKey } from "@/lib/shared-work-sidebar";
import { BotAvatar } from "../Avatar";
import { KindIcon } from "./KindIcon";
import {
  ensureFromSynced,
  nextUntrackedWork,
  syncedBoardCategory,
  taskBoardCategory,
  untrackedItems,
  visibleBoardColumns,
} from "./board";
import { connectorFor, displayLinks, loadTaskConnectors, progressCounts, statusCategoryClass, type TaskConnectorManifest } from "./model";
import { ProviderMark } from "./ProviderMark";
import { TaskAnswer } from "./TaskAnswer";

interface BoardConnection {
  id: string;
  connectorId: string;
  label: string;
}

export function TopicBoard({ group, onOpenTask, queried: queriedProp, connections: connectionsProp }: {
  group: Group; onOpenTask: (threadId: string) => void; queried?: SyncedItem[]; connections?: BoardConnection[];
}) {
  const { state, dispatch } = useStore();
  const tasks = useMemo(() => group.tasks?.flatMap(task => task.workItem ? [task.workItem] : []) ?? [], [group.tasks]);
  const [connectors, setConnectors] = useState<TaskConnectorManifest[]>([]);
  const [loadedConnections, setConnections] = useState<BoardConnection[]>([]);
  const [loadedQueried, setQueried] = useState<SyncedItem[]>([]);
  const connections = connectionsProp ?? loadedConnections;
  const queried = queriedProp ?? loadedQueried;
  const [queryError, setQueryError] = useState("");
  const [queryPending, setQueryPending] = useState(false);
  const [startError, setStartError] = useState("");
  const [starting, setStarting] = useState(false);
  const [connectionId, setConnectionId] = useState(group.taskBoard?.connectionId ?? "");
  const [query, setQuery] = useState(group.taskBoard?.query ?? "");
  const [savingQuery, setSavingQuery] = useState(false);

  useEffect(() => {
    setConnectionId(group.taskBoard?.connectionId ?? "");
    setQuery(group.taskBoard?.query ?? "");
  }, [group.id, group.taskBoard?.connectionId, group.taskBoard?.query]);

  useEffect(() => {
    let cancelled = false;
    void loadTaskConnectors(path => api(path)).then(list => { if (!cancelled) setConnectors(list); });
    if (connectionsProp) return () => { cancelled = true; };
    api<{ connections?: BoardConnection[] }>(`/api/groups/${group.id}/task-board`).then(body => {
      if (!cancelled) setConnections(body.connections ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [group.id, connectionsProp]);

  useEffect(() => {
    if (queriedProp) return;
    const saved = group.taskBoard;
    if (!saved?.connectionId) {
      setQueried([]);
      setQueryError("");
      return;
    }
    let cancelled = false;
    setQueryPending(true);
    api<{ items?: SyncedItem[] }>(`/api/task-connections/${saved.connectionId}/query?${new URLSearchParams({
      query: saved.query, groupId: group.id,
    })}`).then(body => {
      if (!cancelled) { setQueried(body.items ?? []); setQueryError(""); }
    }).catch(error => {
      if (!cancelled) { setQueried([]); setQueryError(error instanceof Error ? error.message : String(error)); }
    }).finally(() => { if (!cancelled) setQueryPending(false); });
    return () => { cancelled = true; };
  }, [group.id, group.taskBoard?.connectionId, group.taskBoard?.query, queriedProp]);

  const untracked = useMemo(() => untrackedItems(tasks, queried), [tasks, queried]);
  const next = nextUntrackedWork(untracked);
  const categories = useMemo(() => {
    const used = [
      ...tasks.map(taskBoardCategory),
      ...untracked.map(syncedBoardCategory),
    ];
    return visibleBoardColumns(used);
  }, [tasks, untracked]);

  const coordinatorId = coordinatorBotId(group.defaultResponder, group.memberIds);

  const start = async (item: SyncedItem) => {
    const body = ensureFromSynced(item, group);
    if (!body || !coordinatorId) return;
    setStarting(true);
    setStartError("");
    try {
      await api("/api/work-items/ensure", { method: "POST", body: JSON.stringify({ ...body, coordinatorBotId }) });
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  };

  const saveQuery = async (clear = false) => {
    setSavingQuery(true);
    setStartError("");
    try {
      const result = await api<{ group?: Partial<Group> & { id: string }; taskBoard?: Group["taskBoard"] }>(`/api/groups/${group.id}/task-board`, {
        method: "PATCH",
        body: JSON.stringify(clear ? {} : { connectionId, query }),
      });
      if (result.group) dispatch({ type: "groupPatched", group: { ...result.group, taskBoard: result.taskBoard ?? null } });
    } catch (caught) {
      setStartError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSavingQuery(false);
    }
  };

  return <section data-topic-board={group.id} aria-label={t("work.boardAria")} className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 pb-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">{t("work.board")}</h2>
        {queryPending && <Loader2 size={14} aria-hidden="true" className="animate-spin text-ink-secondary" />}
      </div>
      <button type="button" disabled={!next || starting || !coordinatorId} onClick={() => next && void start(next)}
        className="rounded-md border border-hairline/50 bg-raised px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-raised-hover disabled:opacity-50">
        {t("work.startNext")}
      </button>
    </div>
    <details className="mb-3 rounded-lg border border-hairline/40 bg-panel p-2 text-[12.5px]">
      <summary className="cursor-pointer font-medium text-ink">{t("work.boardQuery")}</summary>
      <p className="mt-1 text-[11px] text-ink-secondary">{t("work.boardQueryHelp")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="min-w-[10rem] flex-1">
          <span className="mb-1 block text-[11px] text-ink-secondary">{t("work.boardConnection")}</span>
          <select value={connectionId} onChange={event => setConnectionId(event.target.value)}
            className="w-full rounded-md border border-hairline/50 bg-app px-2 py-1 text-ink">
            <option value="">{t("work.boardQueryEmpty")}</option>
            {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}
          </select>
        </label>
        <label className="min-w-[12rem] flex-[2]">
          <span className="mb-1 block text-[11px] text-ink-secondary">{t("work.boardQueryText")}</span>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("work.boardQueryPlaceholder")}
            className="w-full rounded-md border border-hairline/50 bg-app px-2 py-1 text-ink placeholder:text-ink-secondary" />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={savingQuery || !connectionId} onClick={() => void saveQuery(false)}
          className="rounded-md border border-hairline/50 px-2 py-1 text-[11px] text-ink hover:bg-raised disabled:opacity-50">
          {t("work.boardQuerySave")}
        </button>
        <button type="button" disabled={savingQuery || !group.taskBoard} onClick={() => void saveQuery(true)}
          className="rounded-md border border-hairline/50 px-2 py-1 text-[11px] text-ink-secondary hover:bg-raised disabled:opacity-50">
          {t("work.boardQueryClear")}
        </button>
      </div>
    </details>
    {queryError && <p role="alert" className="mb-2 text-xs text-danger">{queryError}</p>}
    {startError && <p role="alert" className="mb-2 text-xs text-danger">{startError}</p>}
    {!next && untracked.length === 0 && group.taskBoard && <p className="mb-2 text-[11px] text-ink-secondary">{t("work.startNextEmpty")}</p>}
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
      {categories.map(category => {
        const taskCards = tasks.filter(item => taskBoardCategory(item) === category);
        const loose = untracked.filter(item => syncedBoardCategory(item) === category);
        return <section key={category} data-board-column={category} aria-label={t(`work.statusCategory.${category}`)}
          className="flex w-[16.5rem] shrink-0 flex-col rounded-xl border border-hairline/40 bg-panel/70">
          <h3 className={cn("px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide", statusCategoryClass(category))}>
            {t(`work.statusCategory.${category}`)}
            <span className="ml-1 font-normal text-ink-secondary">{taskCards.length + loose.length}</span>
          </h3>
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
            {taskCards.map(item => <TaskBoardCard key={item.id} item={item} connectors={connectors} bots={state.bots}
              onOpen={() => onOpenTask(item.threadId)} />)}
            {loose.map(item => <UntrackedBoardCard key={`${item.connectionId}:${item.kind}:${item.externalId}`} item={item}
              connectors={connectors} pending={starting} onStart={() => void start(item)} />)}
            {taskCards.length === 0 && loose.length === 0 &&
              <p className="px-1 pb-2 text-[11px] text-ink-secondary">{t("work.boardEmpty")}</p>}
          </div>
        </section>;
      })}
    </div>
  </section>;
}

function TaskBoardCard({ item, connectors, bots, onOpen }: {
  item: WorkItem; connectors: TaskConnectorManifest[]; bots: Bot[]; onOpen: () => void;
}) {
  const links = displayLinks(item);
  const source = links.find(link => link.role === "source") ?? links[0];
  const changeRequest = firstChangeRequest(item);
  const key = workItemKey(item);
  const counts = progressCounts(item);
  const owner = bots.find(bot => bot.id === item.coordinatorBotId);
  const kind = (source?.kind ?? changeRequest?.kind ?? "link") as LinkKind;
  return <article data-board-card={item.id} data-board-kind={kind} className="rounded-lg border border-hairline/40 bg-app p-2">
    <button type="button" onClick={onOpen} className="flex w-full flex-col items-start gap-1 text-left">
      <span className="flex w-full min-w-0 items-center gap-1.5">
        <KindIcon kind={kind} size={12} />
        {key && <span className="shrink-0 rounded border border-hairline/40 px-1 text-[10px] text-ink-secondary">{key}</span>}
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink">{item.title}</span>
        {source && <ProviderMark connector={connectorFor(source, connectors)} />}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1 text-[10.5px] text-ink-secondary">
        <span>{t(`work.status.${item.status}`)}</span>
        {changeRequest && <>
          <span aria-hidden="true">·</span>
          <KindIcon kind="change_request" size={10} />
          <span className="min-w-0 truncate">{changeRequest.externalId ? `!${changeRequest.externalId}` : changeRequest.title}</span>
        </>}
        {counts.criteriaTotal > 0 && <>
          <span aria-hidden="true">·</span>
          <span>{t("work.progressCriteria", { done: counts.criteriaDone, total: counts.criteriaTotal })}</span>
        </>}
        {owner && <span className="ml-auto"><BotAvatar bot={owner} size={14} state="happy" animated={false} /></span>}
      </span>
    </button>
    <TaskAnswer item={item} />
  </article>;
}

function UntrackedBoardCard({ item, connectors, pending, onStart }: {
  item: SyncedItem; connectors: TaskConnectorManifest[]; pending: boolean; onStart: () => void;
}) {
  return <article data-board-card={`untracked:${item.externalId ?? item.title}`} data-board-kind={item.kind} data-untracked="true"
    className="rounded-lg border border-dashed border-hairline/60 bg-app/70 p-2">
    <div className="flex min-w-0 items-center gap-1.5">
      <KindIcon kind={item.kind} size={12} />
      {item.externalId && <span className="shrink-0 rounded border border-hairline/40 px-1 text-[10px] text-ink-secondary">{item.externalId}</span>}
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{item.title}</span>
      <ProviderMark connector={connectorFor(item, connectors)} />
    </div>
    <p className="mt-1 text-[10.5px] text-ink-secondary">{t("work.noTaskYet")}</p>
    <button type="button" disabled={pending} onClick={onStart}
      className="mt-1.5 rounded-md border border-hairline/50 px-2 py-0.5 text-[11px] text-ink hover:bg-raised disabled:opacity-50">
      {t("work.startTask")}
    </button>
  </article>;
}

function coordinatorBotId(responder: GroupDefaultResponder, memberIds: string[]) {
  if (responder.kind === "member") return responder.botId;
  return memberIds[0];
}
