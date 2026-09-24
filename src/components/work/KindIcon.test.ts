import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LINK_KINDS } from "../../../shared/work-links";
import { KindIcon } from "./KindIcon";

describe("KindIcon", () => {
  it("renders a distinct kind mark for every link kind", () => {
    const html = LINK_KINDS.map(kind => renderToStaticMarkup(createElement(KindIcon, { kind }))).join("");
    for (const kind of LINK_KINDS) {
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain(`aria-label="`);
    }
    expect(html).toContain("Work item");
    expect(html).toContain("Change request");
    expect(html).toContain("Commit");
    expect(html).toContain("Build");
    expect(html).toContain("Comment");
    expect(html).toContain("Document");
    expect(html).toContain("Link");
  });
});
