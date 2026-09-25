import { z } from "zod";
import { memberWorkItem, workItemVisible, type VisibleSet } from "../bot-visibility.ts";
import type { WorkRecord } from "../work-items.ts";
import type { OngoingGoal } from "../../shared/ongoing-goal.ts";
import type { WorkOverview, WorkOverviewCard, WorkOverviewEntry, WorkQueue } from "../../shared/work-overview.ts";
import type { OptionCardData } from "../../shared/wire.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const choiceSchema = z.object({ expectedRevision: z.number().int().positive(),
  scopeIds: z.array(z.string().min(1).max(240)).min(1).max(200) }).strict();
const queues: WorkQueue[] = ["needs-you", "waiting", "working", "completed"];

interface CardMessage { id: string; kind: string; card?: OptionCardData }

export interface WorkConversation {
  threadId: string;
  title: string;
  team: string;
  ownerBotId: string;
  groupId?: string;
  busy: boolean;
  waiting: boolean;
  lifecycle: "open" | "closed" | "archived";
  updatedAt: number;
}

export interface WorkOverviewDeps {
  visible(auth: RequestAuth): VisibleSet;
  tasks(): WorkRecord[];
  conversations(): WorkConversation[];
  goals(): OngoingGoal[];
  teamForGroup(groupId: string): string | undefined;
  teamForBot(botId: string): string | undefined;
  botName(botId: string): string | undefined;
  messages(threadId: string): CardMessage[];
  cardRefusal(auth: RequestAuth, threadId: string, requestId: string, behavior: "allow" | "answer", card: OptionCardData): string | null;
  cardDecisionMaker(threadId: string, requestId: string, card: OptionCardData): string;
  canChooseScope(auth: RequestAuth, goal: OngoingGoal): boolean;
  chooseScope(goal: OngoingGoal, expectedRevision: number, ids: string[]): OngoingGoal;
}

/** A backlog goal can name a board elsewhere in its team. Do not expose its
 * issue names or private task ids if the viewer cannot also see that room. */
export function workGoalVisible(goal: OngoingGoal, visible: VisibleSet, tasks: ReadonlyMap<string, WorkRecord>): boolean {
  if (!visible.bot(goal.ownerBotId) || !visible.thread(goal.sourceThreadId)) return false;
  if (goal.teamBacklog?.scopes.some(scope => scope.groupId && !visible.group(scope.groupId))) return false;
  if (goal.teamBacklog?.choices.some(scope => scope.groupId && !visible.group(scope.groupId))) return false;
  return goal.workItemIds.every(id => {
    const item = tasks.get(id);
    return Boolean(item && workItemVisible(item, visible));
  });
}

