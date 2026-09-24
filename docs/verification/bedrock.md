# Bedrock connections, regions and agent tools

Run the permanent driver and server acceptance tests:

```sh
pnpm exec vitest run server/drivers/bedrock.test.ts server/bedrock.e2e.test.ts
pnpm test:packaged-server
```

The HTTP fixture in `server/testing/fake-bedrock.ts` receives only synthetic
credentials from tests and never forwards requests. It implements the AWS
control-plane catalog, independently encoded native event-stream frames,
Chat Completions SSE and Messages SSE. Native and signed requests use the
real AWS SDK and signer. No live AWS account, model invocation, provider CLI
or user's data is involved.

The driver tests cover token precedence, named profiles and their regions,
AWS key pairs/session tokens, role/profile credential refresh, per-connection
isolation, regional foundation models, paginated inference profiles, Mantle's
separate catalog, partial discovery, model capabilities and all three wire
protocols. Gateway tests cover named token variables, custom headers, URL
path prefixes, legacy bearer settings and missing-token account isolation.
US restrictions check every backing destination and reject global
profiles, unverifiable aliases and ambient/custom endpoint redirection.
Provider and model blocks also cover opaque aliases. Native Converse and
Messages tool continuations preserve signed reasoning, require approval,
correlate tool results, and respect denial and cancellation. Truncated native
tool streams never execute a partial call.
Host-computer tools retain the local approval scope even in Full Access mode;
remote MCP tools return native image content without exposing their HTTP
authorization credentials. Usage includes cache reads and cache writes.
The packaged-server smoke also loads token and named-profile catalogs from
the bundle after copying it outside the repository, with no `node_modules`
available to the server. It uses the same loopback fixture.

`server/bedrock.e2e.test.ts` launches the disposable server described in
[the verification guide](README.md), then uses the launcher's exact URL with
the shared control surface: `new-bot`, `set-model`, `send`, `wait`, `messages`
and `send-channel`. Configuration, model tests and approvals use the same HTTP
routes as the app. The test proves:

- Saved secrets never return through the settings/instance responses, a draft
  catalog check does not alter the config file, and clearing the optional
  token limit persists correctly.
- Incomplete key updates fail, and connection edits during an active turn
  return 409.
- Native tool use reaches a real stdio MCP process only after approval. The
  test checks both the resulting receipt file and the final conversation.
- A room conversation routes through the same selected Bedrock connection.

The test prints an `evidencePath` alongside the retained server log. Its JSON
records the explicit fixture URL, control commands, wait results, bounded
messages and artifact receipt. Cleanup stops only the launched server and
removes its disposable home.

## Real renderer

```sh
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/bedrock-ui.e2e.test.ts
```

This uses `control-omb ui` to launch the actual React app, a disposable server
and a private headless Chrome session. It downloads the pinned browser tools
on first use, as described in [Chat UI](chat-ui.md). Without the flag, the test
runs if those tools are already installed and otherwise skips.

The test drives Settings and the model picker through accessible control
names. It validates regional lists, per-model toggles and aliases, disabling
Claude, US/global profile filters, rejecting a non-US region in US-only mode,
discarding stale catalog responses, saving tokens and AWS keys without
revealing them, retaining a draft after a rejected save, and loading a named
profile from files under the fixture's home. Advanced token-variable/header
edits clear the previous catalog, send the configured gateway header and
persist without returning the token. It then selects that profile's
regional model and sends an actual turn to the offline provider through the
renderer. The picker must identify Bedrock as a cloud engine and display the
resolved region; the browser console must have no errors.
The access panel is also checked at a 390-pixel viewport for horizontal overflow.

Screenshots and the final accessibility tree are retained in
`.omb-scratch/verify-evidence/bedrock`. They contain fixture identities only.
The browser, preview and owned server are closed automatically. Never aim
this recipe at the installed app or a live workspace.

These checks prove protocol, application policy and UI behavior against
offline AWS responses. They do not prove live account entitlements, every
model's inference quality/limits, real AWS SSO/STS connectivity, or regional
availability on a particular date. A live smoke check requires the intended
account, region and model; a catalog load alone is not an inference test.
