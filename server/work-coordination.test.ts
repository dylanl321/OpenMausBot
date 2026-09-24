import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkCoordination } from "./work-coordination.ts";
import type { Store, TaskRecord } from "./store.ts";
import { removeTempDir } from "./testing/cleanup.ts";

it("rolls back unqueued claims, restores retried assignments, and removes only provisional threads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omb-work-rollback-"));
  try {
    const threads: Array<Pick<TaskRecord, "threadId" | "workItemId" | "closedBy">> = [];
    const closedBy = { botId: "chief", name: "Chief", at: 10 };
    let setupFailure = false;
    const store = {
      tasks: () => threads,
      bot: () => ({ id: "chief", name: "Chief", color: "blue" }),
      createTask: () => {
        const task = { threadId: "worker", workItemId: undefined as string | undefined, closedBy: undefined as TaskRecord["closedBy"] };
        threads.push(task);
        return task;
      },
      patchTask: (_botId: string, threadId: string, patch: { workItemId: string }) => Object.assign(threads.find(task => task.threadId === threadId)!, patch),
      appendMessage: () => { if (setupFailure) throw new Error("Thread setup failed"); },
      deleteTask: (_botId: string, threadId: string) => { threads.splice(threads.findIndex(task => task.threadId === threadId), 1); },
      setTaskClosedBy: (_botId: string, threadId: string, value: TaskRecord["closedBy"] | null) => {
        threads.find(task => task.threadId === threadId)!.closedBy = value ?? undefined;
      },
    } as unknown as Store;
    const file = join(directory, "work-items.json");
    const coordination = new WorkCoordination(file, store, {
      handoffs: () => { throw new Error("No handoffs in this fixture"); },
      validate: () => undefined,
      creationProblem: () => undefined,
      publish: () => undefined,
      isUnattended: () => false,
      markUnattended: () => undefined,
    });
    const { item } = coordination.items.ensure({ scope: "Delivery", identity: "rollback", groupId: "room", threadId: "hub", coordinatorBotId: "chief",
      title: "Rollback", objective: "Check dispatch accounting", acceptanceCriteria: ["No ghost claims"] });

    setupFailure = true;
    expect(() => coordination.assignment(item, "worker", "Attempt")).toThrow("Thread setup failed");
    expect(threads).toEqual([]);
    expect(item.assignments).toEqual([]);
    setupFailure = false;
    const rejected = coordination.assignment(item, "worker", "Attempt");
    coordination.rollbackAssignment(item, rejected.assignment, rejected.previous, rejected.createdThread, rejected.previousClosedBy);
    expect(item.assignments).toEqual([]);
    expect(threads).toEqual([]);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].assignments).toEqual([]);

    const dispatched = coordination.assignment(item, "worker", "Original");
    dispatched.assignment.requestId = "queued-request";
    dispatched.assignment.status = "failed";
    dispatched.assignment.result = "Worker failed";
    coordination.items.changed(item);
    threads[0]!.closedBy = closedBy;
    const original = structuredClone(dispatched.assignment);
    const retry = coordination.assignment(item, "worker", "Concrete correction", original.id, true);
    expect(threads[0]!.closedBy).toBeUndefined();
    coordination.rollbackAssignment(item, retry.assignment, retry.previous, retry.createdThread, retry.previousClosedBy);
    expect(item.assignments).toEqual([original]);
    expect(threads[0]!.closedBy).toEqual(closedBy);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].assignments).toEqual([original]);

    coordination.rollbackAssignment(item, original);
    expect(item.assignments).toEqual([original]);
  } finally { await removeTempDir(directory); }
});
