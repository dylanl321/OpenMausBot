# Flexible team work: missions, Work, goals, Setup Guide

Status: proposed · Base: `codex/bedrock-provider` @ `15cb131b` · Docs only

This plan is for implementers. It tells you what to change, in which order,
and how you will know it is safe. It does not implement the code.

Product intent (Dylan): **super flexible, but robust, with no ongoing bugs.**
First-class kits, GitLab, and automations stay coherent with the modular
connector design in [`2026-09-23-task-connectors.md`](2026-09-23-task-connectors.md).

---

## 1. Problem and goals

The new team-backlog mission, Work overview, `/pursue` goals, and Setup Guide
landed as a Jira+GitLab product. That kit is useful, but the code treats the
kit as the architecture:

- Inventory, scope choice, and completion require **both** Jira and GitLab.
- Write HTTP (MR merge, Jira Done) lives outside `server/connectors/*` and
  runs whenever a working mission has evidence.
- Approval rule names `"Security"` and `"Manager"` are hardcoded.
- Client sessions can open Work and `/pursue`, but cannot call most goal
  routes.

**Flexibility goal.** A team with any mix of query-capable connections
(Jira-only, GitLab-only, Plane-only, Jira+GitLab, two GitLabs, …) can run a
mission. Adding a connector does not edit the runner, Work UI, or Zod enums.

**Robustness goal.** External writes are fail-closed. Inventory errors never
look like an empty backlog. Auth is default-deny and the UI does not offer
routes the session cannot call. Evidence, policy, and identity are checked
before any mutating HTTP. Classes of bug are prevented by typed contracts,
allowlists, and readback — not one-off patches.

---

## 2. Verified findings

Review hunches, checked in this tree. All six hold.

### Blockers

1. **Live external writes are on by default.**
   `mergeReviewedRequest` / `transitionEvidencedJiraIssue` in
   [`server/team-backlog-actions.ts`](../../server/team-backlog-actions.ts)
   take `mayWrite: () => boolean = () => true`. The runner passes
   `stillActive` (true for a working/waiting in-flight goal). After observed
   task evidence, the coordinator **PUTs GitLab `/merge` and POSTs Jira
   `/transitions`** against the connection token. Isolated e2e fixtures
   ([`docs/verification/team-backlog.md`](../verification/team-backlog.md))
   never hit that path; unit tests do, and they expect the write. Against
   real tokens this is a live write.

2. **Hardcoded GitLab approval names.** The same file requires rules named
   `"Security"` and `"Manager"` (case-insensitive). Orgs without those names
   can never pass the merge gate, even when GitLab’s own required rules are
   satisfied. Gate kinds `security` / `manager` encode the same org-specific
   pair.

### Should-fix

3. **`CLIENT_ALLOW` gap.**
   [`server/request-auth.ts`](../../server/request-auth.ts) allows
   `GET /api/work/overview` and `POST /api/goals/:id/scope-choice` for
   `client`. It does **not** allow `GET|POST /api/goals` or
   `GET|PATCH /api/goals/:id`. Those stay admin (default deny).
   [`OngoingGoalPanel`](../../src/components/OngoingGoalPanel.tsx) and
   Composer `/pursue` always call them. The panel swallows GET failures
   (`.catch(() => undefined)`). Clients see the UI and get 403.

4. **Jira+GitLab hardcoded as the model.**
   `z.enum(["jira","gitlab"])` in [`shared/team-backlog.ts`](../../shared/team-backlog.ts).
   Infer, choose-scope, and `advanceTeamBacklog` all require one Jira scope
   **and** one GitLab scope. Write HTTP reimplements auth/URL handling
   beside the connectors. Plane is registered and unused by missions.

5. **Single-connector teams stay in `needs-input`.** A GitLab-only or
   Jira-only team always fails the both-providers check, even after a
   scope choice. `chooseBacklogScopes` rejects a one-sided selection.

6. **GitLab issues are queried, then dropped.**
   `gitlabConnector.query` returns issues (`work_item`) and MRs. Scan keeps
   `change_request` only (`server/team-backlog.ts`). Tests assert that:
   [`server/team-backlog.test.ts`](../../server/team-backlog.test.ts)
   pages `/issues` twice and expects itemCount 4 with no `#71`. **Current
   product intent is a Jira-tracker + GitLab-MR kit**, not “GitLab cannot
   have issues.” That filter must become kit policy, not a scanner law.

