# Goals

Phased intent. **Platform** goals apply to every team. **Example-kit**
goals apply to the reference deployment (a tracker role + a code-host
role + coding agents; today exercised as Jira + GitLab + Codex). Kit
goals must not leak into core types, runner branches, or Work copy.

When a goal has an active plan, link it. When the plan is only on
another branch, say so.

## Now (on `codex/bedrock-provider`)

Already in tree, still shaping the next cuts:

| Track | What is true today | Follow-on |
|---|---|---|
| Shared work | One durable task per deliverable; rooms + linked specialists | Keep; do not add a second board. [shared-work.md](../shared-work.md) |
| Connectors | Kind-driven model, drop-in registry, Jira / GitLab / Plane, capture, watches | [task-connectors plan](../plans/2026-09-23-task-connectors.md), [connectors.md](../connectors.md) |
| Missions / Work / `/pursue` | Useful, but one vendor pair is baked into enums, the runner, write HTTP, and the detector | Generalize via kits — plan is [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18), not on this branch |
| Goals | Durable `/pursue`, fail-closed inventory, observed evidence before completion | [ongoing-goals](../verification/ongoing-goals.md), [goal-mode v2](../plans/2026-09-02-goal-mode-v2.md) |
| Approvals | Per-bot levels; a Chief with Full access can cover delegated work; peer-approval cards | Human cards stay for real gates; they are not the keep-working path. [approval-levels.md](../approval-levels.md) |

## Near — platform

1. **One mission model for every connection mix.** Ready means "at
   least one query-capable scope, no unresolved choices," not "has
   vendor A and vendor B." Single-connector teams must leave
   `needs-input` after a valid scope choice.
2. **Kinds in the runner and Work UI.** No vendor enum in core. Copy
   talks about inventory and change requests.
3. **Honest waits.** Inventory errors stay incomplete (never an empty
   success). Client UI does not offer routes the session cannot call.
   Swallowed 403s and silent hangs are defects.
4. **Write capability is optional and off.** Server-owned completion
   exists as a locked action, not a default.

These are the flexibility + robustness cuts in
[PR #18](https://github.com/dylanl321/OpenMausBot/pull/18)
(`docs/plans/2026-09-25-flexible-team-work.md` on that branch).
Implement as plan slices there; do not fork a second workflow path
for one operator.

## Near — example kit

The reference kit must keep working as *one* configuration of the
platform:

- Tracker `work_item` + code-host `change_request` inventory (issues
  on the code host dropped for this kit until the kit says
  otherwise).
- Observed evidence before any completion action.
- Extra named approval rules as **connection or kit data**, not
  compiled role names.
- Isolated fixtures only; live tokens are a desk-test checklist, not
  CI. See [team-backlog verification](../verification/team-backlog.md).

## Mid — platform

Driven by the proposals. Each should land as a dated `docs/plans/`
slice, not as a pile of opportunistic patches.

| Goal | Proposal | Why mid, not near |
|---|---|---|
| Stop taxonomy: human gate vs team-resolvable vs friction | [001](proposals/001-agent-team-keep-working.md) | Needs the kind-driven mission model first, or "stuck" stays vendor-shaped |
| Token-cheap ballots for "is this a human stop?" | [002](proposals/002-cheap-team-voting.md) | Composes with 001; reuse the decision log and peer-approval, do not invent a parliament |
| Explicit ownership, keep-going budgets, ask-for-unblock | [003](proposals/003-bot-ownership-and-consent.md) | Shared tasks already have an owner; extend to missions without a second system |
| Kits as data; new team shapes without runner edits | [004](proposals/004-kits-not-product-shapes.md) | PR #18 sketches the type; mid is shipping kits without a closed world |

## Mid — example kit

- Attested complete/merge when the operator has opened the trust
  locks, with dry-run as the default path.
- Kit-suggested watches (token-free detection) rather than "check
  the board every N minutes" model turns.
- The coding agent remains a bot engine the operator chose, not a
  hardcoded merge actor. The kit names roles; the operator picks
  engines.

## Later / out of scope for this backlog

- Two-way field sync with trackers.
- A generic workflow-builder UI.
- Per-vendor screens.
- Replacing shared tasks, watches, or room `/goal` runs.
- Treating "bots never complete external work" as the product.

## How this file stays current

When a plan is accepted, add it to the matching phase and link it.
When the plan's acceptance criteria land, move or delete the row.
Do not keep a graveyard of shipped bullets here; the plans and
verification recipes are the record.
