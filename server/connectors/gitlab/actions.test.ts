import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ConnectionContext } from "../types.ts";
import { gitlabConnector } from "./index.ts";

const sha = "a".repeat(40);
const newer = "b".repeat(40);
const here = dirname(fileURLToPath(import.meta.url));

function mutating(requests: Array<{ method: string }>) {
  return requests.filter(request => ["PUT", "POST", "PATCH", "DELETE"].includes(request.method));
}

function ctx(fetchImpl: typeof fetch, settings: Record<string, string | number | boolean> = {}): ConnectionContext {
  return {
    connectionId: "gitlab-main",
    settings: { site: "http://127.0.0.1:8325", project: "acme/app", ...settings },
    secret(key) {
      if (!gitlabConnector.manifest.secrets.some(secret => secret.key === key)) throw new Error(`${key} is not declared`);
      return key === "token" ? "fixture" : undefined;
    },
    fetch: fetchImpl,
    log() {},
  };
}

function actMerge(fetchImpl: typeof fetch, mode: "dry-run" | "commit" = "commit",
  settings: Record<string, string | number | boolean> = {}) {
  return gitlabConnector.act!(ctx(fetchImpl, settings), {
    action: "merge_change_request",
    target: { kind: "change_request", externalId: "acme/app!10", headSha: sha },
    mode,
  });
}

function defaultRequiredRules(options: { appsec?: boolean; owners?: boolean } = {}) {
  return [
    { name: "AppSec", approvals_required: 1, approved: options.appsec !== false, approved_by: options.appsec === false ? [] : [{ id: 101 }] },
    { name: "Code owners", approvals_required: 1, approved: options.owners !== false, approved_by: options.owners === false ? [] : [{ id: 102 }] },
  ];
}

