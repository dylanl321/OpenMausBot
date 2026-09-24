import { z } from "zod";
import type { LinkKind } from "../shared/work-links.ts";
import { connectorById, CONNECTORS } from "./connectors/registry.ts";
import type { ConnectionContext, ConnectionListing, StoredConnection } from "./connectors/types.ts";

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const settingValue = z.union([z.string().max(2_000), z.number().finite(), z.boolean()]);

const storedSchema = z.object({
  id: idSchema,
  connectorId: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  settings: z.record(z.string(), settingValue).default({}),
  secrets: z.record(z.string(), z.string().max(16_000)).default({}),
  sections: z.array(z.string().max(200)).max(50).default([]),
  enabled: z.boolean().default(true),
}).strict();

const mutationSchema = storedSchema.extend({
  secrets: z.record(z.string(), z.union([z.string().max(16_000), z.literal(true)])).default({}),
}).strict();

export type TaskConnectionMutation = z.infer<typeof mutationSchema>;

export function parseStoredConnections(raw: unknown): StoredConnection[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(entry => {
    const parsed = storedSchema.safeParse(entry);
    return parsed.success && connectorById(parsed.data.connectorId) ? [parsed.data] : [];
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

export function manifests() {
  return CONNECTORS.map(connector => connector.manifest);
}
