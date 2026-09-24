# Shared task collaboration

Follow [the verification rules](README.md). Never send these mutations to a
live workspace. The server E2E suite launches `launchVerificationServer` with
a temporary home/data directory, scripted fake engine, and explicit fixture
URL. Tests assert actual API state and fake-engine execution records, not
just tool response text.

## Server and storage

```sh
pnpm exec vitest run server/work-items.test.ts server/shared-work.e2e.test.ts server/team-backup.test.ts server/workspace-backup.test.ts server/room-handoffs.test.ts server/bot-visibility.test.ts server/bot-visibility.e2e.test.ts --maxWorkers=2
```

Coverage includes:

- Direct request → topic/task hub → implementation → independent review →
  evidenced outcome, with one receipt in the originating conversation.
- A bounded planning consultation → two ranked delivery tasks in the same
  source request, for both issue-based work and generic research outcomes.
  The consulted specialist is refused if it tries to create a coordinator.
- Routine and webhook deliveries reuse completed work without executing the
  specialist again; the original automation run waits for its task outcome.
- Concurrent duplicate requests reuse one task; two deliverables in one topic
  use separate hub and specialist threads.
- Nested specialists use their immediate lead's peer access without gaining
  a new grant from the coordinator. Revoked peer results are withheld.
- Unbound declared work is refused. Task-scoped Stop prevents coordinator
  replay when an in-flight specialist returns.
- A provider held inside a running coordinator is interrupted by Stop. User
  reopen allocates a distinct execution root; the reopened provider can also
  be stopped and returns to idle without releasing the fixture's hold.
- Registry identity/assignment deduplication, stale-revision rejection,
  bounded correction attempts, execution budgets and corrupt-storage refusal.
- State-key reuse stays within the originating bot/room and task revision;
  revoked routes and new approval requirements cannot reveal cached results.
- Signed-in member creation and immediate response visibility, denied access
  to private tasks, and assignment filtering in HTTP and event streams.
- Portable backup ID remapping and full workspace task retention; unfinished
  work is blocked/failed on recovery, never automatically replayed.
- Portable task keys reused by different bot/room owners resolve to the
  correct new conversations. Storage limits and failed disk writes preserve
  previously saved tasks without retaining unpersisted additions.

The fixture's server log is retained under
`/tmp/openmausbot-verification-evidence/`. Task events include `work.resolved`,
`work.assignment` and `work.state` with task/revision/assignment IDs. They do
not log task contents. Each passing server fixture also prints the path to
its `.shared-work.json` record of actions, final task state, transcripts and
scripted executions. The tests' engine replies are synthetic: they prove
orchestration, not a real Jira integration or a model's ability to fix a bug.

## Renderer

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/shared-work-ui.e2e.test.ts --maxWorkers=1
```

If Chrome is already installed, prefix that command with
`AGENT_BROWSER_EXECUTABLE_PATH=/absolute/path/to/chrome`. The launcher uses
the specified binary with its own disposable browser profile, not an
existing browser session. See [the UI harness](chat-ui.md) for prerequisites.

The recipe drives the real renderer through `control-omb ui`: send from the
composer, open the shared hub while tool calls are hidden, observe the
running/completed task panel, and open the exact linked specialist thread
from the topic folder. It asserts that the worker appears once in the
sidebar, belongs to that topic, and stays selected when opened. It switches
back to the shared chat and also exercises the task panel's worker link.
It also reopens the completed task, stops the running coordinator, checks a
390-pixel mobile viewport for overflow, and requires a clean browser console.
Screenshots and `shared-task.json` are retained in
`.omb-scratch/verify-evidence/shared-work`: before task creation, completed
hub, selected specialist in its topic tree, mobile view and stopped task.
The JSON includes the fixture URL, task records and selected thread.

```sh
pnpm exec vitest run src/components/SharedWorkThreadTree.test.ts src/components/work/TopicBoard.test.ts src/components/work/board.test.ts src/components/Sidebar.simple-mode.test.ts src/components/SidebarBotActivity.test.ts --maxWorkers=2
```

Renderer unit cases also cover earlier revisions, missing-hub fallback,
specialist-name/context search, pending approval indicators, the removal
of duplicate bot-owned rows, and a topic board that mixes sourced, repo-only
and chat-started tasks with untracked query items.

## Limits of this proof

These fixtures do not prove real-model planning quality, semantic identity
selection, actual external issue changes, or cross-environment file sharing.
They also do not migrate historical untracked delegation chains. See
[task-centered collaboration](../shared-work.md) for current behavior and
rollout boundaries.
