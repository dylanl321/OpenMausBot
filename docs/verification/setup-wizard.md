# AI-guided Setup Guide

Run this only against the isolated fake-engine fixtures. Never send wizard
mutations to a running user app or its data directory.

```sh
pnpm exec vitest run server/setup-wizard.test.ts server/setup-wizard-codex.test.ts src/lib/setup-wizard.test.ts
pnpm exec vitest run server/setup-wizard.e2e.test.ts scripts/testing/setup-wizard-ui.e2e.test.ts
pnpm exec vitest run src/components/NewBotDialog.test.ts src/lib/team-import.test.ts
pnpm exec vitest run scripts/testing/bot-draft-visibility-ui.e2e.test.ts scripts/testing/team-template-ui.e2e.test.ts
pnpm typecheck
pnpm lint
```

The HTTP fixture owns a temporary home and only synthetic Claude/Codex
accounts. It scripts two interview questions, a structured draft and a
failure, then proves that bots, conversations and team briefs have not changed
before confirmation. It verifies a new team with a Chief and admins-only
visibility, an existing team with its incumbent Chief and unchanged brief,
person-specific visibility, exact model selections, rejected privilege fields,
stale models/teams, duplicate names, a failed atomic `bots.json` replacement,
retry with the same request ID, and replay after a server restart. The fixture
restores its deliberately obstructed file before retrying; it never touches a
live workspace. Its `.setup-wizard.json` evidence is retained beside the
printed server log; the data directory is removed when the test finishes.

The renderer fixture uses the real React app in a disposable headless browser.
It checks New bot, Create team, an existing team's Add bots action and Templates;
the community-catalog outage falls back to bundled starters. It exercises an
AI failure, question focus, manual name edit surviving a reviewed revision,
exact bot/model/Chief/visibility review, keyboard focus wrapping and Escape
return, and the persona-only community-template route. A review screenshot is
saved in `.omb-scratch/verify-evidence/setup-wizard-review.png`. The existing
manual, companion and direct-import tests above remain in the regression run.

Codex drafting is a separate ephemeral CLI child with an empty temporary cwd,
read-only sandbox, disabled tool and integration surfaces, selected account
only, a bounded Stop, and strict JSON validation. Assist picks
`engine.models.find(m => m.model === instanceDefault) ?? engine.models[0]`;
an explicit assist `model` must be on that engine’s list. The fake CLI test
checks its argv, environment, missing-flag refusal and child cleanup. These fixtures do
not establish the quality of a real model's questions or proposals, nor that
an installed third-party CLI honors every advertised flag. The CLI isolation
settings follow the [official Codex CLI reference](https://developers.openai.com/codex/cli/reference)
and [configuration reference](https://developers.openai.com/codex/config-reference).
