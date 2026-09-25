import { createHash } from "node:crypto";
import type { LinkKind, SyncedItem } from "../../shared/work-links.ts";
import type { SourceChange } from "../../shared/watches.ts";
import { encodeChangeCursor, parseChangeCursor } from "../connectors/change-cursor.ts";
import type { ConnectionContext, Connector, WatchScope } from "../connectors/types.ts";

const KINDS: LinkKind[] = ["work_item", "change_request", "commit", "build", "comment", "document", "link"];

const FIXTURES: Record<string, { title: string; kind: LinkKind; state?: SyncedItem["state"] }> = {
  "PAY-1": { title: "Refund failures", kind: "work_item", state: { label: "In Progress", category: "in_progress" } },
  "482": { title: "Round partial refunds", kind: "change_request", state: { label: "opened", category: "in_review" } },
  "3f2a1c9": { title: "commit 3f2a1c9", kind: "commit" },
  "9001": { title: "pipeline 9001", kind: "build", state: { label: "failed", category: "blocked" } },
  "note-1": { title: "Looks right", kind: "comment" },
  "doc-1": { title: "Refund policy", kind: "document" },
  "ref-1": { title: "Related note", kind: "link" },
};

const QUERY_EXTRAS: Record<string, { title: string; kind: LinkKind; state?: SyncedItem["state"] }> = {
  "PAY-2": { title: "Untracked refunds", kind: "work_item", state: { label: "To Do", category: "todo" } },
  "PAY-8": { title: "Ready story", kind: "work_item", state: { label: "To Do", category: "todo" } },
};

function catalog() {
  return { ...FIXTURES, ...QUERY_EXTRAS };
}

function item(kind: LinkKind, externalId: string, ctx: ConnectionContext): SyncedItem {
  const known = FIXTURES[externalId] ?? QUERY_EXTRAS[externalId];
  return {
    kind,
    externalId,
    title: known?.title ?? externalId,
    url: `https://fake.example/${kind}/${externalId}`,
    connectorId: "fake",
    connectionId: ctx.connectionId,
    ...(known?.state ? { state: known.state } : {}),
    ...(externalId === "PAY-8" ? { details: { labels: "bot-ready", description: "Ship the labelled payments story." } } : {}),
    ...(externalId === "9001" ? { details: { mr: "482" } } : {}),
    updatedAt: 1,
  };
}

const FEED: Array<{ at: number; change: (ctx: ConnectionContext) => SourceChange }> = [
  {
    at: Date.parse("2026-09-23T10:00:00.000Z"),
    change: ctx => ({
      id: "PAY-8@created",
      type: "item.created",
      connectionId: ctx.connectionId,
      item: item("work_item", "PAY-8", ctx),
      actor: { name: "Ada", isBot: false },
      fields: { labels: ["bot-ready"], "state.category": "todo", project: "PAY" },
      at: Date.parse("2026-09-23T10:00:00.000Z"),
    }),
  },
  {
    at: Date.parse("2026-09-23T11:00:00.000Z"),
    change: ctx => ({
      id: "PAY-1@changelog:bot:status",
      type: "item.state_changed",
      connectionId: ctx.connectionId,
      item: item("work_item", "PAY-1", ctx),
      before: { state: "todo", stateLabel: "To Do" },
      actor: { name: "Payments bot", isBot: true },
      fields: { "state.category": "in_progress" },
      at: Date.parse("2026-09-23T11:00:00.000Z"),
    }),
  },
  {
    at: Date.parse("2026-09-23T12:00:00.000Z"),
    change: ctx => ({
      id: "9001@failed",
      type: "build.failed",
      connectionId: ctx.connectionId,
      item: item("build", "9001", ctx),
      actor: { name: "gitlab-bot", isBot: true },
      fields: { mr: "482" },
      at: Date.parse("2026-09-23T12:00:00.000Z"),
    }),
  },
];

function feedFor(ctx: ConnectionContext, scope: WatchScope, cursor: string | null): { changes: SourceChange[]; cursor: string } {
  const parsed = parseChangeCursor(cursor);
  const needle = typeof scope.query === "string" ? scope.query.trim().toLowerCase() : "";
  const changes = FEED
    .filter(row => row.at > parsed.since)
    .map(row => row.change(ctx))
    .filter(change => !needle || change.item.title.toLowerCase().includes(needle) || String(change.item.externalId ?? "").toLowerCase().includes(needle));
  const latest = Math.max(parsed.since, ...changes.map(change => change.at));
  return {
    changes,
    cursor: encodeChangeCursor(latest || parsed.since || Date.parse("2026-09-23T09:00:00.000Z"), parsed.seen, changes.flatMap(change => change.item.externalId ? [change.item.externalId] : [])),
  };
}