### Nits (confirmed, not blockers)

- Commit `b50e9bce` message is `updstes`. Do not rewrite published history;
  do not propagate the typo.
- `SetupWizardError` is an HTTP-status-bearing throw from parse/validate
  helpers. Consistent today; prefer `Result` if those files are touched.
- Codex Setup Guide assist uses `engine.models[0]!.model`
  ([`server/index.ts`](../../server/index.ts) ~17244). Catalog construction
  puts the instance default first, so this is usually the default, but it
  ignores any later UI model pick and breaks if `default` is empty.
- [`WorkPage`](../../src/components/WorkPage.tsx) and the goal panel poll
  every 5s. Task view already has `work.event` / `work.link` SSE;
  goals have no frame.

---

## 3. Current architecture (short)

Two layers that should share a model, and currently do not.

```
connectors (kind-driven, read)
  jira / gitlab / plane / fake
  query, fetch, capture, changes
        │
        │  used by task boards, watches, link chips
        │
        ▼
team backlog mission (provider-named, write)
  inferTeamBacklog → scanTeamBacklog → advanceTeamBacklog
        │                │                    │
        │                │                    ├─ ensure_work_item (bots implement)
        │                │                    └─ merge / Jira Done (server writes)
        ▼                ▼
  /pursue goals     Work overview
  OngoingGoalPanel  scope-choice + 5s poll
```

**What is already solid (keep):**

- Fail-closed **inventory**: any scan error keeps the previous targets and
  last successful timestamp; disappearing items are re-fetched, not assumed
  done ([`scanTeamBacklog`](../../server/team-backlog.ts)).
- SHA-locked merge + post-write readback; `mayWrite()` is checked
  immediately before the mutating HTTP (the default is the bug).
- Observed/synced evidence required before a completion write.
- Stop after `begin` still blocks the write (`stillActive`).
- Setup Guide is **admin-only**, drafts only, no bots until reviewed
  `/commit`. Prompt forbids permissions, grants, integrations, credentials.
  `appHints` are informational.
- Work overview visibility follows bot/thread/group access; budget renew is
  already admin-flagged (`canRenew`).
- Watches already wake missions via `backlogScopeContains` without a model
  turn.

**What is kit logic baked into core:** Jira board widening, “must have both
providers,” GitLab-issue drop, Security/Manager rules, mission detector
requiring the words “jira” and “gitlab.”

---

## 4. Alignment with the task-connectors plan

Keep these principles from
[`2026-09-23-task-connectors.md`](2026-09-23-task-connectors.md):

- Kinds, not providers. UI and runner branch on `kind` / `statusCategory`.
- Drop-in registry: new connector = folder + one `registry.ts` line +
  contract suite. Path allowlist in `scripts/check-connector-pr.mjs`.
- Connectors never see the store, bots, or other connections. `ctx.fetch`
  only.
- Observed over claimed. Claimed evidence cannot complete a mission.
- Watches stay token-free detection; missions consume their `SourceChange`s.
- Isolated fixtures only ([`docs/verification/README.md`](../verification/README.md)).

### Incompatibilities (explicit)

| Task-connectors plan | What landed / what this plan does |
|---|---|
| “Connectors read; bots act.” Writes stay on bot tools. | Missions already do **server-owned** attested writes. We keep that capability (it is the mission’s value) but make it an **optional, fail-closed connector action**, off by default. Bots still implement; only the coordinator may complete. |
| “Nothing outside the connector folder names a provider.” | `team-backlog.ts`, `team-backlog-actions.ts`, the runner, Work scope copy, and `isTeamBacklogObjective` all name Jira/GitLab. Target: those files take `connectorId` from the registry and `kind` from the item. |
| “No two-way sync.” | Unchanged. A completion action is a one-shot attested write with readback, not field sync. |
| Phase 8: GitLab issues as `work_item`. | Connector already implements this. Mission scan drops them. Kit policy will decide. |
| Phase 8: Plane drop-in. | Plane is registered. Missions cannot see it until scopes are kind-driven. |

