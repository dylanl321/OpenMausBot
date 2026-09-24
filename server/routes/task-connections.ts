import { connectorById } from "../connectors/registry.ts";
import { connectionForSection, listConnections, manifests, parseConnectionMutation, queryConnection, testConnection, type TaskConnectionMutation } from "../task-connections.ts";
import type { StoredConnection } from "../connectors/types.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface TaskConnectionRoutes {
  load(): StoredConnection[];
  save(connections: StoredConnection[]): void;
  fetchImpl?: typeof fetch;
  sectionForGroup?(groupId: string): string | undefined;
}

export function createTaskConnectionRoutes(deps: TaskConnectionRoutes): RouteHandler {
  return async ({ req, res, url, path, method, json, readBody }) => {
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
    const match = /^\/api\/task-connections\/([a-z][a-z0-9-]{0,63})(\/test|\/query)?$/.exec(path);
    if (!match) return PASS;
    const current = deps.load();
    const existing = current.find(connection => connection.id === match[1]);
    if (!existing) return json(res, 404, { error: "No such task connection." });
    if (match[2] === "/test" && method === "POST") return json(res, 200, await testConnection(existing, deps.fetchImpl));
    if (match[2] === "/test") return json(res, 405, { error: "Method not allowed." });
    if (match[2] === "/query") {
      if (method !== "GET") return json(res, 405, { error: "Method not allowed." });
      const groupId = url.searchParams.get("groupId") ?? "";
      const section = groupId && deps.sectionForGroup ? deps.sectionForGroup(groupId) : "";
      if (section === undefined) return json(res, 404, { error: "No such channel." });
      if (!connectionForSection(current, section, existing.id)) return json(res, 404, { error: "No such task connection." });
      try {
        return json(res, 200, await queryConnection(existing, url.searchParams.get("query") ?? "", url.searchParams.get("cursor") ?? undefined, deps.fetchImpl));
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    }
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
