import { z } from "zod";
import type { LinkKind, SyncedItem } from "../shared/work-links.ts";
import { connectorById, CONNECTORS } from "./connectors/registry.ts";
import { linkId, MISSION_ACTION_IDS, observedLink, type ConnectionContext, type ConnectionListing, type StoredConnection } from "./connectors/types.ts";

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const settingValue = z.union([z.string().max(2_000), z.number().finite(), z.boolean()]);
const connectionWritesSchema = z.object({
  enabled: z.boolean().optional(),
  allow: z.array(z.enum(MISSION_ACTION_IDS)).max(MISSION_ACTION_IDS.length).optional(),
}).strict();

const storedSchema = z.object({
  id: idSchema,
  connectorId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  settings: z.record(z.string(), settingValue).default({}),
  secrets: z.record(z.string(), z.string().max(16_000)).default({}),
  sections: z.array(z.string().max(200)).max(50).default([]),
  enabled: z.boolean().default(true),
  writes: connectionWritesSchema.optional(),
}).strict();

const mutationSchema = storedSchema.extend({
  secrets: z.record(z.string(), z.union([z.string().max(16_000), z.literal(true)])).default({}),
}).strict();

export type TaskConnectionMutation = z.infer<typeof mutationSchema>;

export function parseStoredConnections(raw: unknown): StoredConnection[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    const parsed = storedSchema.safeParse(entry);
    if (parsed.success && connectorById(parsed.data.connectorId)) return [parsed.data];
    // Invalid writes stay fail-closed (omitted = off) without dropping the
    // rest of a readable connection. Other schema failures still drop the row.
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Object.hasOwn(entry, "writes")) return [];
    const rest = { ...(entry as Record<string, unknown>) };
    delete rest.writes;
    const fallback = storedSchema.safeParse(rest);
    return fallback.success && connectorById(fallback.data.connectorId) ? [fallback.data] : [];
  });
}

export function listConnections(raw: unknown): ConnectionListing[] {
  return parseStoredConnections(raw).map(({ secrets, ...connection }) => ({ ...connection, secretKeys: Object.keys(secrets).sort() }));
}

export function connectionForSection(connections: StoredConnection[], section: string, connectionId: string): StoredConnection | undefined {
  const connection = connections.find(candidate => candidate.id === connectionId && candidate.enabled);
  if (!connection) return undefined;
  if (connection.sections.length && !connection.sections.includes(section)) return undefined;
  return connection;
}

export function parseConnectionMutation(raw: unknown, existing?: StoredConnection): { ok: true; connection: StoredConnection } | { ok: false; error: string } {
  const parsed = mutationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid task connection." };
  const connector = connectorById(parsed.data.connectorId);
  if (!connector) return { ok: false, error: "Unknown connector." };
  const declared = new Set(connector.manifest.secrets.map(secret => secret.key));
  const settings: StoredConnection["settings"] = {};
  for (const field of connector.manifest.settings) {
    const value = parsed.data.settings[field.key];
    if (value === undefined) continue;
    if (field.type === "string" && typeof value !== "string") return { ok: false, error: `${field.label} must be text.` };
    if (field.type === "number" && typeof value !== "number") return { ok: false, error: `${field.label} must be a number.` };
    if (field.type === "boolean" && typeof value !== "boolean") return { ok: false, error: `${field.label} must be yes or no.` };
    if (field.type === "enum" && (typeof value !== "string" || !field.enum?.includes(value))) return { ok: false, error: `${field.label} is not one of the allowed values.` };
    settings[field.key] = value;
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data.secrets)) {
    if (!declared.has(key)) return { ok: false, error: `${key} is not a secret this connector declares.` };
    if (value === true) {
      const kept = existing?.secrets[key];
      if (kept === undefined) return { ok: false, error: `No saved value exists for ${key}.` };
      secrets[key] = kept;
    } else secrets[key] = value;
  }
  return { ok: true, connection: { ...parsed.data, settings, secrets, enabled: parsed.data.enabled } };
}

