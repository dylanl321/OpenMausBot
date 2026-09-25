import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../types.ts";
import { jiraConnector } from "./index.ts";

function mutating(requests: Array<{ method: string }>) {
  return requests.filter(request => ["PUT", "POST", "PATCH", "DELETE"].includes(request.method));
}

function ctx(fetchImpl: typeof fetch, settings: Record<string, string | number | boolean> = {}): ConnectionContext {
  const secrets: Record<string, string> = { email: "fixture@example.invalid", apiToken: "fixture", token: "fixture-pat" };
  return {
    connectionId: "jira-main",
    settings: { site: "http://127.0.0.1:8325", edition: "cloud", ...settings },
    secret(key) {
      if (!jiraConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return secrets[key];
    },
    fetch: fetchImpl,
    log() {},
  };
}

function actComplete(fetchImpl: typeof fetch, mode: "dry-run" | "commit" = "commit",
  settings: Record<string, string | number | boolean> = {}) {
  return jiraConnector.act!(ctx(fetchImpl, settings), {
    action: "complete_work_item",
    target: { kind: "work_item", externalId: "PAY-1" },
    mode,
  });
}

describe("jira complete_work_item", () => {
  it("declares the complete action and dry-run never sends a mutating method", async () => {
    expect(jiraConnector.manifest.actions).toEqual([
      expect.objectContaining({ id: "complete_work_item", kind: "work_item" }),
    ]);
    expect(jiraConnector.manifest.settings.some(field => field.key === "doneTransitionId")).toBe(true);
    expect(jiraConnector.manifest.settings.some(field => field.key === "doneTransitionName")).toBe(true);
    const requests: Array<{ url: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? "GET" });
      return new Response(JSON.stringify(url.endsWith("?fields=status")
        ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
        : { transitions: [{ id: "11", to: { name: "Done", statusCategory: { key: "done" } } }] }), { status: 200 });
    };
    expect(await actComplete(fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });
    expect(mutating(requests)).toEqual([]);
    expect(requests.some(request => request.url.includes("/transitions"))).toBe(true);
  });

  it("transitions a Jira issue through a unique done transition and reads back the status", async () => {
    let done = false;
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("?fields=status")) return new Response(JSON.stringify({ key: "PAY-1", fields: { status: {
        name: done ? "Done" : "In Progress", statusCategory: { key: done ? "done" : "indeterminate" },
      } } }), { status: 200 });
      if (url.endsWith("/transitions") && init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual({ transition: { id: "11" } });
        done = true; return new Response(null, { status: 204 });
      }
      if (url.endsWith("/transitions")) return new Response(JSON.stringify({ transitions: [
        { id: "11", to: { name: "Done", statusCategory: { key: "done" } } },
        { id: "12", to: { name: "Cancelled", statusCategory: { key: "done" } } },
      ] }), { status: 200 });
      throw new Error(`Unexpected ${url}`);
    };
    expect(await actComplete(fetchImpl)).toMatchObject({
      changed: true, target: { state: "done" }, gates: [],
    });
    expect(requests.filter(request => request.startsWith("POST"))).toHaveLength(1);
  });

  it("does not treat a rejected Jira resolution as satisfying acceptance", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify(String(input).endsWith("?fields=status")
        ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
        : { transitions: [{ id: "11", to: { name: "Rejected", statusCategory: { key: "done" } } }] }), { status: 200 });
    };
    expect(await actComplete(fetchImpl)).toMatchObject({ changed: false,
      gates: [expect.objectContaining({ kind: "policy" })] });
    expect(requests.every(request => request.startsWith("GET"))).toBe(true);
  });

  it("uses a configured done transition id when the unique-Done heuristic is ambiguous", async () => {
    function ambiguous() {
      let posted: unknown;
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        requests.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("?fields=status")) return new Response(JSON.stringify({ key: "PAY-1", fields: { status: {
          name: posted ? "Done" : "In Progress", statusCategory: { key: posted ? "done" : "indeterminate" },
        } } }), { status: 200 });
        if (url.endsWith("/transitions") && init?.method === "POST") {
          posted = JSON.parse(String(init.body));
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/transitions")) return new Response(JSON.stringify({ transitions: [
          { id: "21", name: "Ship", to: { name: "Done", statusCategory: { key: "done" } } },
          { id: "31", name: "Accept", to: { name: "Accepted", statusCategory: { key: "done" } } },
        ] }), { status: 200 });
        throw new Error(`Unexpected ${url}`);
      };
      return { fetchImpl, requests, posted: () => posted };
    }
    const heuristic = ambiguous();
    expect(await actComplete(heuristic.fetchImpl, "dry-run")).toMatchObject({
      changed: false, gates: [expect.objectContaining({ kind: "policy" })],
    });
    const configured = ambiguous();
    expect(await actComplete(configured.fetchImpl, "commit", { doneTransitionId: "31" })).toMatchObject({
      changed: true, target: { state: "done" }, gates: [],
    });
    expect(configured.posted()).toEqual({ transition: { id: "31" } });
    expect(configured.requests.filter(request => request.startsWith("POST"))).toHaveLength(1);
    const named = ambiguous();
    expect(await actComplete(named.fetchImpl, "dry-run", { doneTransitionName: "Ship" }))
      .toMatchObject({ changed: false, gates: [] });
    expect(mutating(named.requests)).toEqual([]);
    const unknown = ambiguous();
    expect(await actComplete(unknown.fetchImpl, "dry-run", { doneTransitionId: true }))
      .toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "policy" })] });
  });

  it("observes an already-done issue without writing", async () => {
    const requests: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify({
        key: "PAY-1", fields: { status: { name: "Done", statusCategory: { key: "done" } } },
      }), { status: 200 });
    };
    expect(await actComplete(fetchImpl)).toMatchObject({
      changed: true, target: { state: "done" }, gates: [],
    });
    expect(requests.every(request => request.startsWith("GET"))).toBe(true);
  });

  it("uses ctx.fetch only and throws on undeclared secrets", async () => {
    const fetchImpl: typeof fetch = async (input) => new Response(JSON.stringify(String(input).endsWith("?fields=status")
      ? { key: "PAY-1", fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }
      : { transitions: [{ id: "11", to: { name: "Done", statusCategory: { key: "done" } } }] }), { status: 200 });
    const leaked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      leaked.push(String(input));
      return original(input);
    }) as typeof fetch;
    try {
      await actComplete(fetchImpl, "dry-run");
    } finally {
      globalThis.fetch = original;
    }
    expect(leaked).toEqual([]);
    expect(() => ctx(fetchImpl).secret("not-declared")).toThrow(/not declared/);
  });
});
