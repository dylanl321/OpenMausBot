# Sidebar confirmations

## Team navigator

The sidebar groups one row per bot, group chat, or work topic under General and
named teams. The separately labeled chevron opens a temporary navigator:
bot folders and threads, group-chat threads, or a flat filterable task list.
Only pinning a Chief gives them a sticky hero within their own team; collapsing
the team leaves a small Chief indicator in its heading. The existing Show
threads preference still hides bot browsing and creation; Active Threads
remains accessible from the sidebar header.

When a direct thread is waiting for teammates, the chat header and transcript
show a background-work status until their replies settle. Its bot row shows a
separate accent presence dot (including compact and icon-only layouts), and
the exact thread has a labeled status in the navigator. Waiting on the person
still takes precedence. The signal comes from existing server coordination
state, not transcript text; no agent response is inferred from a spinner.
`src/components/ChatView.controls.test.ts`,
`src/components/SidebarBotListItem.test.ts`, and
`src/components/SidebarThreadRow.test.ts` cover these states. The disposable
direct-coordination browser fixture in
`scripts/testing/direct-coordination-ui.e2e.test.ts` checks appearance and
clearance against a gated fake teammate.

Appearance also offers an off-by-default, device-local **Hide inactive threads**
choice (14, 30, or 90 days). This only trims default bot and group-chat
navigator lists, before the six-recent-thread limit; it never archives or
deletes conversation data, and does not filter work-topic tasks or direct
search results. Pinned, selected, unread, queued, working, and waiting threads
stay visible. Search and Show all reveal hidden threads, and turning the
preference Off restores the default list. The local preference and visibility
rules have focused tests in `src/lib/thread-inactivity-preference.test.ts`,
`src/components/SidebarThreadRow.test.ts`, and
`src/components/Sidebar.simple-mode.test.ts`.

`src/components/Sidebar.simple-mode.test.ts`,
`src/components/SidebarBotListItem.test.ts`,
`src/components/SidebarSectionHeader.test.ts`, and
`src/components/SharedWorkThreadTree.test.ts` cover shallow rows, hero sizes,
folder actions, task filtering, search and topic navigation. The disposable
renderer recipe in `docs/verification/shared-work.md` checks pin transitions,
multiple teams, panel dismissal and focus, desktop docking and 390px mobile
layout; it never operates on the user's app or data.

Launch `node --experimental-strip-types scripts/verify-sidebar.ts`. It creates
an isolated fake-engine server and two disposable bots, then prints a preview
URL. Open that URL, never the user's live app. Ctrl-C closes both servers and
removes only the fixture data.

The preview mounts the actual Sidebar and StoreProvider. Verify:

1. Click Archive Sidebar Atlas: Cancel receives focus by default.
2. Shift-Tab wraps to Archive; Tab wraps back to Cancel.
3. Escape closes the dialog, leaves `Drawer: open`, and restores focus to the
   Archive trigger. No bot is archived.
4. Right-click Sidebar Atlas and choose Delete. Cancel leaves the bot intact
   and returns focus to the sidebar if the menu trigger has disappeared.
5. Repeat Delete and confirm. Only the disposable Atlas bot disappears; the
   remaining bots are unchanged and keyboard focus remains in the sidebar.

Verified on 2026-09-05 against the isolated renderer. Static regression coverage
in `src/components/SidebarBotListItem.test.ts` checks dialog semantics/copy,
chief labels, role badges, and working/waiting indicators. The interaction checks
above are manual browser verification, not assertions made by those unit tests.
This fixture covers the sidebar confirmation and bot-row result only; it does
not exercise Settings > Computers deletion or provider completion polling.
Those paths are covered by the computer-section and server Box inventory tests.

## Section deletion

Run `OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/team-lifecycle-ui.e2e.test.ts --maxWorkers=1`.
The test launches its own isolated server and real renderer; never point it at
the user's live workspace. It retains the Team map lifecycle checks and also
checks deletion directly from a sidebar section header:

- Cancel gets initial focus; Tab and Shift-Tab wrap within the confirmation.
- Escape and Cancel preserve the section and its shared instructions, and return
  focus to its delete button.
- Confirming deletion removes an empty section and its shared instructions.
- Populated, pinned-only and archived-only sections can be deleted; their bots
  move to General with their conversations, pinned state and archived state intact.
- Deleting a group-only section keeps the group chat and its conversation in
  General. The confirmation explains that members and conversations are retained.
- The existing context menu still renames sections while preserving their saved
  order and collapsed state, and its delete action retains pending/retry guards.

The fixture reports its log path and keeps a snapshot and screenshot on failure.
`src/components/SidebarSectionHeader.test.ts` separately checks that the optional
delete control coexists with the context menu and does not replace or nest inside
the collapse button. Server safeguards still reject deletion during active work,
with an assigned team computer, or when moving the Chief would conflict with
General's Chief; see [Teams](teams.md) for those lifecycle checks.
