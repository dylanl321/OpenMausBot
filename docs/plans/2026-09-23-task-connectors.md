# Task connectors and structured shared-task views

Status: proposed · Design canvas: [Shared Task Redesign](https://claude.ai/artifact/5EARfPBL1MM4er7iwSprqg)

Shared tasks ([shared-work.md](../shared-work.md)) give each deliverable one
durable record, but everything a bot produces reaches the UI as free text:
results are strings, artifacts are `label: ref`, evidence and decisions are
string lists. Commits, merge requests and tracker comments exist only inside
prose, and the sidebar can only say *Running* or *Waiting*.

This plan adds:

1. A **provider-neutral model** of what a task is linked to and what happened
   on it (linked items, task events, status categories).
2. **Drop-in connectors** that translate one external system (Jira, GitLab,
   Plane, …) into that model. A new connector adds a folder and one registry
   line; no UI, settings screen or task schema changes.
3. **Automatic capture** of what bots do from the runtime events every driver
   already emits, so the UI does not depend on the model remembering to report.
4. The **task view, sidebar, bot-turn card and topic board** from the design
   canvas, rendered by *kind*, never by provider.
5. **Watches:** token-free automation triggers. Connectors detect changes
   (new issues, status changes, pushes, failed pipelines, new comments)
   deterministically, and a model runs only when a rule matches.

## Principles

- **Kinds, not providers.** UI code branches on `kind` and `statusCategory`.
  A provider contributes a label, an icon and details, nothing structural.
- **Everything is optional.** A task can have no linked items, only a tracker
  item, only code, or any mix. Standalone chat-started work stays first class.
- **Observed over claimed.** Data comes first from recorded tool calls and
  provider sync. Model-reported data is accepted but marked `claimed`.
- **Connectors read; bots act.** Connectors sync state and classify tool
  calls. Writes to external systems (comment, transition, open MR) stay with
  the bots' own tools (MCP, Composio, CLI) and existing permission checks.
- **No new scheduler, no new access model.** Execution stays on
  `RoomHandoffs`; visibility follows the existing work-item filtering.
- **Detect with code, decide with models.** Checking whether anything changed
  never costs tokens; a bot runs only when a change matches a rule.

## Non-goals

- Two-way sync of task fields back into trackers (bots do that via tools).
- Replacing the tracker as the system of record.
- A generic workflow engine or custom per-provider screens.

---

## Architecture

### Core model (`shared/work-links.ts`)

```ts
export type LinkKind =
  | "work_item"       // Jira issue, GitLab issue, Plane work item, ServiceNow incident
  | "change_request"  // GitLab MR, GitHub PR
  | "commit"
  | "build"           // pipeline, CI run, deployment
  | "comment"         // on a work item or change request
  | "document"        // Confluence, Google Doc, file in a workspace
  | "link";           // anything recognised by no connector

export type StatusCategory =
  | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled" | "unknown";

export interface LinkedItem {
  id: string;                  // stable: `${connectionId}:${kind}:${externalId}` or `url:${hash}`
  kind: LinkKind;
  role: "source" | "output" | "reference";
  connectorId?: string;        // "jira", "gitlab", "plane"; absent for plain links
  connectionId?: string;       // one configured account/site of that connector
  externalId?: string;         // "PAY-123", "482", "3f2a1c9"
  url?: string;
  title: string;
  state?: { label: string; category: StatusCategory };  // label is the provider's own words
  parentId?: string;           // comment → work item, commit → change request
  details?: Record<string, string | number | boolean>;  // flat, bounded; rendered as key/value
  provenance: "observed" | "synced" | "claimed";
  createdBy?: { botId: string; threadId: string };
  syncedAt?: number;
  updatedAt: number;
}

export interface TaskEvent {
  id: string;
  workItemId: string;
  revision: number;
  at: number;
  actor: { type: "bot"; botId: string; threadId: string } | { type: "user"; userId?: string }
       | { type: "connector"; connectionId: string } | { type: "system" };
  kind: "tool" | "output" | "state_change" | "comment" | "handoff" | "decision" | "criterion" | "lifecycle";
  summary: string;             // one line, redacted, ≤ 240 chars
  linkId?: string;             // the LinkedItem this event created or touched
  state?: "running" | "complete" | "failed";
  itemId?: string;             // runtime item id, to open the full tool call
  provenance: "observed" | "synced" | "claimed";
}
```

`WorkItem` (`shared/work-item.ts`) gains:

```ts
links: LinkedItem[];                          // replaces `artifacts` (migrated as kind "link")
criteria: { text: string; state: "pending" | "in_progress" | "checked" | "blocked";
            evidence: string[] /* LinkedItem or TaskEvent ids */; }[];   // replaces string list
decisions: { text: string; at: number; by?: string }[];
assignments[].currentStep?: { summary: string; since: number; itemId?: string };
```

`acceptanceCriteria`, `artifacts` and `evidence` stay readable for one
release. The loader migrates them; writers use the new fields.

### Connector contract (`server/connectors/types.ts`)

A connector is one module exporting a `Connector`. Everything the UI and
settings need is in the manifest; everything the server needs is in plain
functions. Nothing outside the connector's folder refers to a provider.

```ts
export interface Connector {
  manifest: {
    id: string;                          // "jira", "gitlab", "plane"; stable, lower case
    name: string;                        // "Jira"
    icon?: string;                       // inline SVG string (stroke, currentColor); fallback is the initial
    kinds: LinkKind[];                   // what it can produce, e.g. ["work_item", "comment"]
    settings: JsonSchema;                // non-secret fields (site URL, workspace slug, default project)
    secrets: { key: string; label: string; help?: string }[];  // stored like MCP server secrets
    capabilities: { webhooks?: boolean; query?: boolean; poll?: boolean };
    statusDefaults?: Record<string, StatusCategory>;  // provider status → category fallback
  };

  /** Validate settings + secrets; return the account label ("acme.atlassian.net"). */
  test(ctx: ConnectionContext): Promise<{ ok: true; account: string } | { ok: false; error: string }>;

  /** Identity ↔ item. "PAY-123" or a pasted URL → externalId; used by ensure_work_item and link_item. */
  parseRef(input: string, ctx: ConnectionContext): { kind: LinkKind; externalId: string } | null;
  urlPatterns(ctx: ConnectionContext): RegExp[];

  /** Read current state for linked items (batched). */
  fetch(ctx: ConnectionContext, refs: { kind: LinkKind; externalId: string }[]): Promise<SyncedItem[]>;

  /** Optional: list items for a board or "start next work" (JQL, Plane filter, GitLab issue query). */
  query?(ctx: ConnectionContext, query: string, cursor?: string): Promise<{ items: SyncedItem[]; cursor?: string }>;

  /** Optional: turn a verified webhook payload into changed refs. */
  webhook?(ctx: ConnectionContext, headers: Headers, body: unknown): Promise<{ kind: LinkKind; externalId: string }[]>;

  /** Declarative capture rules for bot tool calls (see below). */
  capture: CaptureRule[];

  /** Optional: change feed for watches (see Watches). Returns normalized
   * changes after `cursor` and the next cursor. Must be cheap and idempotent. */
  changes?(ctx: ConnectionContext, scope: WatchScope, cursor: string | null):
    Promise<{ changes: SourceChange[]; cursor: string }>;
}
```

The manifest also declares `watch: { scopes: JsonSchema; events: SourceChangeType[] }`,
so the watch editor can render scope fields (project, JQL, repo, branch) and
event choices with no connector-specific UI.

`SyncedItem` is `LinkedItem` minus the fields the server owns (id, role,
provenance, createdBy). `ConnectionContext` carries settings, a secrets
accessor, a rate-limited `fetch`, and a logger. Connectors never receive the
store, bots or other connections.

### Drop-in registry

```
server/connectors/
  types.ts            contract above
  registry.ts         const CONNECTORS = [jira, gitlab, plane, ...] (the one line per connector)
  contract-suite.ts   shared test suite every connector must pass
  capture.ts          runtime-event → rule matching (connector-agnostic)
  sync.ts             polling, webhook route, backoff, batching
  builtin/git.ts      git/shell rules, not tied to any host
  builtin/url.ts      plain-link fallback
  jira/     index.ts  jira.test.ts  fixtures/
  gitlab/   index.ts  gitlab.test.ts fixtures/
  plane/    index.ts  plane.test.ts  fixtures/
```

Adding a connector = a new folder + one import in `registry.ts` + its
contract-suite test passing. The settings UI, link chips, board columns,
sidebar rows and task view pick it up from the manifest with no changes.

### Connections (configuration)

A connector is code; a **connection** is one configured account of it (two
Jira sites are two connections). Stored in `config.json`:

```jsonc
"taskConnections": [
  { "id": "jira-acme", "connectorId": "jira", "label": "Acme Jira",
    "settings": { "site": "https://acme.atlassian.net" },
    "secrets": { "email": "…", "apiToken": "…" },      // encrypted/redacted like mcpServers
    "teams": ["team_payments"],                          // which teams may use it
    "enabled": true }
]
```

- Secret handling reuses the `mcp-registry.ts` pattern: the renderer gets key
  names, never values; mutations keep existing secrets unless replaced.
- Team scoping follows existing team scope. A task can only link items
  through connections its team may use.
- The existing work-item identity `jira:account-a:PAY-123` becomes
  `<connectorId>:<connectionId>:<externalId>`. `ensure_work_item` resolves it
  with `parseRef`; an unrecognised identity still works and simply has no
  source link (today's behaviour).
- Connections are independent of how bots reach the system. A bot may use a
  Jira MCP server, Composio or a CLI; capture rules match all of them, and
  sync uses the connection's own read-only credentials.

### Capture pipeline (`server/connectors/capture.ts`)

Every driver already emits normalized `item.started` / `item.completed`
runtime events with a redacted title, command summary and bounded
input/output preview (`shared/runtime-events.ts`, `server/tool-summary.ts`).
One listener handles all engines:

```
RuntimeEvent (thread bound to a work item via assignment or hub)
  → currentStep update on the assignment         (item.started, always)
  → TaskEvent kind "tool"                        (item.completed, always; collapsed in UI)
  → match CaptureRules (connectors + builtin git + url)
      → upsert LinkedItem (provenance "observed", role "output")
      → TaskEvent kind "output" | "comment" | "state_change"
      → schedule sync fetch for that ref (enrich state/details)
```

A capture rule is data, not code where possible:

```ts
interface CaptureRule {
  match: { tool?: RegExp; server?: RegExp; command?: RegExp };  // tool name, MCP server name, shell summary
  on: "completed";
  requireOk?: boolean;                        // default true
  produce: { kind: LinkKind; parentFrom?: "input" | "output" };
  extract: (call: { title: string; summary?: string; input?: string; output?: string })
           => { externalId: string; url?: string; title?: string; parentRef?: string } | null;
  event: (item: SyncedItem) => string;        // "opened !482 Round partial refunds…"
}
```

Example rules for the Jira connector: tool names matching
`/jira.*(add|create).*comment/i` produce `comment`, with the parent issue
key read from the input; `/jira.*transition/i` produces a `state_change`
event. Built-in git rules parse `git commit` / `git push` output for
hashes and branch names. They are host-agnostic; a GitLab connection later
enriches the commit by its hash.

Matching runs only for threads bound to a work item, and only on the
already-redacted previews. When a preview is truncated and the extractor
cannot find an ID, nothing is created. The raw tool call remains in the
thread.

### Sync (`server/connectors/sync.ts`)

- Pull linked items per connection in batches after capture, when a task is
  opened, and on a backoff poll: 1 min for active tasks, 15 min for settled,
  none for cancelled.
- Webhooks at `POST /api/connectors/:connectionId/webhook`, verified by the
  connector. Desktop installs without a public URL poll only.
- Source-item changes (description, criteria-bearing fields) feed the existing
  `input` fingerprint, so a changed story starts a new revision through the
  current mechanism. Status-only changes do not.
- Rate limits and failures mark the connection degraded in settings; linked
  items keep their last state with `syncedAt`.

### Storage and wire

- `work-items.json` gains `links`, `criteria`, `decisions`,
  `assignments[].currentStep`.
- Events go to `work-events/<workItemId>.jsonl`, append-only, capped per
  revision (e.g. 2 000) with tool events compacted first. Team and workspace
  backups include them; portable team backups drop tool events.
- API: `GET /api/work-items/:id/events?cursor=`, `POST /api/work-items/:id/links`
  (user "Link item"), `GET /api/connectors` (manifests),
  `/api/task-connections` CRUD + test, `GET /api/task-connections/:id/query`.
- Watches: `watches.json` (definitions, cursors, bounded dedupe receipts),
  `/api/watches` CRUD, `POST /api/watches/:id/dry-run`, and SSE `watch` frames
  for check and match counts. Included in team backups with cursors reset.
- SSE: `work.event` and `work.link` deltas, filtered exactly like work items
  (members see only what their topic/hub/coordinator access allows).

### Bot-facing tools (`server/drivers/agents-catalog.ts`)

- `update_work_item`:
  - `completed_criteria: string[]` becomes `criteria: [{ index, state, evidence: string[] }]`,
    where evidence holds LinkedItem/TaskEvent ids from `get_work_item`.
  - The server rejects `checked` without at least one existing evidence id. Only
    `observed`/`synced` evidence satisfies completion. `claimed` evidence is
    recorded, but the task can only reach `needs-input` with it (tunable).
  - `decision` stays text; `artifacts` is deprecated in favour of `link_item`.
- New `link_item({ ref_or_url, role, title? })`: for outputs made outside
  recorded tools. It is resolved through `parseRef`/`urlPatterns`, else stored
  as `link`, and marked `claimed` until a sync confirms it.
- `get_work_item` returns links and recent events with ids, so the
  coordinator can cite them.
- `server/work-instructions.ts` / `work-coordination.ts` get one added rule:
  cite recorded items as evidence; use `link_item` only for work done outside
  your tools.

### Watches: token-free triggers (`server/watches.ts`)

Today a routine runs its prompt on every tick, and a webhook trigger runs
its prompt on every delivery. "Check Jira every 15 minutes for new
bot-ready stories" therefore costs a model run even when nothing changed. A
**watch** moves detection into code: a connector reports what changed since a
stored cursor, a declarative filter decides whether it matters, and only then
does an action run.

```
schedule tick (interval/cron, reusing routine schedules)  ─┐
connector webhook (verified, normalized)                   ─┼→ connector.changes(scope, cursor)
built-in git remote poll (`git ls-remote`, no API needed)  ─┘        │
                                                                     ▼
                          normalize → SourceChange[] → dedupe → filter → debounce/batch
                                                                     │ (no match: record "checked, 0 matches", no tokens)
                                                                     ▼
                                           action: code-only | ensure task | run routine | notify
```

**Normalized change** (`shared/watches.ts`):

```ts
export type SourceChangeType =
  | "item.created" | "item.updated" | "item.state_changed" | "item.assigned"
  | "item.labeled" | "comment.added"
  | "change_request.opened" | "change_request.updated" | "change_request.merged" | "change_request.closed"
  | "review.requested" | "review.submitted"
  | "commit.pushed" | "build.failed" | "build.succeeded" | "branch.created";

export interface SourceChange {
  id: string;                     // provider event/delivery id, or `${externalId}@${updatedAt}`: dedupe key
  type: SourceChangeType;
  connectionId: string;
  item: SyncedItem;               // same generic shape the UI already renders
  before?: { state?: StatusCategory; stateLabel?: string; assignee?: string; labels?: string[] };
  actor?: { name: string; isBot: boolean };  // lets filters ignore changes our own bots made
  fields: Record<string, string | number | boolean | string[]>;  // flat, filterable: project, labels, priority, branch, author…
  at: number;
}
```

**Watch definition** (stored in `watches.json`, team-scoped like routines):

```jsonc
{
  "id": "w_ready_stories",
  "name": "New bot-ready payments stories",
  "source": { "connectionId": "jira-acme",
              "scope": { "query": "project = PAY AND labels = bot-ready" } },   // shape from manifest.watch.scopes
  "events": ["item.created", "item.labeled"],
  "filter": { "all": [                                  // small declarative language, no code
    { "field": "state.category", "in": ["todo"] },
    { "field": "actor.isBot", "eq": false }
  ] },
  "check": { "type": "interval", "everyMinutes": 5 },   // ignored while webhooks deliver; falls back if they stop
  "batch": { "windowSeconds": 120, "max": 10 },         // one action for a burst of changes
  "action": { "type": "ensure_task", "topic": "Payments", "coordinatorBotId": "bot_lead",
              "criteriaFrom": "item" },
  "limits": { "maxActionsPerDay": 20, "quietHours": "22:00-07:00" },
  "startFrom": "now",                                    // or "backfill": fire for existing matches once
  "enabled": true
}
```

**Actions**, cheapest first:

| Action | Tokens | Example |
|---|---|---|
| `record` | none | Update linked items and task events, e.g. mark a task's MR merged, attach a failed build |
| `notify` | none | Sidebar attention / push notification: "PAY-140 moved to Ready" |
| `task_update` | none by default | A source-item change starts a new task revision through the existing `input` fingerprint; review changes on a linked MR wake that task's coordinator with the change as steering context |
| `ensure_task` | only the created task's own work | New matching issue → `ensure_work_item` called by the server with identity `<connector>:<connection>:<key>`, objective and criteria from the item. No coordinator turn is spent deciding whether to create it |
| `run_routine` | one routine run | Run an existing routine with the matched changes as structured context (`{{changes}}`), e.g. a triage bot for new bugs |

Rules that keep this cheap and safe:

- **Cursors are durable** per watch and connection, and advance only after
  actions are committed. A restart resumes without replaying or missing
  changes. Each change id is recorded for dedupe (bounded receipts, as
  webhook runs use today).
- **Ignore our own writes by default.** `actor.isBot` / the connection's own
  account prevents loops where a bot's comment or transition re-triggers its
  own watch. It combines with the existing loop limits on tasks.
- **`startFrom: "now"` by default**, so enabling a watch on a busy project
  does not flood the team. Backfill is explicit and shows a dry-run count first.
- **Budgets:** `maxActionsPerDay` for each watch plus the existing spend cap.
  When a budget is hit, the watch keeps recording but stops acting, and
  raises attention.
- **Webhook first, poll as fallback.** Where a connection has webhooks, the
  schedule acts as a slow safety sweep. Desktop installs poll. Polling
  itself is plain HTTP with no model involved.
- **Routines gain a cheap gate.** An existing scheduled routine can add
  `onlyIfChanged: <watchId>`, so its prompt runs only when that watch saw
  matching changes since the last run. This is the smallest change that
  stops wasted runs on current "check X every N minutes" routines.

**Built-in sources without a connector:**

- `git`: poll `git ls-remote <remote>` for branch/tag head changes
  (`commit.pushed`, `branch.created`) using the credentials already on the
  machine. Works for any git host.
- `webhook`: the existing webhook triggers (`shared/webhooks.ts`) become a
  generic watch source. The payload is mapped by a JSONPath-style field map
  to `SourceChange`, so an unsupported system can still drive watches.

**Integration with routines:** `RoutineRunTrigger` gains `"watch"`. Watch
actions that run prompts go through `RoutineManager`, so run cards, overlap
rules, receipts, `runOn` and results threads behave exactly as for scheduled
and webhook runs. A watch is effectively a routine whose trigger is "a
matching change" rather than "the clock".

**Visibility:** Automations → Watches lists, per watch, the last check,
changes seen, matches, actions, and **runs avoided** (checks that found
nothing to act on). This makes the token saving visible. The editor is
generated from `manifest.watch`, with a "test against the last 7 days"
dry run using `changes` or `query`.

### UI (all kind-driven)

- `src/components/work/` holds `LinkChip`, `LinkCard`, `EventRow`,
  `CriteriaList`, `ProgressStrip`, `NowCard`, `KindIcon`. Each takes a
  `LinkedItem`/`TaskEvent` and switches on `kind`. Provider shows only as
  `manifest.name` and `manifest.icon`.
- Views: task view (header chips, Linked rail, Activity / Outputs / Criteria /
  Threads), bot-turn card, Work sidebar, topic board grouped by
  `statusCategory`.
- Settings → Connections: one generic list and form rendered from
  `manifest.settings` (JSON Schema) and `manifest.secrets`, with Test button.

---

## Plan of attack

Two tracks run after the foundation: **Connectors** (Phases 3–4, 8) and
**UI** (Phases 5–7). The UI tracks against the built-in git capture and a
fake connector, so it never waits on Jira or GitLab.

```
P0 Model + contract ─┬─ P1 Capture + events ─┬─ P2 Structured coordinator tools
                     │                        ├─ P5 Task view ── P6 Sidebar + turn card ── P7 Board
                     ├─ P3 Jira ── P4 GitLab ─┴──────────────────────────────────────────── P8 Drop-in proof (Plane, GitLab issues)
                     └─ P9a Watch engine (git + webhook sources) ── P9b Connector watches (after P3/P4) ── P9c Watches UI
```

Watches are a third track. The engine (P9a) needs only Phase 0 and can
ship early with the built-in git and webhook sources plus the routine
`onlyIfChanged` gate, which cuts wasted routine runs before any connector
exists.

Sizes: S ≈ a few days, M ≈ 1–2 weeks, L ≈ 2–3 weeks for one person.

### Phase 0: Model, contract, registry (M)

- `shared/work-links.ts` types. `WorkItem` additions and a loader migration
  from `artifacts`/`evidence`/`acceptanceCriteria` (`server/work-items.ts`).
- `server/connectors/{types,registry,contract-suite}.ts`, plus a `fake`
  connector under `server/testing/` with fixtures for every kind.
- `taskConnections` config parsing with secret redaction (mirroring
  `mcp-registry.ts`), and team scoping.
- `GET /api/connectors`, `/api/task-connections` CRUD + test.
- **Exit:** migration round-trips existing `work-items.json` fixtures; the fake
  connector passes the contract suite; team backups include connections
  without secrets.

### Phase 1: Capture pipeline and task events (M)

- A runtime-event listener for work-bound threads, updating
  `assignments[].currentStep` and appending `TaskEvent`s.
- `capture.ts` rule engine; `builtin/git.ts` (commit, push, branch, test exit
  codes); `builtin/url.ts`.
- `work-events/*.jsonl` store with caps, backup and restore handling, and
  restart recovery (in-flight tool events closed as failed).
- `GET /api/work-items/:id/events`, SSE `work.event` / `work.link` with access
  filtering.
- **Exit:** with the fake engine, a worker that runs `git commit` produces a
  commit LinkedItem and an event on the task. Events are hidden from
  members without hub access. Verified per
  [docs/verification](../verification/README.md) on an isolated fixture.

### Phase 2: Structured coordinator tools (S–M)

- `update_work_item` criteria/evidence schema, `link_item`, and richer
  `get_work_item`; update catalog goldens.
- Server-side evidence validation and `claimed` handling.
- Instruction updates in `work-instructions.ts` / `work-coordination.ts`.
- Map legacy callers: a `completed_criteria` string list is still accepted
  and stored as `claimed`.
- **Exit:** completion is refused without observed evidence; the legacy call
  shape still works; `shared-work.e2e.test.ts` extended.

### Phase 3: Jira connector (M)

- `server/connectors/jira/`: API-token auth (Cloud) with a site URL setting;
  a Data Center PAT is an option in the same connector.
- `parseRef` for keys and browse URLs; `fetch` via bulk issue search;
  `statusCategory` mapped from Jira's own category (new / indeterminate / done),
  with `in_review` / `blocked` configurable per connection by status name.
- `query` via JQL (feeds the board and "start next work").
- Capture rules for common Jira MCP servers and the Composio Jira toolkit:
  comment, transition, create, assign. Fixtures are recorded from real tool
  calls, redacted.
- Webhook handler (optional), polling by default.
- **Exit:** the contract suite passes with recorded HTTP fixtures; a task
  created with `jira:<connection>:PAY-123` shows the live Jira status; a bot
  commenting through an MCP server produces a comment event.

### Phase 4: GitLab connector (M–L)

- `server/connectors/gitlab/`: PAT or project token, instance URL (SaaS or
  self-managed).
- Kinds: `change_request` (MR state, approvals, draft, conflicts), `commit`
  (enriches git-captured hashes when the remote matches), `build`
  (pipeline and stage status), and `comment` (review threads with open or
  resolved state, file:line in `details`).
- `parseRef` for `!482`, `group/project!482`, and MR/commit/pipeline URLs.
- Capture rules for GitLab MCP tools and `glab` CLI summaries.
- Webhooks for MR, pipeline and note events. Polling otherwise.
- The manifest declares only code kinds for now; GitLab issues come in Phase 8.
- **Exit:** a worker that opens an MR through any access path gets a linked
  change request with pipeline state; review threads appear as comments.

### Phase 5: Task view (L)

- `src/components/work/` primitives, then a `TaskView` replacing
  `WorkItemPanel` in `GroupView.tsx`: header chips, progress strip, Now card,
  Activity feed with filters and a "show tool calls" toggle, Outputs grouped by
  kind, Criteria with evidence links, Threads, and a Linked rail with a
  "Link item" dialog.
- The progress strip is built from assignments and criteria, not fixed code
  stages.
- `claimed` items get a visible marker.
- **Exit:** full task lifecycle renders from the fake connector plus git
  capture alone; component tests per kind; i18n keys in `src/locales/en.json`.

### Phase 6: Sidebar and bot-turn card (M)

- Replace `SharedWorkThreadTree` rows with compact task rows: key (if any),
  status icon, avatars, first change request (if any), criteria count, and
  the selected task's live steps. Filters: All / Needs you / In review / Done.
  Stop auto-expanding every active task.
- A bot-turn card in worker threads: plan (when the engine provides one),
  grouped tool steps, outputs, and links to the raw reply and tool log.
- **Exit:** 10+ tasks across 3 topics stay scannable (e2e in
  `scripts/testing/shared-work-ui.e2e.test.ts`); existing sidebar-attention
  behaviour is preserved.

### Phase 7: Topic board (M)

- A board per topic, grouped by `statusCategory`, mixing tasks with and
  without linked sources.
- An optional connection query per topic shows untracked items ("No task yet")
  and feeds "Start next work".
- Inline answers for `needs-input` tasks.
- **Exit:** a board with mixed Jira-sourced, repo-only and chat-started tasks.

### Phase 8: Drop-in proof and connector guide (S–M)

- **GitLab issues:** add `work_item` to the GitLab manifest, plus
  `parseRef`/`fetch`/`query` for issues. No UI or config code changes.
- **Plane:** `server/connectors/plane/` with API key and workspace slug
  settings. Its state groups (backlog, unstarted, started, completed,
  cancelled) map directly to status categories. It adds `work_item` and
  `comment`.
- `docs/connectors.md`: how to write a connector, the contract suite, capture
  rule examples, and a fixture recording guide.
- **Exit (the architecture test):** the Plane PR touches only
  `server/connectors/plane/**`, one line in `registry.ts`, and docs. CI
  checks this with a path allowlist on connector-only PRs. The PR includes
  Plane's `changes` feed, so Plane watches work with no watch code changes.

### Phase 9a: Watch engine and built-in sources (M)

- `shared/watches.ts` (`SourceChange`, watch definition, filter language)
  and `server/watches.ts` (store, durable cursors, dedupe receipts, filter
  evaluation, batching, budgets, quiet hours).
- Checks reuse the routine schedule types (`shared/routine-schedule.ts`) and
  the existing scheduler timer, with no second clock.
- Built-in sources: `git` (`ls-remote` head polling) and `webhook` (existing
  triggers with a field map into `SourceChange`).
- Actions: `record`, `notify`, `run_routine` (through `RoutineManager`,
  `RoutineRunTrigger` gains `"watch"`), `task_update`.
- Routine `onlyIfChanged` gate.
- **Exit:** with the fake engine, a watch on a local bare repo runs its
  routine once per push, and zero times for 100 idle checks. The routine
  gate skips unchanged runs. The cursor survives restart without replay.
  Verified on an isolated fixture.

### Phase 9b: Connector change feeds (S per connector)

- `changes` for Jira (JQL `updated > cursor` ordered by updated, plus
  changelog for state/assignee/label diffs), GitLab (project events API and
  MR/pipeline webhooks) and Plane (Phase 8, `updated_at` cursor).
- `ensure_task` action: server-side `ensure_work_item` with derived identity,
  objective and criteria.
- Self-write suppression using the connection's account and bot actor
  markers.
- Contract suite additions: cursors only move forward; re-running a
  cursor returns the same changes (idempotent); webhook and poll produce the
  same `SourceChange.id` for the same event.
- **Exit:** a new labelled Jira story creates exactly one shared task with no
  coordinator triage turn. A bot's own transition does not re-trigger.
  A failed GitLab pipeline on a task's MR attaches to that task and wakes
  its coordinator once.

### Phase 9c: Watches UI (M)

- Automations → Watches: list with last check, matches, actions and runs
  avoided; an editor generated from `manifest.watch`; filter builder over
  `SourceChange.fields`; a dry run against recent history; enable with
  "from now" or explicit backfill.
- A "Convert to watch" suggestion on routines whose prompt is a polling check.
- **Exit:** a watch can be created for Jira, GitLab, Plane, git and a generic
  webhook with the same editor.

---

## Testing and verification

- **Contract suite** (`server/connectors/contract-suite.ts`): runs against every
  connector with recorded fixtures. It checks the manifest schema, the
  `parseRef` ↔ `urlPatterns` round trip, `fetch` shape, status mapping
  coverage, capture rules against sample tool calls, that the connector never
  receives secrets it did not declare, and that no network runs outside
  `ctx.fetch`.
- **Capture fixtures:** redacted real `item.completed` previews from each
  engine (Claude, Codex, OpenAI-compatible, Bedrock), since preview shapes
  differ.
- **Isolated verification:** every server phase follows
  [docs/verification/README.md](../verification/README.md) and extends
  [verification/shared-work.md](../verification/shared-work.md). Never against
  live Jira/GitLab or the user's app data.

## Risks and open questions

- **Preview truncation.** Tool previews are bounded and redacted, so some
  IDs may be cut off. Mitigation: extractors look at output before input,
  and connector sync can search by branch or title. Decide whether a
  connector may request a larger, still-redacted preview for matching tool
  names.
- **Credentials.** Connections hold their own read-only tokens. Reusing a
  bot's MCP-server headers is simpler to set up but mixes a bot credential
  with a harness one. Deferred.
- **Webhooks on desktop.** Poll by default; webhooks only for hosted or
  self-hosted server installs.
- **Status mapping.** Provider categories cover most cases; `in_review` and
  `blocked` need per-connection mapping by status name (Jira, GitLab labels).
- **Event volume.** Tool events can be numerous. Caps, compaction and
  collapsing them in the UI by default are required, not optional.
- **Claimed-evidence policy.** Strict rejection may stall legitimate work
  that happens outside tools. Start with "claimed → needs-input" and tune.
- **Watch loops and floods.** A bot writing to a watched system could
  re-trigger itself; a bulk edit could fire hundreds of changes. Mitigations
  are self-write suppression, batching windows, per-watch daily budgets, and
  the existing task loop limits. The open question is whether
  `maxActionsPerDay` should default low (e.g. 10) and require an explicit raise.
- **Change feed gaps.** Some APIs only expose "updated since" without
  field diffs. Connectors keep a small last-seen snapshot for each watched
  item to compute `before`. That snapshot is bounded and dropped when the item
  leaves the scope.
- **Filter language scope.** Keep it declarative (all/any/not, eq/in/contains,
  changed-from/to). Anything needing judgement belongs in a `run_routine`
  action, not the filter.
