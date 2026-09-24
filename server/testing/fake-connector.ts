import { createHash } from "node:crypto";
import type { LinkKind, SyncedItem } from "../../shared/work-links.ts";
import type { ConnectionContext, Connector } from "../connectors/types.ts";

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
  const known = FIXTURES[externalId];
  return {
    kind,
    externalId,
    title: known?.title ?? externalId,
    url: `https://fake.example/${kind}/${externalId}`,
    connectorId: "fake",
    connectionId: ctx.connectionId,
    ...(known?.state ? { state: known.state } : {}),
    updatedAt: 1,
  };
}

export const fakeConnector: Connector = {
  manifest: {
    id: "fake",
    name: "Fake",
    kinds: KINDS,
    settings: [{ key: "site", label: "Site", type: "string" }],
    secrets: [{ key: "token", label: "Token" }],
    capabilities: { query: true, poll: true },
    statusDefaults: { "In Progress": "in_progress", opened: "in_review" },
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
