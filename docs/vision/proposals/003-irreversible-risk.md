# 003 — Humans for irreversible risk; claims that heartbeat

Status: draft
Owner: unassigned
Plan: —
Related: [002](002-gates-not-votes.md),
[005](005-exclusive-resource-leases.md),
[approval-levels.md](../../approval-levels.md),
[spend-cap](../../verification/spend-cap.md)

## Problem

Human-in-the-loop products fail in two opposite ways: they page a
person for reversible work, or they let a bot do something that
cannot be undone.

This tree already splits some of that correctly:

- Setup Guide cannot emit permissions, connections, or write
  flags ([setup-wizard](../../verification/setup-wizard.md)).
- Spend cap refuses the next turn at the workspace limit
  ([spend-cap](../../verification/spend-cap.md)).
- Shared-task Stop cancels queued work and will not let a late
  result reopen the task ([shared-work.md](../../shared-work.md)).
- Full access and connection writes are elevated, default-narrow
  grants ([approval-levels.md](../../approval-levels.md); PR #18
  locks).

What is still muddy:

- Ownership is "whoever is coordinating," not a claim that
  heartbeats and can be reclaimed (Hermes kanban, already cited
  in goal-mode v2; computers already do a weaker form).
- Routine complete / merge is easy to treat as *the product
  forever refusing to finish*, instead of an irreversible action
  behind locks.
- Ask, Stop, budget pause, and `needs-input` read similarly in
  the UI even though only some of them are irreversible or
  operator-only.

Token cost: relaunching a coordinator because the last one died
mid-claim. Stop-friction: paging a person to retry CI, or
silently writing to a tracker because a mission was "working."

## Proposal

**Irreversible vs reversible.** A person (or an explicit lock
they already opened) is required for:

| Irreversible | Reversible (team may do) |
|---|---|
| Attested complete / merge (`act` commit) | Draft change requests, comments, local commits |
| Spend above the cap; budget renew | Turns inside the remaining cap |
| Delete team / bot; Full access; credentials | Inventory refresh, watch checks, retries |
| Computer takeover from a live turn | Waiting for the lease to free ([005](005-exclusive-resource-leases.md)) |

This is the usual HITL cut (payments, deploy, delete), not a
vague "architecture and blatant breakage" list. Architecture
still needs a person *when it is a choice of fundamentals*; that
is `needs-input` with a question, not a standing approval card
on every hop.

**Consent is a lock, not a personality.** Completing external
work stays the three locks in PR #18: workspace flag, connection
allowlist, live `mayWrite()`. Off means dry-run and an `access`
gate — the team is not "broken," it is not allowed to do the
irreversible bit. Cursor background agents work the same way:
the agent opens the change; a person (or a pre-set auto-merge
policy) does the merge.

**Claim, heartbeat, reclaim.** One owner bot at a time on a
task or mission, stored on the existing work record — no second
board. The owner heartbeats while it runs (computers and the
Hermes note in goal-mode v2 already describe this). Silence past
a budget reclaims the claim for another eligible bot. A
specialist assignment is not ownership. Restart without replay
stays (shared-work already fails unfinished assignments).

**Stop is a decision; pause is not Stop.** Budget exhaustion and
"I need a lock opened" stay owned and wait. Stop cancels the
attempt. Work and goal cards must not use one raised-hand for
both.

## Non-goals

- Multi-owner tasks, or ownership by "the team" with no bot id.
- Letting a claim bypass locks, invent credentials, or promote
  claimed evidence to observed.
- A Settings toggle the Setup Guide can flip.
- Replacing bot-tool implementation with server writes for
  ordinary (reversible) work.

## Open questions

1. Is the mission coordinator always the claimant, or may a kit
   name a separate completer? Prefer one claimant for v1.
2. Client-created missions: allowed (writes still locked) or
   admin-only? Decide before the auth slice in PR #18 P1.
3. Reclaim target: any idle teammate with the connection, or
   only a Chief? Prefer "eligible and idle" so a dead Chief
   does not strand the work.

## Success signals

- Default config + evidenced work: `access` gate, **zero**
  mutating HTTP.
- Locks open + evidence + in-flight: one attested write,
  readback, no second write on already-done.
- A fixture that kills the owning turn mid-mission reclaims
  without a human and without replaying the dead attempt.
- Budget pause and Stop are distinguishable in the overview
  payload (different fields, not just copy).
- Setup Guide commit fixtures still contain no write flags.
