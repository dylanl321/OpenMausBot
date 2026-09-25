import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../types.ts";
import { gitlabConnector } from "./index.ts";

const sha = "a".repeat(40);
const newer = "b".repeat(40);

function mutating(requests: Array<{ method: string }>) {
  return requests.filter(request => ["PUT", "POST", "PATCH", "DELETE"].includes(request.method));
}

function ctx(fetchImpl: typeof fetch): ConnectionContext {
  return {
    connectionId: "gitlab-main",
    settings: { site: "http://127.0.0.1:8325", project: "acme/app" },
    secret(key) {
      if (!gitlabConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return key === "token" ? "fixture" : undefined;
    },
    fetch: fetchImpl,
    log() {},
  };
}

function actMerge(fetchImpl: typeof fetch, mode: "dry-run" | "commit" = "commit") {
  return gitlabConnector.act!(ctx(fetchImpl), {
    action: "merge_change_request",
    target: { kind: "change_request", externalId: "acme/app!10", headSha: sha },
    mode,
  });
}

function gitlabFixture(options: { head?: string; manager?: boolean; error?: boolean; pipeline?: string;
  pipelineSha?: string | null; staleApproval?: boolean; policyUnknown?: boolean;
  undated?: boolean; forgedNote?: boolean; noteError?: boolean; alreadyMerged?: boolean } = {}) {
  let merged = false;
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ url, method, body: init?.body?.toString() });
    if (url.endsWith("/merge_requests/10/merge")) {
      expect(method).toBe("PUT");
      expect(JSON.parse(init?.body?.toString() ?? "{}")).toEqual({ sha });
      merged = true;
      return body({ state: "merged" });
    }
    if (url.endsWith("/merge_requests/10")) return body({
      state: options.alreadyMerged || merged ? "merged" : "opened", sha: options.head ?? sha,
      detailed_merge_status: "mergeable", draft: false, has_conflicts: false, blocking_discussions_resolved: true,
      head_pipeline: { status: options.pipeline ?? "success", sha: options.pipelineSha === null ? undefined : options.pipelineSha ?? sha },
      merge_commit_sha: options.alreadyMerged || merged ? newer : null,
    });
    if (url.endsWith("/merge_requests/10/approvals")) return options.error ? new Response("error", { status: 503 }) : body({ approvals_left: 0,
      approved_by: [{ user: { id: 101 }, ...(!options.undated ? { approved_at: "2026-09-24T11:00:00Z" } : {}) },
        { user: { id: 102 }, ...(!options.undated ? { approved_at: options.staleApproval ? "2026-09-24T09:00:00Z" : "2026-09-24T11:00:00Z" } : {}) }] });
    if (url.endsWith("/merge_requests/10/approval_state")) return body({ rules: [
      { name: "Security", approved: true, approved_by: [{ id: 101 }] },
      { name: "Manager", approved: options.manager !== false, approved_by: options.manager === false ? [] : [{ id: 102 }] },
    ] });
    if (url.endsWith("/merge_requests/10/versions?per_page=100")) return body([{ head_commit_sha: sha, created_at: "2026-09-24T10:00:00Z" }]);
    if (url.includes("/merge_requests/10/notes?")) {
      if (options.noteError) return new Response("error", { status: 503 });
      const page = new URL(url).searchParams.get("page");
      const note = (id: number) => ({ system: options.forgedNote && id === 102 ? false : true,
        body: "approved this merge request", author: { id },
        created_at: options.staleApproval && id === 102 ? "2026-09-24T09:00:00Z" : "2026-09-24T11:00:00Z" });
      return new Response(JSON.stringify(page === "1" ? [note(101)] : [note(102)]), { status: 200,
        headers: { "x-next-page": page === "1" ? "2" : "" } });
    }
    if (url.endsWith("/projects/acme%2Fapp")) return body(options.policyUnknown ? {} : {
      only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true,
    });
    throw new Error(`Unexpected fixture request ${url}`);
  };
  return { fetchImpl, requests };
}

