# 003 — Bot ownership and consent

Status: draft
Owner: unassigned
Plan: —
Related: [001](001-agent-team-keep-working.md),
[002](002-cheap-team-voting.md),
[004](004-kits-not-product-shapes.md),
[shared-work.md](../../shared-work.md),
[approval-levels.md](../../approval-levels.md)

## Problem

Work already has records (shared tasks, missions, goals) but
**ownership** is easy to lose and **consent** is easy to misread.

- The coordinator of the moment is not always a durable owner.
  Specialists implement; several bots can look responsible; none
  is clearly allowed to keep going when a wait appears.
- Budgets exist (turns, wall clock, spend, goal pause) but "keep
  going" and "stop" are easy to confuse. An owner who still has
  budget should be able to continue or ask for unblock. A stop is
  a decision, not the only way to leave a wait.
- Write safety is real and must stay real. It is currently easy to
  treat "no live merge / no Done transition" as the *product*.
  That frames attested completion as something bots must never do,
  instead of a lock the operator opens.

Stop-friction: a mission that has evidence and an owner still pages
a person for routine complete, or dies when a budget pauses with
no ask. Token cost: ownerless work relaunches coordinators and
restates the brief.

## Proposal

**One owner at a time.** A task or mission names a bot (or a Chief
acting as coordinator) as owner. Specialists take assignments; they
do not become owners by working. Re-owning is explicit — the same
bar shared tasks already use for a new revision or a changed brief.
Do not add a second ownership table.

**A budget is permission to keep going.** Turns, spend, and
wall-clock already bound a run. The owner may spend the remaining
budget on retries, teammate asks, and
[002](002-cheap-team-voting.md) ballots. Exhaustion is
`ask-for-unblock` (owner or operator), not an implicit stop.
Renewing a budget stays an operator / admin act — same posture as
today's `canRenew`.

**Ask-for-unblock ≠ stop.**

| Signal | Meaning |
|---|---|
| `ask-for-unblock` | Owner (or team vote) wants a human or a higher-trust teammate on a named gate. Work stays owned. |
| `stop` | Cancel the current attempt. Running specialists may finish; they cannot reopen. Existing shared-task Stop rules stay. |

Work UI and goal cards must show which one it is. A raised hand
that is actually a stop is a product bug.

**Consent is a lock, not a personality trait.** Completing external
work (merge a change request, mark a work item done, post a
completion comment) is an optional connector action, fail-closed,
off until the operator opens the locks:

1. Workspace flag (absent = off).
2. Per-connection allowlist of action ids.
3. Live `mayWrite()` (in-flight, not stopped).

That is the safety model in
[PR #18](https://github.com/dylanl321/OpenMausBot/pull/18). This
proposal states the product reading: locks are **trust the
operator enables** so the owning team may finish. They are not
the north-star end-state. Observed / synced evidence, dry-run
before commit, and fail-closed inventory remain mandatory when
locks are open.

**Coordinate without a human in every hop.** Delegation, rooms, and
watches stay the coordination fabric. Peer-approval and Ask-level
cards remain available when the operator has not granted standing
consent (Full access, connection writes, or a reused decision).
The owner decides whether a wait is
[001](001-agent-team-keep-working.md)'s human gate or
team-resolvable; a ballot may help; a person is not the default
router.

## Non-goals

- Multi-owner tasks, or ownership by "the team" with no named bot.
- Letting an owner bypass trust locks, invent credentials, or
  mark claimed evidence as observed.
- A Settings toggle that Setup Guide can flip. Same posture as
  other elevated flags: explicit, default off, not a wizard grant.
- Replacing connector read paths or bot-tool implementation with
  server writes for ordinary work. Bots still implement; only the
  owner/coordinator may request attested completion.

## Open questions

1. Is the owner always the mission coordinator, or may a kit name
   a separate completer role?
2. Client sessions creating missions: allowed (writes still locked)
   or owner/admin-only? PR #18 leaves this open; decide before the
   ownership plan slice.
3. When Full access is delegated by a Chief, does that count as
   standing consent for *harness* actions only, or also as a vote
   of confidence that team-resolvable waits need not page the
   person? (External writes still need the three locks.)

## Success signals

- Every active mission/task in fixtures has exactly one owner bot
  id; a specialist result cannot complete the mission.
- Budget pause surfaces `ask-for-unblock` with a reason, and does
  not look like Stop.
- Default config: evidenced, policy-clean work records an `access`
  gate and **zero** mutating HTTP (locks closed).
- Locks open + evidence + in-flight: one attested write, readback,
  no second write on already-done.
- A person is not required to route a specialist hop when standing
  consent for that hop already exists.