Amended principle:

> **Connectors read by default. Server-owned writes are optional actions
> declared on the manifest, allowlisted per connection, and disabled until
> a workspace flag is on.** Bots still do implementation through their own
> tools. The mission coordinator is the only caller of attested completion.

---

## 5. Non-goals

- Two-way field sync, generic workflow engines, or per-provider screens.
- Replacing shared tasks, watches, or `/goal` room runs.
- Enabling live Jira/GitLab writes in CI or on the user’s workspace.
- Rewriting commit `b50e9bce` (`updstes`).
- Making Setup Guide create connections, grant write tokens, or turn on
  mission writes.
- A Settings toggle for mission writes (same posture as
  `features.sharedComputers`: config-file, explicit, no silent UI grant).
- Inventing connectors that do not exist yet (GitHub, ServiceNow). The
  contract must accept them; this plan does not add them.

---

## 6. Target architecture

### 6.1 Kind-driven missions

A **mission** is an ongoing goal whose inventory is a set of connector
**scopes**, not a Jira+GitLab pair.

```ts
// shared/team-backlog.ts — connectorId is a registry id, not an enum
backlogScopeSchema = {
  id, connectorId: string, connectionId, query, label, groupId?,
  kinds: LinkKind[]  // default: connection’s mission kinds
}
```

`connectorId` is validated at write time against `connectorById`. Unknown
ids fail closed (scope gate), they do not crash the process.

**Ready to run** means: at least one enabled, team-visible, query-capable
scope, and no unresolved scope choices. Not “has Jira and has GitLab.”

**Infer** (same sources as today: team board, watches, linked work, then
section-scoped connections, then global candidates as *choices*):

1. Ask each connection’s connector for `manifest.capabilities.query` and
   `manifest.kinds`.
2. Build scopes with `kinds = kit.inventoryKinds ?? defaultMissionKinds(manifest)`.
3. Default mission kinds = `manifest.kinds ∩ { work_item, change_request }`.
4. If the set is ambiguous (globals, fuzzy board JQL), put them in
   `choices` and raise a `scope` gate. Do not pick for the team.

**Scan** keeps today’s atomic/fail-closed rules. The kind filter becomes
`scope.kinds.includes(item.kind)` instead of
`gitlab ⇒ change_request only`. Out-of-scope project/repo still throws
(incomplete scan). GitLab issues survive when the scope’s kinds include
`work_item`.

**Complete** when a fresh complete scan shows every target `done`, every
linked task has observed checks, and no gates remain. Criteria text is
generated from the selected kinds (“every scoped work item is evidenced
and done”, “every scoped change request is merged at a reviewed head”),
not hardcoded “Jira issues and MRs.”

**Detector** (`isTeamBacklogObjective`): keep the “named issue/MR is a
deliverable” escape. Treat as a mission when the outcome talks about
current/all/unfinished/backlog work **and** the owner’s team has at least
one query-capable connection (or the text names any registered connector
/ “merge requests”). Do not require the words “jira” **and** “gitlab.”
A 1:1 chat with no team connections still becomes `needs-input` (scope
gate), never a false empty completion.

### 6.2 Kits (first-class, still modular)

A **kit** is data, not a second connector system. It says how a common
team shape uses connectors and automations.

```ts
interface TeamWorkKit {
  id: string;                 // "jira-gitlab", "gitlab", "jira", "plane"
  name: string;
  connectors: {               // roles, not required pair
    role: "tracker" | "code" | "other";
    connectorId?: string;     // pin when the kit is branded; omit to accept any
    kinds: LinkKind[];        // inventory kinds for that role
    optional?: boolean;
  }[];
  approval?: { extraRuleNames?: string[] };  // added on top of live required rules
  watches?: { name: string; events: SourceChangeType[]; scopeFrom: "connection" }[];
  criteria: (scopes: BacklogScope[]) => string[];
}
```

- **`jira-gitlab`** is today’s behavior: Jira `work_item` + GitLab
  `change_request` only (issues dropped), extra named rules optional.
