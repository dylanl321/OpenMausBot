import type { MissionActionId, StoredConnection } from "./connectors/types.ts";
import { connectorById } from "./connectors/registry.ts";
import { connectionContext } from "./task-connections.ts";
import { backlogGate } from "./team-backlog.ts";
import type { BacklogGate, BacklogTarget } from "../shared/team-backlog.ts";

export const MISSION_WRITES_DISABLED =
  "External mission writes are disabled until features.teamMissionWrites is on and this connection allowlists the action.";

export const MISSION_ACTION_UNDECLARED =
  "This connection does not declare a completion action for that item.";

export const MISSION_WRITE_STOPPED =
  "The goal stopped before the attested write was sent";

export function missionActionFor(kind: BacklogTarget["kind"]): MissionActionId {
  return kind === "change_request" ? "merge_change_request" : "complete_work_item";
}

export function connectionAllowsMissionWrite(connection: StoredConnection, action: MissionActionId): boolean {
  return connection.writes?.enabled === true && (connection.writes.allow ?? []).includes(action);
}

export function teamMissionWriteAllowed(
  stillActive: boolean,
  workspaceWrites: boolean,
  connection: StoredConnection,
  action: MissionActionId,
): boolean {
  return stillActive && workspaceWrites && connectionAllowsMissionWrite(connection, action);
}

function writesUnlocked(connection: StoredConnection, action: MissionActionId, workspaceWrites: boolean): boolean {
  return workspaceWrites && connectionAllowsMissionWrite(connection, action);
}

function writesLockedOutcome(target: BacklogTarget): Outcome {
  return {
    target,
    gates: [backlogGate("access", MISSION_WRITES_DISABLED, "Workspace owner", target.identity)],
    changed: false,
  };
}

type Outcome = { target: BacklogTarget; gates: BacklogGate[]; changed: boolean };

function connectorDeclaresAction(
  connector: NonNullable<ReturnType<typeof connectorById>>,
  action: MissionActionId,
  kind: BacklogTarget["kind"],
): boolean {
  return Boolean(connector.act && connector.manifest.actions?.some(entry => entry.id === action && entry.kind === kind));
}

/** Server-owned attested write. Chooses `dry-run` vs `commit` from P0 locks
 * so a buggy `act` that ignores `mode` is never invoked with `commit`. */
export async function runMissionAction(input: {
  connection: StoredConnection;
  target: BacklogTarget;
  action: MissionActionId;
  fetchImpl?: typeof fetch;
  mayWrite?: () => boolean;
  workspaceWrites?: boolean;
}): Promise<Outcome> {
  const mayWrite = input.mayWrite ?? (() => false);
  const workspaceWrites = input.workspaceWrites === true;
  const { connection, target, action } = input;
  const connector = connectorById(connection.connectorId);
  if (!connector || !connectorDeclaresAction(connector, action, target.kind) || missionActionFor(target.kind) !== action) {
    return {
      target,
      gates: [backlogGate("access", MISSION_ACTION_UNDECLARED, "Connection owner", target.identity)],
      changed: false,
    };
  }
  const ctx = connectionContext(connection, input.fetchImpl ?? fetch);
  const actInput = {
    action,
    target: {
      kind: target.kind,
      externalId: target.externalId,
      ...(target.headSha ? { headSha: target.headSha } : {}),
    },
  };
  const dry = await connector.act!(ctx, { ...actInput, mode: "dry-run" });
  if (dry.changed || dry.gates.length) {
    return { target: { ...target, ...dry.target }, gates: dry.gates, changed: dry.changed };
  }
  if (!writesUnlocked(connection, action, workspaceWrites)) return writesLockedOutcome(target);
  if (!mayWrite()) throw new Error(MISSION_WRITE_STOPPED);
  const committed = await connector.act!(ctx, { ...actInput, mode: "commit" });
  return { target: { ...target, ...committed.target }, gates: committed.gates, changed: committed.changed };
}
