import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OngoingGoalPanel } from "./OngoingGoalPanel";

describe("ongoing goal creation", () => {
  it("asks for the desired outcome without exposing criteria, IDs or budget inputs", () => {
    const html = renderToStaticMarkup(createElement(OngoingGoalPanel, {
      ownerBots: [], sourceThreadId: "fixture", open: true, onOpen: () => {}, onClose: () => {}, initialObjective: "Finish the release",
    }));
    expect(html).toContain("What do you want done?");
    expect(html).toContain("Finish the release");
    expect(html.match(/<textarea\b/g)).toHaveLength(1);
    expect(html).not.toContain("Authorized task identity prefix");
    expect(html).not.toContain("Acceptance criteria (one per line)");
    expect(html).not.toContain("Active minutes");
  });
});
