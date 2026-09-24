import { randomUUID } from "node:crypto";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { TaskEvent } from "../../shared/work-links.ts";
import type { WorkItems, WorkRecord } from "../work-items.ts";
import { gitCaptureRules } from "./builtin/git.ts";
import { urlCaptureRule, urlLinkId } from "./builtin/url.ts";
import { CONNECTORS } from "./registry.ts";
import { linkId, observedLink, type CaptureCall, type CaptureRule } from "./types.ts";
import type { WorkEvents } from "../work-events.ts";

const SUMMARY_LIMIT = 240;

export interface CaptureHooks {
  items: WorkItems;
  events: WorkEvents;
  publish: (kind: "work.event" | "work.link", item: WorkRecord, payload: Record<string, unknown>) => void;
}

function atOf(createdAt: string): number {
  const numeric = Number(createdAt);
  if (Number.isFinite(numeric) && createdAt.trim() !== "") return numeric;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function line(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, SUMMARY_LIMIT);
}

function toolCall(event: RuntimeEvent & { type: "item.completed" }, started?: { title?: string; summary?: string; input?: string }): CaptureCall {
  return {
    title: started?.title ?? "tool",
    summary: started?.summary,
    input: started?.input,
    output: "output" in event ? event.output : undefined,
    ok: "ok" in event ? event.ok : undefined,
  };
}

function sameParentRef(existing: string | undefined, parentRef: string): boolean {
  if (!existing) return false;
  const left = existing.toLowerCase();
  const right = parentRef.toLowerCase();
  if (left === right) return true;
  if (right.startsWith("!") && left.endsWith(right)) return true;
  if (left.startsWith("!") && right.endsWith(left)) return true;
  return false;
}

function matches(rule: CaptureRule, call: CaptureCall): boolean {
  if (rule.requireOk !== false && call.ok === false) return false;
  if (rule.match.tool && !rule.match.tool.test(call.title)) return false;
  if (rule.match.server && !rule.match.server.test(call.server ?? "")) return false;
  if (rule.match.command && !rule.match.command.test(call.summary ?? "")) return false;
  return Boolean(rule.match.tool || rule.match.server || rule.match.command);
}

export class WorkCapture {
  private readonly open = new Map<string, { title?: string; summary?: string; input?: string }>();
  private readonly hooks: CaptureHooks;

  constructor(hooks: CaptureHooks) {
    this.hooks = hooks;
  }

  handle(event: RuntimeEvent) {
    if (event.type !== "item.started" && event.type !== "item.completed") return;
    if ("itemType" in event && event.itemType !== "tool") return;
    const item = this.hooks.items.forThread(event.threadId);
    if (!item) return;
    const assignment = item.assignments.find(candidate => candidate.threadId === event.threadId && candidate.revision === item.revision);
    const actor = { type: "bot" as const, botId: assignment?.botId ?? item.coordinatorBotId, threadId: event.threadId };
    if (event.type === "item.started") {
      const summary = line(event.summary || event.title || "Working");
      if (summary) this.hooks.items.setCurrentStep(item, event.threadId, { summary, since: atOf(event.createdAt), ...(event.itemId ? { itemId: event.itemId } : {}) });
      if (event.itemId) this.open.set(event.itemId, { title: event.title, summary: event.summary, input: event.input });
      const running = this.hooks.events.append({
        id: randomUUID(), workItemId: item.id, revision: item.revision, at: atOf(event.createdAt), actor,
        kind: "tool", summary: summary || "Working", state: "running", provenance: "observed",
        ...(event.itemId ? { itemId: event.itemId } : {}),
      });
      this.hooks.publish("work.event", item, { event: running });
      return;
    }
    const started = event.itemId ? this.open.get(event.itemId) : undefined;
    if (event.itemId) this.open.delete(event.itemId);
    this.hooks.items.setCurrentStep(item, event.threadId, null);
    const call = toolCall(event, started);
    const summary = line(call.summary || call.title || (call.ok === false ? "Tool failed" : "Tool finished"));
    const finished = this.hooks.events.completeTool(item.id, event.itemId, {
      id: randomUUID(), workItemId: item.id, revision: item.revision, at: atOf(event.createdAt), actor,
      kind: "tool", summary, state: call.ok === false ? "failed" : "complete", provenance: "observed",
      ...(event.itemId ? { itemId: event.itemId } : {}),
    });
    this.hooks.publish("work.event", item, { event: finished });
    if (call.ok === false) return;
    const rules = [...CONNECTORS.flatMap(connector => connector.capture.map(rule => ({ rule, connectorId: connector.manifest.id }))), ...gitCaptureRules.map(rule => ({ rule, connectorId: undefined }))];
    let claimed = false;
    for (const { rule, connectorId } of rules) {
      if (!matches(rule, call)) continue;
      const extracted = rule.extract(call);
      if (!extracted) continue;
      claimed = true;
      this.record(item, actor, atOf(event.createdAt), rule, extracted, connectorId);
    }
    if (!claimed) {
      const extracted = urlCaptureRule.extract(call);
      if (extracted?.url) this.record(item, actor, atOf(event.createdAt), urlCaptureRule, extracted);
    }
  }

  private record(item: WorkRecord, actor: TaskEvent["actor"], at: number, rule: CaptureRule, extracted: NonNullable<ReturnType<CaptureRule["extract"]>>, connectorId?: string) {
    const parentRef = extracted.parentRef;
    const parent = parentRef
      ? item.links?.find(link => (link.kind === "work_item" || link.kind === "change_request") && sameParentRef(link.externalId, parentRef))
      : undefined;
    const id = rule.produce.kind === "link" && extracted.url ? urlLinkId(extracted.url) : linkId(undefined, rule.produce.kind, extracted.externalId);
    const link = this.hooks.items.upsertLink(item, observedLink({
      id, kind: rule.produce.kind, title: extracted.title ?? extracted.externalId, externalId: extracted.externalId,
      url: extracted.url, details: extracted.details, connectorId, at,
      ...(parent ? { parentId: parent.id } : {}),
    }));
    const kind = rule.eventKind ?? (rule.produce.kind === "comment" ? "comment" : "output");
    const output = this.hooks.events.append({
      id: randomUUID(), workItemId: item.id, revision: item.revision, at, actor,
      kind, summary: line(rule.event(link)) || link.title, linkId: link.id, state: "complete", provenance: "observed",
    });
    this.hooks.publish("work.link", item, { link });
    this.hooks.publish("work.event", item, { event: output });
  }
}