- **`gitlab`**: GitLab `work_item` + `change_request`.
- **`jira`** / **`plane`**: tracker `work_item` only; no merge action.
- Unrecognized mix: no kit required. Infer from manifests. Kits are
  conveniences and test fixtures, not a closed world.

Watches stay the automation surface. A kit may *suggest* watches; it does
not embed provider HTTP. Adding Plane is still a connector PR plus, later,
a kit JSON — not a runner edit.

### 6.3 Connector actions (optional writes)

Extend `Connector` / `ConnectorManifest` in
[`server/connectors/types.ts`](../../server/connectors/types.ts):

```ts
type MissionActionId = "complete_work_item" | "merge_change_request";

interface ConnectorManifest {
  // existing fields…
  actions?: {
    id: MissionActionId;
    kind: LinkKind;
    label: string;
  }[];
}

interface Connector {
  // existing methods…
  act?(
    ctx: ConnectionContext,
    input: {
      action: MissionActionId;
      target: { kind: LinkKind; externalId: string; headSha?: string };
      mode: "dry-run" | "commit";
    },
  ): Promise<{
    changed: boolean;
    target: Partial<BacklogTarget>;
    gates: BacklogGate[];
  }>;
}
```

Rules:

- Absent `actions` / `act` ⇒ that connector cannot be asked to write.
  The runner records an `access` gate. No HTTP.
- `act` uses `ctx.fetch` only. Contract suite records every request.
- `mode: "dry-run"` evaluates live policy and returns gates; it must not
  send PUT/POST/DELETE/PATCH.
- `mode: "commit"` is refused by the **server wrapper** unless the safety
  locks below are all open. The connector still re-reads immediately
  before and after the write (today’s SHA / status readback).
- Move today’s GitLab merge and Jira transition bodies into
  `server/connectors/gitlab` and `server/connectors/jira`.
  Delete the parallel HTTP in `team-backlog-actions.ts`.
- The runner calls `act` by `action` + `kind`, never `if (gitlab)`.

This is the drop-in test: a Plane `complete_work_item` lands in
`server/connectors/plane/**` + registry + tests. The runner does not change.

### 6.4 Config-driven gates

Three layers, cheapest first:

1. **Live provider policy (default).** GitLab: every *required*
   `approval_state` rule, `approvals_left === 0`, project
   pipeline/discussion flags, mergeable/not-draft. Jira: exactly one
   non-rejected Done transition (today’s heuristic), or a configured
   transition id. Unknown / missing fields ⇒ `policy` gate, never skip.
2. **Connection extras.** Optional `settings.requiredApprovalRules: string[]`
   (names). Used to require “Security” / “Manager” **when that org has
   them**, not as a global constant. Empty default.
3. **Kit extras.** The `jira-gitlab` kit may ship example extras in docs;
   it does not hardcode them in TypeScript.

Gate kinds stay the existing union, but `security` / `manager` become
optional aliases when a rule name maps to them. New gates use `review`
with `decisionMaker = <rule name>`. Do not add a Zod enum member per org
role.

`BacklogGate.kind` of `scope` | `inventory` | `task` | `review` | `policy`
| `access` | `budget` is enough for the Work UI. Keep `security`/`manager`
readable for one release, then stop emitting them.

### 6.5 Work / goals UX

- Scope picker lists `choice.label` + connector **name** from the
  manifest. Submit enabled when the selection is a valid mission (one or
  more scopes; kit constraints if a kit is pinned). No “must tick Jira
  and GitLab.”
- `/pursue` and the goal panel only render create/control actions the
  session can call (see auth matrix). A client 403 is shown, never
  swallowed.
- Work page: subscribe to SSE `goal` / existing `work.*` frames; keep a
  **30s** fallback poll for the aggregate overview. Do not start a new
  poll while one is in flight (today’s `serial` ref stays).
- Copy talks about “inventory” and “change requests,” not only Jira/MRs.
- `canRenew` stays admin-only and stays the only control that resets
  budgets.

### 6.6 Setup Guide (stay narrow)

No change to the grant model:

- Routes under `/api/setup-wizard/` remain admin-only.
- Assist/commit still cannot emit permissions, connections, write flags,
  skills, or routines.
