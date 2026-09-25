# 001 — Reconcile to observed outcomes

Status: draft
Owner: unassigned
Plan: —
Related: [north star](../north-star.md),
[task-connectors](../../plans/2026-09-23-task-connectors.md),
[goal-mode v2](../../plans/2026-09-02-goal-mode-v2.md),
[shared-work.md](../../shared-work.md)

## Problem

Work already has a desired state (goal text, acceptance criteria)
and an observed state (connector sync, capture, watches). The
harness does not yet treat those as one loop.

What happens instead:

- A routine prompt asks "any new stories?" on a timer, even when
  nothing changed (the problem watches were designed to kill).
- A mission can look `needs-input` because a vendor pair is
  missing, not because the world is unknown.
- An incomplete scan can be mistaken for "nothing left" unless
  every path remembers fail-closed inventory.
- A model can say `continue` or "ready for review" while tools did
  nothing. Goal-mode v2 already names this (Grok Build's stop
  detector; Claude Code's no-progress guard) and it is not fully
  the product yet.

Token cost: detection that should be free. Stop-friction: waits
that are really "we did not look" or "the prompt was polite."

A "keep working" taxonomy (human vs team vs friction) describes
symptoms. Reconciliation names the mechanism.

## Proposal

**Desired vs observed, on one record.** A goal or shared task
states criteria. Connectors and capture fill `links` and events
with `observed` / `synced` / `claimed`. Complete is a function of
a fresh complete scan plus observed evidence — the rule
`server/work-items.ts` already uses, applied everywhere a mission
or routine wants to finish.

**Detect in code; act on a match.** Watches and connector `changes`
are the tick. No match → record "checked, 0" and spend no tokens
(task-connectors P9). A match wakes the existing goal or routine;
it does not fork a second coordinator. Goal-mode v2 is right that
a goal is not a scheduler: routines and watches inject *turns*
into the conversation that already carries the objective.

**Wait is a first-class verdict.** Borrow the Hermes / OpenClaw
shape already cited in goal-mode v2: `continue | completed |
needs-input | blocked | wait`. `wait` parks on a named watch,
lease, or check without burning a turn. A polite "let me know if
you need anything" is not `completed`.

**Failed observation is incomplete, never done.** Keep the
ongoing-goals / team-backlog rule: query errors retain the last
good inventory and last successful timestamp. Disappearing items
are re-fetched. This is Kubernetes-style reconciliation: a failed
read is a requeue, not success.

**Linear / GitHub automation is the product analog.** Those tools
run a rule when an issue or PR *changes*, not every quarter hour.
OMB already specified that; missions and `/pursue` should consume
it instead of growing a parallel poller.

## Non-goals

- A second desired-state language or workflow engine.
- Two-way field sync into trackers.
- "Keep working" as a user-visible mode or sidebar.
- Completing on claimed evidence, or on an incomplete scan.
- Treating one vendor pair as the only world that can be observed.

## Open questions

1. Is `wait` a goal status we persist (goal-mode v2 sketched it)
   or only a runner verdict that maps to `waiting` plus a watch
   id?
2. When a watch fires for a settled task, is that a new revision
   (today's `input` fingerprint) or a wake of the same revision?
   Prefer today's fingerprint unless the change is status-only.
3. First slice: wire missions to existing watches only, or also
   add `wait` to 1:1 `/pursue`?

## Success signals

- A fixture with 100 idle watch checks and zero model turns,
  then one change and exactly one wake (already the P9a exit;
  missions must use it).
- An incomplete scan cannot complete a mission.
- A goal that emits "ready for review" with no tool events
  since the last user message pauses as no-progress, not done.
- Tracker-only and code-host-only teams reconcile their own
  kinds; they do not wait on a vendor that was never connected.
