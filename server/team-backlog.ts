import { createHash } from "node:crypto";
import { connectionForSection, queryConnection } from "./task-connections.ts";
import { connectorById } from "./connectors/registry.ts";
import { connectionContext } from "./task-connections.ts";
import type { StoredConnection } from "./connectors/types.ts";
import type { GroupRecord } from "./store.ts";
import { sectionKey } from "./store.ts";
import type { WorkRecord } from "./work-items.ts";
import { sourceIdentity, type SyncedItem } from "../shared/work-links.ts";
import type { Watch } from "../shared/watches.ts";
import {
  backlogReadyToRun,
  type BacklogGate, type BacklogScope, type BacklogTarget, type MissionKind, type TeamBacklog,
} from "../shared/team-backlog.ts";
import { emptyTeamBacklog } from "../shared/team-backlog.ts";
import { redactSecretsInText } from "./redact.ts";
import {
  asMissionKind,
  connectorDisplayName,
  connectorIdsOf,
  isKnownConnectorId,
  isQueryCapableConnector,
  scopeKinds,
  stampScopes,
} from "./team-work-kits.ts";

const MAX_PAGES = 1_000;
const MAX_TARGETS = 10_000;
const PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/i;
const GITLAB_PROJECT = /^(?:[\w.-]+\/)+[\w.-]+$/;
const unfinished = (item: { state?: { category: string } }) => !["done", "cancelled"].includes(item.state?.category ?? "unknown");
const scopeId = (connectionId: string, query: string) =>
  `scope:${createHash("sha256").update(JSON.stringify([connectionId, query])).digest("hex").slice(0, 20)}`;