- `appHints` stay display-only.
- When Codex assist is used, pick
  `engine.models.find(m => m.model === instanceDefault) ?? engine.models[0]`
  and, if assist input later gains a `model` field, require it to be in
  that engine’s list. Do not invent a model id.

Optional cleanup (same PR as the Codex nit, not a rewrite): return
`{ ok, status, error }` from parse/validate instead of throwing
`SetupWizardError` out of pure functions. HTTP mapping stays at the route.

---

## 7. Safety model

Three locks. All must be open for `mode: "commit"`. Any one closed ⇒
dry-run only, `access` or `policy` gate, **zero** mutating HTTP.

| Lock | Default | Where |
|---|---|---|
| Workspace flag `features.teamMissionWrites` | **off** (absent = off), like `sharedComputers` | `config.json` / `featureConfigSchema`. No Settings toggle. |
| Connection allowlist `writes.enabled` + `writes.allow: MissionActionId[]` | **off**, empty allow | stored with the connection; secrets handling unchanged |
| Live `mayWrite()` | false unless the goal is still in-flight **and** the two locks above are open | runner, checked again immediately before `act(..., commit)` |

Additional invariants (already partly present — make them tests, not
comments):

- **Dry-run is the default path.** Unit tests for merge/transition with
  default config must assert no PUT/POST/PATCH/DELETE.
- **Fail-closed inventory.** Error ⇒ `scan.status = incomplete`, previous
  targets retained. Never complete a mission on an incomplete scan.
- **Evidence gate.** `complete_*` / `merge_*` require observed/synced
  criteria on the linked task. Claimed evidence ⇒ `task` gate.
- **Idempotency.** Already-done (merged / Jira done) is a successful
  no-op with readback, not a second write.
- **Identity lock.** GitLab merge still sends `{ sha }`. Head change ⇒
  `review` gate, no write. Jira readback must return the same key and a
  done category.
- **Stop is honored.** `mayWrite()` false after Stop throws *before*
  mutating HTTP (existing test stays).
- **No silent Setup Guide grants.** Wizard cannot set
  `features.teamMissionWrites` or `writes.enabled`.
- **Self-write suppression** on watches stays on (existing
  `actor.isBot`). A coordinator Done/merge must not loop the mission.

Behavior change vs `15cb131b`: a working mission that *would* have merged
or transitioned now records “external writes are disabled” until an admin
sets both locks. That is the point of P0.

---

## 8. Auth matrix

Default deny stays. List a route in `CLIENT_ALLOW` only when the handler
already filters visibility. Add a **body/action filter** for PATCH, the
same way bot/room display patches work.

| Route | Client | Admin | Handler extra |
|---|---|---|---|
| `GET /api/work/overview` | yes (already) | yes | existing visibility |
| `GET /api/goals`, `GET /api/goals/:id` | **add** | yes | `workGoalVisible` |
| `POST /api/goals` | **add** | yes | existing conversation/bot checks. Writes remain locked off, so a client-created mission cannot mutate Jira/GitLab |
| `POST /api/goals/:id/scope-choice` | yes (already) | yes | requester or admin (`canChooseScope`) |
| `PATCH … action=pause\|stop\|wake` | **add** | yes | visible goal; wake does **not** reset budgets |
| `PATCH … action=resume` | no | yes | budget renew; Work `canRenew` already encodes this |
| `POST /api/goals/:id/work-items` | optional later | yes | keep admin until a client UI needs it |
| `/api/setup-wizard/*` | no | yes (already) | unchanged |
| `/api/task-connections` mutations | no | yes | unchanged |

UI contract: Composer, OngoingGoalPanel, and Work only show an action when
the session may call it. Use `isOwnerOrAdmin` / a small
`goalCapabilities` from `GET /api/auth/session` or the already-client
`GET /api/config` feature bag. Do not infer from a 403 after click.

Work `canRenew` stays admin. Do not add resume to `CLIENT_ALLOW` and then
“hope” the handler checks — put the check in both places and test both.

---

## 9. Phased implementation

Small shippable PRs, each mergeable without the later ones. P0 and P1 can
land in parallel after P0’s flag exists.

### P0 — Fail-closed writes (safety freeze)

