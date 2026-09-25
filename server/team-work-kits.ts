import { z } from "zod";
import { criteriaFromKinds, MISSION_KINDS, missionKindSchema, type BacklogScope, type MissionKind } from "../shared/team-backlog.ts";
import { SOURCE_CHANGE_TYPES } from "../shared/watches.ts";
import type { LinkKind } from "../shared/work-links.ts";
import { connectorById } from "./connectors/registry.ts";
import type { ConnectorManifest } from "./connectors/types.ts";
import kitCatalog from "./team-work-kits.json" with { type: "json" };

export type KitRole = "tracker" | "code" | "other";

export interface TeamWorkKitRole {
  role: KitRole;
  connectorId?: string;
  kinds: MissionKind[];
  optional?: boolean;
}

export interface TeamWorkKitWatch {
  name: string;
  events: Array<(typeof SOURCE_CHANGE_TYPES)[number]>;
  scopeFrom: "connection";
}

export interface TeamWorkKit {
  id: string;
  name: string;
  connectors: TeamWorkKitRole[];
  /** Optional extras on top of live required rules. Shipped kits omit this;
   * operators set names on the connection (`requiredApprovalRules`). */
  approval?: { extraRuleNames?: string[] };
  /** Suggested watches. Kits do not create watches or embed provider HTTP. */
  watches?: TeamWorkKitWatch[];
}

const kitRoleSchema = z.object({
  role: z.enum(["tracker", "code", "other"]),
  connectorId: z.string().min(1).max(64).optional(),
  kinds: z.array(missionKindSchema).min(1).max(8),
  optional: z.boolean().optional(),
}).strict();

const kitWatchSchema = z.object({
  name: z.string().min(1).max(80),
  events: z.array(z.enum(SOURCE_CHANGE_TYPES)).min(1),
  scopeFrom: z.literal("connection"),
}).strict();

export const teamWorkKitSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  connectors: z.array(kitRoleSchema).min(1).max(8),
  approval: z.object({
    extraRuleNames: z.array(z.string().min(1).max(80)).max(20).optional(),
  }).strict().optional(),
  watches: z.array(kitWatchSchema).max(20).optional(),
}).strict();

export const teamWorkKitCatalogSchema = z.object({
  kits: z.array(teamWorkKitSchema).min(1).max(32),
}).strict();

export function parseTeamWorkKits(input: unknown): TeamWorkKit[] {
  return teamWorkKitCatalogSchema.parse(input).kits;
}

/** Default mission kinds: the connector's kinds ∩ { work_item, change_request }. */
export function defaultMissionKinds(manifest: Pick<ConnectorManifest, "kinds">): MissionKind[] {
  const allowed = new Set<string>(MISSION_KINDS);
  return manifest.kinds.filter((kind): kind is MissionKind => allowed.has(kind));
}

export const TEAM_WORK_KITS: TeamWorkKit[] = parseTeamWorkKits(kitCatalog);

export function kitById(id: string): TeamWorkKit | undefined {
  return TEAM_WORK_KITS.find(kit => kit.id === id);
}

export const JIRA_GITLAB_KIT = kitById("jira-gitlab")!;
export const GITLAB_KIT = kitById("gitlab")!;
export const JIRA_KIT = kitById("jira")!;
export const PLANE_KIT = kitById("plane")!;

export function connectorIdsOf(scopes: readonly Pick<BacklogScope, "connectorId">[]): string[] {
  return [...new Set(scopes.map(scope => scope.connectorId))];
}

/** Required pinned connector ids for a branded kit, sorted. Optional or
 * unpinned roles do not constrain the mix. */
export function pinnedConnectorIds(kit: TeamWorkKit): string[] {
  return [...new Set(kit.connectors
    .filter(role => role.connectorId && !role.optional)
    .map(role => role.connectorId!))].sort();
}

/** Exact pinned-id match against a catalog. Unrecognized mixes return
 * undefined so infer can use manifests. Duplicate matches fail closed. */
export function matchKitFromCatalog(
  kits: readonly TeamWorkKit[],
  connectorIds: readonly string[],
): TeamWorkKit | undefined {
  const mix = [...new Set(connectorIds)].sort();
  if (!mix.length) return undefined;
  const matches = kits.filter(kit => {
    const pinned = pinnedConnectorIds(kit);
    return pinned.length === mix.length && pinned.every((id, index) => id === mix[index]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pin a branded kit when the connector set is an exact known shape. */
export function matchTeamWorkKit(connectorIds: readonly string[]): TeamWorkKit | undefined {
  return matchKitFromCatalog(TEAM_WORK_KITS, connectorIds);
}

export function kitKindsForConnector(kit: TeamWorkKit, connectorId: string): MissionKind[] {
  const kinds = [...new Set(kit.connectors
    .filter(role => !role.connectorId || role.connectorId === connectorId)
    .flatMap(role => role.kinds))];
  return MISSION_KINDS.filter(kind => kinds.includes(kind));
}

export function kitCriteria(kit: TeamWorkKit): string[] {
  return criteriaFromKinds([...new Set(kit.connectors.flatMap(role => role.kinds))]);
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