function jiraProjectQuery(projects: readonly string[]): string {
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

function projectsFromScopeQuery(query: string): string[] | null {
  return jiraProjectsFromBoard(query) ?? (PROJECT_KEY.test(query.trim()) ? [query.trim().toUpperCase()] : null);
}

function queryUsable(connectorId: string, query: string): boolean {
  if (!query.trim()) return false;
  if (connectorId === "gitlab") return GITLAB_PROJECT.test(query.trim());
  return true;
}

function queryFromSettings(connection: StoredConnection): string {
  const project = String(connection.settings.project ?? "").trim();
  if (connection.connectorId === "jira") return PROJECT_KEY.test(project) ? jiraProjectQuery([project.toUpperCase()]) : "";
  return project;
}

function queryCapable(connection: StoredConnection): boolean {
  return connection.enabled && isQueryCapableConnector(connection.connectorId) && isKnownConnectorId(connection.connectorId);
}

/** A source change may wake this team mission without widening it to every
 * project on a shared connection. The next full scan still owns inventory truth. */
export function backlogScopeContains(scope: BacklogScope, item: SyncedItem): boolean {
  if (scope.connectionId !== item.connectionId || scope.connectorId !== item.connectorId || !item.externalId) return false;
  const kinds = scopeKinds(scope);
  if (item.kind && !kinds.includes(item.kind as MissionKind)) return false;
  if (GITLAB_PROJECT.test(scope.query)) {
    return item.externalId.startsWith(`${scope.query}!`) || item.externalId.startsWith(`${scope.query}#`);
  }
  const key = /^([A-Z][A-Z0-9_]*)-\d+(?=$|:)/i.exec(item.externalId)?.[1];
  return Boolean(key && projectsFromScopeQuery(scope.query)?.includes(key.toUpperCase()));
}

function projectFromLinkedId(connectorId: string, externalId: string): string {
  if (connectorId === "gitlab" || GITLAB_PROJECT.test(externalId.split(/[#!]/)[0] ?? "")) {
    return /^(.+)[#!]\d+$/.exec(externalId)?.[1] ?? "";
  }
  const project = /^([A-Z][A-Z0-9_]*)-\d+$/i.exec(externalId);
  if (!project) return "";
  return connectorId === "jira" ? jiraProjectQuery([project[1].toUpperCase()]) : project[1].toUpperCase();
}

/** A board is the team's tracker source of truth. Global connections only fill
 * gaps when there is no team-owned board, watch, or linked work. */
export function inferTeamBacklog(input: {
  section: string;
  ownerBotId: string;
  groups: readonly GroupRecord[];
  watches: readonly Watch[];
  connections: readonly StoredConnection[];
  work: readonly WorkRecord[];
}): TeamBacklog {
  const section = sectionKey(input.section);
  const result = emptyTeamBacklog(section);
  const groups = input.groups.filter(group => !group.dm && sectionKey(group.section) === section && group.memberIds.includes(input.ownerBotId));
  const boardGroup = groups.find(group => group.taskBoard);
  const add = (list: BacklogScope[], connectorId: string, connectionId: string, query: string, label: string, groupId?: string) => {
    const connection = connectionForSection([...input.connections], section, connectionId);
    if (!connection || connection.connectorId !== connectorId || !queryCapable(connection) || !queryUsable(connectorId, query)) return;
    const id = scopeId(connectionId, query.trim());
    if (!list.some(scope => scope.id === id)) {
      list.push({
        id, connectorId, connectionId, query: query.trim(),
        label: redactSecretsInText(label).slice(0, 300),
        ...(groupId ? { groupId } : {}),
      });
    }
  };
  const owned: BacklogScope[] = [];
  let uncertainBoard = false;
  for (const group of groups) {
    const board = group.taskBoard;
    if (!board) continue;
    const connection = connectionForSection([...input.connections], section, board.connectionId);
    if (!connection || !queryCapable(connection)) continue;
    const name = connectorDisplayName(connection.connectorId);
    if (connection.connectorId === "jira") {
      const projects = jiraProjectsFromBoard(board.query);
      if (projects?.length) add(owned, connection.connectorId, board.connectionId, jiraProjectQuery(projects),
        `${group.name} ${name} projects`, group.id);
      else uncertainBoard = true;
    } else if (queryUsable(connection.connectorId, board.query)) {
      add(owned, connection.connectorId, board.connectionId, board.query, `${group.name} ${name} board`, group.id);
    } else uncertainBoard = true;
  }
  const hasJiraBoard = owned.some(scope => scope.connectorId === "jira");
  for (const watch of input.watches) {
    if (!watch.enabled || sectionKey(watch.section) !== section || watch.source.type !== "connection") continue;
    const connection = connectionForSection([...input.connections], section, watch.source.connectionId);
    if (!connection || !queryCapable(connection)) continue;
    const name = connectorDisplayName(connection.connectorId);
    const project = typeof watch.source.scope?.project === "string" ? watch.source.scope.project.trim() : "";
    const query = typeof watch.source.scope?.query === "string" ? watch.source.scope.query.trim() : "";
    if (connection.connectorId === "jira") {
      if (hasJiraBoard) continue;
      const projects = query ? jiraProjectsFromBoard(query) : PROJECT_KEY.test(project) ? [project.toUpperCase()] : null;
      add(owned, "jira", connection.id, projects?.length ? jiraProjectQuery(projects) : "",
        `${watch.name} ${name} watch`, boardGroup?.id);
      continue;
    }
    if (connection.connectorId === "gitlab") {
      add(owned, "gitlab", connection.id, project || String(connection.settings.project ?? ""),
        `${watch.name} ${name} repository`, boardGroup?.id);
      continue;
    }
    add(owned, connection.connectorId, connection.id, project || query || queryFromSettings(connection),
      `${watch.name} ${name} watch`, boardGroup?.id);
  }
  const configured = new Set(owned.map(scope => scope.connectorId));
  for (const item of input.work) {
    if (item.scope !== section || !groups.some(group => group.id === item.groupId)) continue;
    const parts = /^([^:]+):([^:]+):(.+)$/.exec(item.identity);
    if (!parts) continue;
    const connectorId = parts[1];
    const connectionId = parts[2];
    if (connectorId === "jira" && configured.has("jira")) continue;
    const extracted = projectFromLinkedId(connectorId, parts[3]);
    if (!extracted) continue;
    const name = connectorDisplayName(connectorId);
    add(owned, connectorId, connectionId, extracted, `Linked ${name} ${extracted}`, item.groupId);
  }
  const available = input.connections.filter(connection =>
    connectionForSection([...input.connections], section, connection.id) && queryCapable(connection));
  const candidates: BacklogScope[] = [];
  const missingOwned = [...new Set(available.map(connection => connection.connectorId))]
    .filter(connectorId => !owned.some(scope => scope.connectorId === connectorId));
  for (const connectorId of missingOwned) {
    const built: BacklogScope[] = [];
    for (const connection of available.filter(value => value.connectorId === connectorId)) {
      const name = connectorDisplayName(connectorId);
      add(built, connectorId, connection.id, queryFromSettings(connection),
        `${connection.label} ${name}`, boardGroup?.id);
    }
    const scoped = built.filter(candidate =>
      input.connections.find(connection => connection.id === candidate.connectionId)?.sections.includes(section));
    if (scoped.length) owned.push(...scoped);
    else candidates.push(...built);
  }
  if (candidates.length || uncertainBoard && owned.length) {
    result.choices = [...owned, ...candidates];
  }
  result.scopes = [...owned];
  const mix = [...new Set(available.map(connection => connection.connectorId))];
  result.scopes = stampScopes(result.scopes, mix.length ? mix : connectorIdsOf(result.scopes));
  result.choices = stampScopes(result.choices, mix.length ? mix : connectorIdsOf(result.choices));
  if (result.choices.length || result.scopes.length < 1) {
    const names = [...new Set([...result.scopes, ...result.choices].map(scope => connectorDisplayName(scope.connectorId)))];
    result.gates = [{
      kind: "scope",
      decisionMaker: "Conversation requester or workspace admin",
      detail: `${uncertainBoard ? `The board query does not identify a project${owned.some(scope => scope.connectorId === "jira") ? "; confirm the listed project scope" : ""}. ` : ""}${
        result.scopes.length < 1 && !result.choices.length
          ? "Configure a team-owned query-capable connection. No external inventory has been claimed."
          : result.choices.length
            ? `Select the applicable inventory scopes: ${result.choices.map(choice => choice.label).join(", ")}.`
            : "No external inventory has been claimed."}${
        names.length ? ` Available connectors: ${names.join(", ")}.` : ""}`,
    }];
  }
  return result;
}

function targetFrom(item: SyncedItem): BacklogTarget | null {
  const identity = sourceIdentity(item);
  const kind = item.kind ? asMissionKind(item.kind) : undefined;
  if (!identity || !item.externalId || !item.connectionId || !item.connectorId || !kind || !isKnownConnectorId(item.connectorId)) {
    return null;
  }
  const details = item.details;
  const blockers = typeof details?.blockers === "string" ? details.blockers.split(",").map(value => value.trim()).filter(Boolean).slice(0, 20) : [];
  const headSha = typeof details?.sha === "string" && /^[0-9a-f]{40}$/i.test(details.sha) ? details.sha.toLowerCase() : undefined;
  const observedResult = item.state?.category === "done"
    ? kind === "change_request"
      ? `Observed merged commit ${typeof details?.mergeCommitSha === "string" ? details.mergeCommitSha : "not supplied"}`
      : "Observed done status"
    : undefined;
  return {
    identity, connectorId: item.connectorId, connectionId: item.connectionId, externalId: item.externalId,
    kind, title: redactSecretsInText(item.title).slice(0, 300),
    state: item.state?.category ?? "unknown", label: redactSecretsInText(item.state?.label ?? "Unknown").slice(0, 80),
    updatedAt: item.updatedAt, observedAt: Date.now(),
    ...(typeof details?.description === "string" ? { requirements: redactSecretsInText(details.description).slice(0, 500) } : {}),
    ...(typeof details?.priority === "string" ? { priority: redactSecretsInText(details.priority).slice(0, 80) } : {}),
    ...(blockers.length ? { blockers } : {}), ...(headSha ? { headSha } : {}),
    ...(observedResult ? { result: observedResult } : {}),
  };
}

/** A scan is atomic from the mission's perspective: any error retains the
 * previous inventory and its last successful timestamp. Missing known work
 * is fetched strictly, since disappearing from an open query is not proof of
 * completion (especially for an MR closed without merging). */
export async function scanTeamBacklog(backlog: TeamBacklog, connections: StoredConnection[], fetchImpl?: typeof fetch): Promise<TeamBacklog> {
  const at = Date.now();
  const previous = new Map(backlog.targets.map(target => [target.identity, target]));
  const targets = new Map<string, BacklogTarget>();
  const errors: string[] = [];
  for (const scope of backlog.scopes) {
    const connection = connectionForSection(connections, backlog.section, scope.connectionId);
    if (!connection || connection.connectorId !== scope.connectorId || !isKnownConnectorId(scope.connectorId) || !queryCapable(connection)) {
      errors.push(`${scope.label}: the connection is unavailable to this team`);
      continue;
    }
    const kinds = scopeKinds(scope);
    try {
      if (scope.connectorId === "gitlab" && !GITLAB_PROJECT.test(scope.query)) {
        throw new Error("The repository scope is not a complete GitLab project path");
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const response = await queryConnection(connection, scope.query, cursor, fetchImpl);
        for (const item of response.items) {
          const kind = item.kind ? asMissionKind(item.kind) : undefined;
          if (!kind || !kinds.includes(kind)) continue;
          if (!backlogScopeContains({ ...scope, kinds }, item)) throw new Error("A source item fell outside the requested project scope");
          const target = targetFrom(item);
          if (!target) throw new Error("A source item had no stable external identity");
          if (unfinished(item) || previous.has(target.identity)) {
            const old = previous.get(target.identity);
            targets.set(target.identity, { ...target, ...(old?.taskId ? { taskId: old.taskId } : {}),
              ...(old?.dispatchedHeadSha ? { dispatchedHeadSha: old.dispatchedHeadSha } : {}),
              ...(old?.gateCheckedAt && old.state === target.state && old.headSha === target.headSha
                ? { gateCheckedAt: old.gateCheckedAt } : {}),
              ...(!target.result && old?.result && target.state === "done" ? { result: old.result } : {}) });
          }
          if (targets.size > MAX_TARGETS) throw new Error("Inventory exceeds the 10,000-task storage limit");
        }
        if (!response.cursor) break;
        if (seen.has(response.cursor) || page === MAX_PAGES - 1) throw new Error("Pagination did not finish");
        seen.add(response.cursor);
        cursor = response.cursor;
      }
    } catch (error) {
      errors.push(redactSecretsInText(`${scope.label}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 500));
    }
  }
  if (!errors.length) {
    for (const [identity, old] of previous) {
      if (targets.has(identity)) continue;
      const connection = connectionForSection(connections, backlog.section, old.connectionId);
      const connector = connection && connectorById(old.connectorId);
      if (!connection || !connector) { errors.push(`${identity}: connection disappeared`); continue; }
      try {
        const [item] = await connector.fetch(connectionContext(connection, fetchImpl), [{ kind: old.kind, externalId: old.externalId }]);
        if (!item?.state || item.externalId !== old.externalId) throw new Error("Unable to verify the current state");
        const target = targetFrom(item);
        if (!target) throw new Error("Unable to verify the external identity");
        targets.set(identity, { ...target, ...(old.taskId ? { taskId: old.taskId } : {}),
          ...(old.dispatchedHeadSha ? { dispatchedHeadSha: old.dispatchedHeadSha } : {}),
          ...(old.gateCheckedAt && old.state === target.state && old.headSha === target.headSha
            ? { gateCheckedAt: old.gateCheckedAt } : {}),
          ...(!target.result && old.result && target.state === "done" ? { result: old.result } : {}) });
      } catch (error) {
        errors.push(redactSecretsInText(`${identity}: ${error instanceof Error ? error.message : String(error)}`).slice(0, 500));
      }
      if (errors.length >= 200) break;
    }
  }
  if (errors.length) return { ...backlog, scan: { ...backlog.scan, status: "incomplete", attemptedAt: at, errors: errors.slice(0, 200) } };
  return { ...backlog, targets: [...targets.values()], scan: { status: "complete", attemptedAt: at,
    completedAt: Date.now(), itemCount: targets.size, errors: [] } };
}

export function backlogGate(kind: BacklogGate["kind"], detail: string, decisionMaker: string, identity?: string): BacklogGate {
  return { kind, detail: redactSecretsInText(detail).slice(0, 1000), decisionMaker,
    ...(identity ? { identity } : {}) };
}

export { backlogReadyToRun };
