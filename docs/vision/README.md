# Product vision

This directory is the shared source of truth for **where the product is
going**. Implementation plans stay in [`docs/plans/`](../plans/).
User-facing help stays in `apps/docs/`. Verification recipes stay in
[`docs/verification/`](../verification/).

Read in this order:

1. [North star](north-star.md) — durable product direction. Feature
   PRs are tested against it.
2. [Goals](goals.md) — near and mid work, split into **platform** vs
   **example-kit**.
3. [Proposals](proposals/README.md) — living backlog of product
   decisions that later become plan slices.

## Who this is for

Humans and agents. A later routine will watch these files and keep
build-out moving. Until then, status lives in the files themselves.

Operator notes are one input among many. If a clearer frame or a
simpler mechanism shows up in the tree (or in a pattern we
actually use), it outranks a sketch. Do not shoehorn proposals
to match one person's wording.

## How to add a proposal

1. Read the [north star](north-star.md) and [goals](goals.md). If the
   idea fails the north-star tests, stop or rewrite it as a kit, not
   core.
2. Skim [proposals/README.md](proposals/README.md). Reuse or extend an
   existing proposal instead of opening a parallel one.
3. Copy [proposals/TEMPLATE.md](proposals/TEMPLATE.md) to
   `proposals/NNN-short-slug.md` using the next unused number.
4. Leave `Status: draft`. Fill every section. Keep it short and
   decision-oriented.
5. Add a row to the index table in `proposals/README.md`.
6. Open a PR. Review moves the status; the author does not
   self-accept.

Do not put implementation checklists here. When a proposal is
accepted, write a dated plan under `docs/plans/` and point the
proposal at it.

## Status tracking

| Layer | What moves | Who updates it |
|---|---|---|
| North star | Rarely. A rewrite is a product decision. | Human review |
| Goals | When a phase lands or a plan is accepted | The PR that lands the work |
| Proposal `Status:` line | `draft` → `accepted` → `in-plan` → `done` / `rejected` | Reviewer, then the plan PR |
| `proposals/README.md` index | Must match each file's `Status:` | Same PR as the status change |

Rejected proposals stay in the tree with a one-line reason so the
same idea is not reopened without new evidence.
