# Ongoing goal pursuit

Run the server state-machine tests and the isolated fake-engine fixture:

```sh
pnpm exec vitest run server/ongoing-goals.test.ts server/ongoing-goals.e2e.test.ts server/ongoing-goals-auth.test.ts src/components/OngoingGoalPanel.test.ts --maxWorkers=1
```

The fixture starts a separate OpenMausBot process in a temporary home using
`launchVerificationServer`, never the user's running server. It checks explicit
creation, actual provider dispatch, a recorded completion and evidence, and
the absence of private pursuit control text from the conversation. Goal
changes also emit visibility-filtered `goal` SSE frames (id, revision, status,
detail, scan, gate counts). The goal panel and Work view subscribe and keep a
30s fallback poll; they do not start a second fetch while one is in flight.

Then run the adjacent coordination and watch regressions:

```sh
pnpm exec vitest run server/shared-work.e2e.test.ts server/group-goal-run.e2e.test.ts server/watches.test.ts --maxWorkers=2
```

`/goal` is still a bounded room run. `/pursue` asks only for the desired outcome
(and a coordinator when a room has several bots). The server generates a
private task-identity scope and default budgets. When the outcome cites exactly
one accessible existing task, it reuses that task's identity and links it;
ambiguous references do not grant access to an entire project. The coordinator
derives and records observable acceptance checks in its private decision before
it may mark an outcome-only goal complete. Existing explicit criteria and scope
inputs remain supported by the API. An existing task can be attached only
after the server validates its access and scope.
An owner may explicitly resume a budget pause, but a check-in cannot renew it.
Creation accepts a stable `requestId` for safe HTTP retries; changing the
request while reusing its ID is rejected. A linked task interrupted by restart
parks the goal until its worker effects have been inspected and the task has
been explicitly reopened. A watch match can wake a waiting goal without
redoing an already-recorded watch action.
Removing the owner from the source or linked room parks the goal immediately,
interrupts its active coordinator turn and cancels goal-owned active tasks.
For a blanket request to finish *all* current inventory work, the fixture
scripts a false completion claim. The server must not accept or repeat it:
without named project/repository scope and an independently observed
inventory, it records the missing decision as `needs-input`. Naming a
registered connector or “merge requests” is enough to start a mission; the
detector does not require both “jira” and “gitlab”. A named issue or MR
(`PAY-123`, `group/project!10`) stays a deliverable and is not widened. This
test never reads or mutates live tracker issues or merge requests.
Desk-test, the flag-off default, and the synthetic writes-enabled recipe
live in [team-backlog.md](team-backlog.md). Never point either recipe at
live Jira/GitLab.
