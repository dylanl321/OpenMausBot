# Team backlog mission and Work view

Use the isolated fixture only. It starts a temporary OpenMausBot home and a
loopback-only synthetic Jira/GitLab service; it never connects to an account or
the user's running app.

```sh
pnpm exec vitest run server/work-coordination.test.ts server/work-items.test.ts server/connectors/jira/jira.test.ts server/connectors/gitlab/gitlab.test.ts server/ongoing-goals.test.ts server/ongoing-goals.e2e.test.ts server/team-backlog.e2e.test.ts server/team-backlog.test.ts server/team-work-kits.test.ts server/team-backlog-actions.test.ts server/routes/work-overview.test.ts src/components/WorkPage.test.ts --maxWorkers=2
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
deduplication against shared work hubs.

The e2e case sends the exact misspelled backlog prompt into a team with an
assigned Jira board. It proves that an empty backlog is complete only after
the scoped inventory finishes, and that open work instead appears in the Work
overview without any synthetic Jira transition or GitLab merge.

A mission is ready when it has at least one query-capable scope and no
unresolved choices. Jira-only, GitLab-only, and Plane-only teams can leave
`needs-input` after a valid one-sided choice. The default `jira-gitlab` kit
still inventories Jira `work_item`s and GitLab `change_request`s only (GitLab
issues stay dropped) until the team uses a `gitlab` kit or adds `work_item`
to that scope. GitLab-only fixtures include issues and merge requests.

Verify the kind-driven suites with:

```sh
pnpm exec vitest run server/team-backlog.test.ts server/team-work-kits.test.ts server/team-backlog.e2e.test.ts server/ongoing-goals.test.ts src/components/WorkPage.test.ts --maxWorkers=2
```

**Writes stay off unless both locks are set.** Default config and default
connections never send PUT/POST/PATCH/DELETE for a merge or Jira Done
transition. Policy probes still run so Work can show missing reviews. To
unlock a synthetic write in an isolated fixture only:

1. `features.teamMissionWrites: true` in that fixture's `config.json` (no
   Settings toggle; absent = off).
2. On that connection, `writes.enabled: true` and the action on
   `writes.allow` (`complete_work_item` or `merge_change_request`).

Either lock closed records an `access` gate and leaves the tracker/MR
unchanged. Do not enable these locks against live tokens from a recipe.

Before rollout, run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
`pnpm build:server`. Identify the connected workspace explicitly and check
that its running turns are quiescent before replacing its server/UI. Do not
point the disposable fixture at the live server. After deployment, start one
goal with the supplied outcome in the current team, read its actual inventory
and gates, and read back Jira and MR outcomes. Those live observations are
rollout checks, not test data or permission to bypass a review/policy gate.