describe("gitlab merge_change_request", () => {
  it("declares the merge action and dry-run never sends a mutating method", async () => {
    expect(gitlabConnector.manifest.actions).toEqual([
      expect.objectContaining({ id: "merge_change_request", kind: "change_request" }),
    ]);
    const api = gitlabFixture();
    expect(await actMerge(api.fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });
    expect(mutating(api.requests)).toEqual([]);
    expect(api.requests.some(request => request.url.endsWith("/approvals"))).toBe(true);
  });

  it("merges only after current-head Security, Manager and project policy checks, with an exact SHA precondition", async () => {
    const api = gitlabFixture();
    const result = await actMerge(api.fetchImpl);
    expect(result).toMatchObject({ changed: true, target: { state: "done", label: "merged", headSha: sha }, gates: [] });
    expect(result.target.result).toContain(newer);
    expect(api.requests.filter(request => request.method === "PUT")).toHaveLength(1);
    expect(api.requests.some(request => /pipelines\/?$|close/.test(request.url))).toBe(false);
  });

  it("treats an already-merged MR as a successful observation without writing", async () => {
    const api = gitlabFixture({ alreadyMerged: true });
    expect(await actMerge(api.fetchImpl)).toMatchObject({
      changed: true, target: { state: "done", label: "merged" }, gates: [],
    });
    expect(mutating(api.requests)).toEqual([]);
  });

  it("invalidates a stale head and waits for the actual reviewer or policy actor without writing", async () => {
    const head = gitlabFixture({ head: newer });
    expect(await actMerge(head.fetchImpl, "dry-run")).toMatchObject({ changed: false,
      target: { headSha: newer }, gates: [expect.objectContaining({ kind: "review" })] });
    expect(head.requests.some(request => request.method === "PUT")).toBe(false);
    const manager = gitlabFixture({ manager: false });
    const missing = await actMerge(manager.fetchImpl);
    expect(missing.gates.map(gate => gate.kind)).toContain("manager");
    expect(manager.requests.some(request => request.method === "PUT")).toBe(false);
    const stale = gitlabFixture({ staleApproval: true });
    expect((await actMerge(stale.fetchImpl)).gates.map(gate => gate.kind)).toContain("manager");
    expect(stale.requests.some(request => request.method === "PUT")).toBe(false);
    const policy = gitlabFixture({ pipeline: "running" });
    expect((await actMerge(policy.fetchImpl)).gates.map(gate => gate.kind)).toContain("policy");
    expect(policy.requests.some(request => request.method === "PUT")).toBe(false);
    for (const unsafe of [gitlabFixture({ policyUnknown: true }), gitlabFixture({ pipelineSha: null })]) {
      expect((await actMerge(unsafe.fetchImpl)).gates.map(gate => gate.kind)).toContain("policy");
      expect(unsafe.requests.some(request => request.method === "PUT")).toBe(false);
    }
    const error = gitlabFixture({ error: true });
    await expect(actMerge(error.fetchImpl)).rejects.toThrow(/approvals returned 503/);
    expect(error.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it("proves undated current approvers using paginated post-head system notes, not forged or stale comments", async () => {
    const proved = gitlabFixture({ undated: true });
    expect((await actMerge(proved.fetchImpl)).target.state).toBe("done");
    expect(proved.requests.filter(request => request.url.includes("/notes?"))).toHaveLength(2);
    for (const unsafe of [gitlabFixture({ undated: true, forgedNote: true }),
      gitlabFixture({ undated: true, staleApproval: true })]) {
      expect((await actMerge(unsafe.fetchImpl)).gates.map(gate => gate.kind)).toContain("manager");
      expect(unsafe.requests.some(request => request.method === "PUT")).toBe(false);
    }
    const incomplete = gitlabFixture({ undated: true, noteError: true });
    await expect(actMerge(incomplete.fetchImpl)).rejects.toThrow(/approval notes returned 503/);
    expect(incomplete.requests.some(request => request.method === "PUT")).toBe(false);
  });

  it("uses ctx.fetch only and throws on undeclared secrets", async () => {
    const api = gitlabFixture();
    const leaked: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      leaked.push(String(input));
      return original(input);
    }) as typeof fetch;
    try {
      await actMerge(api.fetchImpl, "dry-run");
    } finally {
      globalThis.fetch = original;
    }
    expect(leaked).toEqual([]);
    expect(() => ctx(api.fetchImpl).secret("not-declared")).toThrow(/not declared/);
  });
});
