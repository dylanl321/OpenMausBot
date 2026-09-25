# 002 — Cheap team voting

Status: draft
Owner: unassigned
Plan: —
Related: [001](001-agent-team-keep-working.md),
[003](003-bot-ownership-and-consent.md),
[approval-levels.md](../../approval-levels.md)

## Problem

"Is this really a human stop?" is asked often and answered
expensively.

Today the expensive paths are: page a person (`waiting-on-you`,
peer-approval, `needs-input`), or start a multi-turn discussion
(sequential room talk, a chair, several specialist hops). Both are
right for architecture. Both are wrong for "CI went red on a flake
we have seen," "the review comment is nits," or "do we treat this
label as `blocked` or `in_progress`?"

Token cost is the constraint. A vote that costs a full deliberation
turn per teammate is not cheaper than asking the human. Stop-friction
is the other constraint: if the cheap path does not exist, every
ambiguous wait becomes a human gate.

## Proposal

Add a **ballot**, not a parliament.

- **Structured, short options.** A ballot is a closed set
  (`continue` / `ask-human` / `retry` / `block`) plus an optional
  one-line reason code. No free-form debate in the default path.
- **Cheap to cast.** Prefer one short structured completion per
  voter, or a code path when the shape has been seen before. Do not
  open specialist threads, do not replay the task brief, do not
  require every member.
- **Reuse prior decisions.** The existing decision log and task
  `decisions[]` are the first lookup. Same gate kind + same reason
  code + same connection → reuse, do not revote. Watches that
  suppress self-writes already show the pattern: detect in code,
  decide only on a new shape.
- **Quorum without a symposium.** Default: owner plus one other
  eligible teammate, or a configured majority of a small electorate
  (coordinator, named reviewer role — roles from the kit, not
  compiled vendor names). Timeout is a documented outcome
  (`ask-human` or owner's casting vote), never a silent hang.
- **Advisory vs binding.** A ballot may resolve a
  [001](001-agent-team-keep-working.md) team-resolvable wait. It
  cannot open a trust lock, enter credentials, or complete an
  attested write that [003](003-bot-ownership-and-consent.md) forbids.

Compose with what exists. Peer-approval stays the human card for
bot-to-bot hops that the operator still wants to see. Chief Full
access stays a standing consent grant, not a vote. Room discussion
stays available for real design. Voting is the cheap off-ramp those
mechanisms do not have.

## Non-goals

- Liquid democracy, ranked choice, or persistent voter reputation.
- Replacing the coordinator / Chief decision on ordinary assignment.
- Voting on whether to ignore fail-closed inventory or skip
  observed-evidence rules.
- A chatty "council" engine as the default. If an engine can host
  one, it is an implementation, not the product shape.
- Per-vendor ballot types. The ballot is about wait buckets and
  reason codes, not about one host's approval rule names.

## Open questions

1. Default electorate: owner + one, or kit-defined roles only?
2. May a binding vote demote a wait that was labeled human gate, or
   only classify unlabeled waits?
3. Should reused decisions expire (time, head-sha, inventory
   revision), and what is the first conservative default?
4. Is the first slice read-only / advisory (log the ballot, owner
   still acts) so we can measure token cost before binding?

## Success signals

- A repeated "retry CI / ask human" wait is resolved from the
  decision log with **no** new model turn after the first ballot.
- A new wait of that shape costs at most one short structured call
  per voter, not a specialist thread each.
- Timeout produces `ask-for-unblock` or `ask-human`, never an idle
  hang.
- Fixtures prove a ballot cannot fire `act(..., commit)` when
  trust locks are closed.
- Isolated tests do not need a live model: scripted structured
  votes are enough.
