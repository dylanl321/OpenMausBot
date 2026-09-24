import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BotTurnCard } from "./BotTurnCard";
import type { WorkerTurn } from "./bot-turn";

const turn: WorkerTurn = {
  id: "t1", turnId: "t1", startedAt: 1, endedAt: 4, live: false,
  plan: "Check boundaries, then commit.",
  tools: [{ name: "Bash", count: 2, failed: 0, running: false, sample: "git commit" }],
  outputs: [{
    id: "commit-1", kind: "commit", role: "output", title: "commit 3f2a1c9", provenance: "observed", updatedAt: 3,
  }],
  replyId: "reply", replyText: "Refunds checked.",
};

describe("BotTurnCard", () => {
  it("renders plan, grouped tools, outputs, and links to the raw reply and tool log", () => {
    const onRawReply = vi.fn();
    const onToolLog = vi.fn();
    const html = renderToStaticMarkup(createElement(BotTurnCard, { turn, onRawReply, onToolLog }));
    expect(html).toContain('data-bot-turn="t1"');
    expect(html).toContain('aria-label="This turn"');
    expect(html).toContain("Check boundaries, then commit.");
    expect(html).toContain("Bash");
    expect(html).toContain("×2");
    expect(html).toContain("git commit");
    expect(html).toContain("commit 3f2a1c9");
    expect(html).toContain('data-link-kind="commit"');
    expect(html).toContain("Raw reply");
    expect(html).toContain("Tool log");
  });

  it("omits the plan and raw-reply link when the engine did not provide them", () => {
    const html = renderToStaticMarkup(createElement(BotTurnCard, {
      turn: { ...turn, plan: undefined, replyId: undefined, live: true, tools: [{ name: "Bash", count: 1, failed: 0, running: true }] },
      onToolLog: vi.fn(),
    }));
    expect(html).toContain('data-bot-turn-live="true"');
    expect(html).not.toContain("Check boundaries");
    expect(html).not.toContain("Raw reply");
    expect(html).toContain("Running");
    expect(html).toContain("Tool log");
  });
});
