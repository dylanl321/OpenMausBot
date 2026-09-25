# 004 — Kits, not product shapes

Status: draft
Owner: unassigned
Plan: [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18)
(`docs/plans/2026-09-25-flexible-team-work.md` is on that branch,
not on `codex/bedrock-provider`)
Related: [task-connectors plan](../../plans/2026-09-23-task-connectors.md),
[connectors.md](../../connectors.md), [003](003-bot-ownership-and-consent.md)

## Problem

The platform already has a modular connector contract (kinds, not
providers; drop-in folder + registry line). The first mission /
Work / `/pursue` cut then baked one pairing into core: inventory,
readiness, write HTTP, approval rule names, and the "is this a
mission?" detector all assume that pairing.

That is the opposite of simplify. It creates two products in one
tree — "the reference team's workflow" and "everyone else" — and
it makes Plane, tracker-only, and code-host-only teams look stuck
(`needs-input`) even after a valid scope choice.

Stop-friction: false gates that are really missing kit data.
Token cost: none directly, but every false `needs-input` burns a
human or coordinator turn.

## Proposal

A **kit** is data that says how a common team shape uses
connectors and automations. It is not a second connector system
and not a hardcoded product.

A kit names **roles** (tracker, code, other), the **kinds** each
role inventories, optional extra approval-rule names, and optional
watch suggestions. It may pin a `connectorId` when the kit is
branded, or omit the pin and accept any connector that offers
those kinds.

Examples, not a closed world:

| Kit | What it means |
|---|---|
| Reference tracker + code host | `work_item` from the tracker role, `change_request` from the code role. Today's Jira + GitLab behavior, including "drop issues on the code host," lives here as data. |
| Code host only | That host's `work_item` + `change_request`. |
| Tracker only | `work_item` only; no merge action. |
| Unrecognized mix | No kit required. Infer scopes from manifests. |

Core (runner, Work UI, Zod, detector) branches on `kind`,
`statusCategory`, and registry ids. It never names a vendor. Adding
a team shape is a kit record plus, if needed, a connector PR that
touches only `server/connectors/<id>/**` and one registry line.

The reference deployment — the operator who actually runs a
tracker, a code host, and coding agents (today: Jira, GitLab,
Codex) — stays first-class **as that kit**. Automations, attested
completion, and named extra rules are kit or connection settings.
They are not compiled into `team-backlog` as `"Security"` /
`"Manager"` or a `z.enum` of two vendors.

This proposal accepts the direction in PR #18. It exists here so
vision tracking does not depend on that branch being merged, and
so later slices (voting, ownership) keep using kits instead of
re-specializing core.

## Non-goals

- Inventing connectors that do not exist yet (another git host,
  a service desk). The contract must accept them; this proposal
  does not add them.
- Two-way field sync, per-vendor screens, or a kit marketplace.
- A second mission runner for "everyone else."
- Enabling live external writes. That is
  [003](003-bot-ownership-and-consent.md) plus PR #18 P0.

## Open questions

1. Existing tracker + code-host teams: keep dropping code-host
   issues until they opt into a different kit? (PR #18 default:
   yes.)
2. Are kits JSON on disk, a small `server/team-work-kits.ts`
   module, or both (module now, file later)?
3. May a team pin a kit, or is kit match always inferred? Pinning
   is simpler to test; inference is simpler to start.

## Success signals

- A new connector that offers `work_item` can run a mission
  without editing the runner, Work UI, or a core enum.
- Tracker-only, code-host-only, and the reference pair each have a
  fixture that leaves `needs-input` after a valid scope choice.
- Production code has no compiled vendor-pair enum and no compiled
  extra approval-rule names. Those strings live in kit or
  connection fixtures.
- Feature PRs that add a wait or a completion path pass the
  north-star tests: finish more work, stay general.
