import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LINK_KINDS, type LinkedItem } from "../../../shared/work-links";
import { LinkCard } from "./LinkCard";

const item = (kind: LinkedItem["kind"], patch: Partial<LinkedItem> = {}): LinkedItem => ({
  id: `${kind}-1`, kind, role: "output", title: `${kind} card`, externalId: kind, provenance: "observed", updatedAt: 1, ...patch,
});

describe("LinkCard", () => {
  it("renders each kind with role, details and a claimed marker", () => {
    for (const kind of LINK_KINDS) {
      const html = renderToStaticMarkup(createElement(LinkCard, {
        item: item(kind, { provenance: kind === "link" ? "claimed" : "observed", details: { revision: "abc123" }, connectorId: "fake" }),
        connectors: [{ id: "fake", name: "Fake", icon: "<svg></svg>" }],
      }));
      expect(html).toContain(`data-link-kind="${kind}"`);
      expect(html).toContain(`${kind} card`);
      expect(html).toContain("abc123");
      expect(html).toContain("data-provider=\"fake\"");
      if (kind === "link") expect(html).toContain("Claimed");
      else expect(html).not.toContain("Claimed");
    }
  });
});
