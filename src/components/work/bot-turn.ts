import type { Message } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem } from "../../../shared/work-links";
import { displayLinks } from "./model";

export interface GroupedToolStep {
  name: string;
  count: number;
  failed: number;
  running: boolean;
  sample?: string;
}

export interface WorkerTurn {
  id: string;
  turnId?: string;
  startedAt: number;
  endedAt: number;
  plan?: string;
  tools: GroupedToolStep[];
  outputs: LinkedItem[];
  replyId?: string;
  replyText?: string;
  live: boolean;
}

function isUserTurnStart(message: Message): boolean {
  return message.role === "user" && message.kind === "text" && !message.queued;
}

function toolMessages(slice: readonly Message[]): Message[] {
  return slice.filter(message =>
    message.kind === "activity" && message.tool && !message.comm && !message.threadRef && !message.tool.name.startsWith("error:"));
}

export function groupToolSteps(messages: readonly Message[]): GroupedToolStep[] {
  const byName = new Map<string, GroupedToolStep>();
  for (const message of messages) {
    const tool = message.tool;
    if (!tool) continue;
    const current = byName.get(tool.name) ?? { name: tool.name, count: 0, failed: 0, running: false };
    current.count += 1;
    if (tool.ok === false) current.failed += 1;
    if (tool.ok === undefined) current.running = true;
    current.sample ??= tool.summary ?? tool.input;
    byName.set(tool.name, current);
  }
  return [...byName.values()];
}

function sliceTurns(messages: readonly Message[]): Message[][] {
  const slices: Message[][] = [];
  let current: Message[] = [];
  for (const message of messages) {
    if (isUserTurnStart(message) && current.length) {
      slices.push(current);
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length) slices.push(current);
  return slices;
}

export function workerTurns(messages: readonly Message[], item: WorkItem, threadId: string): WorkerTurn[] {
  return sliceTurns(messages).flatMap((slice, index) => {
    const start = slice.find(isUserTurnStart)?.at ?? slice[0]!.at;
    const end = slice.at(-1)!.at;
    const botTexts = slice.filter(message => message.role === "bot" && message.kind === "text" && message.text);
    const steps = toolMessages(slice);
    const running = steps.some(message => message.tool?.ok === undefined);
    const reply = botTexts.find(message => message.turnTerminal) ?? (running ? undefined : botTexts.at(-1));
    const plan = botTexts.filter(message => message !== reply).map(message => message.text!).join("\n\n").trim() || undefined;
    const digest = [...slice].reverse().find(message => message.kind === "digest")?.digest;
    const fromDigest = digest?.tools.map(tool => ({
      name: tool.name, count: tool.count, failed: tool.failed, running: false, sample: tool.sample,
    })) ?? [];
    const tools = fromDigest.length ? fromDigest : groupToolSteps(steps);
    const inflight = groupToolSteps(steps.filter(message => message.tool?.ok === undefined));
    for (const step of inflight) {
      if (!tools.some(tool => tool.name === step.name && tool.running)) tools.push(step);
    }
    const outputs = displayLinks(item).filter(link =>
      link.role === "output" && link.createdBy?.threadId === threadId && link.updatedAt >= start && link.updatedAt <= end);
    const live = !reply;
    if (!plan && !tools.length && !outputs.length && !reply) return [];
    return [{
      id: reply?.turnId ?? reply?.id ?? slice.find(isUserTurnStart)?.id ?? `turn-${index}`,
      turnId: reply?.turnId,
      startedAt: start,
      endedAt: end,
      plan,
      tools,
      outputs,
      replyId: reply?.id,
      replyText: reply?.text,
      live,
    }];
  });
}
