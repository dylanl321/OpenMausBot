import { connectorById } from "../connectors/registry.ts";
import { listConnections, manifests, parseConnectionMutation, testConnection, type TaskConnectionMutation } from "../task-connections.ts";
import type { StoredConnection } from "../connectors/types.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TaskConnectionRoutes {
  load(): StoredConnection[];
  save(connections: StoredConnection[]): void;
  fetchImpl?: typeof fetch;
}

export function createTaskConnectionRoutes(deps: TaskConnectionRoutes): RouteHandler {
  return async ({ req, res, path, method, json, readBody }) => {
    if (path === "/api/task-connectors" && method === "GET") return json(res, 200, { connectors: manifests() });
    if (path === "/api/task-connectors") return json(res, 405, { error: "Method not allowed." });
    if (path === "/api/task-connections" && method === "GET") return json(res, 200, { connections: listConnections(deps.load()) });
    if (path === "/api/task-connections" && method === "POST") {
      const parsed = parseConnectionMutation(await readBody(req));
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      const current = deps.load();
      if (current.some(connection => connection.id === parsed.connection.id)) return json(res, 409, { error: "A connection with that id already exists." });
      deps.save([...current, parsed.connection]);
      return json(res, 201, { connection: listConnections([parsed.connection])[0] });
    }
    const match = /^\/api\/task-connections\/([a-z][a-z0-9-]{0,63})(\/test)?$/.exec(path);
    if (!match) return PASS;
    const current = deps.load();
    const existing = current.find(connection => connection.id === match[1]);
    if (!existing) return json(res, 404, { error: "No such task connection." });
    if (match[2] && method === "POST") return json(res, 200, await testConnection(existing, deps.fetchImpl));
    if (match[2]) return json(res, 405, { error: "Method not allowed." });
    if (method === "DELETE") {
      deps.save(current.filter(connection => connection.id !== existing.id));
      return json(res, 200, { ok: true });
    }
    if (method === "PATCH") {
      const body = await readBody(req) as Partial<TaskConnectionMutation>;
      const parsed = parseConnectionMutation({ ...existing, ...body, secrets: body.secrets ?? Object.fromEntries(Object.keys(existing.secrets).map(key => [key, true])) }, existing);
      if (!parsed.ok) return json(res, 400, { error: parsed.error });
      if (parsed.connection.id !== existing.id) return json(res, 400, { error: "Connection id cannot change." });
      if (!connectorById(parsed.connection.connectorId)) return json(res, 400, { error: "Unknown connector." });
      deps.save(current.map(connection => connection.id === existing.id ? parsed.connection : connection));
      return json(res, 200, { connection: listConnections([parsed.connection])[0] });
    }
    return json(res, 405, { error: "Method not allowed." });
  };
}
