# 005 — Exclusive resource leases

Status: draft
Owner: unassigned
Plan: —
Related: [computer-wait](../../verification/computer-wait.md),
[bot-concurrency](../../plans/2026-09-02-bot-concurrency.md),
[003](003-irreversible-risk.md)

This proposal is **not** from the operator sketch (votes, keep
working, one tracker+VCS loop). It comes from behavior the
harness already has for computers and still lacks for every
other scarce resource.

## Problem

Agent teams share things that cannot safely be written by two
turns at once: a cloud desktop, a local VM, a host seat, a
working folder, a browser profile, a connection's write slot.

The harness already gets this right for **one** case. A second
thread under the same bot waits without another provider prompt;
Stop on the waiter does not interrupt the owner; when the owner
stops, the waiter starts — no Retry, no extra user message
([computer-wait](../../verification/computer-wait.md)).
`shared/computer-contention.ts` exists so "busy" is not
misread as "couldn't reach the computer." Group local-VM routing
is explicit that contention copy must not send the model into a
retry storm.

Everywhere else, the rule is tribal:

- Bot-concurrency (Sep 2) still treats opt-in parallel turns as
  needing "exclusive leases on the bot's computer *and any
  shared working folder*" — the folder half is unbuilt.
- Browser profiles and connection writes have no wait-then-start
  lane.
- A dead holder can strand a desktop until a person notices;
  computers heartbeat in some paths, missions do not reclaim.

Claude Code's own agent-team note (cited in that concurrency
plan) is the same physics: one teammate, one process, one task.
Devin-style ticket runners and Cursor background agents also
serialize on the checkout and the machine, then hand a person
the irreversible merge. We should not invent a softer rule.

Token cost: a model that retries a 409 as if the computer were
down. Stop-friction: a person dispatching who may use the VM.

## Proposal

**One lease type.** A scarce resource has an id, a holder
(bot + thread + turn generation), a heartbeat, and a wait
queue. Resources at v1:

| Resource | Exists today | Gap |
|---|---|---|
| Bot cloud / team computer | Wait-then-start, turn-spanning ownership | Reclaim on dead heartbeat |
| Local VM / host seat | Per-speaker routing; honest busy | Same lease object |
| Shared working folder | Called out, not built | Exclusive writer |
| Browser profile | Contention-adjacent | Exclusive or explicit snapshot |
| Connection `act` write slot | Locks are consent, not a mutex | One in-flight commit per connection |

**Wait is the feature.** A blocked acquirer does not start a
second provider turn (computer-wait already). It does not vote.
It does not page a person unless the wait exceeds the existing
availability window (30 minutes by default) — that expiry is
`needs-input`, not a silent hang.

**No interleaving.** Desktop ownership already spans a turn so
screenshot/click cannot interleave. Folders and write slots get
the same generation fence: a superseded attempt cannot complete
a newer claim.

**Reclaim on silence.** If the holder dies (no heartbeat, turn
failed, process gone), the lease frees and the next waiter
starts. Do not replay an operation with an unknown outcome —
`SharedComputers` already refuses that on disconnect. Missions
reuse the same rule for attested writes: unknown → dry-run,
not a second PUT.

**UI tells the truth.** Busy-because-leased is not an error
(the computer panel lesson). Work overview should show "waiting
for &lt;resource&gt;" the same way rooms already show waiting
for the team computer.

## Non-goals

- Simultaneous control of one screen or one working tree.
- A general distributed lock service.
- Leasing *models* or *API keys* (spend cap already bounds
  those).
- Making `waiting-on-you` (a human card) look like a resource
  lease. Different bucket: irreversible or a question, see
  [003](003-irreversible-risk.md).

## Open questions

1. Is the first slice "folders + reclaim on computers" only,
   with browser and write-slot as follow-ups?
2. Cross-bot folder leases: team-scoped (any teammate waits)
   or bot-scoped? Team-scoped matches shared working folders.
3. Does a Chief Full-access hop inherit the sender's lease, or
   must it acquire its own? Prefer acquire-own so Stop on the
   Chief cannot yank a specialist's desktop mid-click.

## Success signals

- Two threads, one folder: the second waits with no extra
  provider prompt, then starts when the first settles — the
  computer-wait fixture shape, for a folder.
- Killing the holder frees the lease; the waiter starts; no
  unknown write is replayed.
- A 409 from a leased computer is classified as wait, never as
  "computer unavailable" (existing contention wording stays).
- Isolated fixtures only; no live Box or host desktop.