export function connectionContext(connection: StoredConnection, fetchImpl: typeof fetch = fetch): ConnectionContext {
  const connector = connectorById(connection.connectorId);
  const declared = new Set(connector?.manifest.secrets.map(secret => secret.key) ?? []);
  return {
    connectionId: connection.id,
    settings: connection.settings,
    secret(key: string) {
      if (!declared.has(key)) throw new Error(`${key} is not declared`);
      return connection.secrets[key];
    },
    fetch: fetchImpl,
    log(message: string) {
      console.info(JSON.stringify({ event: "task.connection", connectionId: connection.id, message: message.slice(0, 300) }));
    },
  };
}

export async function testConnection(connection: StoredConnection, fetchImpl?: typeof fetch) {
  const connector = connectorById(connection.connectorId);
  if (!connector) return { ok: false as const, error: "Unknown connector." };
  return connector.test(connectionContext(connection, fetchImpl));
}

export async function queryConnection(
  connection: StoredConnection,
  query: string,
  cursor?: string,
  fetchImpl?: typeof fetch,
): Promise<{ items: SyncedItem[]; cursor?: string }> {
  const connector = connectorById(connection.connectorId);
  if (!connector) throw new Error("Unknown connector.");
  if (!connector.query || !connector.manifest.capabilities.query) throw new Error("This connection cannot list items.");
  return connector.query(connectionContext(connection, fetchImpl), query, cursor);
}

export function resolveIdentityLink(connections: StoredConnection[], section: string, identity: string): { connection: StoredConnection; kind: LinkKind; externalId: string } | null {
  const parts = identity.split(":");
  if (parts.length < 3) return null;
  const [connectorId, connectionId, ...rest] = parts;
  const externalId = rest.join(":");
  const connection = connectionForSection(connections, section, connectionId);
  if (!connection || connection.connectorId !== connectorId) return null;
  const connector = connectorById(connectorId);
  const parsed = connector?.parseRef(externalId, connectionContext(connection));
  if (!parsed) return null;
  return { connection, kind: parsed.kind, externalId: parsed.externalId };
}

const SOURCE_FETCH_MS = 8_000;

/** Resolve `jira:<connection>:PAY-123` and fetch the live item when the connector can. */
export async function sourceLinkedItem(
  connections: StoredConnection[],
  section: string,
  identity: string,
  fetchImpl?: typeof fetch,
): Promise<ReturnType<typeof observedLink> | null> {
  const resolved = resolveIdentityLink(connections, section, identity);
  if (!resolved) return null;
  const connector = connectorById(resolved.connection.connectorId);
  if (!connector) return null;
  const ctx = connectionContext(resolved.connection, fetchImpl);
  const claimed = observedLink({
    id: linkId(resolved.connection.id, resolved.kind, resolved.externalId),
    kind: resolved.kind,
    title: resolved.externalId,
    externalId: resolved.externalId,
    connectorId: resolved.connection.connectorId,
    connectionId: resolved.connection.id,
    role: "source",
    provenance: "claimed",
    at: Date.now(),
  });
  try {
    const items = await Promise.race([
      connector.fetch(ctx, [{ kind: resolved.kind, externalId: resolved.externalId }]),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out")), SOURCE_FETCH_MS);
        timer.unref?.();
      }),
    ]);
    const synced = items[0];
    if (!synced?.state && !synced?.url) return claimed;
    return observedLink({
      id: claimed.id,
      kind: synced.kind,
      title: synced.title || resolved.externalId,
      externalId: synced.externalId ?? resolved.externalId,
      url: synced.url,
      connectorId: resolved.connection.connectorId,
      connectionId: resolved.connection.id,
      details: synced.details,
      state: synced.state,
      role: "source",
      provenance: "synced",
      syncedAt: Date.now(),
      at: Date.now(),
    });
  } catch {
    return claimed;
  }
}

export function manifests() {
  return CONNECTORS.map(connector => connector.manifest);
}
