import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { BacklogTarget } from "../shared/team-backlog.ts";
import type { Connector, StoredConnection } from "./connectors/types.ts";
import { fakeConnector } from "./testing/fake-connector.ts";
import {
  MISSION_ACTION_UNDECLARED, MISSION_WRITES_DISABLED, MISSION_WRITE_STOPPED, missionActionFor,
  runMissionAction,
} from "./team-backlog-actions.ts";

const here = dirname(fileURLToPath(import.meta.url));
const target: BacklogTarget = {
  identity: "fake:fake-main:PAY-1", connectorId: "fake", connectionId: "fake-main",
  externalId: "PAY-1", kind: "work_item", title: "Refund failures", state: "in_progress",
  label: "In Progress", updatedAt: 1, observedAt: 2,
};
const connection: StoredConnection = {
  id: "fake-main", connectorId: "fake", label: "Fake",
  settings: { site: "https://fake.example" }, secrets: { token: "fixture" },
  sections: ["Delivery"], enabled: true,
};
const unlocked: StoredConnection = { ...connection, writes: { enabled: true, allow: ["complete_work_item"] } };

function mutating(requests: Array<{ method: string }>) {
  return requests.filter(request => ["PUT", "POST", "PATCH", "DELETE"].includes(request.method));
}

function recordingFetch() {
  const requests: Array<{ url: string; method: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), method: (init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify({
      title: "Refund failures",
      state: { label: "In Progress", category: "in_progress" },
    }), { status: 200 });
  };
  return { fetchImpl, requests };
}

function run(connection: StoredConnection, fetchImpl: typeof fetch, mayWrite: () => boolean = () => false,
  workspaceWrites = false) {
  return runMissionAction({
    connection, target, action: missionActionFor(target.kind), fetchImpl, mayWrite, workspaceWrites,
  });
}

describe("server mission action wrapper", () => {
  const originalAct = fakeConnector.act!;
  afterEach(() => {
    fakeConnector.act = originalAct;
  });

  function spyAct() {
    const seen: Array<"dry-run" | "commit"> = [];
    fakeConnector.act = (async (ctx, input) => {
      seen.push(input.mode);
      return originalAct.call(fakeConnector, ctx, input);
    }) as Connector["act"];
    return seen;
  }

  it("does not commit a ready item unless both locks are open", async () => {
    const locked = recordingFetch();
    const seen = spyAct();
    expect(await run(connection, locked.fetchImpl)).toMatchObject({
      changed: false, target, gates: [expect.objectContaining({ kind: "access", detail: MISSION_WRITES_DISABLED })],
    });
    expect(seen).toEqual(["dry-run"]);
    expect(mutating(locked.requests)).toEqual([]);
    expect(locked.requests.some(request => request.url.includes("/work_item/PAY-1"))).toBe(true);

    const flagOnly = recordingFetch();
    expect(await run(connection, flagOnly.fetchImpl, () => true, true)).toMatchObject({
      changed: false, gates: [expect.objectContaining({ kind: "access" })],
    });
    const allowOnly = recordingFetch();
    expect(await run(unlocked, allowOnly.fetchImpl, () => true, false)).toMatchObject({
      changed: false, gates: [expect.objectContaining({ kind: "access" })],
    });
    const emptyAllow = recordingFetch();
    expect(await run({ ...connection, writes: { enabled: true, allow: [] } }, emptyAllow.fetchImpl, () => true, true))
      .toMatchObject({ changed: false, gates: [expect.objectContaining({ kind: "access" })] });
  });

  it("commits through the fake connector when locks are open and the goal is still active", async () => {
    const api = recordingFetch();
    const seen = spyAct();
    expect(await run(unlocked, api.fetchImpl, () => true, true)).toMatchObject({
      changed: true, target: { state: "done" }, gates: [],
    });
    expect(seen).toEqual(["dry-run", "commit"]);
    expect(mutating(api.requests)).toEqual([]);
  });

  it("rechecks a stopped mission immediately before commit", async () => {
    const api = recordingFetch();
    const seen = spyAct();
    await expect(run(unlocked, api.fetchImpl, () => false, true)).rejects.toThrow(MISSION_WRITE_STOPPED);
    expect(seen).toEqual(["dry-run"]);
    expect(mutating(api.requests)).toEqual([]);
  });

  it("records an access gate and sends no HTTP when the connector does not declare the action", async () => {
    const requests: Array<{ method: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ method: (init?.method ?? "GET").toUpperCase() });
      throw new Error(`Unexpected fixture request ${String(input)}`);
    };
    const plane: StoredConnection = {
      id: "plane-main", connectorId: "plane", label: "Plane",
      settings: { site: "https://api.plane.so", workspace: "acme", project: "PAY" },
      secrets: { apiKey: "fixture" }, sections: ["Delivery"], enabled: true,
    };
    const item: BacklogTarget = { ...target, identity: "plane:plane-main:PAY-1", connectorId: "plane",
      connectionId: "plane-main" };
    expect(await runMissionAction({
      connection: plane, target: item, action: "complete_work_item", fetchImpl, mayWrite: () => true, workspaceWrites: true,
    })).toMatchObject({
      changed: false, target: item, gates: [expect.objectContaining({ kind: "access", detail: MISSION_ACTION_UNDECLARED })],
    });
    expect(requests).toEqual([]);
  });

  it("keeps provider write HTTP and provider-named write branches out of the wrapper and runner", () => {
    const actions = readFileSync(join(here, "team-backlog-actions.ts"), "utf8");
    const runner = readFileSync(join(here, "team-backlog-runner.ts"), "utf8");
    expect(actions).not.toMatch(/gitlabRequest|jiraRequest|function endpoint/);
    expect(runner).not.toMatch(/mergeReviewedRequest|transitionEvidencedJiraIssue/);
    expect(runner).not.toMatch(/if\s*\(\s*(?:connection\.)?connectorId\s*===\s*["']gitlab["']/);
    expect(runner).toMatch(/runMissionAction/);
  });
});
