import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { canSubmitScopeChoice, sourceRowDetail } from "../../shared/team-backlog";
import type { BacklogScope } from "../../shared/team-backlog";
import type { WorkOverviewCard } from "../../shared/work-overview";
import { WORK_FALLBACK_POLL_MS, WorkCard, WorkScopeForm, workEntryChip, workGateText, workScanText } from "./WorkPage";

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

describe("Work fallback poll", () => {
  it("keeps a 30s fallback and shares the serial helper interval", () => {
    expect(WORK_FALLBACK_POLL_MS).toBe(30_000);
  });

  it("names source rows by inventory kind", () => {
    expect(sourceRowDetail({ kind: "work_item", label: "Blocked" })).toBe("Work item: Blocked");
    expect(sourceRowDetail({ kind: "change_request", label: "Review" })).toBe("Change request: Review");
    expect(sourceRowDetail({ kind: "work_item", label: "Blocked", requirements: "Needs PAY-2" })).toBe("Needs PAY-2");
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
    expect(html).toContain("Choose what this team should track");
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

describe("Work overview labels", () => {
  it("uses kind-driven chips instead of raw kind and status tokens", () => {
    expect(workEntryChip({ kind: "task", status: "needs-input" })).toBe("Task · Needs input");
    expect(workEntryChip({ kind: "goal", status: "paused" })).toBe("Goal · Paused");
    expect(workEntryChip({ kind: "source", status: "In review" })).toBe("Source · In review");
  });

  it("drops raw gate kinds and inventory jargon from scan lines", () => {
    expect(workGateText({ detail: "PAY-1 awaits PAY-2", decisionMaker: "Requester" }))
      .toBe("PAY-1 awaits PAY-2 · Requester");
    expect(workScanText({ status: "complete", itemCount: 4, errors: [], completedAt: 1_700_000_000_000 }))
      .toContain("Scan: complete · 4 items");
    expect(workScanText({ status: "not-scanned", itemCount: 1, errors: [] }))
      .toBe("Scan: not scanned · 1 item · no complete scan yet");
  });
});
