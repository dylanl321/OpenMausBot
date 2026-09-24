# Task connectors

A **connector** translates one external system (Jira, GitLab, Plane, …) into
the shared task model: linked items, status categories, capture rules, and an
optional change feed. The UI, settings form, topic board and task view never
branch on a provider. They read the manifest and render by `kind`.

A **connection** is one configured account of that connector (two Plane
workspaces are two connections). Secrets are stored like MCP server secrets;
the renderer sees key names, never values.

## Add a connector

Adding a connector is a new folder, one registry line, and tests. No settings
screen, task schema, or board code.

```
server/connectors/
  types.ts            contract
  registry.ts         CONNECTORS = […, yours]
  contract-suite.ts   shared tests every connector must pass
  <id>/
    index.ts          export const <id>Connector: Connector
    <id>.test.ts
    fixtures/         recorded HTTP + redacted tool previews
```

1. Create `server/connectors/<id>/` with `id` lower-case (`plane`, `servicenow`).
2. Export a `Connector`. Register it with one import in
   [`server/connectors/registry.ts`](../server/connectors/registry.ts).
3. Run the contract suite against recorded fixtures. Add connector-specific
   tests for status mapping, query, webhooks, capture, and (if you have one)
   `changes`.
4. Do not edit UI, config parsing, or task storage. Those already read
   `CONNECTORS`.

A drop-in PR should touch only `server/connectors/<id>/**`, that one registry
line, docs, and tests or fixtures under the same folder. `changes` belongs in
the connector so watches can use it later without another connector edit.

## The contract

Implement `Connector` in [`server/connectors/types.ts`](../server/connectors/types.ts).
The server calls these methods; it never imports a provider by name.

| Piece | What it must do |
|---|---|
| `manifest` | Stable `id`, display `name`, `kinds`, settings (non-secret), `secrets`, `capabilities`. Optional `icon` (inline SVG, `stroke="currentColor"`), `statusDefaults`, `watch`. |
| `test` | Validate settings + secrets. Return `{ ok: true, account }` (a host or workspace slug) or `{ ok: false, error }`. |
| `parseRef` | Turn `PAY-123`, `#140`, `group/project!482`, or a pasted URL into `{ kind, externalId }`. |
| `urlPatterns` | Regexes the link dialog uses to recognise a URL. `parseRef(url)` must equal `parseRef(ref)` for every sample. |
| `fetch` | Read current state for a batch of refs. Always return one `SyncedItem` per ref (stub the ones you cannot load). Use `ctx.fetch` only. |
| `query` | Optional. List items for a board or “start next work” (JQL, PQL, GitLab project search). |
| `webhook` | Optional. Verify the delivery, then return changed refs. |
| `changes` | Optional. Cheap, idempotent change feed after `cursor`. Same cursor → same `SourceChange[]`. Cursor only moves forward. |
| `capture` | Declarative rules over redacted `item.completed` previews. |

`SyncedItem` is a `LinkedItem` without the fields the server owns (`id`,
`role`, `provenance`, `createdBy`). Status labels stay in the provider’s
words; `statusCategory` is one of `todo`, `in_progress`, `in_review`,
`blocked`, `done`, `cancelled`, `unknown`.

`ConnectionContext` gives you settings, `secret(key)` (throws if the key is
not on the manifest), a rate-limited `fetch`, and `log`. Never log secrets,
`Authorization`, or `X-API-Key`. Never take the store, bots, or other
connections.

### Manifest settings

Settings are a list of `{ key, label, type, help? }`. Types are `string`,
`number`, `boolean`, or `enum` (with `enum: string[]`). The connections form
renders this list as-is.

`watch.scopes` uses the same field shape so a later watch editor can ask for
a project or query without connector-specific UI. `watch.events` is the
`SourceChangeType` list you emit.

## Contract suite

[`server/connectors/contract-suite.ts`](../server/connectors/contract-suite.ts)
is the shared gate. Call it from `<id>.test.ts` with a fixture-backed
`ConnectionContext` and at least one `{ ref, url }` sample per kind you
round-trip:

