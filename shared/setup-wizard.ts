import { z } from "zod";

import { EFFORT_LEVELS } from "./wire.ts";

export const SETUP_WIZARD_MAX_BOTS = 8;
export const SETUP_WIZARD_MAX_QUESTIONS = 3;

const line = (max: number) => z.string().trim().min(1).max(max);
const modelSelectionSchema = z.object({
  instanceId: line(128), model: line(200),
  effort: z.enum(EFFORT_LEVELS).optional(),
}).strict();
const visibilitySchema = z.union([
  z.literal("everyone"), z.literal("admins"),
  z.object({ people: z.array(z.string().max(320)).min(1).max(500) }).strict(),
]);

export const wizardDestinationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new"), name: z.string().trim().max(60) }).strict(),
  // The empty section is the existing General team, not a new team.
  z.object({ kind: z.literal("existing"), section: z.string().trim().max(60) }).strict(),
]);

export const wizardSeedSchema = z.object({
  name: z.string().trim().max(60).optional(),
  description: z.string().max(2_000).optional(),
  bots: z.array(z.object({
    key: line(80), name: line(100), title: z.string().max(200),
    description: z.string().max(4_000), soul: z.string().max(24_000),
    appHints: z.array(line(100)).max(12).optional(),
  }).strict()).min(1).max(SETUP_WIZARD_MAX_BOTS),
}).strict();

export const wizardBotSchema = z.object({
  key: line(80), name: line(100), title: line(200),
  description: z.string().max(4_000), soul: line(24_000),
  modelSelection: modelSelectionSchema,
  // Hints are displayed to the owner, never installed or connected.
  appHints: z.array(line(100)).max(12),
}).strict();

export const wizardDraftSchema = z.object({
  destination: wizardDestinationSchema,
  bots: z.array(wizardBotSchema).min(1).max(SETUP_WIZARD_MAX_BOTS),
  chiefKey: line(80).nullable(),
  teamBrief: z.string().max(24_000),
  visibility: visibilitySchema,
}).strict();

export const wizardAssistInputSchema = z.object({
  instanceId: line(128),
  goal: line(4_000),
  destination: wizardDestinationSchema,
  seed: wizardSeedSchema.optional(),
  answers: z.array(z.object({ question: line(300), answer: line(2_000) }).strict()).max(SETUP_WIZARD_MAX_QUESTIONS).default([]),
  followUp: z.string().trim().max(2_000).optional(),
  currentDraft: wizardDraftSchema.optional(),
  /** When present, must be an exact model id listed on the selected engine. */
  model: line(200).optional(),
}).strict();

export const wizardAiOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("questions"), questions: z.array(line(300)).min(1).max(SETUP_WIZARD_MAX_QUESTIONS) }).strict(),
  z.object({ kind: z.literal("draft"),
    teamName: z.string().trim().max(60).optional(),
    teamBrief: z.string().max(24_000).optional(),
    bots: z.array(wizardBotSchema).min(1).max(SETUP_WIZARD_MAX_BOTS),
    chiefKey: line(80).nullable().optional(),
  }).strict(),
]);

export const wizardCommitInputSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  draft: wizardDraftSchema,
}).strict();

export type WizardDestination = z.infer<typeof wizardDestinationSchema>;
export type WizardSeed = z.infer<typeof wizardSeedSchema>;
export type WizardBot = z.infer<typeof wizardBotSchema>;
export type WizardDraft = z.infer<typeof wizardDraftSchema>;
export type WizardAssistInput = z.infer<typeof wizardAssistInputSchema>;
export type WizardAiOutput = z.infer<typeof wizardAiOutputSchema>;
