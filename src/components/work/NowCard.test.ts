import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import type { WorkItem } from "../../../shared/work-item";
import { NowCard } from "./NowCard";

const item: WorkItem = {
  id: "work", groupId: "topic", threadId: "hub", title: "Refunds", objective: "Fix refunds",
  acceptanceCriteria: ["Tests pass"], coordinatorBotId: "chief", revision: 1, status: "active",
  detail: "Waiting for review", decisions: [], artifacts: [], evidence: [],
  assignments: [{ id: "a1", botId: "eng", threadId: "t", revision: 1, attempts: 1, message: "Implement", status: "running", result: "",
    currentStep: { summary: "git commit -am fix", since: 10 } }],
  createdAt: 1, updatedAt: 2,
};

describe("NowCard", () => {
  it("shows the live assignment step", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(NowCard, { item })));
    expect(html).toContain("Now");
    expect(html).toContain("git commit -am fix");
  });

  it("falls back to idle copy when nothing is in flight", () => {
    const html = renderToStaticMarkup(createElement(StoreProvider, null, createElement(NowCard, {
      item: { ...item, assignments: [], status: "active" },
    })));
    expect(html).toContain("No specialist is working on this revision.");
  });
});
