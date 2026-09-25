# 002 — Gates and required checks, not team votes

Status: draft
Owner: unassigned
Plan: —
Related: [001](001-reconcile-to-observed.md),
[003](003-irreversible-risk.md),
[approval-levels.md](../../approval-levels.md)

## Problem

"Is this really a human stop?" is a real question. Answering it
with a **team vote** (structured ballots, quorum, LLM
deliberation) is the expensive, unreliable answer.

This repo already refuses to take a model's word: claimed
evidence cannot complete a task, and goal-mode v2 adds a
no-progress guard because a self-reporting model can emit
`continue` forever with zero tool calls. A vote among the same
models does not make that true. Routing and talk are not a
judgment.

Token cost of a ballot-per-teammate is in the same order as asking
the person. Stop-friction of *not* having *some* cheap path is
also real — but the cheap path already exists in pieces:

- `BacklogGate` kinds: `scope`, `inventory`, `task`, `review`,
  `policy`, `access`, `budget`.
- Observed / synced evidence required before completion; claimed
  → `needs-input` (`server/work-items.test.ts`).
- Live provider policy (required approval rules, mergeable, unique
  Done transition) in the mission actions — once they are not
  hardcoded role names.
- Decision log and task `decisions[]`.
- Native required checks on the code host.

GitHub does not merge because three teammates voted. It merges
when required checks are green, CODEOWNERS (if any) are satisfied,
and the merge queue has a clean head. That is cheap consensus
without LLM chatter.

## Proposal

**Policy is the vote.** A wait is allowed to clear when, and only
when, its declared gates are satisfied. Gates are data: check
names, evidence ids, live provider fields, allowlists. They are
not a show of hands.

**Reuse before recompute.** Same gate kind + same reason code +
same head or inventory revision → cite the decision log (ADR
style). Do not start a specialist thread to re-ask.

**Electorate is a check, not a bot.** If an org wants a "security"
pass, that is a required rule name on the connection (or a
required CI check), not a bot named Security who must speak. PR
#18 already moves `"Security"` / `"Manager"` out of TypeScript;
this proposal says: do not replace those constants with voters.

**Discussion stays for design.** Rooms, `coordinate_bots`, and
any future chair/decide flow are for architecture and briefs.
They are not the merge bit, the Done bit, or the
"is this a human gate?" bit.

**Independent verification is evaluation, not suffrage.**
Goal-mode v2's later Grok Build panel (hidden evaluator, then a
small refute panel) is a *check*: a detached task with a schema.
If we ever add it, it reports `continue | candidate_complete |
blocked`, it does not campaign among teammates. A human sees
`contradiction | unverifiable`, not a tally.

**Why not ship ballots first.** They invite a second coordination
system, they cost turns, and they cannot open a trust lock. If a
later plan still wants an advisory ballot, it sits behind this
proposal and cannot bind attested writes.

## Non-goals

- Liquid democracy, ranked choice, voter reputation.
- Replacing Chief / coordinator assignment with a majority.
- Skipping fail-closed inventory or observed-evidence rules
  because a ballot passed.
- Per-vendor ballot types.

## Open questions

1. First slice: persist gate snapshots on the work record so Work
   can show "required checks" the way a PR shows CI, without a
   new UI invention?
2. Do we ever want the Grok Build-style detached verifier in
   mid-term, or is observed evidence + live provider policy
   enough?
3. Client-visible "why this is waiting" should list unsatisfied
   gates only — confirm no parallel prose status?

## Success signals

- Work / mission fixtures explain a wait as a gate list
  (`inventory`, `review`, `access`, …), never "awaiting vote."
- Reused decision: second identical gate on the same revision
  spends no model turn.
- A discussion room cannot call `act(..., commit)` ; only the
  coordinator after gates pass and locks are open.
- Production code has no compiled extra approval-rule names;
  those strings live on the connection or kit.
- Isolated tests script gate satisfaction; they do not need a
  live model to "agree."
