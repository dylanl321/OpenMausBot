import { describe, expect, it } from "vitest";
import {
  beforeFromSnapshot,
  connectionActor,
  cursorMovesForward,
  encodeChangeCursor,
  parseChangeCursor,
  snapshotFromItem,
} from "./change-cursor.ts";

describe("change cursors", () => {
  it("reads a plain ISO cursor and a snapshot bag, and never moves backward", () => {
    const iso = parseChangeCursor("2026-09-23T14:22:00.000Z");
    expect(iso.since).toBe(Date.parse("2026-09-23T14:22:00.000Z"));
    expect(iso.seen.size).toBe(0);
    const packed = encodeChangeCursor("2026-09-23T14:22:00.000Z", new Map([
      ["PAY-123", { state: "todo", assignee: "Ada", labels: ["bot-ready"] }],
      ["PAY-1", { state: "done" }],
    ]), ["PAY-123"]);
    const parsed = parseChangeCursor(packed);
    expect(parsed.iso).toBe("2026-09-23T14:22:00.000Z");
    expect(parsed.seen.get("PAY-123")).toEqual({ state: "todo", assignee: "Ada", labels: ["bot-ready"] });
    expect(parsed.seen.has("PAY-1")).toBe(false);
    expect(cursorMovesForward(iso.iso, packed)).toBe(true);
    expect(cursorMovesForward(packed, "2026-09-23T14:21:00.000Z")).toBe(false);
    expect(encodeChangeCursor("2026-09-23T14:22:00.000Z", new Map())).toBe("2026-09-23T14:22:00.000Z");
  });

  it("builds before from a snapshot and marks the connection account as a bot write", () => {
    const item = {
      kind: "work_item" as const,
      title: "Refunds",
      externalId: "PAY-123",
      state: { label: "In Progress", category: "in_progress" as const },
      details: { assignee: "Ada", labels: "bot-ready,payments" },
      updatedAt: 1,
    };
    expect(snapshotFromItem(item)).toEqual({
      state: "in_progress",
      stateLabel: "In Progress",
      assignee: "Ada",
      labels: ["bot-ready", "payments"],
    });
    expect(beforeFromSnapshot({ state: "todo", stateLabel: "To Do" })).toEqual({
      state: "todo",
      stateLabel: "To Do",
    });
    expect(connectionActor({
      name: "Payments bot",
      accountId: "qm:bot",
      account: { accountId: "qm:bot", email: "bot@example.test", displayName: "Payments bot" },
    }).isBot).toBe(true);
    expect(connectionActor({
      name: "Ada",
      accountId: "qm:ada",
      account: { accountId: "qm:bot", displayName: "Payments bot" },
    }).isBot).toBe(false);
    expect(connectionActor({ name: "gitlab-bot", bot: true }).isBot).toBe(true);
  });
});
