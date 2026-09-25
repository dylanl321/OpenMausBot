# North star

OpenMausBot is a **reconciliation harness for agent teams**.

State an outcome. The platform observes the world through connectors,
captures, and watches. The team acts until **observed** state matches
that outcome, or until it hits a gate that is actually irreversible.
People choose outcomes and sit those gates. They do not pull, build,
submit, or complete as a daily job.

A tracker plus a code host plus a coding agent is a **kit**. It is
not the product.

## Why this frame

The tree already points here more than it points at slogans like
"keep working" or "the team votes":

- Shared tasks will not complete on claimed evidence
  (`server/work-items.ts`; [shared-work.md](../shared-work.md)).
- Watches detect change in code and spend tokens only on a match
  ([task-connectors plan](../plans/2026-09-23-task-connectors.md)).
- Inventory errors stay incomplete; they never look like an empty
  success ([ongoing-goals](../verification/ongoing-goals.md)).
- One computer is leased, not hoped: a second turn waits, then
  starts when the owner stops
  ([computer-wait](../verification/computer-wait.md)).
- Setup Guide drafts a team and cannot grant privileges
  ([setup-wizard](../verification/setup-wizard.md)).

Outside the repo, the same shape is what actually ships:

- **GitHub required checks and merge queues** merge when policy is
  green, not when people or bots have talked enough.
- **Linear / GitHub project automation** fires on a state change,
  not on a 15-minute "check the board" prompt.
- **Kubernetes reconciliation** loops until actual matches desired;
  a failed read is a requeue, not "done."
- **Cursor background agents** (this workflow) take an outcome and
  open a change; a person reviews the irreversible merge.
- **ADR / RFC** writes a decision once. Later work cites it instead
  of re-debating.

"Keep working" is a *consequence* of reconciliation, not the slogan.
A multi-bot vote is a weaker, costlier substitute for gates. One
user's tracker + VCS + coding-agent loop is a reference kit.

Operator notes (including that loop, team voting, and a keep-working
stop taxonomy) are **inputs**, not the closed set of what to build.

## The shape

**One work record.** A deliverable is a shared task, or a goal that
points at one. Rooms, specialists, and missions are views of that
record, not parallel systems.

**Kinds, not brands.** Work sources are `work_item`,
`change_request`, `build`, `comment`, …. A vendor name is a
connector label, never a branch in the runner, Work UI, or a core
enum. See [connectors.md](../connectors.md).

**Detect in code.** A watch or scan decides whether the world
moved. A model runs when a rule matches or when implementation is
required. See [proposal 001](proposals/001-reconcile-to-observed.md).

**Lease what cannot be shared.** Desktops, working folders, browser
profiles, and write slots are exclusive. Wait is honest;
interleaving is a bug. See
[proposal 005](proposals/005-exclusive-resource-leases.md).

**Gates, not ballots.** Ready means required checks, observed
evidence, live provider policy, and open consent locks. A multi-bot
discussion is for design, not for "may we merge?" See
[proposal 002](proposals/002-gates-not-votes.md).

**People for irreversible risk.** Attested writes, spend over the
cap, deletes, credentials, Full access, computer takeover. Retries,
drafts, comments, and inventory refresh are team work. See
[proposal 003](proposals/003-irreversible-risk.md).

**Kits configure; they do not fork the product.** Setup Guide and
Templates already apply a team shape without granting write power.
Mission inventory should work the same way. See
[proposal 004](proposals/004-kits-and-setup-shapes.md).

## What this is not

- Not one tracker + one code host + one coding agent, auto-merged
  for one team. Other teams run tracker-only, code-host-only, a
  different issue system, two git hosts, or chat-started work.
- Not a second product for "everyone else." One model, many kits.
  The flexible-team-work plan lives on
  [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18)
  (`docs/plans/2026-09-25-flexible-team-work.md` is not on this
  branch).
- Not an unsupervised write surface. Completing external work is an
  optional, fail-closed action. Off until an operator opens the
  locks.
- Not a council of bots. Cheap consensus is policy and prior
  decisions. Deliberation is expensive, and a model can claim
  "done" or "we agreed" while tools did nothing — that is why
  claimed evidence cannot complete a task.

## Test against a feature PR

Answer both before merge:

1. **Close the gap?** Does this make observed state able to catch
   up to a stated outcome without a person in routine motion?
2. **Stay general?** Does this avoid boxing the product into one
   tracker + one code host + one coding agent?

If (1) is no, it is not on the north star. If (2) is no, it belongs
in a kit or example, not in core.

A useful extra: **classify the wait.** Watch, lease, required
check, irreversible gate — or friction (a product bug)?

## Durable bets

These should still be true a year from now:

- Kinds and kits, not vendor-shaped core.
- Observed evidence completes; claimed evidence does not.
- Detection is code; models implement and judge only on a match.
- Scarce resources are leased and reclaimed, not interleaved.
- Humans sit irreversible risk, not the daily loop.
- The operator can read what happened (links, events, decision
  log) without having been in that loop.
