/** Provider-agnostic watch actions: attach changes to tasks and ensure_task. */
import { randomUUID } from "node:crypto";
import { sourceIdentity, type LinkedItem } from "../shared/work-links.ts";
import { summarizeChanges, type SourceChange, type Watch, type WatchAction } from "../shared/watches.ts";
import { linkId, observedLink } from "./connectors/types.ts";
import type { WorkEvents } from "./work-events.ts";
import type { WorkItems, WorkRecord } from "./work-items.ts";

export function isWatchInputChange(change: SourceChange): boolean {
  return change.type === "item.updated"
    || change.type === "item.created"
    || change.type === "commit.pushed"
    || change.type === "build.failed";
}

export function watchParentRef(change: SourceChange): string | undefined {
  const fields = change.fields;
  const parent = fields.mr ?? fields.parent ?? fields.issue ?? change.item.details?.mr ?? change.item.details?.issue;
  return typeof parent === "string" && parent ? parent : undefined;
}

export function watchLinkMatches(link: LinkedItem, change: SourceChange): boolean {
  if (change.item.externalId && link.externalId === change.item.externalId) return true;
  if (change.item.url && link.url === change.item.url) return true;
  const parent = watchParentRef(change);
  if (parent && (link.externalId === parent || link.id === parent)) return true;
  if (change.item.kind === "build" && link.kind === "change_request") {
    const pipelineId = link.details?.pipelineId;
    const external = change.item.externalId ?? "";
    if (pipelineId != null && external.endsWith(`#pipeline:${pipelineId}`)) return true;
  }
  return false;
}

export function applyWatchToWork(input: {
  items: WorkItems;
  events?: WorkEvents;
  changes: SourceChange[];
  bumpInput: boolean;
  onLink?: (item: WorkRecord, link: LinkedItem) => void;
  onEvent?: (item: WorkRecord, event: { id: string; workItemId: string; summary: string }) => void;
  onWake?: (item: WorkRecord) => void;
}): { attached: number; woken: string[] } {
  const woken: string[] = [];
  let attached = 0;
  for (const change of input.changes) {
    for (const item of input.items.records.values()) {
      const match = item.links?.find(link => watchLinkMatches(link, change));
      if (!match) continue;
      const parentId = match.kind !== change.item.kind ? match.id : match.parentId;
      const link = input.items.upsertLink(item, observedLink({
        id: change.item.externalId && change.item.kind
          ? linkId(change.item.connectionId ?? match.connectionId, change.item.kind, change.item.externalId)
          : match.id,
        kind: change.item.kind,
        title: change.item.title || match.title,
        externalId: change.item.externalId ?? match.externalId,
        url: change.item.url ?? match.url,
        connectorId: change.item.connectorId ?? match.connectorId,
        connectionId: change.item.connectionId ?? match.connectionId,
        parentId,
        details: change.item.details ?? match.details,
        state: change.item.state ?? match.state,
        role: change.item.kind === match.kind ? match.role : "output",
        provenance: "synced",
        syncedAt: change.at,
        at: change.at,
      }));
      attached += 1;
      input.onLink?.(item, link);
      const event = input.events?.append({
        id: randomUUID(),
        workItemId: item.id,
        revision: item.revision,
        at: change.at,
        actor: { type: "system" },
        kind: change.type === "item.state_changed" ? "state_change" : "output",
        summary: `${change.type} ${change.item.title}`.slice(0, 240),
        linkId: link.id,
        state: "complete",
        provenance: "synced",
      });
      if (event) input.onEvent?.(item, event);
      if (input.bumpInput && isWatchInputChange(change)) {
        try {
          const result = input.items.ensure({
            groupId: item.groupId,
            identity: item.identity,
            scope: item.scope,
            title: item.title,
            objective: item.objective,
            acceptanceCriteria: item.acceptanceCriteria,
            threadId: item.threadId,
            coordinatorBotId: item.coordinatorBotId,
            input: summarizeChanges([change]),
          });
          if (result.started && !woken.includes(item.id)) {
            woken.push(item.id);
            input.onWake?.(item);
          }
        } catch {
          /* still working; the event already recorded the change */
        }
      }
    }
  }
  return { attached, woken };
}

