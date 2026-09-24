import type { WorkItem } from "../../shared/work-item.ts";
import type { TaskEvent } from "../../shared/work-links.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createWorkEventRoutes(deps: {
  item(id: string): Pick<WorkItem, "groupId" | "threadId" | "coordinatorBotId"> | undefined;
  events(id: string): TaskEvent[];
  canSee(auth: RequestAuth, item: Pick<WorkItem, "groupId" | "threadId" | "coordinatorBotId">): boolean;
}): RouteHandler {
  return async ({ res, path, method, url, auth, json }) => {
    const match = /^\/api\/work-items\/([\w-]+)\/events$/.exec(path);
    if (!match) return PASS;
    if (method !== "GET") return json(res, 405, { error: "Method not allowed." });
    const item = deps.item(match[1]);
    if (!item || !deps.canSee(auth, item)) return json(res, 404, { error: "No such shared task" });
    const events = deps.events(match[1]);
    const cursor = url.searchParams.get("cursor");
    const start = cursor ? events.findIndex(event => event.id === cursor) + 1 : 0;
    if (cursor && start === 0) return json(res, 200, { events: [], cursor });
    return json(res, 200, { events: events.slice(Math.max(0, start)) });
  };
}
