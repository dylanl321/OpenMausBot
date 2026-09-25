import { describe, expect, it } from "vitest";

import { wizardAssistInputSchema, wizardCommitInputSchema, type WizardDraft } from "../shared/setup-wizard.ts";
import { draftFromWizardAi, parseWizardAiOutput, setupWizardPrompt, validateWizardDraft } from "./setup-wizard.ts";

const models = [
  { instanceId: "claude", model: "claude-sonnet", label: "Sonnet", coordination: true, effortLevels: ["low", "high"] },
  { instanceId: "plain", model: "plain-1", label: "Plain", coordination: false, effortLevels: [] },
];
const bot = (key: string, name: string, modelSelection = { instanceId: "claude", model: "claude-sonnet" }) => ({
  key, name, title: "Researcher", description: "Checks sources", soul: "Verify the important claims and cite sources.",
  modelSelection, appHints: ["calendar"],
});
const ai = { kind: "draft" as const, teamName: "Research desk", teamBrief: "Answer questions with evidence.",
  bots: [bot("lead", "Lead"), bot("check", "Check", { instanceId: "plain", model: "plain-1" })], chiefKey: null };
const input = wizardAssistInputSchema.parse({ instanceId: "claude", goal: "Build a research team",
  destination: { kind: "new", name: "" }, answers: [] });
const state = { teams: ["", "Operations"], bots: [] as Array<{ name: string; section?: string; chiefOfStaff?: boolean }>,
  maxBots: 100, models };

