import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canSubmitScopeChoice } from "../../shared/team-backlog";
import type { BacklogScope } from "../../shared/team-backlog";
import type { WorkOverviewCard } from "../../shared/work-overview";
import { WorkCard, WorkScopeForm } from "./WorkPage";

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

describe("Work inventory scope form", () => {
  const gitlab: BacklogScope = {
    id: "repo", connectorId: "gitlab", connectionId: "gitlab-main", query: "acme/app",
    label: "App repo", kinds: ["work_item", "change_request"],
  };
  const jira: BacklogScope = {
    id: "board", connectorId: "jira", connectionId: "jira-main", query: "project = PAY",
    label: "PAY board", kinds: ["work_item"],
  };

  it("enables submit for a valid one-sided choice and labels scopes from manifests", () => {
    expect(canSubmitScopeChoice(["repo"], [gitlab, jira])).toBe(true);
    expect(canSubmitScopeChoice(["board"], [gitlab, jira])).toBe(true);
    expect(canSubmitScopeChoice([], [gitlab, jira])).toBe(false);
    const html = renderToStaticMarkup(createElement(WorkScopeForm, {
      choices: [gitlab], selected: ["repo"], connectors: [{ id: "gitlab", name: "GitLab" }],
      onChange() {}, onSubmit() {},
    }));
    expect(html).toContain("Choose the team’s inventory scopes");
    expect(html).toContain("App repo · GitLab");
    expect(html).not.toContain('disabled=""');
    const idle = renderToStaticMarkup(createElement(WorkScopeForm, {
      choices: [gitlab, jira], selected: [], connectors: [
        { id: "gitlab", name: "GitLab" }, { id: "jira", name: "Jira" },
      ],
      onChange() {}, onSubmit() {},
    }));
    expect(idle).toContain('disabled=""');
    expect(idle).toContain("PAY board · Jira");
  });
});
