# Proposals

Decision-oriented product ideas. Short on purpose. An accepted
proposal becomes a dated plan under `docs/plans/`; it is not itself
an implementation checklist.

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
| [001](001-agent-team-keep-working.md) | Agent teams keep working | draft | — |
| [002](002-cheap-team-voting.md) | Cheap team voting | draft | — |
| [003](003-bot-ownership-and-consent.md) | Bot ownership and consent | draft | — |
| [004](004-kits-not-product-shapes.md) | Kits, not product shapes | draft | [PR #18](https://github.com/dylanl321/OpenMausBot/pull/18) (plan not on this branch) |

## How to add one

See [the vision index](../README.md#how-to-add-a-proposal). Use
[TEMPLATE.md](TEMPLATE.md). Next number is one higher than the
highest `NNN-` prefix in this folder (004 → 005).

Prefer extending an existing draft over opening a near-duplicate.
Three to six strong proposals beat a laundry list.

## What belongs here

A proposal is the right shape when it:

- changes how agent teams finish work, stop, vote, own, or consent,
  or how work sources plug in;
- can later be sliced into a plan with tests;
- is not already decided in the [north star](../north-star.md).

A proposal is the wrong shape when it is a bug fix, a vendor-only
tweak, or an implementation sequence. Those go to issues or
`docs/plans/`.

## Tracking

The `Status:` line in each file is canonical. This index must match
it. A later routine may watch `docs/vision/proposals/` and drive
build-out from `accepted` / `in-plan` rows. Until that exists,
humans and agents update both places in the same PR.
