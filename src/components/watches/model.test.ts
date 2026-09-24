import { describe, expect, it } from "vitest";
import type { Routine } from "@/lib/routines";
import type { Watch } from "@/lib/watches";
import {
  buildFilter,
  draftFromRoutine,
  flattenFilter,
  pollingRoutineHint,
  suggestedWatchEvents,
  watchSourceSummary,
} from "./model";

const routine = (prompt: string, patch: Partial<Routine> = {}): Routine => ({
  id: "r1",
  name: "Inbox",
  prompt,
  target: "bot",
  botId: "scout",
  runOn: "maus",
  enabled: true,
  schedule: { type: "interval", everyMinutes: 15, anchorAt: 1 },
  durationMinutes: 30,
  nextRunAt: 2,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

describe("watch model", () => {
  it("suggests converting polling-check routines and skips ones that already gate on a watch", () => {
    expect(pollingRoutineHint(routine("Check Jira every 15 minutes for new bot-ready stories"))).toBe(true);
    expect(pollingRoutineHint(routine("Look for failed pipelines"))).toBe(true);
    expect(pollingRoutineHint(routine("Write the morning brief"))).toBe(false);
    expect(pollingRoutineHint(routine("Check Jira every 15 minutes", { onlyIfChanged: "w1" }))).toBe(false);
    expect(pollingRoutineHint(routine("Check Jira every 15 minutes", { schedule: { type: "once", at: 10 } }))).toBe(false);
  });

  it("guesses events from a polling prompt and seeds a run_routine draft", () => {
    expect(suggestedWatchEvents("Watch for failed builds")).toEqual(["build.failed", "build.succeeded"]);
    const draft = draftFromRoutine(routine("Check Jira for new stories"));
    expect(draft.action).toEqual({ type: "run_routine", routineId: "r1" });
    expect(draft.fromRoutineId).toBe("r1");
    expect(draft.events).toContain("item.created");
  });

  it("names a webhook watch from the trigger, not the id", () => {
    const watch = {
      id: "w1",
      name: "Inbound",
      source: { type: "webhook", webhookId: "wh-1" },
    } as Watch;
    expect(watchSourceSummary(watch, [], [], [{ id: "wh-1", name: "Payments events" }]).detail).toBe("Payments events");
    expect(watchSourceSummary(watch, [], []).detail).toBe("wh-1");
  });

  it("round-trips a flat all/any filter including not and changed-to", () => {
    const built = buildFilter("all", [
      { id: "a", field: "state.category", op: "eq", value: "todo", changedFrom: "", changedTo: "" },
      { id: "b", field: "actor.isBot", op: "eq", value: "false", changedFrom: "", changedTo: "", not: true },
      { id: "c", field: "state.category", op: "changed", value: "", changedFrom: "", changedTo: "in_progress" },
    ]);
    expect(built).toEqual({
      all: [
        { field: "state.category", eq: "todo" },
        { not: { field: "actor.isBot", eq: false } },
        { field: "state.category", changedTo: "in_progress" },
      ],
    });
    const flat = flattenFilter(built);
    expect(flat).not.toBe("complex");
    if (flat && flat !== "complex") {
      expect(flat.mode).toBe("all");
      expect(flat.rows).toHaveLength(3);
      expect(flat.rows[1]?.not).toBe(true);
    }
  });
});