export function criteriaFromItem(item: SourceChange["item"]): string[] {
  const fromDetails = typeof item.details?.criteria === "string"
    ? item.details.criteria.split("\n")
    : Array.isArray(item.details?.criteria) ? (item.details?.criteria as unknown[]).map(String) : [];
  const description = typeof item.details?.description === "string" ? item.details.description : "";
  const bullets = [...fromDetails, ...description.split("\n")]
    .map(line => line.replace(/^[-*]\s*/, "").trim())
    .filter(line => line.length > 2)
    .slice(0, 20);
  if (bullets.length) return bullets;
  return [`${item.title} is complete`];
}

export function objectiveFromItem(item: SourceChange["item"]): string {
  const description = typeof item.details?.description === "string" ? item.details.description.trim() : "";
  return (description || item.title).slice(0, 4000);
}

export interface EnsureTaskCoordinator {
  id: string;
  name: string;
  color: string;
  section?: string;
}

export async function ensureTasksFromChanges(input: {
  watch: Watch;
  changes: SourceChange[];
  action: Extract<WatchAction, { type: "ensure_task" }>;
  items: WorkItems;
  scopeOf: (bot: EnsureTaskCoordinator) => string;
  resolveCoordinator: (watch: Watch, action: Extract<WatchAction, { type: "ensure_task" }>) => EnsureTaskCoordinator | null;
  resolveTopic: (scope: string, name: string, bot: EnsureTaskCoordinator) => { groupId: string; threadId: string };
  sourceLink?: (scope: string, identity: string) => LinkedItem | null | Promise<LinkedItem | null>;
  publish?: (item: WorkRecord) => void;
  onCreated?: (item: WorkRecord) => void;
}): Promise<{ created: string[]; reused: string[]; started: boolean }> {
  const bot = input.resolveCoordinator(input.watch, input.action);
  if (!bot) throw new Error("The assigned coordinator is unavailable");
  const scope = input.scopeOf(bot);
  const topic = input.action.topic?.trim() || "Shared work";
  const created: string[] = [];
  const reused: string[] = [];
  const seen = new Set<string>();
  for (const change of input.changes) {
    if (change.item.kind !== "work_item") continue;
    const identity = sourceIdentity(change.item);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    const existing = input.items.find(scope, identity);
    const topicRef = existing
      ? { groupId: existing.groupId, threadId: existing.threadId }
      : input.resolveTopic(scope, topic, bot);
    const result = input.items.ensure({
      scope: existing?.scope ?? scope,
      identity: existing?.identity ?? identity,
      groupId: topicRef.groupId,
      threadId: topicRef.threadId,
      coordinatorBotId: existing?.coordinatorBotId ?? bot.id,
      title: (change.item.title || identity).slice(0, 80),
      objective: objectiveFromItem(change.item),
      acceptanceCriteria: criteriaFromItem(change.item),
    });
    if (result.created) {
      const sourceLink = await input.sourceLink?.(result.item.scope, result.item.identity);
      const fallback = observedLink({
        id: linkId(change.item.connectionId, change.item.kind, change.item.externalId ?? identity),
        kind: change.item.kind,
        title: change.item.title,
        externalId: change.item.externalId,
        url: change.item.url,
        connectorId: change.item.connectorId,
        connectionId: change.item.connectionId,
        details: change.item.details,
        state: change.item.state,
        role: "source",
        provenance: change.item.state || change.item.url ? "synced" : "claimed",
        syncedAt: change.at,
        at: change.at,
      });
      const link = sourceLink ?? fallback;
      if (!result.item.links?.some(entry => entry.id === link.id)) input.items.upsertLink(result.item, link);
      input.onCreated?.(result.item);
      created.push(result.item.id);
    } else {
      reused.push(result.item.id);
    }
    input.publish?.(result.item);
  }
  return { created, reused, started: false };
}
