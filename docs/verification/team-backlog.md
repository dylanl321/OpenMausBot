# Team backlog mission and Work view

Use the isolated fixture only. It starts a temporary OpenMausBot home and a
loopback-only synthetic Jira/GitLab service; it never connects to an account or
the user's running app. **Never point a recipe at live Jira, GitLab, Plane, or
the user's live app.**

Desk-test always starts here: fixtures first. Real tokens are an operator
checklist after P0+P3+P4, not CI. See [Desk-test](#desk-test) and
[Operator checklist (real tokens)](#operator-checklist-real-tokens).

Write locks stay off unless both workspace and connection locks are set.
Absent `features.teamMissionWrites`, absent `writes.enabled`, or an empty
`writes.allow` means dry-run only. Do not enable live write locks in
repository config or CI.

## Default recipe (flag-off)

This is the default. Isolated launches and these suites leave
`features.teamMissionWrites` unset (off) and connections without `writes`.
Evidenced ready items record an `access` gate and send **no**
PUT/POST/PATCH/DELETE.

```sh
pnpm exec vitest run server/work-coordination.test.ts server/work-items.test.ts server/connectors/jira/jira.test.ts server/connectors/jira/actions.test.ts server/connectors/gitlab/gitlab.test.ts server/connectors/gitlab/actions.test.ts server/connectors/contract-suite.test.ts server/ongoing-goals.test.ts server/ongoing-goals.e2e.test.ts server/team-backlog.e2e.test.ts server/team-backlog.test.ts server/team-work-kits.test.ts server/team-backlog-actions.test.ts server/routes/work-overview.test.ts server/bot-visibility.test.ts server/goal-live.test.ts src/components/WorkPage.test.ts src/lib/serial-refresh.test.ts src/lib/goal-live.test.ts scripts/check-connector-pr.test.ts --maxWorkers=2
```

With the pinned UI browser installed, run the real Work renderer against its
disposable fake-engine server and synthetic overview/decision responses:

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-backlog-ui.e2e.test.ts --maxWorkers=1
```

That fixture checks full request display, the one-time approve/deny/answer
path, a non-actionable decision-maker, and preservation of loaded pages on
refresh. It never connects to the user's active workspace.

The overview route fixture also checks direct bot tasks, team-room tasks and
pending main-conversation decisions, including hidden-thread filtering and
deduplication against shared work hubs. Source rows use kind-driven copy
(work item / change request), not Jira or MR labels. Work subscribes to
`goal` and `work.*` SSE frames and keeps a 30s fallback poll that does not
overlap an in-flight refresh. A member without hub access does not receive
another team’s mission `goal` frame.

The e2e case sends the exact misspelled backlog prompt into a team with an
assigned Jira board. It proves that an empty backlog is complete only after
the scoped inventory finishes, and that open work instead appears in the Work
overview without any synthetic Jira transition or GitLab merge. The isolated
server + loopback stub records mutating methods; flag-off cases expect none.

A mission is ready when it has at least one query-capable scope and no
unresolved choices. Jira-only, GitLab-only, and Plane-only teams can leave
`needs-input` after a valid one-sided choice. The default `jira-gitlab` kit
still inventories Jira `work_item`s and GitLab `change_request`s only (GitLab
issues stay dropped) until the team uses a `gitlab` kit or adds `work_item`
to that scope. GitLab-only fixtures include issues and merge requests.

The four kits load as data from
[`server/team-work-kits.json`](../../server/team-work-kits.json). Infer and
the runner use kit `kinds`, not provider-named core enums.

Verify the kind-driven suites with:

```sh
pnpm exec vitest run server/team-backlog.test.ts server/team-work-kits.test.ts server/team-backlog.e2e.test.ts server/ongoing-goals.test.ts src/components/WorkPage.test.ts --maxWorkers=2
```

## Writes-enabled recipe (synthetic HTTP only)

A **separate** path. Run it only against synthetic HTTP: the existing
isolated server + loopback stub, recorded connector fixtures, or the fake
connector. Never point it at live Jira/GitLab or a workspace `config.json`
that holds real tokens.

The suites below turn both locks on **inside the test process**. They do not
write `features.teamMissionWrites` into the fixture launcher or CI config.

```sh
pnpm exec vitest run server/team-backlog-actions.test.ts server/team-backlog.test.ts server/connectors/jira/actions.test.ts server/connectors/gitlab/actions.test.ts --maxWorkers=2
```

What this proves:

- Default `mayWrite` / no-flag: `changed: false`, `access` gate, dry-run
  only, zero mutating methods.
- Both locks on + still-active + fixtures: `commit` through `connector.act`
  with readback. The runner still does not name a provider.
- Stop mid-probe (`mayWrite` false after dry-run): no write.
- Contract suite: declared `actions` emit no PUT/POST/PATCH/DELETE on
  `dry-run`.

Policy probes still run (`dry-run`) so Work can show missing reviews when
locks are closed.

To desk-test `commit` against the loopback stub on an isolated
`control-omb` launch (not the user's app):

1. `node --experimental-strip-types scripts/control-omb.ts launch`
2. In **that fixture's** printed data directory only, set
   `features.teamMissionWrites: true` in its `config.json` (no Settings
   toggle; absent = off).
3. On **that fixture's** connection, set `writes.enabled: true` and put the
   action on `writes.allow` (`complete_work_item` or
   `merge_change_request`).
4. Run one evidenced item against the stub. Confirm exactly one mutating
   request and a matching readback.
5. Stop mid-probe. Confirm the stub saw no further write.
6. Turn both locks off again in that fixture.

Either lock closed records an `access` gate and leaves the tracker/MR
unchanged. Do not copy these settings into the user's config, repository
defaults, or CI.

GitLab merge policy is the live required `approval_state` rules, project
pipeline/discussion flags, and mergeable/not-draft. Optional connection
`requiredApprovalRules` (comma-separated names) add extras on top; empty
means live required rules only. A jira-gitlab team that still wants named
extras such as Security or Manager sets those names on the GitLab
connection. Jira completion uses the unique-Done heuristic unless
`doneTransitionId` or `doneTransitionName` is set. Missing
`approval_state.rules` or unknown policy fields fail closed and never write.

## Desk-test

Always, before any real token:

1. `node --experimental-strip-types scripts/control-omb.ts launch`
2. The [default recipe](#default-recipe-flag-off) above and
   [ongoing-goals.md](ongoing-goals.md).
3. Never point a recipe at the user's live app or real Jira/GitLab.

See also the plan's migration notes in
[`docs/plans/2026-09-25-flexible-team-work.md`](../plans/2026-09-25-flexible-team-work.md)
§10.

## Operator checklist (real tokens)

Only after P0+P3+P4 (fail-closed writes, connector `act`, config-driven
policy), on a **scratch** project the operator names, with both locks **off
first**. This sequence is a rollout checklist, not CI. Do not enable live
write locks in config or CI.

1. Run a mission flag-off: confirm inventory and gates, confirm the
   tracker/MR did not change (readback in the provider UI).
2. Enable locks on that connection only. Run one evidenced item.
3. Confirm exactly one write and a matching readback.
4. Stop mid-probe; confirm no write.
5. Turn locks off again.

Before a workspace rollout, also run `pnpm lint`, `pnpm typecheck`,
`pnpm build`, and `pnpm build:server`. Identify the connected workspace
explicitly and check that its running turns are quiescent before replacing
its server/UI. Do not point the disposable fixture at the live server.
Those live observations are rollout checks, not test data or permission to
bypass a review/policy gate.
