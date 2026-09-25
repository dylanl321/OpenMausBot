import type { LinkKind } from "../shared/work-links.ts";
import { MISSION_KINDS, type BacklogScope, type MissionKind } from "../shared/team-backlog.ts";
import { connectorById } from "./connectors/registry.ts";
import type { ConnectorManifest } from "./connectors/types.ts";

export type KitRole = "tracker" | "code" | "other";

export interface TeamWorkKitRole {
  role: KitRole;
  connectorId?: string;
  kinds: MissionKind[];
  optional?: boolean;
}

export interface TeamWorkKit {
  id: string;
  name: string;
  connectors: TeamWorkKitRole[];
}

/** Default mission kinds: the connector's kinds ∩ { work_item, change_request }. */
export function defaultMissionKinds(manifest: Pick<ConnectorManifest, "kinds">): MissionKind[] {
  const allowed = new Set<string>(MISSION_KINDS);
  return manifest.kinds.filter((kind): kind is MissionKind => allowed.has(kind));
}

/**
 * Today's Jira-tracker + GitLab-MR shape. Existing mixed teams keep dropping
 * GitLab issues until they opt into the gitlab kit or add work_item.
 * Extra approval-rule names are connection settings, not compiled into this
 * kit. A jira-gitlab org that still wants named extras documents them on the
 * GitLab connection (`requiredApprovalRules`), not here.
 */
export const JIRA_GITLAB_KIT: TeamWorkKit = {
  id: "jira-gitlab",
  name: "Jira + GitLab",
  connectors: [
    { role: "tracker", connectorId: "jira", kinds: ["work_item"] },
    { role: "code", connectorId: "gitlab", kinds: ["change_request"] },
  ],
};

export const GITLAB_KIT: TeamWorkKit = {
  id: "gitlab",
  name: "GitLab",
  connectors: [
    { role: "tracker", connectorId: "gitlab", kinds: ["work_item"] },
    { role: "code", connectorId: "gitlab", kinds: ["change_request"] },
  ],
};

export const JIRA_KIT: TeamWorkKit = {
  id: "jira",
  name: "Jira",
  connectors: [{ role: "tracker", connectorId: "jira", kinds: ["work_item"] }],
};

export const PLANE_KIT: TeamWorkKit = {
  id: "plane",
  name: "Plane",
  connectors: [{ role: "tracker", connectorId: "plane", kinds: ["work_item"] }],
};

export const TEAM_WORK_KITS: TeamWorkKit[] = [JIRA_GITLAB_KIT, GITLAB_KIT, JIRA_KIT, PLANE_KIT];

export function connectorIdsOf(scopes: readonly Pick<BacklogScope, "connectorId">[]): string[] {
  return [...new Set(scopes.map(scope => scope.connectorId))];
}

/** Pin a branded kit when the connector set is an exact known shape. */
export function matchTeamWorkKit(connectorIds: readonly string[]): TeamWorkKit | undefined {
  const set = new Set(connectorIds);
  if (set.has("jira") && set.has("gitlab")) return JIRA_GITLAB_KIT;
  if (set.size === 1 && set.has("gitlab")) return GITLAB_KIT;
  if (set.size === 1 && set.has("jira")) return JIRA_KIT;
  if (set.size === 1 && set.has("plane")) return PLANE_KIT;
  return undefined;
}

export function kitKindsForConnector(kit: TeamWorkKit, connectorId: string): MissionKind[] {
  const kinds = [...new Set(kit.connectors
    .filter(role => !role.connectorId || role.connectorId === connectorId)
    .flatMap(role => role.kinds))];
  return MISSION_KINDS.filter(kind => kinds.includes(kind));
}

/**
 * Stored scopes without kinds keep the jira-gitlab defaults so a pull does
 * not suddenly inventory GitLab issues.
 */
export function missingKindsFallback(connectorId: string): MissionKind[] {
  const fromKit = kitKindsForConnector(JIRA_GITLAB_KIT, connectorId);
  if (fromKit.length) return fromKit;
  const manifest = connectorById(connectorId)?.manifest;
  return manifest ? defaultMissionKinds(manifest) : ["work_item"];
}

export function kindsForConnector(connectorId: string, mix: readonly string[]): MissionKind[] {
  const kit = matchTeamWorkKit(mix);
  if (kit) {
    const kinds = kitKindsForConnector(kit, connectorId);
    if (kinds.length) return kinds;
  }
  const manifest = connectorById(connectorId)?.manifest;
  return manifest ? defaultMissionKinds(manifest) : missingKindsFallback(connectorId);
}

export function scopeKinds(scope: Pick<BacklogScope, "connectorId" | "kinds">): MissionKind[] {
  return scope.kinds?.length ? scope.kinds : missingKindsFallback(scope.connectorId);
}

export function stampScopeKinds<T extends BacklogScope>(scope: T, mix: readonly string[]): T {
  return { ...scope, kinds: kindsForConnector(scope.connectorId, mix) };
}

export function stampScopes<T extends BacklogScope>(scopes: readonly T[], mix?: readonly string[]): T[] {
  const ids = mix ?? connectorIdsOf(scopes);
  return scopes.map(scope => stampScopeKinds(scope, ids));
}

export function isQueryCapableConnector(connectorId: string): boolean {
  const connector = connectorById(connectorId);
  return Boolean(connector?.manifest.capabilities.query && connector.query);
}

export function connectorDisplayName(connectorId: string): string {
  return connectorById(connectorId)?.manifest.name ?? connectorId;
}

export function isKnownConnectorId(connectorId: string): boolean {
  return Boolean(connectorById(connectorId));
}

export function asMissionKind(kind: LinkKind): MissionKind | undefined {
  return kind === "work_item" || kind === "change_request" ? kind : undefined;
}
