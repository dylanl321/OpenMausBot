# Goals

Phased intent. **Platform** goals apply to every team. **Example-kit**
goals apply to a reference deployment (tracker role + code-host role
+ coding agents; today exercised as Jira + GitLab + Codex). Kit
goals must not leak into core types, runner branches, or Work copy.

When a goal has an active plan, link it. When the plan is only on
another branch, say so.

## Now (on `codex/bedrock-provider`)

Already in tree, still shaping the next cuts:

| Track | What is true today | Follow-on |
|---|---|---|
| Shared work | One durable task; rooms + specialists; claimed evidence cannot complete | Keep; do not add a second board. [shared-work.md](../shared-work.md) |
| Connectors + watches | Kind-driven registry; Jira / GitLab / Plane; token-free change feeds | [task-connectors](../plans/2026-09-23-task-connectors.md), [connectors.md](../connectors.md) |
| Missions / Work / `/pursue` | Kind-driven scopes; kits as data; writes fail-closed (off unless both locks are set) | Keep general. [team-backlog](../verification/team-backlog.md), [connectors](../connectors.md), [plan](../plans/2026-09-25-flexible-team-work.md) |
| Goals / routines | Durable `/pursue`; fail-closed inventory; routines can wait on shared work; watches can wake a goal | [ongoing-goals](../verification/ongoing-goals.md), [goal-mode v2](../plans/2026-09-02-goal-mode-v2.md), [routines](../verification/routines.md) |
| Computers | Exclusive turn ownership; siblings wait, then start; no interleaving | [computer-wait](../verification/computer-wait.md) — generalize in [005](proposals/005-exclusive-resource-leases.md) |
| Setup Guide | Drafts only; privilege fields rejected; Templates apply a team shape | [setup-wizard](../verification/setup-wizard.md) |
| Approvals / spend | Per-bot levels; Chief Full access can cover a hop; monthly spend cap is a hard refuse | [approval-levels.md](../approval-levels.md), [spend-cap](../verification/spend-cap.md) |

## Near — platform

1. **Kind-driven missions.** Ready means at least one query-capable
   scope and no unresolved choices — not "has vendor A and vendor
   B." Single-connector teams leave `needs-input` after a valid
   choice. (PR #18 P2.)
2. **Fail-closed writes.** Server-owned completion is locked off
   until a workspace flag and a connection allowlist are on.
   Default fixtures send zero mutating HTTP. (PR #18 P0.)
3. **Honest client UX.** Do not offer `/pursue` or renew when the
   session cannot call them. Do not swallow 403s. (PR #18 P1.)
4. **Watches over polling routines.** Prefer a watch match as the
   wake; a timed "check the board" prompt is the fallback, not the
   design. Already specified in the task-connectors plan (P9).

Do not fork a second workflow path for one operator.

## Near — example kit

The reference kit is *one* configuration:

- Tracker `work_item` + code-host `change_request` (code-host
  issues dropped until that kit says otherwise).
- Observed evidence before any completion action.
- Extra approval-rule names as connection or kit data, not
  compiled constants.
- Isolated fixtures only. [team-backlog](../verification/team-backlog.md).

## Mid — platform

| Goal | Proposal | Why mid |
|---|---|---|
| Reconcile to observed state; wait on watches, not token polls | [001](proposals/001-reconcile-to-observed.md) | Needs kind-driven scopes so "the world" is not one vendor pair |
| Required checks and reused decisions; no team parliament | [002](proposals/002-gates-not-votes.md) | Compose with existing `BacklogGate` / evidence; do not add voters first |
| Humans only for irreversible risk; claims that heartbeat | [003](proposals/003-irreversible-risk.md) | Locks land in P0; claims reuse computer-wait, not a new board |
| Kits + Setup Guide / Templates as the apply path | [004](proposals/004-kits-and-setup-shapes.md) | PR #18 sketches kit data; Setup Guide already drafts teams |
| Exclusive leases for computers, folders, browsers, write slots | [005](proposals/005-exclusive-resource-leases.md) | Computers already wait; the gap is every other scarce resource |

## Mid — example kit

- Attested complete/merge only with locks open; dry-run default.
- Kit-suggested watches instead of "check Jira every 15 minutes."
- Coding agent is an engine the operator picked, not a hardcoded
  merge actor.

## Later / out of scope for this backlog

- Two-way field sync, workflow-builder UIs, per-vendor screens.
- Replacing shared tasks, watches, or room `/goal` runs.
- Multi-bot voting as the consensus mechanism.
- Treating "bots never complete external work" as the product.
- A second ownership table beside shared tasks.

## How this file stays current

When a plan is accepted, add it to the matching phase and link it.
When its acceptance criteria land, move or delete the row. Plans
and verification recipes are the record of what shipped.