**Why first.** Stops live merges/transitions on any workspace that pulls
`codex/bedrock-provider` with real tokens.

- Add `features.teamMissionWrites` (optional boolean, default off).
- Add connection `writes: { enabled?: boolean, allow?: MissionActionId[] }`
  to the stored-connection schema (default off/empty). Ignore unknown
  action ids.
- Change `mayWrite` default to `() => false`. Runner composes
  `stillActive && workspaceFlag && connection.writes.enabled && allow.includes(action)`.
- When locks are closed and evidence/policy would otherwise write: record
  an `access` gate, leave the target unchanged, send no mutating HTTP.
- Keep today’s dry-run policy checks so Work still shows what is missing.

**Acceptance**

- Default fixture / default config: evidenced ready MR + unique Jira Done
  transition ⇒ `changed: false`, gate present, **no** PUT/POST.
- Both locks on + `stillActive` + fixtures: today’s write+readback still
  works.
- Stop during probe: still no write (existing test).
- Verification doc states writes are off unless both locks are set.

**Tests**

- `server/team-backlog-actions.test.ts`: default `mayWrite` / no-flag
  cases (the current “merges only after …” test must pass the flag in).
- `server/team-backlog.test.ts`: runner with evidenced tasks and default
  config never calls merge/transition fetch methods.
- `server/config` / task-connection parse: unknown `writes.allow` entries
  dropped or rejected (pick reject — fail closed).
- `server/request-auth.test.ts` unchanged in this PR.

**Verify:**
`pnpm exec vitest run server/team-backlog-actions.test.ts server/team-backlog.test.ts server/team-backlog.e2e.test.ts --maxWorkers=2`

No live tokens.

### P1 — Auth matrix and honest UX

- Add the client routes in §8 to `CLIENT_ALLOW` and the golden list in
  `server/request-auth.test.ts`.
- PATCH handler: `resume` requires `admin`; other actions use visibility.
- Composer: `/pursue` only if the session can `POST /api/goals`.
- OngoingGoalPanel: do not swallow GET/POST errors; hide create/resume
  the session cannot use.
- Work renew button already uses `canRenew`; add a test that a client
  overview payload has no `canRenew` and that PATCH resume is 403.

**Acceptance**

- Client session: GET goals 200 (filtered), POST deliverable 201, PATCH
  pause 200, PATCH resume 403, Setup Guide 403.
- Client UI does not show Start pursuing / Renew.
- Admin/loopback owner unchanged.

**Tests**

- `server/request-auth.test.ts` (client vs admin paths).
- Route fixture with a `client` session cookie (extend
  `server/routes/work-overview.test.ts` or a small `server/ongoing-goals`
  auth test).
- `src/components/OngoingGoalPanel.test.ts` + Composer slash-command test
  for the hidden `/pursue` case.
- `src/lib/session.test.ts` if a new capability helper is added.

**Verify:** request-auth + overview + panel tests; no browser required
beyond existing UI e2e if you touch Work copy.

### P2 — Kind-driven scopes and single-provider teams

- Replace `z.enum(["jira","gitlab"])` with a registry-checked string.
- Infer / choose / runner: ready when `scopes.length >= 1` and
  `choices` is empty (or the user just chose a valid subset).
- Scan kind filter = `scope.kinds`.
- Default kinds per §6.1. Ship `jira-gitlab` kit kinds so existing
  Jira+GitLab teams **keep dropping GitLab issues** until they opt into
  the `gitlab` kit or add `work_item` to that scope.
- Detector no longer requires both words; still refuses to widen a named
  `PAY-123` / `group/project!10`.
- Generated acceptance criteria from kinds.
- Work scope form: any valid subset; labels from manifests.

**Acceptance**

- GitLab-only team with a project setting: mission scans issues + MRs,
  completes when both are done (writes still off ⇒ `access` gates if
  they would write).
- Jira-only: scans issues, never asks for GitLab.
- Plane-only (fake or recorded fixtures): same, `work_item` only.
- Jira+GitLab with the default kit: same inventory as today (`PAY-1`,
  `acme/app!10`, no `#71`).
- Ambiguous globals still `needs-input` with choices; one-sided choice
  is accepted.

