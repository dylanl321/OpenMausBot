# 001 — Agent teams keep working

Status: draft
Owner: unassigned
Plan: —
Related: [north star](../north-star.md), [002](002-cheap-team-voting.md),
[003](003-bot-ownership-and-consent.md), [shared-work.md](../../shared-work.md)

## Problem

Teams already pause for real reasons (missing credentials, an
incomplete inventory, a policy gate, a person who must choose
architecture). They also pause for reasons that are not gates:

- A wait that looks like `needs-input` because the runner assumed a
  particular vendor pair, or because the UI offered a route the
  session cannot call.
- A specialist parked on `waiting-on-you` for routine pull / build /
  submit / complete.
- A silent hang: a recovered follow-up that never resumes, a
  swallowed 403, a poll that looks idle.
- A "stop" that a teammate or a short vote could resolve ("is this
  actually blocked, or do we rerun CI?").

Stop-friction is the product leaking into the team's day.
Token cost is secondary here but real: every false stop either burns
a coordinator turn restating the same question or pages a human.

## Proposal

Classify every wait. Three buckets, no fourth:

| Bucket | Meaning | Who moves it |
|---|---|---|
| **Human gate** | Architecture, an unset fundamental, blatant breakage, or a trust lock the operator has not opened | A person |
| **Team-resolvable** | The team can retry, ask a teammate, wait on a watch, or take a cheap vote ([002](002-cheap-team-voting.md)) | The owning bot or the team |
| **Friction** | Accidental. Incomplete inventory shown as empty success, hardcoded pairing, silent hang, honest UI lying | A product fix; not a workflow |

Keep-working is the default. A state is allowed to be `waiting` or
`needs-input` only if it is a human gate or a team-resolvable
question with an owner and a next action. Friction is a defect.

Reuse the records we already have. Shared tasks, missions, and
`/pursue` goals already carry status, gates, and evidence. Do not
add a second "stuck board." Teach those records to name the bucket
and the unblock path (`ask-for-unblock` vs `stop` — see
[003](003-bot-ownership-and-consent.md)).

Detection stays cheap: watches and connector scans decide *whether
anything changed* without a model
([task-connectors plan](../../plans/2026-09-23-task-connectors.md)).
A model runs when a rule matches or when a wait must be classified.
Reclassification of a repeated wait should hit the decision log
first, not start a new deliberation.

## Non-goals

- Removing trust locks or auto-enabling attested writes.
- A visual taxonomy explorer or a new sidebar section.
- Treating every approval card as team-resolvable. Native provider
  questions and missing credentials stay human gates.
- A second workflow for one operator's tracker + code host.

## Open questions

1. Who may demote a wait from human gate to team-resolvable — only
   the operator, or also a quorum under [002](002-cheap-team-voting.md)?
2. After a team-resolvable wait times out, does it escalate to a
   human gate or to `ask-for-unblock` on the owner?
3. Are recovered-follow-up hangs in scope for the first plan slice,
   or is the first slice classification + honest `needs-input` only?

## Success signals

- A team with one query-capable connection can run a mission after
  a valid scope choice; "missing the other vendor" is not a stop.
- Work and goal UIs do not offer actions the session cannot call;
  a 403 is shown, never swallowed.
- An incomplete scan cannot complete a mission (already true; keep
  it as a classification of inventory → human or team gate, never
  "empty / done").
- A routine change-request flow that is waiting on CI or a teammate
  review does not page a person unless a trust lock or a real
  policy gate says so.
- New waits in tests assert a bucket and an unblock path.
