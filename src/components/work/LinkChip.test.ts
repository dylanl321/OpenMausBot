import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LINK_KINDS, type LinkedItem } from "../../../shared/work-links";
import { LinkChip } from "./LinkChip";

const item = (kind: LinkedItem["kind"], patch: Partial<LinkedItem> = {}): LinkedItem => ({
  id: `${kind}-1`, kind, role: "output", title: `${kind} title`, provenance: "observed", updatedAt: 1, ...patch,
});

describe("LinkChip", () => {
  it("switches on kind and only names a provider from the manifest", () => {
    const connectors = [{ id: "fake", name: "Fake" }];
    for (const kind of LINK_KINDS) {
      const html = renderToStaticMarkup(createElement(LinkChip, { item: item(kind, { connectorId: "fake" }), connectors }));
      expect(html).toContain(`data-link-kind="${kind}"`);
      expect(html).toContain(`${kind} title`);
      expect(html).toContain("data-provider=\"fake\"");
      expect(html).toContain("Fake");
      expect(html).not.toContain("Jira");
      expect(html).not.toContain("GitLab");
    }
  });

  it("marks claimed items and shows the provider status label", () => {
    const html = renderToStaticMarkup(createElement(LinkChip, {
      item: item("work_item", { provenance: "claimed", state: { label: "In Progress", category: "in_progress" }, url: "https://fake.example/work_item/PAY-1" }),
    }));
    expect(html).toContain("data-claimed=\"true\"");
    expect(html).toContain("Claimed");
    expect(html).toContain("In Progress");
    expect(html).toContain("https://fake.example/work_item/PAY-1");
  });

  it("shows artifact revisions on claimed fallback links", () => {
    const html = renderToStaticMarkup(createElement(LinkChip, {
      item: item("link", { title: "Patch", details: { revision: "abc123", assignee: "Ada Lovelace" }, provenance: "claimed" }),
    }));
    expect(html).toContain("abc123");
    expect(html).not.toContain("Ada Lovelace");
  });
});
