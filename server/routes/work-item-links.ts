import type { WorkItem } from "../../shared/work-item.ts";
import type { LinkedItem } from "../../shared/work-links.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createWorkItemLinkRoutes(deps: {
  item(id: string): Pick<WorkItem, "groupId" | "threadId" | "coordinatorBotId"> | undefined;
  canSee(auth: RequestAuth, item: Pick<WorkItem, "groupId" | "threadId" | "coordinatorBotId">): boolean;
  link(id: string, raw: unknown): LinkedItem;
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/work-items\/([\w-]+)\/links$/.exec(path);
    if (!match) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Method not allowed." });
    const item = deps.item(match[1]);
    if (!item || !deps.canSee(auth, item)) return json(res, 404, { error: "No such shared task" });
    try {
      return json(res, 200, { link: deps.link(match[1], await readBody(req)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json(res, 400, { error: message });
    }
  };
}
