import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OngoingGoal } from "../../shared/ongoing-goal";
import { goalRequestError, loadThreadGoals, OngoingGoalPanel } from "./OngoingGoalPanel";

const owner = { canCreate: true, canControl: true, canResume: true };
const client = { canCreate: true, canControl: true, canResume: false };
const none = { canCreate: false, canControl: false, canResume: false };

const pausedGoal: OngoingGoal = {
  id: "11111111-1111-1111-1111-111111111111",
  revision: 2,
  ownerBotId: "lead",
  sourceThreadId: "fixture",
  executionThreadId: "fixture",
  kind: "deliverable",
  objective: "Finish the release",
  acceptanceCriteria: ["Shipped"],
  scope: "goal:test:",
  status: "paused",
  detail: "Goal budget exhausted; explicitly renew it to continue.",
  workItemIds: [],
  ownedWorkItemIds: [],
  evidence: [],
  actions: 3,
  maxActions: 48,
  activeMs: 0,
  maxActiveMinutes: 1440,
  spentUsd: 0,
  chargedTurnIds: [],
  createdAt: 1,
  updatedAt: 2,
  waitCount: 0,
  noProgress: 0,
};

function render(props: Partial<Parameters<typeof OngoingGoalPanel>[0]> = {}) {
  return renderToStaticMarkup(createElement(OngoingGoalPanel, {
    ownerBots: [], sourceThreadId: "fixture", open: true, onOpen: () => {}, onClose: () => {},
    initialObjective: "Finish the release", capabilities: owner, ...props,
  }));
}

describe("ongoing goal creation", () => {
  it("asks for the desired outcome without exposing criteria, IDs or budget inputs", () => {
    const html = render();
    expect(html).toContain("What do you want done?");
    expect(html).toContain("Finish the release");
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    expect(html).not.toContain("Authorized task identity prefix");
    expect(html).not.toContain("Acceptance criteria (one per line)");
    expect(html).not.toContain("Active minutes");
  });

  it("hides Start pursuing and resume when the session cannot call those routes", () => {
    expect(render({ capabilities: none })).not.toContain("Start pursuing");
    expect(render({ capabilities: none })).not.toContain("New goal");
    const withGoal = render({ capabilities: client, initialGoals: [pausedGoal], open: false });
    expect(withGoal).toContain("Finish the release");
    expect(withGoal).not.toContain("Resume with renewed limits");
    expect(withGoal).not.toContain("Start pursuing");
    expect(render({ capabilities: owner, initialGoals: [pausedGoal], open: false })).toContain("Resume with renewed limits");
  });

  it("surfaces a failed goals list instead of swallowing it", async () => {
    expect(goalRequestError(new Error("forbidden: lacks the admin scope"))).toContain("lacks the admin scope");
    await expect(loadThreadGoals("fixture", async () => {
      throw new Error("forbidden: lacks the admin scope");
    })).rejects.toThrow("lacks the admin scope");
  });
});
