# 004 — Kits and Setup Guide shapes

Status: draft
Owner: unassigned
Plan: [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18)
(`docs/plans/2026-09-25-flexible-team-work.md` is on that branch,
not on `codex/bedrock-provider`)
Related: [connectors.md](../../connectors.md),
[setup-wizard](../../verification/setup-wizard.md),
[001](001-reconcile-to-observed.md)

## Problem

Two apply-paths already exist and they do not agree.

**Connectors** are kind-driven and drop-in. **Missions / Work /
`/pursue`** then assume one vendor pair in enums, readiness,
write HTTP, and the detector. Teams with one connection, or with
Plane, look stuck.

**Setup Guide and Templates** already apply a *team shape*
(Chief, members, models, visibility) as a reviewed draft. They
refuse privilege fields. They do not speak connector kinds,
watches, or mission scopes — so a new team still has to be
hand-wired to work sources.

If we only "add kit JSON for Jira+GitLab" we recreate one
operator's loop as the documented happy path. The simpler
product is: **a shape is data you apply; core never names the
vendors inside it.**

## Proposal

A **shape** (kit) is data:

- roles (`tracker`, `code`, `other`, or none),
- kinds each role inventories,
- optional extra check names (not compiled role bots),
- optional watch suggestions,
- optional bot roles the Setup Guide / Templates may draft
  (coordinator, implementer, reviewer) *without* engines,
  credentials, or write locks.

Pinned `connectorId` is allowed when a shape is branded.
Omitted pin → any connector that offers those kinds. Unrecognized
mix → no shape required; infer from manifests.

**One apply path, two surfaces.**

| Surface | What it may do | What it must not do |
|---|---|---|
| Setup Guide / Templates | Draft bots, team brief, suggested watches and connection *kinds* as `appHints` | Set `features.teamMissionWrites`, connection `writes`, Full access, secrets |
| Mission infer / Work | Build scopes from connections the team already has, filtered by the shape's kinds | Require a vendor pair; invent a second runner |

Adding a team shape is a data record. Adding a system is still a
connector PR (`server/connectors/<id>/**` + one registry line).
The reference tracker + code-host + coding-agent deployment is
one row in that table — useful, tested, not privileged in core.

This accepts PR #18's kit type and adds the Setup Guide as the
human-facing apply path the plan left narrow on purpose.

## Non-goals

- Inventing connectors that do not exist yet.
- A kit marketplace, two-way sync, or per-vendor screens.
- A second mission runner for "everyone else."
- Letting Templates unlock attested writes.
- Making Codex (or any engine) part of a shape. Engines stay an
  operator pick on each bot.

## Open questions

1. Existing tracker + code-host teams: keep dropping code-host
   issues until they opt into another shape? (PR #18 default:
   yes — that is kit policy, not a scanner law.)
2. Shapes as JSON, a `server/team-work-kits.ts` module, or both?
3. May a team pin a shape, or only infer? Pinning is easier to
   test.

## Success signals

- A new `work_item` connector can run a mission with no runner,
  Work UI, or core-enum edit.
- Tracker-only, code-host-only, and the reference pair each have
  a fixture that leaves `needs-input` after a valid scope choice.
- A Templates / Setup Guide draft can name "tracker + code host"
  as hints and still commits zero connections and zero write
  flags (extend the existing privilege-rejection e2e).
- Production code has no compiled vendor-pair enum.