**Tests**

- `server/team-backlog.test.ts`: one new case per shape above; keep the
  existing both-providers cases as the `jira-gitlab` kit.
- `server/ongoing-goals.test.ts`: detector cases (Jira-only wording,
  GitLab-only wording, named issue still not a mission).
- `server/team-backlog.e2e.test.ts`: add a GitLab-only isolated fixture
  (synthetic HTTP, no real token).
- Work UI: submit enabled without both connector ids
  (`scripts/testing/team-backlog-ui.e2e.test.ts` or a static WorkRow test).

**Verify:** existing team-backlog vitest list plus the new e2e shape.
Update [`docs/verification/team-backlog.md`](../verification/team-backlog.md)
and [`docs/verification/ongoing-goals.md`](../verification/ongoing-goals.md).

### P3 — Move writes into connector actions

- Add `actions` / `act` to the contract (§6.3).
- Implement GitLab `merge_change_request` and Jira `complete_work_item`
  using the existing probe/readback logic.
- Runner: `connector.act(...)` only. Delete standalone HTTP helpers once
  tests move.
- Contract suite: if `actions` is declared, `dry-run` emits no mutating
  methods; `commit` is not called by the suite unless the test harness
  sets locks; `ctx.fetch` is the only network; secrets undeclared throw.
- Fake connector gets a dry-run-only `complete_work_item` for UI/runner
  tests.

**Acceptance**

- `scripts/check-connector-pr.mjs` still passes a Plane-only actions
  addition (document that `actions` inside the folder is allowed).
- No `gitlabRequest` / `jiraRequest` outside `server/connectors/*`.
- P0 locks still wrap `commit` in the **server**, not only inside the
  connector (defense in depth: a buggy `act` that ignores `mode` still
  cannot be invoked).

**Tests**

- Move action fixtures under `server/connectors/{jira,gitlab}/`.
- Contract-suite additions in `server/connectors/contract-suite.ts`.
- Runner test uses the fake connector only (no provider names).

**Verify:** connector tests + team-backlog runner tests +
`pnpm exec vitest run scripts/check-connector-pr.test.ts`.

### P4 — Config-driven approval / policy

- GitLab: required live rules + optional `requiredApprovalRules`.
- Remove the `"Security"` / `"Manager"` constants.
- Jira: optional `doneTransitionId` / `doneTransitionName`; else today’s
  unique-Done heuristic.
- Gate `decisionMaker` = rule name or “Project approvers”.
- Kit extras are data. The `jira-gitlab` kit *may* document Security /
  Manager as an example extras list, not compiled-in.

**Acceptance**

- Fixture with rules `AppSec` + `Code owners` only: merge dry-run passes
  when those required rules are current-head approved.
- Fixture that still has Security/Manager: passes only if extras (or live
  required rules) say so.
- Missing `approval_state.rules`: throw / `policy` gate, no write.

**Tests:** extend GitLab action fixtures; one Jira configured-transition
case; one “unknown policy fields” fail-closed case (already exists —
keep it).

### P5 — Work/goals UX, SSE, Setup Guide nits

- SSE `goal` frames (id, revision, status, detail, scan, gate counts),
  filtered like work items. Work page + goal panel subscribe; 30s
  fallback remains.
- Scope / source-row copy is kind-driven.
- Codex assist model selection (§6.6).
- Optional `SetupWizardError` → Result if that file is already open.

**Acceptance**

- Toggling a goal in a fixture updates Work without waiting 5s (SSE or
  test hook).
- Codex assist with a non-first listed model uses the instance default
  (or the explicit assist model once added).
- Setup Guide still creates no connections and cannot set write flags
  (existing e2e).

**Tests**

- Goal SSE filter (member without hub access does not see another team’s
  mission detail).
- `server/setup-wizard-codex.test.ts` or the assist route test for model
  choice.
- Work poll interval assertion (30s fallback, no overlapping polls).

**Verify:**
[`docs/verification/setup-wizard.md`](../verification/setup-wizard.md),
team-backlog UI e2e, ongoing-goals fixture.

### P6 — Docs, kits as data, desk-test story

