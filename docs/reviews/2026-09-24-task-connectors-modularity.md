# Task-connectors modularity review

Status: review only · Tip: `cursor/watches-ui-phase-9c-3a3c` (PR #11) · Plan: [`docs/plans/2026-09-23-task-connectors.md`](../plans/2026-09-23-task-connectors.md)

This is an architecture check of the stacked task-connectors work (PRs #2–#11). No product rewrite. Issues that live in earlier stack PRs are marked by number.

Validated against the plan principles:

1. **Kinds, not providers.** UI branches on `kind` / `statusCategory` only. Provider chrome is `manifest.name` / `manifest.icon`.
2. **Drop-in connectors.** A new connector is a folder + one `registry.ts` line + the contract suite.
3. **First-class coherence** with kits (Composio connected apps), GitLab integrations, and automations / watches.
4. **Connectors read; bots act.** No connector write path that bypasses bot tools.
5. **Watches:** detection in code, model only on match; engine provider-agnostic.

## Verdict

The **renderer and watch engine keep the kind-driven contract**. Work UI, board, sidebar, and the Watches editor do not switch on `jira` / `gitlab` / `plane`. Connectors do not POST mutations to trackers. Detection stays in `connector.changes` / git / webhook maps.

The **drop-in contract is incomplete and slightly leaky**:

- There is still no Settings form that renders `manifest.settings` / `manifest.secrets`, so a new connector is not actually usable from the product UI.
- Capture rules run globally. Plane’s update rule matches the built-in `update_work_item` tool (PR #8). GitLab’s issue-create rule is the generic `/create[_-]?issue/` the connector guide tells authors not to write (PRs #5 / #8).
- Phase 8 did not prove “Plane is folder + registry line”: that PR also edited GitLab, shared `capture.ts`, and the contract types.
- Built-in git / webhook watches, Composio kits, MCP servers, and task connections are four parallel “connect something” systems. They do not share a manifest or editor.

No tiny contract-fix commit is included with this review. The highest-priority follow-ups are listed at the end.

## Stack map

| PR | Phase | Head |
|---|---|---|
| #2 (merged) | 0–2 model, capture, evidence | `cursor/task-connectors-p0-p2-861d` |
| #3 | 5 Task view | `cursor/task-view-phase-5-5012` |
| #4 | 3 Jira | `cursor/jira-connector-phase-3-fff8` |
| #5 | 4 GitLab (code kinds) | `cursor/gitlab-connector-phase-4-65f3` |
| #6 | 6 Sidebar + bot-turn card | `cursor/sidebar-bot-turn-phase-6-7e73` |
| #7 | 7 Topic board | `cursor/topic-board-phase-7-9bce` |
| #8 | 8 GitLab issues + Plane + guide | `cursor/drop-in-connectors-phase-8-26f1` |
| #9 | 9a Watch engine | `cursor/watch-engine-phase-9a-0463` |
| #10 | 9b Connector change feeds | `cursor/watch-engine-phase-9b-c3ac` |
| #11 | 9c Watches UI | `cursor/watches-ui-phase-9c-3a3c` |

PR #11 itself is largely clean on the five principles. Most violations landed earlier and were inherited.

---

## Passes

### 1. Work UI switches on `kind` / `statusCategory` (PRs #3, #6, #7)

`src/components/work/` primitives take a `LinkedItem` / `TaskEvent` and look up chrome with `connectorFor` → `manifest.name` / `manifest.icon`. Tests assert the markup does not contain “Jira” or “GitLab”.

| File | Evidence |
|---|---|
| `src/components/work/KindIcon.tsx` | `Record<LinkKind, LucideIcon>` only |
| `src/components/work/ProviderMark.tsx` | Renders `connector.icon` or the first letter of `connector.name`; `data-provider={connector.id}` is opaque |
| `src/components/work/LinkChip.tsx`, `LinkCard.tsx` | Kind icon + `statusCategoryClass(item.state.category)` + `ProviderMark` |
| `src/components/work/model.ts` | `outputGroups` walks `LINK_KINDS`; `connectorFor` is `connectors.find(id === item.connectorId)` |
| `src/components/work/board.ts` | `taskBoardCategory` prefers change-request `in_review`, then source `state.category`, then task status |
| `src/components/work/TopicBoard.tsx` | Columns are `data-board-column={category}`; cards are `data-board-kind={kind}` |
| `src/components/work/EventRow.tsx` | Icons keyed by `TaskEvent["kind"]` |
| `src/components/work/BotTurnCard.tsx` | Outputs are `LinkChip`s |
| `src/components/work/TaskView.tsx` | Header chips: `role === "source" \|\| kind === "change_request"` (kind, not provider) |
| `src/components/WorkItemPanel.tsx` | Re-export of `TaskView` — old panel is gone |
| `src/components/GroupView.tsx` | Hub renders `TaskView` |

`LinkItemDialog` is provider-agnostic: paste a ref or URL; the server runs `parseRef` / `urlPatterns`.

### 2. Sidebar is kind-driven (PR #6)

`src/lib/shared-work-sidebar.ts` derives the compact row from `work_item` / `change_request` links and `statusCategory`. Filters are All / Needs you / In review / Done. `SharedWorkThreadTree.tsx` does not name a provider.

One display leak (`!` prefix) is called out below.

### 3. Registry is the one provider-naming site (PRs #2, #4, #5, #8)

```ts
// server/connectors/registry.ts
export const CONNECTORS: Connector[] = [fakeConnector, jiraConnector, gitlabConnector, planeConnector];
```

`server/task-connections.ts`, `server/connectors/capture.ts`, `server/index.ts` (watch hooks and webhook ingress), and `server/watch-actions.ts` all go through `connectorById` / `CONNECTORS`. Nothing in `src/components/work/` or `src/components/watches/` imports a provider module except **tests**.

Plane’s implementation lives under `server/connectors/plane/**`. Jira and GitLab do not appear in production UI conditionals.

### 4. Watches UI is generated from `manifest.watch` (PR #11)

`WatchEditor` lists enabled connections and paints `ProviderMark` + `connector.name`. Scope fields come from `manifest.watch.scopes` via `WatchScopeFields`. Event chips come from `manifest.watch.events`. Git and webhook reuse the same field renderer (`GIT_WATCH_MANIFEST` / `WEBHOOK_WATCH_MANIFEST`).

`src/components/watches/WatchEditor.test.ts` renders the same editor against Jira, GitLab, Plane, fake, git, and webhook manifests and asserts the HTML does not contain “Jira-specific” / “GitLab-specific”.

The filter builder is over `SourceChange` paths (`state.category`, `actor.isBot`, `fields.*`), not provider APIs.

### 5. Watch engine is provider-agnostic (PRs #9, #10)

`shared/watches.ts` and `server/watches.ts` speak `connectionId`, `WatchSource.type`, and `SourceChange`. `WatchManager` receives `connectionChanges` / `connectionQuery` callbacks. `server/index.ts` (~9432) resolves the connection, then calls `connector.changes` — no `if (connectorId === "jira")`.

`ensure_task` / `task_update` / `record` write **local** work items and events (`server/watch-actions.ts`). They do not call tracker APIs. `ensure_task` only creates tasks for `kind === "work_item"`.

Detection is code: schedule tick, connector webhook, or `git ls-remote`. A model runs only through `run_routine` after a match. `onlyIfChanged` on routines is a cheap gate.

### 6. Connectors read; bots act (PRs #3–#8, #10)

Connector HTTP:

- Jira `POST`s are Cloud JQL / bulk fetch (`server/connectors/jira/index.ts`), not issue mutations.
- GitLab and Plane `index.ts` files are GET-style fetch / query / events.
- Capture records observed tool calls; writes stay with MCP / Composio / CLI tools the bot already has.

`sourceLinkedItem` and watch `ensure_task` fetch and persist `LinkedItem`s locally. They do not comment, transition, or open MRs.

### 7. Contract suite and guide exist (PRs #2, #8, #10)

`server/connectors/contract-suite.ts` checks manifest renderability, `parseRef` ↔ `urlPatterns`, fetch shape, capture extract, `ctx.fetch` on `test`, and (when present) change-feed idempotence / cursor monotonicity / webhook↔poll id overlap.

`docs/connectors.md` states the drop-in rule and tells authors to keep capture host-specific.

### 8. Automations treat watches as a sibling of routines (PR #11)

`RoutineCalendarPage.tsx` adds an Automations → Watches tab next to routines and webhooks. `ConvertToWatchHint` / `pollingRoutineHint` use generic poll verbs, not provider names. Converted drafts keep `run_routine` as the action so existing routine cards still apply.

---

## Violations / smells

Severity: **High** = breaks drop-in or kind-driven behavior. **Medium** = plan promise not met, or a leak that will bite the next connector. **Low** = inconsistency.

### High

#### H1. Plane capture matches the built-in coordinator tool — PR #8

`server/connectors/plane/index.ts` (rule 3):

```ts
match: { tool: /workitem|plane[_-]?(?:update|transition)|update[_-]?work[_-]?item/i },
```

`update[_-]?work[_-]?item` matches the catalog tool `update_work_item`. `actionOf` treats any title containing `update` as `"update"`, then `extractWorkItem` scans input/output for `IDENTIFIER` (`PAY-123`).

Capture runs **every** connector’s rules on **every** work-bound tool call (`server/connectors/capture.ts` ~97–105), with `connectorId: "plane"` stamped on a hit. A coordinator completing a Jira-sourced task whose preview still contains `PAY-123` can grow a Plane-attributed link.

This is a drop-in isolation failure: adding Plane changed capture for tasks that never configured Plane.

#### H2. GitLab issue-create rule is the generic matcher the guide forbids — PRs #5, #8

`server/connectors/gitlab/index.ts`:

```ts
match: { tool: /create[_-]?issue(?![_\s-]?(?:note|comment))|…|\bissue_create\b/i },
```

`docs/connectors.md` (same PR): “Keep rules host-specific. A generic `/create[_-]?issue/` match will fire on every tracker.”

`JIRA_CREATE_ISSUE`, Linear `create_issue`, and similar titles match the first alternative. Extract then looks for GitLab-shaped `#140` / `group/project#140`. Cross-provider capture is possible whenever those shapes appear in a preview.

#### H3. No Settings → Connections form for task connections — PR #2 (claimed in #4–#8)

Plan (UI section): one generic list/form from `manifest.settings` + `manifest.secrets`, with Test.

What exists:

- CRUD + test API: `server/routes/task-connections.ts`
- Secret redaction and section scoping: `server/task-connections.ts`
- **No** `src/` caller of `POST` / `PATCH` / `DELETE` `/api/task-connections`

`SettingsModal.tsx` section `"connections"` is Composio / API keys / VPS. PRs #4, #5, and #8 say “Settings already render from the connector manifest.” That form is not in the tree.

The UI type `TaskConnectorManifest` (`src/components/work/model.ts`) omits `settings` and `secrets`, so a form cannot be built from the client type as written. `GET /api/task-connectors` does return the full server manifest.

A new connector is therefore not drop-in for an operator: watches and the board can only consume connections created via config / API / team backup.

Watches (PR #11) and the topic board (PR #7) inherit this: the editor lists connections; it cannot create them.

### Medium

#### M1. Change-request chips hardcode GitLab `!` — PRs #6, #7

```215:215:src/components/work/TopicBoard.tsx
          <span className="min-w-0 truncate">{changeRequest.externalId ? `!${changeRequest.externalId}` : changeRequest.title}</span>
```

Same pattern in `src/components/SharedWorkThreadTree.tsx` (~51).

GitLab already stores `externalId` as `group/project!482` (`mrId` in `server/connectors/gitlab/index.ts`). The chip renders `!acme/payments!482`. A future GitHub connector’s `123` would show as `!123`. Provider punctuation does not belong in kind-driven UI; show `externalId` or `title` as-is.

#### M2. Fake connector is a production registry citizen — PR #2

`CONNECTORS` starts with `fakeConnector` from `server/testing/fake-connector.ts`. `parseStoredConnections` accepts any `connectorById` hit, so `connectorId: "fake"` is a valid live config. `GET /api/task-connectors` advertises it. Useful for isolated fixtures; it is not gated on test/dev.

#### M3. Phase 8 did not prove the drop-in allowlist — PR #8

Plan exit: the Plane PR touches only `server/connectors/plane/**`, one `registry.ts` line, and docs; CI enforces a path allowlist.

`2d7aaef3` also changed:

- `server/connectors/gitlab/index.ts` (+ issues, notes, query)
- `server/connectors/capture.ts` (`#` / `!` parent-ref matching)
- `server/connectors/types.ts` (`changes` / `watch` on the contract)

GitLab issues were in the same phase, so the “Plane-only PR” test never ran. `.github/workflows/ci.yml` has no connector path allowlist.

`sameParentRef` in shared capture now special-cases `!` and `#`. The next host with a different short-ref syntax will need another edit outside its folder.

#### M4. Planned sync poller is missing — PR #2

`server/connectors/sync.ts` (1 min / 15 min backoff poll, webhook route ownership, degraded-connection marking) was never added. Live state is:

- `sourceLinkedItem` on ensure
- board / watch `query` and `changes`
- `POST /api/connectors/:connectionId/webhook` in `server/index.ts` (~12815)

Opened tasks do not refresh on the planned cadence. The webhook path sits under `/api/connectors/…`, the same prefix Composio uses for `/api/connectors`, `/catalog`, `/connected`.

#### M5. Capture `match.server` is dead contract — PR #2

`CaptureRule.match.server` is documented and tested for in `matches()`, but `toolCall()` never sets `call.server`, and `RuntimeEvent` has no MCP server field. No connector uses `match.server`. Authors cannot disambiguate two `create_issue` tools by server name — which is why H2 matters.

#### M6. Four parallel connection systems — coherence (pre-stack + PRs #2, #9, #11)

| System | Manifest | Settings UI | Wire |
|---|---|---|---|
| Composio kits | marketplace catalog | `PluginsPanel` + Settings → Connections | `/api/connectors*` |
| MCP servers | per-server config | `McpServersPanel` | `/api/mcp-servers` |
| Task connectors | `Connector.manifest` | **missing** | `/api/task-connectors`, `/api/task-connections` |
| Automations | routines / webhooks / watches | `RoutineCalendarPage` + `WatchEditor` | `/api/routines`, `/api/webhooks`, `/api/watches` |

Jira appears twice: Composio curated slug `jira` (`server/composio.ts` ~1004) and task connector `jira`. A bot can write through a kit while watches read through a task connection. That split matches “connectors read; bots act”, but operators see two unrelated “Jira” setups with different secrets and no shared editor.

Git / webhook watches have **client-side** manifests (`src/components/watches/model.ts`) instead of sitting next to `builtin/git.ts` in the registry. Built-in capture (git, url) is also special-cased in `capture.ts` rather than registered.

Watch and routine editors share visual language (cards, chips) but not a schema renderer. MCP secret-redaction is the pattern task connections copied on the server; the renderer never reused the MCP form.

#### M7. Watch attach path knows a GitLab pipeline id shape — PR #10

`server/watch-actions.ts` `watchLinkMatches`:

```ts
if (pipelineId != null && external.endsWith(`#pipeline:${pipelineId}`)) return true;
```

That suffix is `pipelineId()` in the GitLab connector. A provider-neutral match should use `details.pipelineId` / parent refs the connector already puts on `SourceChange.fields` (`fields.mr`).

#### M8. Contract suite probes Jira-shaped ids — PR #2

```ts
const refs = connector.manifest.kinds.map(kind => ({
  kind, externalId: kind === "work_item" ? "PAY-1" : "SAMPLE-1",
}));
```

Every connector’s `fetch` must accept `PAY-1` / `SAMPLE-1` (or stub them). That is a hidden fixture convention, not a host-neutral contract. GitLab and Plane tests pass because they stub unknown refs.

#### M9. Closed filter-field list — PR #11

`FILTER_FIELDS` in `src/components/watches/model.ts` is a fixed set. Connectors may emit other `SourceChange.fields` keys (Plane `stateGroup`, GitLab `approvals`). The builder will not offer them. Fine for v1; a drop-in connector cannot declare extra filter fields on the manifest.

#### M10. i18n names vendors — PR #11

`watches.emptyHelp`: “Jira, GitLab, Plane, git, or a webhook”. The editor is manifest-driven; the empty state is not. A fourth tracker would need a locale edit.

### Low

- **Duplicate `SettingField` / manifest types** in `server/connectors/types.ts` and `src/components/work/model.ts`. Drift risk (already: client manifest dropped `settings` / `secrets`).
- **WatchEditor tests import server connector modules** (`src/components/watches/WatchEditor.test.ts`). Renderer tests should consume `/api/task-connectors` JSON (or a shared manifest fixture), not `server/connectors/jira`.
- **Board query** is a free-text box (`TopicBoard.tsx`). Kind-driven and acceptable, but it does not surface `manifest` help (JQL vs PQL vs project path), so operators guess.
- **Plan `teams` vs implemented `sections`.** Scoping follows existing section keys, not a new `teams` array. Adaptation, not a leak.
- **Plan `settings: JsonSchema` vs `SettingField[]`.** The implemented field list is what the watch editor already renders. Document the deviation; do not introduce JSON Schema unless a form needs it.

---

## What is not a violation

- `ensure_task` creating local work items without a coordinator triage turn — planned, and not a tracker write.
- Jira Cloud `POST` for JQL / bulkfetch — read semantics.
- `WatchEditor` `if (source.type === "git"|"webhook")` — built-in source kinds, not Jira/GitLab/Plane.
- Test fixtures named `jira-acme` / `PAY-123`.
- `data-provider={connector.id}` / `data-watch-connector={manifest.id}` — opaque ids for tests.
- Coordinator prompt mention of “Jira or another tracker” in `server/work-instructions.ts` — prose.
- Electron-updater `case "gitlab"` — unrelated updater host.

---

## Recommended follow-ups (ordered)

1. **Tighten capture isolation (PR #8, then #5)** — highest leverage, small diff.
   - Plane: drop `update[_-]?work[_-]?item`; match `workitem` / `plane_*` only. Add a negative fixture: `title: "update_work_item"` must not extract.
   - GitLab: require `gitlab` / `glab` / `GITLAB_` in the issue-create tool pattern; keep `^glab issue create`.
   - Optionally run connector capture only when that `connectorId` is on the task or an enabled connection exists. That is the real drop-in fence.

2. **Ship the missing Settings form (PR #2 gap)** — without this, drop-in is theoretical.
   - Generic list + form from `manifest.settings` / `manifest.secrets`, Test button, section picker.
   - Expand `TaskConnectorManifest` (or share the server type) so the client sees fields.
   - Gate `fake` on non-production (or omit it from `GET /api/task-connectors` unless a test flag is on).
   - Place it in Settings next to kits / MCP so Jira-the-kit and Jira-the-connection are distinguishable.

3. **Remove GitLab chrome from kind-driven chips (PRs #6, #7)** — two-line fix: render `externalId` without a `!` prefix in `SharedWorkThreadTree` and `TopicBoard`.

4. **Finish the Phase 8 architecture test**
   - Add the CI path allowlist the plan described.
   - Move `!` / `#` parent matching behind a connector-declared `refAliases` (or keep short-ref resolution inside `parseRef` only) so shared `capture.ts` stops growing host syntax.

5. **Neutralize remaining host shapes**
   - Contract suite: let each connector supply fetch probe refs (the samples array already exists) instead of hard-coding `PAY-1`.
   - `watchLinkMatches`: match `details.pipelineId` / `fields.mr`, not `#pipeline:`.
   - Thread `server` (or tool namespace) through capture so `match.server` works.

6. **Coherence pass (not a rewrite)**
   - One operator-facing word for Composio kits vs task connections (the `/api/connectors` collision is the sharp edge).
   - Register git / webhook watch manifests next to `builtin/` so the UI does not own a second registry.
   - Let `manifest.watch` optionally declare extra filter fields.
   - Replace `watches.emptyHelp` vendor list with “a connection, git, or a webhook”.

7. **Sync poller (`server/connectors/sync.ts`)** when opened-task freshness matters. Not required for modularity; required for the plan’s “observed over claimed” loop on desktop installs without webhooks.

---

## PR #11 notes

Phase 9c did what the plan asked: one editor, kind/manifest-driven, dry-run, convert-to-watch, token-saving stats. No provider `switch`. Do not block #11 on H1–H3 or the missing Settings form; those belong to #8 and #2.

Within #11, the only modularity nits are M9 (closed filter fields) and M10 (vendor names in empty-state copy). Optional follow-ups, not merge blockers.
