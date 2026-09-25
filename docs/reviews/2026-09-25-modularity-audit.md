# Modularity audit: kits, GitLab, automations

Date: 2026-09-25
Branch audited: `codex/bedrock-provider` @ `88bfd97b` (P6 through PR #26, plus the earlier task-connectors stack)
This PR: scoped fixes on top of that tip

**Verdict: mostly modular.** After the fixes in this PR, UI, schemas, infer/scan, and the mission runner branch on `kind` / `statusCategory` / manifests / kit data — not `if (jira)` / `if (gitlab)`. Kits, GitLab issues-as-`work_item`, and watches are coherent with that design. Remaining gaps are unused kit watch *suggestions*, Settings search synonyms, and a few identifier-shape heuristics that a later contract could absorb as data.

Dylan’s “super flexible, but robust” bar is the input. Where a simpler modular shape would beat what landed, that is called out under **Larger debt**.

---

## Method

Production code only for pass/fail (UI, runner, shared schemas, Work copy). Tests and docs are cited when they lock a class of mistake. No live tokens.

Searched for `z.enum(["jira","gitlab"])`, `=== "jira"` / `=== "gitlab"` / `=== "plane"`, and provider-named Work/runner copy. Traced kit matching, `scope.kinds`, watch editor → `manifest.watch` → `connector.changes`, and `scripts/check-connector-pr.mjs`.

---

## Check results

| # | Check | Result | Severity |
|---|---|---|---|
| 1 | Shared schemas: no `z.enum(["jira","gitlab"])` | **Pass** | — |
| 2 | UI branches on kind/manifest, not provider | **Pass** | — |
| 3 | Infer/scan/runner: no provider-id `if` | **Pass** (was fail; fixed here) | High (fixed) |
| 4 | Work / runner copy is kind-driven | **Pass** (was fail; fixed here) | Medium (fixed) |
| 5 | Connector drop-in + PR allowlist | **Pass** | — |
| 6 | Connector isolation (`ctx.fetch`, no store/bots) | **Pass** | — |
| 7 | Optional `act` fail-closed; Plane has no writes | **Pass** | — |
| 8 | Four kits as data; jira-gitlab vs gitlab kinds | **Pass** | — |
| 9 | Watches: schema editor + `changes` feed | **Pass** | — |
| 10 | Kit `watches[]` consumed as automations | **Fail** (debt) | Low |
| 11 | GitLab first-class (issues + MRs when kit says so) | **Pass** | — |

---

### 1. Shared schemas — **Pass**

`shared/team-backlog.ts:12` types `connectorId` as `z.string().min(1).max(64)`, not a provider enum. `kind` is `missionKindSchema` (`work_item` | `change_request`) at `shared/team-backlog.ts:9,31`. Locked by `server/team-backlog.test.ts` and `server/modularity.test.ts`.

Comment at `shared/team-backlog.ts:21` names the `jira-gitlab` *kit* for missing-`kinds` migration. That is kit-id documentation, not a schema branch.

`BacklogGate.kind` still includes `security` / `manager` (`shared/team-backlog.ts:50`). Flexible-team-work P4 kept those as a one-release alias. Runner/actions no longer emit hardcoded `"Security"` / `"Manager"` rule names (kit JSON forbids them: `server/team-work-kits.test.ts`).

---

### 2. UI — **Pass**

Production `src/components/**/*.tsx` has no `Jira` / `GitLab` copy and no `=== "jira"` branches.

| Surface | Evidence |
|---|---|
| Work scope picker | `src/components/WorkPage.tsx:99-107` — `scopeChoiceLabel(choice, connector?.name)`; submit via `canSubmitScopeChoice` (one or more scopes). |
| Work source rows | `shared/team-backlog.ts:113-117` — `"Change request"` / `"Work item"` from `kind`. |
| Task board / chips | Tests assert rendered HTML contains no `"Jira"` / `"GitLab"` (`src/components/work/TaskView.test.ts`, `LinkChip.test.ts`, `TopicBoard.test.ts`). |
| Connections editor | `src/components/connections/ConnectionFields.tsx:4-16` renders `manifest.settings` / secrets. Same form for every connector. |
| Watch editor | `src/components/watches/WatchEditor.tsx:239-243` — scopes/events from `manifest.watch`. `WatchScopeFields` is the same generated field list. |
| Provider mark | `src/components/work/ProviderMark.tsx:5-14` — `connector.icon` / first letter of `manifest.name`. |

WorkPage tests still *construct* jira/gitlab fixtures and expect manifest **names** (`App repo · GitLab`). That is display of `manifest.name`, not a UI branch.

**Exception (not a violation):** `src/components/SettingsModal.tsx:63` search keywords include `jira`, `gitlab`, `plane` so Settings find-in-page still hits Connections. `tracker` is already in that list. A new connector would be findable via `tracker` / `task connection` without editing this file.

---

### 3. Infer / scan / runner provider `if`s — **Pass (fixed)**

**Was fail.** `server/team-backlog.ts` on `88bfd97b` branched on `connectorId === "jira"` / `"gitlab"` for query usability, board JQL widening, watch skip-if-board, linked-work skip, GitLab project-path scan errors, and scope membership. That is the opposite of “new connector = folder + registry line”: a fourth tracker would have edited infer.

**Fix in this PR.** Optional `Connector.missionScope` (`server/connectors/types.ts:105-128`). Infer/scan call `connectorById(id)?.missionScope` only. `hasBoard` is computed once after the team-board pass so two tracker watches still both become scopes:

- Jira JQL widening / watch skip / linked-id → JQL: `server/connectors/jira/scope.ts`
- GitLab project-path usable / watch project / `group/project!n` membership: `server/connectors/gitlab/scope.ts`
- Plane and the fake connector omit the hook; core uses identifier-shape defaults (project key, nested path) in `server/team-backlog.ts:54-59`

`server/team-backlog.ts` and `server/team-backlog-runner.ts` have no `=== "jira"` / `=== "gitlab"` / `=== "plane"`. Guard: `server/modularity.test.ts`, `server/team-backlog.test.ts`.

**Simpler shape that would still beat this:** declare query shape in the manifest (`usablePattern`, `identityPattern`, `boardWiden: "jql-project"`) instead of functions. Functions were the scoped move that preserved today’s Jira sprint-board behavior without inventing a JQL DSL in JSON.

---

### 4. Work / runner copy — **Pass (fixed)**

**Was fail.**

| Before | After |
|---|---|
| `server/team-backlog-runner.ts` `"Jira project owner"` (two gates) | `sourceOwner(kind)` → `"Work item owner"` / `"Repository maintainer"` (`:26-28`, `:130`, `:232`) |
| `"final Jira transition"` / `"close the MR"` | `"final tracker completion"` / `"close the change request"` (`:155-156`) |
| `shared/ongoing-goal.ts` “team Jira/GitLab mission” | “team mission” |
| `server/work-instructions.ts` “Jira or another tracker” | “a connected tracker” |
| `goal.panel.scopeHint` `jira:connection:PROJECT-` | `connector:connection:ITEM-` |
| Settings/watch empty copy listed Jira, GitLab, Plane | generic tracker / code host |

`inventoryNoun` (`server/team-backlog-runner.ts:19-23`) and `criteriaFromKinds` (`shared/team-backlog.ts:96-100`) were already kind-driven.

---

### 5. Drop-in connector + allowlist — **Pass**

`server/connectors/registry.ts:7,14-16`: one import per host connector; comment states the rule.

`scripts/check-connector-pr.mjs:9-49`: a PR that touches exactly one `server/connectors/<id>/**` plus `registry.ts` may not also edit UI/shared server files. Docs are allowed. `actions.ts` inside the folder is allowed (Plane write drop-in). Tests: `scripts/check-connector-pr.test.ts`, `server/modularity.test.ts`.

**Allowlist is still meaningful.** A Plane-only `complete_work_item` does not need a runner edit. This PR did not find a hole that let connector PRs silently edit Work/infer.

**Not a gap, documented limitation:** the check allows the whole `registry.ts` file, not “one line.” Mixed PRs that touch two connectors plus UI stay silent (by design: `connectors.size !== 1` ⇒ no extras reported).

Plane and GitLab stay folder-isolated. Host HTTP helpers (`jiraRequest`, `gitlabRequest`, `planeRequest`) exist only under `server/connectors/{jira,gitlab,plane}/`. Locked by `server/team-backlog-actions.test.ts`.

---

### 6. Connector isolation — **Pass**

`ConnectionContext` (`server/connectors/types.ts:53-59`) is settings, `secret()`, `fetch`, `log`. No store, bots, or other connections.

Grep of `server/connectors/**` (excluding tests) finds no store/bot imports. Contract suite asserts `test` / `act` dry-run use `ctx.fetch` only (`server/connectors/contract-suite.ts`).

**Exception:** `server/connectors/gitlab/index.ts` `emptyCtx()` uses `globalThis.fetch` as a no-op context for *capture extractors* that only call `parseRef` / URL helpers. Those extractors do not perform HTTP. Intentional; not a live client.

---

### 7. Optional writes — **Pass**

- Jira: `complete_work_item` (`server/connectors/jira/index.ts` `actions` + `act`)
- GitLab: `merge_change_request`
- Plane: no `actions` / `act` (`server/connectors/plane/index.ts:458+`) → runner `access` gate, no HTTP
- Wrapper: `server/team-backlog-actions.ts:55-92` chooses `dry-run` vs `commit` from workspace + connection + `mayWrite()` locks. Default `mayWrite` is `() => false`. This PR does not enable locks.

---

### 8. Kits as data — **Pass**

`server/team-work-kits.json` is the catalog. `server/team-work-kits.ts` parses it; it is not a second connector system.

| Kit | Pinned ids | Inventory kinds |
|---|---|---|
| `jira-gitlab` | jira + gitlab | Jira `work_item`; GitLab `change_request` only |
| `gitlab` | gitlab | `work_item` + `change_request` |
| `jira` | jira | `work_item` |
| `plane` | plane | `work_item` |

Matching is exact pinned-id set (`server/team-work-kits.ts:97-108`). Unrecognized mixes (e.g. jira+plane) return `undefined`; infer uses `manifest.kinds ∩ { work_item, change_request }`.

Scan filters `scope.kinds` (`server/team-backlog.ts` + `scopeKinds`). Same GitLab connector, different kit ⇒ issues dropped or kept. Tests: `server/team-work-kits.test.ts`, `server/team-backlog.test.ts` (“keeps dropping GitLab issues for the jira-gitlab kit…”).

`missingKindsFallback` (`server/team-work-kits.ts:130-135`) fills stored scopes without `kinds` from the **jira-gitlab** kit so a pull does not suddenly inventory GitLab issues. Intentional migration, not a UI branch. A simpler long-term shape: stamp `kinds` on write and drop the fallback.

Kit ids/names (`jira`, `gitlab`, …) are branded data. Core matches on `connectorId` strings from that data, not `if (kit.id === "jira")`.

---

### 9. Watches / automations — **Pass**

End-to-end is kind/manifest-driven:

1. Connector declares `manifest.watch.scopes` + `events` (Jira JQL, GitLab project, Plane PQL — labels live on the manifest).
2. Connector implements `changes` (and optional `webhookChanges`).
3. `server/index.ts:9597-9602` resolves `connectionId` → `connectorById` → `connector.changes(ctx, scope, cursor)`. No provider `if`.
4. Watch editor generates fields from `manifest.watch` (`WatchEditor.tsx:239-243`, `WatchScopeFields.tsx`).
5. Filter language is shared (`shared/watches.ts`).
6. Missions wake via `backlogScopeContains` on `SourceChange.item` (`server/index.ts` watch matched hook), still kind + scope query, not provider name.

Git, webhook, and connection sources share one editor. Tests: `src/components/watches/WatchEditor.test.ts` (“same generated form for Jira, GitLab, Plane, git, and a generic webhook”).

Plane has `changes` + `watch` and no `act` — first-class for automations, read-only for missions.

---

### 10. Kit-suggested watches — **Fail (low) / debt**

Each kit JSON row includes `watches[]` (`server/team-work-kits.json:10-21` etc.). Schema and load tests accept them (`server/team-work-kits.ts:31-32,42-46`).

Nothing in infer, Setup Guide, or the watch UI *reads* `kit.watches`. The comment says “Kits do not create watches” — correct, and they also do not suggest them in the product.

**Coherence:** watches as a system are first-class (check 9). Kit rows that duplicate `manifest.watch.events` with friendlier names are dead data.

**Simpler shape:** omit `watches` from shipped kits until a preset list exists, *or* have the watch editor offer `matchTeamWorkKit(connectionMix)?.watches` as named presets (still no auto-create, still no provider screen). Do not invent that UI in this PR.

---

### 11. GitLab first-class — **Pass**

- Connector kinds include `work_item` and `change_request` (`server/connectors/gitlab/index.ts` manifest).
- `gitlab` kit inventories both; `jira-gitlab` drops issues (`server/team-work-kits.ts` + tests).
- GitLab-only infer is ready without asking for Jira (`server/team-backlog.test.ts`, `server/team-backlog.e2e.test.ts`).
- Detector uses registered connector **id/name** or “merge requests”, or any query-capable connection (`server/ongoing-goals.ts:35-55`). Does not require the words “jira” and “gitlab”.
- Merge writes live in `server/connectors/gitlab/actions.ts`, called by `action` + `kind`.

Identifier heuristics in the detector (`PAY-123`, `group/project!n`, `!n`) are deliverable-escape rules, not provider UI. They happen to match Jira/Plane keys and GitLab MRs. A later `parseRef` loop over registered connectors would be cleaner (debt).

---

## Intentional exceptions

| What | Why it is not a violation |
|---|---|
| Connector folders and manifests name Jira/GitLab/Plane APIs | The folder *is* the provider adapter. |
| Kit ids `jira-gitlab`, `gitlab`, … | Branded catalog data. Matching is pinned-id equality. |
| `missingKindsFallback` → jira-gitlab kit | Migration so stored missions do not gain GitLab issues. |
| Settings Connections keywords `jira`/`gitlab`/`plane` | Search synonyms; generic `tracker` already present. |
| Composio toolkit list includes `{ slug: "jira" }` (`server/composio.ts`) | Separate connected-apps catalog, not the task-connector registry. |
| Capture rules match `jira_*` / `glab` / `plane_*` tool names | Host-specific extractors inside the connector folder. |
| Fixture/test names (`jira-main`, “Check Jira every 15 minutes”) | Tests, not product UI. |
| `gitlab-bot` actor in the fake change feed | Fixture identity. |

---

## Fixes in this PR

Safe, scoped. No write locks enabled. No new connectors.

1. Move infer/scan provider `if`s into `missionScope` on Jira and GitLab.
2. Kind-driven runner / Work / instructions / locale copy.
3. `server/modularity.test.ts` plus focused Jira/GitLab `missionScope` tests.
4. Document `missionScope` on the connector contract.

---

## Larger debt (list only)

1. **Kit `watches[]` unused.** Either delete until needed or surface as editor presets. Do not auto-create watches.
2. **`missionScope` as functions vs manifest data.** A JSON query-shape (`usablePattern`, identity capture, optional JQL widen flag) would let a new connector skip TypeScript hooks. Today’s Jira board widening is real JQL parsing; data-only would need a small DSL.
3. **`missingKindsFallback` hard-wires the jira-gitlab kit.** Stamp `kinds` on every write and retire the fallback.
4. **Detector identifier escape** (`KEY-123` / `path!n`) instead of `CONNECTORS.flatMap(c => c.parseRef(...))`.
5. **Allowlist does not count registry lines.** Fine; optional tightening if connector PRs start rewriting `connectorsFor`.
6. **`security` / `manager` gate kinds** still in the Zod union. Stop emitting (already done for hardcoded names); remove from the schema after stored missions age out.
7. **Plane PQL as a mission scope query** can fail `contains` (identifier-shape default expects a project key or nested path). Plane-only tests use `query: "PAY"`. A Plane `missionScope.contains` would make PQL watches mission-safe.
8. **Settings search keywords** still list three host names. Optional: drop them and keep `tracker`.
9. **Registry comment is slightly stale** (`registry.ts:14` “Nothing else in the server names a provider”) — kit JSON and `missingKindsFallback` name kit ids. The *runner* no longer does.
)