- `docs/connectors.md`: document `actions`, dry-run, locks.
- `docs/verification/team-backlog.md`: flag-off is the default recipe;
  a **separate** “writes enabled” recipe exists only against synthetic
  HTTP (the existing isolated server + loopback stub).
- Ship kit JSON (or a `server/team-work-kits.ts` module) for the four
  kits in §6.2. No new connector.
- Desk-test: fixtures first; real tokens only after P0+P3+P4 and an
  explicit operator checklist (below).

---

## 10. Migration and desk-test

### Existing missions

- Stored `teamBacklog` with `connectorId: "jira"|"gitlab"` remains valid.
- Missing `kinds`: fill from the `jira-gitlab` kit defaults so inventory
  does not suddenly include GitLab issues.
- On first advance after P0, writes that previously succeeded now gate
  until locks are set. Operators who relied on auto-merge must set
  `features.teamMissionWrites` **and** `writes` on that connection.

### Desk-test (always)

1. `node --experimental-strip-types scripts/control-omb.ts launch`
2. Recipes in `docs/verification/team-backlog.md` and `ongoing-goals.md`.
3. Never point a recipe at the user’s live app or real Jira/GitLab.

### When real tokens are allowed

Only after P0–P4, on a **scratch** project the operator names, with both
locks off first:

1. Run a mission flag-off: confirm inventory and gates, confirm the
   tracker/MR did not change (readback in the provider UI).
2. Enable locks on that connection only. Run one evidenced item.
3. Confirm exactly one write and a matching readback.
4. Stop mid-probe; confirm no write.
5. Turn locks off again.

That sequence is a rollout checklist, not CI.

---

## 11. Bug-prevention test strategy

Prefer tests that lock a *class* of mistake:

| Class | Where it is locked |
|---|---|
| Silent live write | P0: default config + evidenced target ⇒ zero mutating methods. Contract suite: `dry-run` has the same assertion for every connector that declares `actions`. |
| Provider-named core | P2/P3: runner unit tests use the fake connector only. `check-connector-pr` stays. A lint or unit test that `shared/team-backlog.ts` has no `z.enum(["jira","gitlab"])`. |
| Auth drift | `request-auth.test.ts` remains the golden list. Any new `/api/goals*` or `/api/work*` path must be added as client **or** asserted admin. UI tests hide actions not on the client list. |
| Single-provider stuck | P2 fixtures: GitLab-only / Jira-only / Plane-only must leave `needs-input` after a valid one-sided choice. |
| False empty inventory | Keep the malformed-row and out-of-project tests. Add: query 503 ⇒ incomplete, not `itemCount: 0` complete. |
| Kit vs connector filter | Jira+GitLab kit fixture drops GitLab issues; GitLab kit fixture keeps them. Same connector, different `scope.kinds`. |
| Approval org-specific | P4: no test string `"Security"` in production code; extras live in fixture settings. |
| Wizard privilege | Existing setup-wizard e2e: rejected privilege fields, no connections, no write flags in commit payload. |
| Idempotent write | Already-merged / already-Done ⇒ `changed: true` observation, no second mutating HTTP. |
| Stop vs write | Existing `mayWrite === false` test stays on the server wrapper. |

Do not add a live-token test. Do not add a sample-data generator.

---

## 12. Open questions (Dylan)

Only these block a later phase. Everything else is decided above.

1. **Client-created missions.** This plan lets a `client` session
   `POST /api/goals` (writes stay locked). If missions should be
   owner/admin-only, say so before P1 — then `/pursue` stays hidden for
   clients and they only use Work + scope-choice.
2. **Jira+GitLab kit vs GitLab issues.** Plan default: existing
   Jira+GitLab teams keep dropping GitLab issues; GitLab-only teams
   include them. If every GitLab connection should inventory issues even
   beside Jira, say so — that is a one-line kit default, not a redesign.
3. **Settings surface for write locks.** Plan: config-file only, no
   toggle (same as `sharedComputers`). If operators need an admin Settings
   panel later, it must be explicit, default off, and never offered by
   Setup Guide.

Not an open question: server-owned attested completion stays. Turning the
mission back into “bots merge through MCP only” would drop the evidence
gate that is the feature.
