import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskEventSchema, type TaskEvent } from "../shared/work-links.ts";

const MAX_PER_REVISION = 2_000;

export class WorkEvents {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of this.safeNames()) this.recover(name);
  }

  private safeNames(): string[] {
    try {
      return readdirSync(this.directory).filter(name => name.endsWith(".jsonl") && !name.includes("/") && !name.includes(".."));
    } catch {
      return [];
    }
  }

  private path(workItemId: string): string {
    if (!/^[\w-]+$/.test(workItemId)) throw new Error("Invalid work item id");
    return join(this.directory, `${workItemId}.jsonl`);
  }

  read(workItemId: string): TaskEvent[] {
    try {
      return readFileSync(this.path(workItemId), "utf8").split("\n").filter(Boolean).flatMap(line => {
        const parsed = taskEventSchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  recent(workItemId: string, limit = 30): TaskEvent[] {
    return this.read(workItemId).slice(-limit);
  }

  append(event: TaskEvent): TaskEvent {
    const parsed = taskEventSchema.parse(event);
    const events = this.read(parsed.workItemId);
    events.push(parsed);
    this.write(parsed.workItemId, compact(events));
    return parsed;
  }

  /** Close the running tool row for this runtime item, or append a finished row. */
  completeTool(workItemId: string, itemId: string | undefined, finished: TaskEvent): TaskEvent {
    const events = this.read(workItemId);
    const open = itemId ? [...events].reverse().find(event => event.kind === "tool" && event.state === "running" && event.itemId === itemId) : undefined;
    if (open) {
      open.state = finished.state;
      open.summary = finished.summary;
      open.at = finished.at;
      this.write(workItemId, compact(events));
      return open;
    }
    return this.append(finished);
  }

  private recover(name: string) {
    const workItemId = name.slice(0, -".jsonl".length);
    const events = this.read(workItemId);
    let changed = false;
    for (const event of events) {
      if (event.kind === "tool" && event.state === "running") {
        event.state = "failed";
        event.summary = "Interrupted by server restart; not replayed.".slice(0, 240);
        changed = true;
      }
    }
    if (changed) this.write(workItemId, events);
  }

  importEvents(workItemId: string, events: TaskEvent[]) {
    const parsed = events.map(event => taskEventSchema.parse({ ...event, workItemId }));
    this.write(workItemId, compact(parsed));
  }

  private write(workItemId: string, events: TaskEvent[]) {
    const body = events.map(event => JSON.stringify(event)).join("\n");
    writeFileSync(this.path(workItemId), body ? `${body}\n` : "", { mode: 0o600 });
  }

  /** Non-tool events, for a portable team backup. */
  exportPortable(workItemIds: string[]): { workItemId: string; events: TaskEvent[] }[] {
    return workItemIds.flatMap(workItemId => {
      const events = this.read(workItemId).filter(event => event.kind !== "tool");
      return events.length ? [{ workItemId, events }] : [];
    });
  }
}

function compact(events: TaskEvent[]): TaskEvent[] {
  const byRevision = new Map<number, TaskEvent[]>();
  for (const event of events) {
    const list = byRevision.get(event.revision) ?? [];
    list.push(event);
    byRevision.set(event.revision, list);
  }
  const kept: TaskEvent[] = [];
  for (const list of byRevision.values()) {
    if (list.length <= MAX_PER_REVISION) {
      kept.push(...list);
      continue;
    }
    const overflow = list.length - MAX_PER_REVISION;
    let dropped = 0;
    const next = list.filter(event => {
      if (dropped < overflow && event.kind === "tool") {
        dropped += 1;
        return false;
      }
      return true;
    });
    kept.push(...(next.length > MAX_PER_REVISION ? next.slice(next.length - MAX_PER_REVISION) : next));
  }
  return kept;
}