export const fakeConnector: Connector = {
  manifest: {
    id: "fake",
    name: "Fake",
    kinds: KINDS,
    settings: [{ key: "site", label: "Site", type: "string" }],
    secrets: [{ key: "token", label: "Token" }],
    capabilities: { query: true, poll: true, webhooks: true },
    statusDefaults: { "In Progress": "in_progress", opened: "in_review" },
    watch: {
      scopes: [
        { key: "query", label: "Query", type: "string", help: "Optional title or id filter" },
      ],
      events: ["item.created", "item.updated", "item.state_changed", "item.labeled", "build.failed"],
    },
    actions: [
      { id: "complete_work_item", kind: "work_item", label: "Complete work item" },
    ],
  },
  async test(ctx) {
    const token = ctx.secret("token");
    if (!token) return { ok: false, error: "Token is required." };
    const response = await ctx.fetch(`${ctx.settings.site ?? "https://fake.example"}/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return { ok: false, error: `Fake connector rejected the token (${response.status}).` };
    const body = await response.json() as { account?: string };
    return { ok: true, account: body.account ?? "fake-account" };
  },
  parseRef(input) {
    const keyed = /^(work_item|change_request|commit|build|comment|document|link):([A-Za-z0-9._-]+)$/.exec(input.trim());
    if (keyed) return { kind: keyed[1] as LinkKind, externalId: keyed[2] };
    const url = /https:\/\/fake\.example\/(work_item|change_request|commit|build|comment|document|link)\/([A-Za-z0-9._-]+)/.exec(input);
    if (url) return { kind: url[1] as LinkKind, externalId: url[2] };
    const bare = input.trim();
    const known = catalog()[bare];
    if (known) return { kind: known.kind, externalId: bare };
    if (/^[A-Z]+-\d+$/.test(bare)) return { kind: "work_item", externalId: bare };
    return null;
  },
  urlPatterns() {
    return [/https:\/\/fake\.example\/(work_item|change_request|commit|build|comment|document|link)\/([A-Za-z0-9._-]+)/];
  },
  async fetch(ctx, refs) {
    return refs.map(ref => item(ref.kind, ref.externalId, ctx));
  },
  async query(ctx, query) {
    const needle = query.trim().toLowerCase();
    const listed = Object.entries(catalog()).filter(([id, spec]) =>
      !needle || needle === "*" || needle === "all" || id.toLowerCase().includes(needle) || spec.title.toLowerCase().includes(needle));
    return { items: listed.map(([id, spec]) => item(spec.kind, id, ctx)) };
  },
  async webhook(_ctx, _headers, body) {
    const record = typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : body as Record<string, unknown>;
    const id = typeof record?.externalId === "string" ? record.externalId : "PAY-8";
    const kind = catalog()[id]?.kind ?? "work_item";
    return [{ kind, externalId: id }];
  },
  async changes(ctx, scope, cursor) {
    return feedFor(ctx, scope, cursor);
  },
  async webhookChanges(ctx, _headers, body) {
    const record = typeof body === "string" ? JSON.parse(body) as Record<string, unknown> : body && typeof body === "object" ? body as Record<string, unknown> : {};
    const wanted = typeof record.id === "string" ? record.id : typeof record.externalId === "string" ? `${record.externalId}@created` : "PAY-8@created";
    return feedFor(ctx, {}, "1970-01-01T00:00:00.000Z").changes.filter(change => change.id === wanted);
  },
  /** Dry-run-only: never sends PUT/POST/PATCH/DELETE. Commit reports done
   * from the local catalog so runner tests can exercise the server wrapper. */
  async act(ctx, input) {
    if (input.action !== "complete_work_item" || input.target.kind !== "work_item") {
      throw new Error("Fake connector does not implement that action.");
    }
    const token = ctx.secret("token");
    if (!token) throw new Error("Token is required.");
    const site = String(ctx.settings.site ?? "https://fake.example");
    const response = await ctx.fetch(`${site}/work_item/${input.target.externalId}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Fake work item returned ${response.status}`);
    const body = await response.json().catch(() => null) as { state?: { category?: string; label?: string } } | null;
    const category = body?.state?.category;
    const label = body?.state?.label ?? (category === "done" ? "Done" : "Unknown");
    if (category === "done") {
      return {
        changed: true,
        target: { state: "done", label, observedAt: Date.now(), result: "Observed done status" },
        gates: [],
      };
    }
    if (input.mode !== "commit") return { changed: false, target: {}, gates: [] };
    return {
      changed: true,
      target: { state: "done", label: "Done", observedAt: Date.now(), result: "Observed done status" },
      gates: [],
    };
  },
  capture: [{
    match: { tool: /fake\.issue/i },
    on: "completed",
    extract: call => {
      const key = (call.output ?? call.input ?? "").match(/\b([A-Z]+-\d+)\b/);
      if (!key) return null;
      return { externalId: key[1], title: key[1], url: `https://fake.example/work_item/${key[1]}` };
    },
    event: extracted => `opened ${extracted.externalId}`,
    produce: { kind: "work_item" },
  }],
};

export function fakeFixtureHash(externalId: string): string {
  return createHash("sha256").update(externalId).digest("hex").slice(0, 8);
}