```ts
connectorContract(planeConnector, ctx(), [
  { ref: "PAY-123", url: "https://app.plane.so/acme/browse/PAY-123" },
], captureCall("create"));
```

It checks:

- the manifest is renderable (id, kinds, setting keys, declared secrets)
- `ctx.secret("not-declared")` throws
- each sample `parseRef`s and its URL matches `urlPatterns`
- `parseRef(url)` equals `parseRef(ref)`
- `fetch` returns one titled item per requested kind
- the first capture rule extracts an id from the sample preview
- `test` uses `ctx.fetch` (no raw `globalThis.fetch`)

Add your own tests for mapping, query pagination, webhook verification,
truncated previews, and secret hygiene.

## Capture rules

Rules run on redacted tool previews for threads already bound to a task.
When the preview is truncated and the extractor cannot find an id, return
`null`. The raw tool call stays in the thread.

```ts
{
  match: { tool: /workitem_comment|plane.*comment/i },
  on: "completed",
  produce: { kind: "comment" },
  eventKind: "comment",
  extract: call => {
    const key = /\b([A-Z]+-\d+)\b/.exec(`${call.output ?? ""}\n${call.input ?? ""}`);
    if (!key) return null;
    return { externalId: `${key[1]}:${commentId}`, parentRef: key[1], title: `Comment on ${key[1]}` };
  },
  event: item => `commented on ${item.details?.issue ?? item.externalId}`,
}
```

Match on `tool` (MCP / toolkit name), `command` (shell summary, e.g.
`/^glab\s+issue\s+create\b/`), or `server` (MCP server name). Prefer output
over input when reading an id. Look at JSON bodies when the preview is a
JSON object; fall back to `#140`, `PAY-123`, or a recognised URL.

Existing connectors:

- **Jira** — `jira_add_comment` / Composio comment, transition, create, assign.
- **GitLab** — `create_merge_request`, `glab mr create`, review notes, `glab issue create`.
- **Plane** — `workitem` create / update, `workitem_comment` create.
- **Built-in git / url** — `git commit` / `git push` and bare URLs, in
  `server/connectors/builtin/`.

Keep rules host-specific. A generic `/create[_-]?issue/` match will fire on
every tracker.

## Recording fixtures

Record from a real call, then redact. Do not invent live data.

**HTTP.** Point `ctx.fetch` at a function that serves files from
`fixtures/`. Save the JSON the API actually returned (issue, project, comment
list, webhook body). Replace tokens, emails, and display names. Keep ids,
status names, and timestamps — tests assert those.

```ts
function fixtureFetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url = String(input);
  if (!url.startsWith("https://api.example.test/")) throw new Error(`unexpected fetch ${url}`);
  if (url.endsWith("/me")) return jsonResponse(readJson("me.json"));
  return new Response("not found", { status: 404 });
}
```

Refuse any host that is not in the recording. GET-only unless you are
testing `query` that POSTs (Jira Cloud JQL).

**Capture.** Save redacted `item.completed` previews as
`fixtures/capture/<action>.json`: `title`, `summary`, `input`, `output`,
`server`, `ok`. Include one **truncated** preview that contains
`[… preview shortened]` before the id — the extractor must return `null`.

Record at least one preview per engine you care about (Claude, Codex,
OpenAI-compatible, Bedrock). Shapes differ; the extractor should still find
the id when it is in the uncut prefix.

**Changes.** For `changes`, record a page ordered by `updated_at`. The suite
you write should show: the same cursor returns the same change ids; a later
cursor returns nothing new; the next cursor is not earlier than the last
item’s `updated_at`.

Never commit a live token. Assert logs and `sourceLinkedItem` output do not
contain the fixture secret.

## Verification

Connector tests use fixtures only. Do not call live Jira, GitLab, or Plane,
and do not write to the user’s app data. Server behaviour that creates tasks
from a connector identity is checked with the isolated fake-engine fixture
in [verification/README.md](verification/README.md) and
[verification/shared-work.md](verification/shared-work.md).
