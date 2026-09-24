import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { WorkItems, publicWorkItem, type WorkRecord } from "./work-items.ts";
import { removeTempDir } from "./testing/cleanup.ts";

async function fixture(test: (items: WorkItems, file: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "omb-work-items-"));
  try { test(new WorkItems(join(directory, "work-items.json")), join(directory, "work-items.json")); }
  finally { await removeTempDir(directory); }
}

const input = { scope: "Engineering", identity: "jira:account-a:PAY-123", groupId: "payments", threadId: "hub",
  coordinatorBotId: "chief", title: "Refund failures", objective: "Fix refunds", acceptanceCriteria: ["Refund test passes"] };
const finish = (items: WorkItems, item: WorkRecord) => items.update(item, { expectedRevision: item.revision,
  status: "completed", detail: "Refund fixed and verified", evidence: ["thread:test-output"], completedCriteria: item.acceptanceCriteria }, "chief");

describe("shared work identity", () => {
  it("reuses an unchanged deliverable across triggers and does not use titles as identity", () => fixture(items => {
    const first = items.ensure(input);
    expect(first.created).toBe(true);
    expect(items.ensure({ ...input, title: "A different display name" })).toMatchObject({ created: false, started: false, item: { id: first.item.id } });
    const other = items.ensure({ ...input, identity: "jira:account-b:PAY-123", threadId: "other-hub" });
    expect(other.item.id).not.toBe(first.item.id);
    expect(items.ensure({ ...input, scope: "Another team", threadId: "third-hub" }).item.id).not.toBe(first.item.id);
  }));

  it("keeps completed work quiet until relevant input changes or the user reopens it", () => fixture(items => {
    const { item } = items.ensure({ ...input, input: "requirements v1" });
    finish(items, item);
    expect(items.ensure({ ...input, input: "requirements v1" }).started).toBe(false);
    expect(items.ensure(input).started).toBe(false);
    expect(items.ensure({ ...input, input: "requirements v2" })).toMatchObject({ started: true, item: { revision: 2, status: "active" } });
    items.settle(item, "blocked", "Missing dependency");
    expect(items.ensure({ ...input, input: "requirements v2" }).started).toBe(false);
    item.rootId = "previous-execution";
    items.update(item, { expectedRevision: 2, reopen: true });
    expect(item).toMatchObject({ revision: 3, status: "active" });
    expect(item.rootId).toBeUndefined();
  }));

  it("does not mutate running requirements or accept stale final results", () => fixture(items => {
    const { item } = items.ensure(input);
    expect(() => items.ensure({ ...input, input: "new" })).toThrow("still working");
    expect(() => items.update(item, { expectedRevision: 0, status: "completed" }, "chief")).toThrow("revision changed");
    expect(() => items.update(item, { expectedRevision: 1, status: "completed" }, "worker")).toThrow("coordinator");
    expect(() => items.update(item, { expectedRevision: 1, status: "completed", detail: "Done" }, "chief")).toThrow("evidence");
    expect(item.status).toBe("active");
  }));

  it("subscribes each originating conversation once without exposing sources on the public wire", () => fixture(items => {
    const { item } = items.ensure(input);
    items.subscribe(item, { botId: "chief", threadId: "chat" });
    items.subscribe(item, { botId: "chief", threadId: "chat" });
    items.subscribe(item, { botId: "chief", threadId: "routine-run" });
    expect(item.sources).toHaveLength(2);
    expect(items.pendingForSource("chat")).toBe(true);
    expect(publicWorkItem(item)).not.toHaveProperty("sources");
    expect(publicWorkItem(item)).not.toHaveProperty("identity");
    finish(items, item);
    expect(items.pendingForSource("chat")).toBe(false);
  }));
});