describe("reviewed Setup Guide boundary", () => {
  it("accepts only structured questions or a strictly scoped proposal", () => {
    expect(parseWizardAiOutput('```json\n{"kind":"questions","questions":["What outcome matters most?"]}\n```'))
      .toEqual({ kind: "questions", questions: ["What outcome matters most?"] });
    expect(parseWizardAiOutput(JSON.stringify(ai))).toEqual(ai);
    for (const unexpected of [{ approvalMode: "full" }, { mcpServers: ["secret"] }, { existingBotId: "incumbent" },
      { grants: ["chief"] }, { rooms: [] }, { routines: [] }, { skills: [] }]) {
      expect(() => parseWizardAiOutput(JSON.stringify({ ...ai, bots: [{ ...ai.bots[0], ...unexpected }] }))).toThrow("invalid proposal");
    }
    expect(() => parseWizardAiOutput(JSON.stringify({ ...ai, visibility: "everyone" }))).toThrow("invalid proposal");
    expect(() => parseWizardAiOutput(JSON.stringify({ kind: "questions", questions: ["1", "2", "3", "4"] }))).toThrow();
    expect(() => parseWizardAiOutput("not json")).toThrow("valid JSON");
  });

  it("preselects only an eligible new Chief and leaves an incumbent untouched", () => {
    const draft = draftFromWizardAi(ai, input, state);
    expect(draft.chiefKey).toBe("lead");
    expect(draft.teamBrief).toBe(ai.teamBrief);
    expect(draft.visibility).toBe("everyone");
    expect(draftFromWizardAi({ ...ai, teamBrief: "" }, input, state).teamBrief).toBe(input.goal);
    expect(draftFromWizardAi({ ...ai, teamBrief: "" }, { ...input, seed: {
      name: "Research desk", description: "Use primary sources.", bots: [{ key: "lead", name: "Lead", title: "Lead",
        description: "", soul: "Verify claims." }] } }, state).teamBrief).toBe("Use primary sources.");
    const plain = { instanceId: "plain", model: "plain-1" };
    const preferred = draftFromWizardAi({ ...ai, chiefKey: "check" }, input, state);
    expect(preferred.chiefKey).toBe("check");
    expect(preferred.bots[1].modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet" });
    const allPlain = draftFromWizardAi({ ...ai, bots: ai.bots.map(candidate => ({ ...candidate, modelSelection: plain })) }, input, state);
    expect(allPlain.chiefKey).toBe("lead");
    expect(allPlain.bots[0].modelSelection).toEqual({ instanceId: "claude", model: "claude-sonnet" });
    expect(() => validateWizardDraft({ ...allPlain, chiefKey: null, bots: allPlain.bots.map(candidate => ({ ...candidate, modelSelection: plain })) }, state)).not.toThrow();
    expect(draftFromWizardAi({ ...ai, bots: ai.bots.map(candidate => ({ ...candidate, modelSelection: plain })) }, input,
      { ...state, models: models.filter(model => !model.coordination) }).chiefKey).toBeNull();
    expect(() => validateWizardDraft({ ...draft, chiefKey: "check" }, state)).toThrow("coordination-capable");
    expect(() => validateWizardDraft({ ...draft, chiefKey: null }, state)).not.toThrow();
    const existing = { ...input, destination: { kind: "existing" as const, section: "Operations" } };
    const incumbentState = { ...state, bots: [{ name: "Current Chief", section: "Operations", chiefOfStaff: true }] };
    const inTeam = draftFromWizardAi(ai, existing, incumbentState);
    expect(inTeam).toMatchObject({ destination: existing.destination, teamBrief: "", chiefKey: null });
    expect(() => validateWizardDraft({ ...inTeam, chiefKey: "lead" }, incumbentState)).toThrow("incumbent");
  });

  it("revalidates exact models, reasoning effort, capacity, names and the existing brief", () => {
    const draft = draftFromWizardAi(ai, input, state);
    expect(() => validateWizardDraft({ ...draft, bots: [{ ...draft.bots[0], modelSelection: { instanceId: "claude", model: "retired" } }] }, state))
      .toThrow("no longer available");
    expect(() => validateWizardDraft({ ...draft, bots: [{ ...draft.bots[0], modelSelection: { ...draft.bots[0].modelSelection, effort: "max" } }] as WizardDraft["bots"] }, state))
      .toThrow("reasoning effort");
    expect(() => validateWizardDraft(draft, { ...state, maxBots: 1 })).toThrow("limit");
    expect(() => validateWizardDraft(draft, { ...state, teams: [...state.teams, "RESEARCH DESK"] })).toThrow("already exists");
    expect(() => validateWizardDraft({ ...draft, bots: [draft.bots[0], { ...draft.bots[1], name: "lead" }] }, state)).toThrow("already exists");
    const existing = draftFromWizardAi(ai, { ...input, destination: { kind: "existing", section: "Operations" } }, state);
    expect(() => validateWizardDraft({ ...existing, teamBrief: "overwrite team brief" }, state)).toThrow("cannot change");
    expect(() => validateWizardDraft({ ...existing, bots: [{ ...existing.bots[0], name: "Current" }] },
      { ...state, bots: [{ name: "current", section: "Operations" }] })).toThrow("already exists");
  });

  it("rejects privilege-bearing commit input and excludes visibility from the AI prompt", () => {
    const draft = draftFromWizardAi(ai, input, state);
    const valid = { requestId: "request_12345678", draft };
    expect(wizardCommitInputSchema.safeParse(valid).success).toBe(true);
    for (const change of [
      { ...valid, approveTools: true },
      { ...valid, draft: { ...draft, rooms: ["hidden"] } },
      { ...valid, draft: { ...draft, bots: [{ ...draft.bots[0], approvalMode: "full" }] } },
      { ...valid, draft: { ...draft, bots: [{ ...draft.bots[0], credentials: "token" }] } },
      { ...valid, draft: { ...draft, bots: [{ ...draft.bots[0], computer: "local" }] } },
      { ...valid, draft: { ...draft, bots: [{ ...draft.bots[0], modelSelection: { ...draft.bots[0].modelSelection, variant: "hidden" } }] } },
    ]) expect(wizardCommitInputSchema.safeParse(change).success).toBe(false);
    const prompt = setupWizardPrompt({ ...input, currentDraft: { ...draft, visibility: { people: ["private@example.test"] } } }, models);
    expect(prompt).not.toContain("private@example.test");
    expect(prompt).toContain("no prose or tool calls");
    expect(setupWizardPrompt(input, models, 1)).toContain("Propose exactly 1 new bot");
    expect(() => setupWizardPrompt(input, models, 0)).toThrow("limit");
  });
});
