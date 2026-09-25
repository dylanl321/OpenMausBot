import type { ConnectorMissionScope, MissionBoardScope, MissionWatchScope } from "../types.ts";

const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/i;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]*)-\d+(?=$|:)/i;

export function jiraProjectQuery(projects: readonly string[]): string {
  const project = projects.length === 1 ? `project = ${projects[0]}` : `project in (${projects.join(", ")})`;
  return `${project} AND statusCategory != Done`;
}

/** The board can be filtered to today's sprint or one assignee. Its project
 * clause identifies the team's projects; those other filters must not hide
 * unfinished issues. Complex JQL is a scope gate, not a narrow inventory. */
export function jiraProjectsFromBoard(query: string): string[] | null {
  if (/\b(?:OR|NOT)\b/i.test(query) || [...query.matchAll(/\bproject\b/gi)].length !== 1) return null;
  const single = /\bproject\s*=\s*(?:"([A-Z][A-Z0-9_]*)"|([A-Z][A-Z0-9_]*))(?=\W|$)/i.exec(query);
  if (single) return [(single[1] ?? single[2]).toUpperCase()];
  const list = /\bproject\s+in\s*\(([^)]+)\)/i.exec(query);
  if (!list) return null;
  const projects = list[1].split(",").map(value => value.trim().replace(/^"|"$/g, "").toUpperCase());
  return projects.length > 0 && projects.length <= 20 && projects.every(value => PROJECT_KEY.test(value))
    ? [...new Set(projects)] : null;
}

function projectsFromQuery(query: string): string[] | null {
  return jiraProjectsFromBoard(query) ?? (PROJECT_KEY.test(query.trim()) ? [query.trim().toUpperCase()] : null);
}

function fromBoard(query: string): MissionBoardScope {
  const projects = jiraProjectsFromBoard(query);
  return projects?.length ? { query: jiraProjectQuery(projects) } : { uncertain: true };
}

function fromWatch(input: {
  scope?: Record<string, string | number | boolean | undefined>;
  settings: Record<string, string | number | boolean>;
  hasBoard: boolean;
}): MissionWatchScope {
  if (input.hasBoard) return { skip: true }; // team board already owns this tracker
  const project = typeof input.scope?.project === "string" ? input.scope.project.trim() : "";
  const query = typeof input.scope?.query === "string" ? input.scope.query.trim() : "";
  const projects = query ? jiraProjectsFromBoard(query) : PROJECT_KEY.test(project) ? [project.toUpperCase()] : null;
  return { query: projects?.length ? jiraProjectQuery(projects) : "" };
}

function queryFromSettings(settings: Record<string, string | number | boolean>): string {
  const project = String(settings.project ?? "").trim();
  return PROJECT_KEY.test(project) ? jiraProjectQuery([project.toUpperCase()]) : "";
}

function fromLinkedId(externalId: string): string {
  const project = /^([A-Z][A-Z0-9_]*)-\d+$/i.exec(externalId);
  return project ? jiraProjectQuery([project[1].toUpperCase()]) : "";
}

function contains(query: string, item: { externalId?: string }): boolean {
  const key = ISSUE_KEY.exec(item.externalId ?? "")?.[1];
  return Boolean(key && projectsFromQuery(query)?.includes(key.toUpperCase()));
}

export const jiraMissionScope: ConnectorMissionScope = {
  queryFromSettings,
  fromBoard,
  fromWatch,
  fromLinkedId,
  skipLinkedWhenConfigured: true,
  contains,
  boardNoun: "projects",
};
