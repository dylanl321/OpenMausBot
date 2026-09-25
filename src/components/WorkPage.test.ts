import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { WorkOverviewCard } from "../../shared/work-overview";
import { WorkCard } from "./WorkPage";

const pending: WorkOverviewCard = { entryId: "work", threadId: "thread", messageId: "message",
  canAct: true, decisionMaker: "Requester", card: { title: "Review command",
    subtitle: `Do the whole thing: ${"details ".repeat(500)}`, options: ["Allow", "Deny"], tool: "Bash", requestId: "request" } };

describe("Work inline decisions", () => {
  it("renders the full pending request and one-time approve/deny with no blanket grant", () => {
    const detailed = { ...pending, card: { ...pending.card, fullRequest: `Full parameters: ${"all steps ".repeat(600)}` } };
    const html = renderToStaticMarkup(createElement(WorkCard, { pending: detailed, onResolved: async () => {} }));
    expect(html).toContain(detailed.card.fullRequest);
    expect(html).toContain("Approve once");
    expect(html).toContain("Deny");
    expect(html).not.toContain("Always allow");
  });

  it("names the decision-maker for others and answers real questions inline", () => {
    const waiting = renderToStaticMarkup(createElement(WorkCard, { pending: { ...pending, canAct: false }, onResolved: async () => {} }));
    expect(waiting).toContain("Decision-maker: Requester");
    expect(waiting).not.toContain("Approve once");
    const question = renderToStaticMarkup(createElement(WorkCard, { pending: { ...pending, card: {
      title: "Choose scope", subtitle: "Which project?", options: [], requestId: "question",
      questionRequest: { version: 1, questions: [{ question: "Which project?", options: [{ label: "PAY" }, { label: "OPS" }] }] },
    } }, onResolved: async () => {} }));
    expect(question).toContain("Which project?");
    expect(question).toContain("Send answer");
    expect(question).not.toContain("Approve once");
  });
});
