import { expect, it } from "vitest";
import { cursorMovesForward } from "./change-cursor.ts";
import type { CaptureCall, ConnectionContext, Connector, WatchScope } from "./types.ts";

export function connectorContract(
  connector: Connector,
  ctx: ConnectionContext,
  samples: { ref: string; url: string }[],
  capture: CaptureCall = { title: "fake.issue", output: "Created PAY-1", ok: true },
  changes?: { scope?: WatchScope; cursor?: string | null; webhook?: { headers?: Headers; body: unknown } },
) {
  it(`${connector.manifest.id} publishes a manifest the settings screen can render`, () => {
    expect(connector.manifest.id).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(connector.manifest.name.length).toBeGreaterThan(0);
    expect(connector.manifest.kinds.length).toBeGreaterThan(0);
    for (const field of connector.manifest.settings) {
      expect(field.key).toMatch(/^[a-zA-Z][\w-]*$/);
      if (field.type === "enum") expect(field.enum?.length).toBeGreaterThan(0);
    }
    const declared = new Set(connector.manifest.secrets.map(secret => secret.key));
    expect(() => ctx.secret("not-declared")).toThrow(/not declared/);
    for (const key of declared) expect(() => ctx.secret(key)).not.toThrow();
    if (connector.changes) {
      expect(connector.manifest.watch?.scopes.length).toBeGreaterThan(0);
      expect(connector.manifest.watch?.events.length).toBeGreaterThan(0);
    }
  });

  it(`${connector.manifest.id} round-trips parseRef and urlPatterns`, () => {
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      const parsed = connector.parseRef(sample.ref, ctx);
      expect(parsed?.externalId).toBeTruthy();
      expect(connector.urlPatterns(ctx).some(pattern => pattern.test(sample.url))).toBe(true);
      expect(connector.parseRef(sample.url, ctx)).toEqual(parsed);
    }
  });

  it(`${connector.manifest.id} fetch returns synced items and capture rules find an id`, async () => {
    const refs = connector.manifest.kinds.map(kind => ({ kind, externalId: kind === "work_item" ? "PAY-1" : "SAMPLE-1" }));
    const items = await connector.fetch(ctx, refs);
    expect(items).toHaveLength(refs.length);
    for (const item of items) {
      expect(item.kind).toBeTruthy();
      expect(item.title.length).toBeGreaterThan(0);
      expect(item.externalId).toBeTruthy();
    }
    const rule = connector.capture[0];
    expect(rule).toBeTruthy();
    const extracted = rule.extract(capture);
    expect(extracted?.externalId).toBeTruthy();
    expect(rule.event({ externalId: extracted!.externalId, title: extracted!.externalId })).toMatch(/\S/);
    const fetches: string[] = [];
    const recording = { ...ctx, fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      fetches.push(String(input));
      return ctx.fetch(input, init);
    }) as typeof fetch };
    const result = await connector.test(recording);
    expect(result.ok).toBe(true);
    expect(fetches.length).toBeGreaterThan(0);
  });

  if (connector.changes) {
    it(`${connector.manifest.id} change feed is idempotent and cursors only move forward`, async () => {
      const scope = changes?.scope ?? {};
      const cursor = changes?.cursor ?? "1970-01-01T00:00:00.000Z";
      const first = await connector.changes!(ctx, scope, cursor);
      expect(cursorMovesForward(cursor ?? "", first.cursor)).toBe(true);
      const again = await connector.changes!(ctx, scope, cursor);
      expect(again.changes.map(change => change.id)).toEqual(first.changes.map(change => change.id));
      expect(cursorMovesForward(first.cursor, again.cursor)).toBe(true);
      const later = await connector.changes!(ctx, scope, first.cursor);
      const firstIds = new Set(first.changes.map(change => change.id));
      expect(later.changes.every(change => !firstIds.has(change.id))).toBe(true);
      expect(cursorMovesForward(first.cursor, later.cursor)).toBe(true);
    });
  }

  if (connector.changes && connector.webhookChanges && changes?.webhook) {
    it(`${connector.manifest.id} webhook and poll produce the same SourceChange.id`, async () => {
      const scope = changes.scope ?? {};
      const cursor = changes.cursor ?? "1970-01-01T00:00:00.000Z";
      const polled = await connector.changes!(ctx, scope, cursor);
      const headers = changes.webhook!.headers ?? new Headers();
      const hooked = await connector.webhookChanges!(ctx, headers, changes.webhook!.body);
      expect(hooked.length).toBeGreaterThan(0);
      const pollIds = new Set(polled.changes.map(change => change.id));
      expect(hooked.some(change => pollIds.has(change.id))).toBe(true);
    });
  }
}