function gitlabFixture(options: {
  head?: string; error?: boolean; pipeline?: string; pipelineSha?: string | null;
  staleApproval?: boolean; policyUnknown?: boolean; undated?: boolean; forgedNote?: boolean;
  noteError?: boolean; alreadyMerged?: boolean; missingRules?: boolean;
  rules?: Array<Record<string, any>>;
} = {}) {
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
    if (url.endsWith("/merge_requests/10/approval_state")) {
      if (options.missingRules) return body({});
      return body({ rules: options.rules ?? defaultRequiredRules() });
    }
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
    expect(gitlabConnector.manifest.settings.some(field => field.key === "requiredApprovalRules")).toBe(true);
    const api = gitlabFixture();
    expect(await actMerge(api.fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });
    expect(mutating(api.requests)).toEqual([]);
    expect(api.requests.some(request => request.url.endsWith("/approvals"))).toBe(true);
  });

  it("dry-run passes when live required AppSec and Code owners rules are current-head approved", async () => {
    const api = gitlabFixture();
    expect(await actMerge(api.fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });
    expect(mutating(api.requests)).toEqual([]);
  });

  it("merges only after current-head required rules and project policy checks, with an exact SHA precondition", async () => {
    const api = gitlabFixture();
    const result = await actMerge(api.fetchImpl);
    expect(result).toMatchObject({ changed: true, target: { state: "done", label: "merged", headSha: sha }, gates: [] });
    expect(result.target.result).toContain(newer);
    expect(api.requests.filter(request => request.method === "PUT")).toHaveLength(1);
    expect(api.requests.some(request => /pipelines\/?$|close/.test(request.url))).toBe(false);
  });

  it("does not require Security or Manager unless extras or live required rules say so", async () => {
    const optional = [
      { name: "Security", approvals_required: 0, approved: false, approved_by: [] },
      { name: "Manager", approvals_required: 0, approved: false, approved_by: [] },
    ];
    const ignored = gitlabFixture({ rules: optional });
    expect(await actMerge(ignored.fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });
    expect(mutating(ignored.requests)).toEqual([]);
    const withLive = gitlabFixture({ rules: [...optional, ...defaultRequiredRules()] });
    expect(await actMerge(withLive.fetchImpl, "dry-run")).toMatchObject({ changed: false, gates: [] });

    const extras = gitlabFixture({
      rules: [
        { name: "Security", approvals_required: 0, approved: true, approved_by: [{ id: 101 }] },
        { name: "Manager", approvals_required: 0, approved: false, approved_by: [] },
        ...defaultRequiredRules(),
      ],
    });
    const missing = await actMerge(extras.fetchImpl, "dry-run", { requiredApprovalRules: "Security, Manager" });
    expect(missing.gates.map(gate => gate.kind)).toContain("manager");
    expect(missing.gates.find(gate => gate.kind === "manager")?.decisionMaker).toBe("Manager");
    expect(mutating(extras.requests)).toEqual([]);

    const live = gitlabFixture({
      rules: [
        { name: "Security", approvals_required: 1, approved: true, approved_by: [{ id: 101 }] },
        { name: "Manager", approvals_required: 1, approved: false, approved_by: [] },
      ],
    });
    const liveMissing = await actMerge(live.fetchImpl, "dry-run");
    expect(liveMissing.gates.map(gate => gate.kind)).toContain("manager");
    expect(mutating(live.requests)).toEqual([]);

    const satisfied = gitlabFixture({
      rules: [
        { name: "Security", approvals_required: 0, approved: true, approved_by: [{ id: 101 }] },
        { name: "Manager", approvals_required: 0, approved: true, approved_by: [{ id: 102 }] },
      ],
    });
    expect(await actMerge(satisfied.fetchImpl, "dry-run", { requiredApprovalRules: "Security, Manager" }))
      .toMatchObject({ changed: false, gates: [] });
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
      target: { headSha: newer }, gates: [expect.objectContaining({ kind: "review", decisionMaker: "Project approvers" })] });
    expect(head.requests.some(request => request.method === "PUT")).toBe(false);
    const owners = gitlabFixture({ rules: defaultRequiredRules({ owners: false }) });
    const missing = await actMerge(owners.fetchImpl);
    expect(missing.gates.map(gate => [gate.kind, gate.decisionMaker])).toContainEqual(["review", "Code owners"]);
    expect(owners.requests.some(request => request.method === "PUT")).toBe(false);
    const stale = gitlabFixture({ staleApproval: true, rules: defaultRequiredRules({ owners: true }) });
    expect((await actMerge(stale.fetchImpl)).gates.map(gate => gate.decisionMaker)).toContain("Code owners");
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

  it("fails closed when approval rules are missing or a required rule field is unknown", async () => {
    const missing = gitlabFixture({ missingRules: true });
    await expect(actMerge(missing.fetchImpl, "dry-run")).rejects.toThrow(/approval rules are unavailable/);
    expect(mutating(missing.requests)).toEqual([]);
    for (const rules of [
      [{ name: "AppSec", approvals_required: "all", approved: true, approved_by: [{ id: 101 }] }],
      [{ name: "AppSec", approved: true, approved_by: [{ id: 101 }] }],
    ]) {
      const unknown = gitlabFixture({ rules });
      const gated = await actMerge(unknown.fetchImpl, "dry-run");
      expect(gated).toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "policy" })] });
      expect(mutating(unknown.requests)).toEqual([]);
    }
    const badExtras = gitlabFixture();
    expect(await actMerge(badExtras.fetchImpl, "dry-run", { requiredApprovalRules: true }))
      .toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "policy" })] });
    expect(mutating(badExtras.requests)).toEqual([]);
  });

  it("proves undated current approvers using paginated post-head system notes, not forged or stale comments", async () => {
    const proved = gitlabFixture({ undated: true });
    expect((await actMerge(proved.fetchImpl)).target.state).toBe("done");
    expect(proved.requests.filter(request => request.url.includes("/notes?"))).toHaveLength(2);
    for (const unsafe of [gitlabFixture({ undated: true, forgedNote: true }),
      gitlabFixture({ undated: true, staleApproval: true })]) {
      expect((await actMerge(unsafe.fetchImpl)).gates.map(gate => gate.decisionMaker)).toContain("Code owners");
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

  it("does not compile extra approval-rule names into production code", () => {
    for (const file of ["actions.ts", "../jira/actions.ts", "../../team-backlog-runner.ts", "../../team-work-kits.ts", "../../team-work-kits.json"]) {
      const source = readFileSync(join(here, file), "utf8");
      expect(source, file).not.toMatch(/["']Security["']/);
      expect(source, file).not.toMatch(/["']Manager["']/);
    }
  });
});
