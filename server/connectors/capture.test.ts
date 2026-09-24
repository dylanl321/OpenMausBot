import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { WorkItems } from "../work-items.ts";
import { WorkEvents } from "../work-events.ts";
import { WorkCapture } from "./capture.ts";

const input = { scope: "Engineering", identity: "refunds", groupId: "payments", threadId: "hub",
  coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds", acceptanceCriteria: ["Refund test passes"] };

function tool(partial: Partial<RuntimeEvent> & { type: "item.started" | "item.completed"; threadId: string }): RuntimeEvent {
  return { eventId: "e", provider: "claude", createdAt: 10, ...partial } as RuntimeEvent;
}

describe("work capture", () => {
  it("turns a git commit preview into a commit link and a task event", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-capture-"));
    try {
      const items = new WorkItems(join(directory, "work-items.json"));
      const events = new WorkEvents(join(directory, "work-events"));
      const { item } = items.ensure(input);
      items.claim(item, { botId: "engineer", threadId: "worker", message: "Commit the fix" });
      const capture = new WorkCapture({ items, events, publish() {} });
      capture.handle(tool({ type: "item.started", threadId: "worker", itemType: "tool", itemId: "bash-1", title: "Bash", summary: "git commit -m refund", createdAt: "20" }));
      expect(item.assignments[0].currentStep?.summary).toBe("git commit -m refund");
      capture.handle(tool({ type: "item.completed", threadId: "worker", itemType: "tool", itemId: "bash-1", ok: true, output: "[main 3f2a1c9] refund\n 1 file changed\n", createdAt: "30" }));
      expect(item.links?.some(link => link.kind === "commit" && link.externalId === "3f2a1c9" && link.provenance === "observed")).toBe(true);
      const recorded = events.read(item.id);
      expect(recorded.some(event => event.kind === "tool" && event.state === "complete")).toBe(true);
      expect(recorded.some(event => event.kind === "output" && event.linkId)).toBe(true);
      expect(item.assignments[0].currentStep).toBeUndefined();
    } finally { await removeTempDir(directory); }
  });

  it("closes a running tool event when the process restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "omb-events-"));
    try {
      const events = new WorkEvents(join(directory, "work-events"));
      events.append({
        id: "running-1", workItemId: "task-1", revision: 1, at: 1,
        actor: { type: "bot", botId: "engineer", threadId: "worker" },
        kind: "tool", summary: "git commit -m refund", state: "running", provenance: "observed", itemId: "bash-1",
      });
      const reloaded = new WorkEvents(join(directory, "work-events"));
      expect(reloaded.read("task-1")[0]).toMatchObject({ state: "failed" });
    } finally { await removeTempDir(directory); }
  });
});