describe("shared assignments", () => {
  it("coalesces active and completed work despite changed request wording", () => fixture(items => {
    const { item } = items.ensure(input);
    const first = items.claim(item, { botId: "engineer", threadId: "worker", message: "Fix the refund bug" });
    expect(items.claim(item, { botId: "engineer", threadId: "different", message: "Fix it please" })).toMatchObject({ duplicate: true, assignment: { id: first.assignment.id, threadId: "worker" } });
    first.assignment.status = "completed";
    first.assignment.result = "Fixed and checked";
    expect(items.claim(item, { botId: "engineer", threadId: "worker", message: "Thanks, approved" })).toMatchObject({ duplicate: true, assignment: { result: "Fixed and checked" } });
    expect(item.assignments).toHaveLength(1);
  }));

  it("requires concrete rework and blocks after two corrections", () => fixture(items => {
    const { item } = items.ensure(input);
    const { assignment } = items.claim(item, { botId: "engineer", threadId: "worker", message: "Fix refunds" });
    assignment.status = "completed";
    expect(() => items.claim(item, { botId: "engineer", threadId: "worker", message: "Again", rework: true })).toThrow("assignment_id");
    for (const message of ["Handle empty refunds", "Handle duplicate refunds"]) {
      expect(items.claim(item, { botId: "engineer", threadId: "worker", message, assignmentId: assignment.id, rework: true }).duplicate).toBe(false);
      assignment.status = "completed";
    }
    expect(() => items.claim(item, { botId: "engineer", threadId: "worker", message: "Again now", assignmentId: assignment.id, rework: true })).toThrow("Two automatic correction");
    expect(item.status).toBe("blocked");
    expect(items.ensure(input).started).toBe(false);
  }));

  it("refuses completion while a required worker is queued, failed or on an older revision", () => fixture(items => {
    const { item } = items.ensure(input);
    const { assignment } = items.claim(item, { botId: "engineer", threadId: "worker", message: "Fix refunds" });
    expect(() => finish(items, item)).toThrow("assignments");
    assignment.status = "failed";
    expect(() => finish(items, item)).toThrow("assignments");
    assignment.status = "completed";
    finish(items, item);
    items.update(item, { expectedRevision: 1, reopen: true });
    expect(items.admit(item, 1)).toMatch(/older task revision/);
  }));

  it("persists execution budgets across trigger roots", () => fixture((items, file) => {
    const { item } = items.ensure(input);
    for (let execution = 0; execution < 48; execution += 1) expect(items.admit(item, 1)).toBeUndefined();
    expect(items.ensure(input).started).toBe(false);
    expect(items.admit(item, 1)).toMatch(/budget exhausted/);
    expect(JSON.parse(readFileSync(file, "utf8"))[0].executions).toBe(48);
  }));

  it("records interruption without replay and fails closed on corrupt storage", () => fixture((items, file) => {
    const { item } = items.ensure(input);
    items.claim(item, { botId: "engineer", threadId: "worker", message: "Fix refunds" });
    const recovered = new WorkItems(file);
    expect(recovered.find(input.scope, input.identity)).toMatchObject({ status: "blocked", assignments: [{ status: "failed" }] });
    expect(recovered.ensure(input).started).toBe(false);
    writeFileSync(file, "broken");
    const broken = new WorkItems(file);
    expect(() => broken.ensure(input)).toThrow("storage is unreadable");
    expect(readFileSync(file, "utf8")).toBe("broken");
  }));

  it("refuses additions at capacity without creating a file recovery would reject", () => fixture((items, file) => {
    const { item } = items.ensure(input);
    finish(items, item);
    for (let i = 1; i < 10_000; i++) {
      const id = `retained-${i}`;
      items.records.set(id, { ...structuredClone(item), id, identity: id });
    }
    items.changed(item);
    const saved = readFileSync(file, "utf8");
    expect(() => items.ensure({ ...input, identity: "overflow" })).toThrow("storage limit");
    expect(() => items.restore({ ...publicWorkItem(item), id: "import-overflow", scope: input.scope, identity: "overflow" })).toThrow("storage limit");
    expect(readFileSync(file, "utf8")).toBe(saved);
    const recovered = new WorkItems(file);
    expect(recovered.records.size).toBe(10_000);
    expect(recovered.ensure(input)).toMatchObject({ created: false, started: false, item: { status: "completed", detail: "Refund fixed and verified" } });
  }));

  it("does not retain a newly created or imported task after a failed disk write", () => fixture((items, file) => {
    const { item } = items.ensure(input);
    rmSync(file);
    mkdirSync(file); // A directory cannot be replaced by the atomic file writer.
    expect(() => items.ensure({ ...input, identity: "unsaved" })).toThrow();
    expect(() => items.restore({ ...publicWorkItem(item), id: "unsaved-import", scope: input.scope, identity: "unsaved" })).toThrow();
    expect(items.find(input.scope, "unsaved")).toBeUndefined();
    expect([...items.records.values()]).toEqual([item]);
  }));
});
