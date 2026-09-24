import type { LinkKind, LinkedItem, Provenance, StatusCategory, SyncedItem } from "../../shared/work-links.ts";
import type { SourceChange, SourceChangeType, WatchScope } from "../../shared/watches.ts";

export type { SourceChange, SourceChangeType, SyncedItem, WatchScope };

export interface SettingField {
  key: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  enum?: string[];
  help?: string;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  icon?: string;
  kinds: LinkKind[];
  settings: SettingField[];
  secrets: { key: string; label: string; help?: string }[];
  capabilities: { webhooks?: boolean; query?: boolean; poll?: boolean };
  statusDefaults?: Record<string, StatusCategory>;
  watch?: { scopes: SettingField[]; events: SourceChangeType[] };
}

export interface ConnectionContext {
  connectionId: string;
  settings: Record<string, string | number | boolean>;
  /** Throws when the key was not declared on the manifest. */
  secret(key: string): string | undefined;
  fetch: typeof fetch;
  log: (message: string) => void;
}

export interface CaptureCall {
  title: string;
  summary?: string;
  input?: string;
  output?: string;
  server?: string;
  ok?: boolean;
}

export interface CaptureRule {
  match: { tool?: RegExp; server?: RegExp; command?: RegExp };
  on: "completed";
  requireOk?: boolean;
  produce: { kind: LinkKind };
  eventKind?: "output" | "comment" | "state_change";
  extract: (call: CaptureCall) => { externalId: string; url?: string; title?: string; parentRef?: string; details?: Record<string, string | number | boolean> } | null;
  event: (item: { externalId?: string; title: string; url?: string; details?: Record<string, string | number | boolean> }) => string;
}

export interface Connector {
  manifest: ConnectorManifest;
  test(ctx: ConnectionContext): Promise<{ ok: true; account: string } | { ok: false; error: string }>;
  parseRef(input: string, ctx: ConnectionContext): { kind: LinkKind; externalId: string } | null;
  urlPatterns(ctx: ConnectionContext): RegExp[];
  fetch(ctx: ConnectionContext, refs: { kind: LinkKind; externalId: string }[]): Promise<SyncedItem[]>;
  query?(ctx: ConnectionContext, query: string, cursor?: string): Promise<{ items: SyncedItem[]; cursor?: string }>;
  webhook?(ctx: ConnectionContext, headers: Headers, body: unknown): Promise<{ kind: LinkKind; externalId: string }[]>;
  /** Change feed for watches. Cheap and idempotent: the same cursor returns the same changes. */
  changes?(ctx: ConnectionContext, scope: WatchScope, cursor: string | null): Promise<{ changes: SourceChange[]; cursor: string }>;
  capture: CaptureRule[];
}

export type StoredConnection = {
  id: string;
  connectorId: string;
  label: string;
  settings: Record<string, string | number | boolean>;
  secrets: Record<string, string>;
  /** Empty means every section. Otherwise sectionKey values. */
  sections: string[];
  enabled: boolean;
};

export type ConnectionListing = Omit<StoredConnection, "secrets"> & { secretKeys: string[] };

export function linkId(connectionId: string | undefined, kind: LinkKind, externalId: string): string {
  return `${connectionId ?? "local"}:${kind}:${externalId}`;
}

export function observedLink(input: {
  id: string;
  kind: LinkKind;
  title: string;
  externalId?: string;
  url?: string;
  connectorId?: string;
  connectionId?: string;
  parentId?: string;
  details?: LinkedItem["details"];
  state?: LinkedItem["state"];
  role?: LinkedItem["role"];
  provenance?: Provenance;
  syncedAt?: number;
  at: number;
}): LinkedItem {
  return {
    id: input.id,
    kind: input.kind,
    role: input.role ?? "output",
    title: input.title,
    provenance: input.provenance ?? "observed",
    updatedAt: input.at,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.state ? { state: input.state } : {}),
    ...(input.syncedAt ? { syncedAt: input.syncedAt } : {}),
  };
}
