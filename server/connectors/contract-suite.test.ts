import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "./types.ts";
import { fakeConnector } from "../testing/fake-connector.ts";
import { connectorContract } from "./contract-suite.ts";

const ctx: ConnectionContext = {
  connectionId: "fake-acme",
  settings: { site: "https://fake.example" },
  secret(key) {
    if (!fakeConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
    return "token-value";
  },
  fetch: async () => new Response(JSON.stringify({ account: "acme.example" }), { status: 200 }),
  log() {},
};

describe("fake connector contract", () => {
  connectorContract(fakeConnector, ctx, [
    { ref: "work_item:PAY-1", url: "https://fake.example/work_item/PAY-1" },
    { ref: "commit:3f2a1c9", url: "https://fake.example/commit/3f2a1c9" },
    { ref: "build:9001", url: "https://fake.example/build/9001" },
    { ref: "comment:note-1", url: "https://fake.example/comment/note-1" },
    { ref: "document:doc-1", url: "https://fake.example/document/doc-1" },
    { ref: "link:ref-1", url: "https://fake.example/link/ref-1" },
    { ref: "change_request:482", url: "https://fake.example/change_request/482" },
  ]);
});

describe("fake connector query", () => {
  it("lists untracked extras and accepts a bare issue key", async () => {
    expect(fakeConnector.parseRef("PAY-2", ctx)).toEqual({ kind: "work_item", externalId: "PAY-2" });
    const result = await fakeConnector.query!(ctx, "untracked");
    expect(result.items.map(item => item.externalId)).toContain("PAY-2");
  });
});
