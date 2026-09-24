import { connectorById } from "../connectors/registry.ts";
import { connectionForSection, listConnections } from "../task-connections.ts";
import type { StoredConnection } from "../connectors/types.ts";
import type { GroupRecord } from "../store.ts";
import { PASS, type RouteHandler } from "./table.ts";

function queryableConnections(connections: StoredConnection[], section: string) {
  return listConnections(connections.filter(connection => {
    if (!connectionForSection(connections, section, connection.id)) return false;
    const connector = connectorById(connection.connectorId);
    return Boolean(connector?.query && connector.manifest.capabilities.query);
  }));
}

const querySchema = (raw: unknown): { connectionId: string; query: string } | { clear: true } | { error: string } => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "body must be a JSON object" };
  const body = raw as { connectionId?: unknown; query?: unknown };
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  const query = typeof body.query === "string" ? body.query : "";
  if (!connectionId) return { clear: true };
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(connectionId)) return { error: "connectionId is not a saved connection." };
  if (query.length > 4_000) return { error: "query must be at most 4000 characters" };
  return { connectionId, query };
};

export function createGroupTaskBoardRoutes(deps: {
  group(id: string): GroupRecord | undefined;
  connections(): StoredConnection[];
  save(groupId: string, taskBoard: GroupRecord["taskBoard"] | undefined): GroupRecord | null | undefined;
}): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    const match = /^\/api\/groups\/([\w-]+)\/task-board$/.exec(path);
    if (!match) return PASS;
    const group = deps.group(match[1]);
    if (!group || group.dm) return json(res, 404, { error: "No such channel." });
    if (method === "GET") {
      return json(res, 200, {
        taskBoard: group.taskBoard ?? null,
        connections: queryableConnections(deps.connections(), group.section ?? ""),
      });
    }
    if (method !== "PATCH") return json(res, 405, { error: "Method not allowed." });
    const parsed = querySchema(await readBody(req));
    if ("error" in parsed) return json(res, 400, { error: parsed.error });
    if ("clear" in parsed) {
      const updated = deps.save(group.id, undefined);
      return json(res, 200, { group: updated, taskBoard: null });
    }
    const connection = connectionForSection(deps.connections(), group.section ?? "", parsed.connectionId);
    const connector = connection ? connectorById(connection.connectorId) : undefined;
    if (!connection || !connector?.query || !connector.manifest.capabilities.query) {
      return json(res, 400, { error: "Choose a connection that can list items for this topic." });
    }
    const taskBoard = { connectionId: parsed.connectionId, query: parsed.query };
    const updated = deps.save(group.id, taskBoard);
    return json(res, 200, { group: updated, taskBoard });
  };
}
