# North star

OpenMausBot is a platform where **agent teams finish work**.

Give a team connectors and explicit consent, and it should pick up
work, do the work, coordinate without a person in every hop, and
complete the work. Human attention is reserved for architecture,
fundamentals, and blatant breakage — not routine pull, build, submit,
or complete.

That is the product. One operator's tracker, code host, and coding
agent are a **reference kit**, not the app.

## The shape

**Agent teams.** A team is a set of bots that can own a deliverable
end-to-end: inventory, implementation, review, evidence, completion.
Roles (coordinator, specialist, reviewer) are capabilities on bots,
not a second product. Shared tasks, rooms, and missions are the same
work record seen at different altitudes — see
[shared-work.md](../shared-work.md).

**Pluggable work sources.** Work arrives from trackers, code hosts,
issue systems, mail, chats, or a person typing. The platform speaks
**kinds** (`work_item`, `change_request`, `build`, `comment`, …) and
**status categories**. A vendor name is a connector label, never a
branch in the runner, Work UI, or a core enum. See
[connectors.md](../connectors.md) and the
[task-connectors plan](../plans/2026-09-23-task-connectors.md).

**Human attention is a scarce gate.** A person is in the loop when
the decision is architectural, a fundamental is unset, or something
is blatantly broken. Routine motion — claiming the next item, opening
a change request, waiting on CI, asking a teammate, marking done —
is team work. If a feature spends a human turn on that motion, it is
off-star.

**Keep-working is the default.** A stop is either a true human gate
or something the team can resolve (retry, ask a teammate, take a
structured vote). Silent hangs, swallowed errors, "both vendors
required", and other accidental friction are not stops; they are
product bugs. See
[proposal 001](proposals/001-agent-team-keep-working.md).

**Consent is a lock the operator opens.** Safety stays real: attested
writes, fail-closed inventory, explicit write allowlists. Those are
**trust locks** an operator enables so a team may complete. They are
not the forever end-state of "bots never finish anything." See
[proposal 003](proposals/003-bot-ownership-and-consent.md).

## What this is not

- Not "one tracker + one code host + one coding agent, auto-merged
  for one team." That pairing is the first **kit**: a tracker role, a
  code-host role, a coding-agent role. Other teams run tracker-only,
  code-host-only, a different issue system, two git hosts, or
  chat-started work on the same platform.
- Not a second product for "everyone else." One model, many kits.
  Align with `docs/plans/2026-09-25-flexible-team-work.md` when that
  file is on the branch; today it lives only on
  [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18).
- Not an unsupervised write surface. Completing external work is an
  optional, fail-closed action. Off until the operator unlocks it.
- Not a requirement that every decision be a long multi-bot debate.
  Cheap consensus exists so "is this really a human stop?" does not
  cost a deliberation turn each time
  ([proposal 002](proposals/002-cheap-team-voting.md)).

## Test against a feature PR

Answer both before merge:

1. **Finish more work?** Does this make an agent team more able to
   complete a deliverable once connectors and consent are in place?
2. **Stay general?** Does this avoid boxing the product into one
   tracker + one code host + one coding agent?

If (1) is no, it is not on the north star. If (2) is no, it belongs
in a kit or example, not in core.

A useful extra: **honest stop?** If the change introduces a wait, is
that wait a true human gate, a team-resolvable question, or
accidental friction?

## Durable bets

These should still be true a year from now:

- Kinds and kits, not vendor-shaped core
  ([proposal 004](proposals/004-kits-not-product-shapes.md)).
- One work record per deliverable. Bots implement. Connectors
  observe. The server may complete only through attested, locked
  actions.
- Token-cheap by default: detect in code, decide with a model only
  when a rule matches; vote with a ballot, not a symposium.
- Ownership is explicit. A task or mission has one owner at a time,
  a budget to keep going, and a way to ask for unblock that is not
  the same as stop.
- The operator can see what the team did (observed evidence,
  decision log) without having been in the loop.
