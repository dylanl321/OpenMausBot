# Proposals

Decision-oriented product ideas. Short on purpose. An accepted
proposal becomes a dated plan under `docs/plans/`; it is not itself
an implementation checklist.

Operator sketches (one team's tracker+VCS loop, team voting,
keep-working as a slogan) are **inputs**. They are not the closed
set. Prefer a mechanism the tree already has — or a simpler
outside pattern that fits — over padding those notes.

## Lifecycle

```text
draft → accepted → in-plan → done
                 ↘ rejected
```

| Status | Meaning |
|---|---|
| `draft` | Written, not yet a product decision. Default for new files. |
| `accepted` | Direction is agreed. A plan may be written. |
| `in-plan` | A `docs/plans/` slice exists and is linked from the proposal. |
| `done` | The plan's acceptance criteria landed. Link the implementing PRs. |
| `rejected` | Will not be built. Keep the file; state the reason in one line. |

Only a reviewer (human, or an agent acting on an explicit review
request) may move a proposal out of `draft`. The author does not
self-accept.

## Index

Keep this table in the same PR as any status or filename change.

| # | Title | Status | Plan |
|---|---|---|---|
| [001](001-reconcile-to-observed.md) | Reconcile to observed outcomes | draft | — |
| [002](002-gates-not-votes.md) | Gates and required checks, not team votes | draft | — |
| [003](003-irreversible-risk.md) | Humans for irreversible risk; claims that heartbeat | draft | — |
| [004](004-kits-and-setup-shapes.md) | Kits and Setup Guide shapes | draft | [flexible-team-work](../../plans/2026-09-25-flexible-team-work.md) (kit JSON shipped; Setup Guide apply path still draft) |
| [005](005-exclusive-resource-leases.md) | Exclusive resource leases | draft | — |

005 is a finding from computer-wait / shared computers / bot
concurrency, not from the operator sketch.

## Demoted sketches

Not rejected forever; not the center. Do not reopen as the north
star without new evidence.

| Sketch | Why it is not the center | Where it went |
|---|---|---|
| "Keep working" as a stop taxonomy | Consequence of reconciliation; the work is naming watches, leases, and gates | [001](001-reconcile-to-observed.md) |
| Team vote as cheap consensus | Required checks and reused decisions are cheaper; models can agree in prose and still fail the evidence rule we already enforce | [002](002-gates-not-votes.md) |
| Named owner + ask-for-unblock as the ownership story | Weaker than claim + heartbeat + irreversible-vs-reversible | [003](003-irreversible-risk.md) |
| One tracker + VCS auto-merge as the app | A shape you apply, not core | [004](004-kits-and-setup-shapes.md) |

## How to add one

See [the vision index](../README.md#how-to-add-a-proposal). Use
[TEMPLATE.md](TEMPLATE.md). Next number is one higher than the
highest `NNN-` prefix in this folder (005 → 006).

Prefer extending an existing draft over opening a near-duplicate.
Three to six strong proposals beat a laundry list.

## What belongs here

A proposal is the right shape when it changes how agent teams
reconcile, gate, lease, consent, or plug work sources in; can
later be sliced into a plan with tests; and is not already
decided in the [north star](../north-star.md).

A proposal is the wrong shape when it is a bug fix, a vendor-only
tweak, an implementation sequence, or a restatement of one
operator's loop as if it were the platform.

## Tracking

The `Status:` line in each file is canonical. This index must match
it. A later routine may watch `docs/vision/proposals/` and drive
build-out from `accepted` / `in-plan` rows. Until that exists,
humans and agents update both places in the same PR.
