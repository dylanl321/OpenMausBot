import { expect, it } from "vitest";
import type { ConnectionContext, Connector } from "./types.ts";

export function connectorContract(connector: Connector, ctx: ConnectionContext, samples: { ref: string; url: string }[]) {
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
    const extracted = rule.extract({ title: "fake.issue", output: "Created PAY-1", ok: true });
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
}
