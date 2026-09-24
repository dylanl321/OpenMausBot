import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../shared/work-links";
import { publishWorkLive, subscribeWorkLive } from "./work-live";

describe("work live frames", () => {
  it("delivers events to subscribers and unsubscribes", () => {
    const seen: string[] = [];
    const stop = subscribeWorkLive(frame => {
      if (frame.kind === "work.event") seen.push(frame.event.id);
    });
    const event: TaskEvent = {
      id: "e1", workItemId: "work", revision: 1, at: 1, actor: { type: "system" }, kind: "lifecycle",
      summary: "opened", provenance: "observed",
    };
    publishWorkLive({ kind: "work.event", event, workItem: { groupId: "g", threadId: "t", coordinatorBotId: "chief" } });
    stop();
    publishWorkLive({ kind: "work.event", event: { ...event, id: "e2" }, workItem: { groupId: "g", threadId: "t", coordinatorBotId: "chief" } });
    expect(seen).toEqual(["e1"]);
  });
});
