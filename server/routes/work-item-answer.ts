import { z } from "zod";
import type { WorkItem } from "../../shared/work-item.ts";
import type { RequestAuth } from "../request-auth.ts";
import { PASS, type RouteHandler } from "./table.ts";

const answerSchema = z.object({
  expectedRevision: z.number().int().positive(),
  text: z.string().trim().min(1).max(4000),
}).strict();

export function createWorkItemAnswerRoutes(deps: {
  item(id: string): (Pick<WorkItem, "status" | "groupId" | "threadId" | "coordinatorBotId"> & { revision: number }) | undefined;
  canSee(auth: RequestAuth, item: Pick<WorkItem, "groupId" | "threadId" | "coordinatorBotId">): boolean;
  answer(id: string, input: { expectedRevision: number; text: string }): { workItem: WorkItem };
}): RouteHandler {
  return async ({ req, res, path, method, auth, json, readBody }) => {
    const match = /^\/api\/work-items\/([\w-]+)\/answer$/.exec(path);
    if (!match) return PASS;
    if (method !== "POST") return json(res, 405, { error: "Method not allowed." });
    const item = deps.item(match[1]);
    if (!item || !deps.canSee(auth, item)) return json(res, 404, { error: "No such shared task" });
    if (item.status !== "needs-input") return json(res, 400, { error: "This task is not waiting for your input." });
    const parsed = answerSchema.safeParse(await readBody(req));
    if (!parsed.success) return json(res, 400, { error: parsed.error.issues[0]?.message ?? "Answer the question in plain text." });
    try {
      return json(res, 200, deps.answer(match[1], parsed.data));
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}
