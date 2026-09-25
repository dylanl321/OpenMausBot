import { describe, expect, it } from "vitest";
import { setupGuideError } from "./SetupWizardDialog";

describe("Setup Guide errors", () => {
  it("names a missing admin scope instead of a raw forbidden status", () => {
    expect(setupGuideError(new Error("forbidden: lacks the admin scope"))).toBe("Setup Guide needs a workspace admin.");
    expect(setupGuideError(new Error("403"))).toBe("Setup Guide needs a workspace admin.");
    expect(setupGuideError(new Error("Guide engine timed out"))).toBe("Guide engine timed out");
  });
});
