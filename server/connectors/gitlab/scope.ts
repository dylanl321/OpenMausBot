import type { ConnectorMissionScope, MissionWatchScope } from "../types.ts";

export const GITLAB_PROJECT = /^(?:[\w.-]+\/)+[\w.-]+$/;

function queryUsable(query: string): boolean {
  return GITLAB_PROJECT.test(query.trim());
}

function fromWatch(input: {
  scope?: Record<string, string | number | boolean | undefined>;
  settings: Record<string, string | number | boolean>;
  hasBoard: boolean;
}): MissionWatchScope {
  const project = typeof input.scope?.project === "string" ? input.scope.project.trim() : "";
  return { query: project || String(input.settings.project ?? "") };
}

function fromLinkedId(externalId: string): string {
  return /^(.+)[#!]\d+$/.exec(externalId)?.[1] ?? "";
}

function contains(query: string, item: { externalId?: string }): boolean {
  const id = item.externalId ?? "";
  return id.startsWith(`${query}!`) || id.startsWith(`${query}#`);
}

export const gitlabMissionScope: ConnectorMissionScope = {
  queryUsable,
  queryError: "The repository scope is not a complete project path",
  fromWatch,
  fromLinkedId,
  contains,
  watchNoun: "repository",
};