export function createWorkOverviewRoutes(deps: WorkOverviewDeps): RouteHandler {
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    if (path === "/api/work/overview") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed" });
      const visible = deps.visible(auth);
      const tasks = deps.tasks();
      const taskById = new Map(tasks.map(item => [item.id, item]));
      const goals = deps.goals();
      const coveredThreads = new Set([...tasks.flatMap(item => [item.threadId, ...item.assignments.map(assignment => assignment.threadId)]),
        ...goals.map(goal => goal.executionThreadId)]);
      const team = url.searchParams.get("team");
      const status = url.searchParams.get("status") ?? "all";
      const cursor = Number(url.searchParams.get("cursor") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
          !["all", ...queues].includes(status)) return json(res, 400, { error: "Invalid Work filter or cursor" });
      const cardsByEntry = new Map<string, WorkOverviewCard[]>();
      const usedCards = new Set<string>();
      const cardsFor = (entryId: string, threadIds: string[]) => {
        const cards: WorkOverviewCard[] = [];
        for (const threadId of new Set(threadIds)) {
          if (!visible.thread(threadId)) continue;
          for (const message of deps.messages(threadId)) {
            const card = message.card;
            if (message.kind !== "options" || !card?.requestId || card.answered || card.dismissed) continue;
            const key = `${threadId}:${card.requestId}`;
            if (usedCards.has(key)) continue;
            usedCards.add(key);
            const approval = !card.questionRequest && Boolean(card.tool || card.routineRequest || card.profileRequest ||
              card.teamSetupRequest || card.skillRequest);
            const behavior = approval ? "allow" : "answer";
            cards.push({ entryId, threadId, messageId: message.id, card,
              canAct: !deps.cardRefusal(auth, threadId, card.requestId, behavior, card),
              decisionMaker: deps.cardDecisionMaker(threadId, card.requestId, card) });
          }
        }
        cardsByEntry.set(entryId, cards);
        return cards;
      };
      const entries: WorkOverviewEntry[] = [];
      for (const item of tasks) {
        if (!workItemVisible(item, visible)) continue;
        const view = memberWorkItem(item, visible);
        const cards = cardsFor(item.id, [item.threadId, ...view.assignments.map(assignment => assignment.threadId)]);
        const canAnswerTask = item.status === "needs-input";
        const queue: WorkQueue = item.status === "completed" || item.status === "cancelled" ? "completed"
          : cards.some(card => card.canAct) || canAnswerTask ? "needs-you"
          : item.status === "active" ? "working" : "waiting";
        entries.push({ kind: "task", id: item.id, team: deps.teamForGroup(item.groupId) ?? "", title: item.title,
          status: item.status, queue, owner: { id: item.coordinatorBotId, name: deps.botName(item.coordinatorBotId) ?? "Coordinator" },
          detail: item.detail, nextCheckpoint: view.assignments.find(assignment => assignment.currentStep)?.currentStep?.summary ?? item.detail,
          evidence: [...item.evidence, ...(item.criteria ?? []).flatMap(criterion => criterion.evidence)],
          updatedAt: item.updatedAt, threadId: item.threadId, revision: item.revision,
          ...(canAnswerTask ? { canAnswerTask } : {}) });
      }
      for (const conversation of deps.conversations()) {
        if (coveredThreads.has(conversation.threadId) || !visible.bot(conversation.ownerBotId) ||
            !visible.thread(conversation.threadId) || conversation.groupId && !visible.group(conversation.groupId)) continue;
        const id = `thread:${conversation.threadId}`;
        const cards = cardsFor(id, [conversation.threadId]);
        const queue: WorkQueue = conversation.lifecycle !== "open" ? "completed"
          : cards.some(card => card.canAct) ? "needs-you"
          : conversation.busy ? "working" : "waiting";
        const detail = conversation.lifecycle !== "open" ? `This task is ${conversation.lifecycle}.`
          : cards.length ? "A decision is pending in this conversation."
          : conversation.busy ? "The owner is working in this conversation."
          : conversation.waiting ? "Waiting for teammates to return." : "Awaiting the next conversation update.";
        entries.push({ kind: "task", id, team: conversation.team, title: conversation.title,
          status: conversation.lifecycle !== "open" ? conversation.lifecycle : conversation.busy ? "working"
            : conversation.waiting ? "waiting" : "idle", queue,
          owner: { id: conversation.ownerBotId, name: deps.botName(conversation.ownerBotId) ?? "Task owner" },
          detail, nextCheckpoint: cards[0]?.card.title ?? detail, evidence: [],
          updatedAt: conversation.updatedAt, threadId: conversation.threadId, revision: 1 });
      }
      for (const goal of goals) {
        if (!workGoalVisible(goal, visible, taskById)) continue;
        const cards = cardsFor(goal.id, [goal.sourceThreadId, goal.executionThreadId]);
        const canChooseScope = Boolean(goal.teamBacklog?.choices.length && deps.canChooseScope(auth, goal));
        const canRenew = goal.status === "paused" && /budget|spending cannot be priced/i.test(goal.detail) && auth.scopes.includes("admin");
        const budgetGate = goal.status === "paused" && /budget|spending cannot be priced/i.test(goal.detail)
          ? [{ kind: "budget" as const, detail: goal.detail, decisionMaker: "Workspace admin" }] : [];
        const queue: WorkQueue = ["completed", "stopped"].includes(goal.status) ? "completed"
          : cards.some(card => card.canAct) || canChooseScope || canRenew ? "needs-you"
          : goal.status === "working" ? "working" : "waiting";
        entries.push({ kind: "goal", id: goal.id, team: goal.teamBacklog?.section ?? deps.teamForBot(goal.ownerBotId) ?? "",
          title: goal.objective, status: goal.status, queue, owner: { id: goal.ownerBotId, name: deps.botName(goal.ownerBotId) ?? "Coordinator" },
          detail: goal.detail, nextCheckpoint: goal.nextAction ?? (goal.nextWakeAt ? new Date(goal.nextWakeAt).toISOString() : goal.detail),
          evidence: goal.evidence, updatedAt: goal.updatedAt, threadId: goal.sourceThreadId, revision: goal.revision,
          ...(goal.teamBacklog || budgetGate.length ? { gates: [...(goal.teamBacklog?.gates ?? []), ...budgetGate] } : {}),
          ...(goal.teamBacklog ? { choices: goal.teamBacklog.choices, scan: goal.teamBacklog.scan } : {}),
          ...(canChooseScope ? { canChooseScope } : {}), ...(canRenew ? { canRenew } : {}) });
        for (const target of goal.teamBacklog?.targets ?? []) {
          const item = target.taskId ? taskById.get(target.taskId) : undefined;
          const targetGates = goal.teamBacklog?.gates.filter(gate => gate.identity === target.identity) ?? [];
          const queue: WorkQueue = target.state === "done" ? "completed" : item?.status === "active" ||
            !targetGates.length && goal.status === "working" ? "working" : "waiting";
          entries.push({ kind: "source", id: `source:${goal.id}:${target.identity}`, team: goal.teamBacklog!.section,
            title: `${target.externalId} · ${target.title}`, status: target.label, queue,
            owner: { id: item?.coordinatorBotId ?? goal.ownerBotId,
              name: deps.botName(item?.coordinatorBotId ?? goal.ownerBotId) ?? "Coordinator" },
            detail: target.requirements ?? `${target.connectorId === "jira" ? "Jira issue" : "GitLab MR"}: ${target.label}`,
            nextCheckpoint: targetGates[0]?.detail ?? (item?.status === "active" ? item.detail :
              target.state === "done" ? target.result : "Dispatch or recheck this source item."),
            evidence: [...(target.result ? [target.result] : []), ...(target.headSha ? [`Current head: ${target.headSha}`] : [])],
            updatedAt: target.observedAt, threadId: item?.threadId ?? goal.sourceThreadId,
            revision: item?.revision ?? goal.revision, ...(targetGates.length ? { gates: targetGates } : {}) });
        }
      }
      const teams = [...new Set(entries.map(entry => entry.team))].sort();
      const inTeam = entries.filter(entry => team === null || team === entry.team);
      const counts: WorkOverview["counts"] = { "needs-you": 0, waiting: 0, working: 0, completed: 0 };
      for (const entry of inTeam) counts[entry.queue] += 1;
      const matching = inTeam.filter(entry => status === "all" || status === entry.queue);
      matching.sort((a, b) => queues.indexOf(a.queue) - queues.indexOf(b.queue) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      const page = matching.slice(cursor, cursor + limit);
      const cards = page.flatMap(entry => cardsByEntry.get(entry.id) ?? []);
      return json(res, 200, { entries: page, cards, teams, counts,
        ...(cursor + limit < matching.length ? { nextCursor: String(cursor + limit) } : {}) } satisfies WorkOverview);
    }
    const choice = /^\/api\/goals\/([\w-]+)\/scope-choice$/.exec(path);
    if (!choice) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Method not allowed" });
    const goal = deps.goals().find(candidate => candidate.id === choice[1]);
    if (!goal || !workGoalVisible(goal, deps.visible(auth), new Map(deps.tasks().map(item => [item.id, item])))) {
      return json(res, 404, { error: "No such goal" });
    }
    if (!deps.canChooseScope(auth, goal)) return json(res, 403, { error: "Only the authorized requester or admin may choose scope" });
    const parsed = choiceSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: "Choose the listed scopes at the current revision" });
    try { return json(res, 200, { goal: deps.chooseScope(goal, parsed.data.expectedRevision, parsed.data.scopeIds) }); }
    catch (error) { return json(res, 409, { error: error instanceof Error ? error.message : String(error) }); }
  };
}
