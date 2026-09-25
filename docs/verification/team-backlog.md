# Team backlog mission and Work view

Use the isolated fixture only. It starts a temporary OpenMausBot home and a
loopback-only synthetic Jira/GitLab service; it never connects to an account or
the user's running app.

```sh
pnpm exec vitest run server/work-coordination.test.ts server/work-items.test.ts server/connectors/jira/jira.test.ts server/connectors/gitlab/gitlab.test.ts server/ongoing-goals.test.ts server/ongoing-goals.e2e.test.ts server/team-backlog.e2e.test.ts server/team-backlog.test.ts server/team-backlog-actions.test.ts server/routes/work-overview.test.ts src/components/WorkPage.test.ts --maxWorkers=2
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
both external lists finish, and that open work instead appears in the Work
overview without any synthetic Jira transition or GitLab merge.

Before rollout, run `pnpm lint`, `pnpm typecheck`, `pnpm build`, and
`pnpm build:server`. Identify the connected workspace explicitly and check
that its running turns are quiescent before replacing its server/UI. Do not
point the disposable fixture at the live server. After deployment, start one
goal with the supplied outcome in the current team, read its actual inventory
and gates, and read back Jira and MR outcomes. Those live observations are
rollout checks, not test data or permission to bypass a review/policy gate.
