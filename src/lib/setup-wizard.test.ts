import { describe, expect, it } from "vitest";

import type { WizardDraft } from "../../shared/setup-wizard";
import { communityWizardSeed } from "./team-import";
import { mergeWizardRevision, seedFromRole, STARTER_TEAMS, WIZARD_ROLES } from "./setup-wizard";

const draft: WizardDraft = { destination: { kind: "new", name: "Desk" }, teamBrief: "Short brief", chiefKey: "lead", visibility: "everyone",
  bots: [
    { key: "lead", name: "Lead", title: "Coordinator", description: "Plan", soul: "Coordinate the research.", modelSelection: { instanceId: "a", model: "coord" }, appHints: [] },
    { key: "scout", name: "Scout", title: "Researcher", description: "Research", soul: "Find and check sources.", modelSelection: { instanceId: "b", model: "plain" }, appHints: [] },
  ] };

describe("wizard seeds and revisions", () => {
  it("provides three editable starter teams and reuses the existing single-bot roles", () => {
    expect(STARTER_TEAMS).toHaveLength(3);
    expect(new Set(STARTER_TEAMS.map(team => team.seed.name)).size).toBe(3);
    for (const team of STARTER_TEAMS) {
      expect(team.seed.bots.length).toBeGreaterThan(1);
      expect(team.seed.bots.every(bot => Boolean(bot.name && bot.soul))).toBe(true);
    }
    expect(WIZARD_ROLES.length).toBeGreaterThan(1);
    for (const role of WIZARD_ROLES) expect(seedFromRole(role).bots[0]).toMatchObject({ name: role.name, soul: role.soul });
  });

  it("projects a community playbook onto names and prompts, never imported authority", () => {
    const source = { format: "openmaus.package", version: 1, package: {
      name: "Market desk", summary: "Analyze competitors", chiefOfStaff: "lead",
      agents: [{ key: "lead", name: "Analyst", title: "Researcher", description: "Research markets", soul: "Cite sources",
        mcpServers: [{ name: "hidden" }], approvalMode: "full", computer: "local", credentials: "private" }],
      rooms: [{ name: "work" }], routines: [{ command: "danger" }], skills: { entries: [{ name: "script" }] },
      grants: ["admin"], requirements: { apps: [{ label: "Mail", optional: false }] },
    } };
    expect(communityWizardSeed(source)).toEqual({ name: "Market desk", description: "Analyze competitors",
      bots: [{ key: "community-1", name: "Analyst", title: "Researcher", description: "Research markets", soul: "Cite sources" }] });
    expect(() => communityWizardSeed({ format: "openmaus.backup", version: 1 })).toThrow();
  });

  it("retains field-level manual edits, added roles and removed roles across AI revisions", () => {
    const edited: WizardDraft = { ...draft, teamBrief: "My private, edited brief", visibility: "admins", chiefKey: null,
      bots: [{ ...draft.bots[0], name: "My lead", modelSelection: { instanceId: "b", model: "other" } },
        { key: "manual", name: "Mine", title: "Verifier", description: "", soul: "Check claims.", modelSelection: { instanceId: "b", model: "plain" }, appHints: [] }] };
    const proposed: WizardDraft = { ...draft, teamBrief: "New AI brief", bots: [
      { ...draft.bots[0], name: "AI lead", soul: "Revise the plan." }, draft.bots[1],
      { key: "writer", name: "Writer", title: "Writer", description: "", soul: "Write summaries.", modelSelection: { instanceId: "b", model: "plain" }, appHints: [] },
    ] };
    const merged = mergeWizardRevision(draft, edited, proposed);
    expect(merged).toMatchObject({ teamBrief: edited.teamBrief, visibility: "admins", chiefKey: null });
    expect(merged.bots.map(bot => bot.key)).toEqual(["lead", "writer", "manual"]);
    expect(merged.bots[0]).toMatchObject({ name: "My lead", soul: "Revise the plan.", modelSelection: edited.bots[0].modelSelection });
    const many = { ...proposed, bots: [...proposed.bots, ...Array.from({ length: 5 }, (_, index) =>
      ({ ...draft.bots[1], key: `suggested-${index}` }))] };
    expect(mergeWizardRevision(draft, edited, many).bots.some(bot => bot.key === "manual")).toBe(true);
  });
});
