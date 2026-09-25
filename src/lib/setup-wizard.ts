import { BOT_ROLES, type BotRole } from "./bot-roles";
import type { WizardBot, WizardDraft, WizardSeed } from "../../shared/setup-wizard";

export interface StarterTeam { id: string; label: string; seed: WizardSeed }

export const STARTER_TEAMS: StarterTeam[] = [
  { id: "research-desk", label: "Research desk", seed: {
    name: "Research Desk", description: "Research a question, verify the evidence, and return a concise brief.",
    bots: [
      { key: "lead", name: "Anchor", title: "Research lead", description: "Frames the question and assembles a clear answer.", soul: "Clarify the research question, delegate evidence gathering, compare findings, and return one concise, sourced brief. Separate verified facts from inference." },
      { key: "scout", name: "Scout", title: "Source researcher", description: "Finds primary sources and traces claims.", soul: BOT_ROLES.find(role => role.id === "research")!.soul },
      { key: "check", name: "Proof", title: "Fact checker", description: "Challenges weak claims and checks citations.", soul: "Check each central claim against the cited source. Flag contradictions, missing dates and uncertainty. Never invent a citation." },
    ],
  } },
  { id: "product-studio", label: "Product studio", seed: {
    name: "Product Studio", description: "Turn a product idea into a scoped plan, implementation and review.",
    bots: [
      { key: "lead", name: "Map", title: "Product lead", description: "Turns goals into priorities and acceptance criteria.", soul: "Translate the user's goal into a small, testable plan. Coordinate implementation and review, surface tradeoffs and ask before irreversible decisions." },
      { key: "build", name: "Dev", title: "Implementation engineer", description: "Builds and tests the change.", soul: BOT_ROLES.find(role => role.id === "coder")!.soul, appHints: ["github"] },
      { key: "review", name: "Check", title: "Quality reviewer", description: "Checks behavior, edge cases and usability.", soul: "Review the proposed change against the acceptance criteria. Test meaningful failure paths, document evidence, and distinguish observations from guesses." },
    ],
  } },
  { id: "operations-desk", label: "Operations desk", seed: {
    name: "Operations Desk", description: "Triage inbound work and keep follow-ups organized.",
    bots: [
      { key: "lead", name: "North", title: "Operations lead", description: "Prioritizes incoming work and coordinates follow-ups.", soul: "Keep an accurate view of commitments, assign clear owners and report what needs the user's decision. Never send messages, schedule work, or grant access without review." },
      { key: "inbox", name: "Inbox", title: "Email triage", description: BOT_ROLES.find(role => role.id === "inbox")!.description, soul: BOT_ROLES.find(role => role.id === "inbox")!.soul, appHints: ["gmail"] },
      { key: "ops", name: "Ops", title: "Calendar and task follow-up", description: BOT_ROLES.find(role => role.id === "ops")!.description, soul: BOT_ROLES.find(role => role.id === "ops")!.soul, appHints: ["googlecalendar", "notion"] },
    ],
  } },
];

export function seedFromRole(role: BotRole): WizardSeed {
  return { name: role.name, description: role.description,
    bots: [{ key: role.id, name: role.name, title: role.title,
      description: role.description, soul: role.soul, appHints: [...role.apps] }] };
}

export const WIZARD_ROLES = BOT_ROLES;

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A model revision is a suggestion, not a reset. Keep individual fields,
 * newly added bots and deliberate removals made by the person since the last
 * suggestion. The next suggestion stays as the comparison baseline. */
export function mergeWizardRevision(previous: WizardDraft | null, edited: WizardDraft | null, next: WizardDraft): WizardDraft {
  if (!previous || !edited) return next;
  const pick = <T,>(oldValue: T, editedValue: T, newValue: T): T => equal(oldValue, editedValue) ? newValue : editedValue;
  const oldBots = new Map(previous.bots.map(bot => [bot.key, bot]));
  const edits = new Map(edited.bots.map(bot => [bot.key, bot]));
  const bots: WizardBot[] = [];
  for (const suggestion of next.bots) {
    const original = oldBots.get(suggestion.key);
    const changed = edits.get(suggestion.key);
    if (original && !changed) continue; // the person removed this role
    if (!original || !changed) { bots.push(suggestion); continue; }
    bots.push(Object.fromEntries((Object.keys(suggestion) as Array<keyof WizardBot>).map(key =>
      [key, pick(original[key], changed[key], suggestion[key])])) as unknown as WizardBot);
  }
  for (const bot of edited.bots) {
    if (bots.some(candidate => candidate.key === bot.key)) continue;
    const original = oldBots.get(bot.key);
    // A manually added role or an edited role the model proposed removing
    // survives. An unchanged removed suggestion may disappear.
    if (!original || !equal(original, bot)) bots.push(bot);
  }
  const protectedKeys = new Set(edited.bots.filter(bot => {
    const original = oldBots.get(bot.key);
    return !original || !equal(original, bot);
  }).map(bot => bot.key));
  const allowed = new Set([...bots.filter(bot => protectedKeys.has(bot.key)), ...bots.filter(bot => !protectedKeys.has(bot.key))]
    .slice(0, 8).map(bot => bot.key));
  const selectedBots = bots.filter(bot => allowed.has(bot.key));
  const chiefKey = pick(previous.chiefKey, edited.chiefKey, next.chiefKey);
  return {
    destination: pick(previous.destination, edited.destination, next.destination),
    bots: selectedBots,
    chiefKey: chiefKey && allowed.has(chiefKey) ? chiefKey : null,
    teamBrief: pick(previous.teamBrief, edited.teamBrief, next.teamBrief),
    visibility: edited.visibility,
  };
}
