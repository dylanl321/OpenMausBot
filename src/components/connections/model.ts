import type { SettingField, TaskConnectorManifest } from "../work/model";

const CONNECTION_ID = /^[a-z][a-z0-9-]{0,63}$/;

export type ConnectionMutation = {
  id: string;
  connectorId: string;
  label: string;
  settings: Record<string, string | number | boolean>;
  secrets: Record<string, string | true>;
  sections: string[];
  enabled: boolean;
};

export type ConnectionTestResult =
  | { ok: true; account: string }
  | { ok: false; error: string };

export function isConnectionId(value: string): boolean {
  return CONNECTION_ID.test(value);
}

/** Lowercase id from a connector and a human label. Never includes secret values. */
export function slugConnectionId(connectorId: string, label: string): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const base = !slug
    ? connectorId
    : slug === connectorId || slug.startsWith(`${connectorId}-`)
      ? slug
      : `${connectorId}-${slug}`;
  return base.replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/-$/g, "").slice(0, 64) || connectorId;
}

export function uniqueConnectionId(suggested: string, existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(suggested) && isConnectionId(suggested)) return suggested;
  for (let n = 2; n < 1000; n++) {
    const suffix = `-${n}`;
    const next = `${suggested.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`;
    if (!taken.has(next) && isConnectionId(next)) return next;
  }
  return suggested.slice(0, 64);
}

export function teamChoices(
  sections: readonly string[] = [],
  members: readonly { section?: string }[] = [],
): string[] {
  return [...new Set([...sections, ...members.map((member) => member.section ?? "")])]
    .map((name) => name.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function coerceSetting(
  field: SettingField,
  raw: string | number | boolean | undefined,
): string | number | boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (field.type === "number") {
    const value = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(value) ? value : undefined;
  }
  if (field.type === "boolean") return raw === true;
  return String(raw);
}

/** Keep only fields the manifest declares. */
export function buildSettings(
  fields: readonly SettingField[] | undefined,
  values: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const settings: Record<string, string | number | boolean> = {};
  for (const field of fields ?? []) {
    const value = coerceSetting(field, values[field.key]);
    if (value === undefined) continue;
    settings[field.key] = value;
  }
  return settings;
}

/**
 * Renderer-facing secret handling: drafts are what the user typed.
 * A blank draft next to a known key name becomes `true` (keep saved value).
 * Secret values from the server never appear here — only key names.
 */
export function buildSecrets(
  secrets: readonly { key: string }[] | undefined,
  drafts: Record<string, string>,
  savedKeys: readonly string[] = [],
): Record<string, string | true> {
  const payload: Record<string, string | true> = {};
  const saved = new Set(savedKeys);
  for (const secret of secrets ?? []) {
    const typed = (drafts[secret.key] ?? "").trim();
    if (typed) payload[secret.key] = typed;
    else if (saved.has(secret.key)) payload[secret.key] = true;
  }
  return payload;
}

export function connectionMutation(input: {
  id: string;
  connectorId: string;
  label: string;
  settings: Record<string, string | number | boolean | undefined>;
  secretDrafts: Record<string, string>;
  secretKeys?: readonly string[];
  sections: string[];
  enabled: boolean;
  manifest?: TaskConnectorManifest;
}): { ok: true; body: ConnectionMutation } | { ok: false; error: "connector" | "label" | "id" } {
  const label = input.label.trim();
  const id = input.id.trim();
  if (!input.connectorId) return { ok: false, error: "connector" };
  if (!label) return { ok: false, error: "label" };
  if (!isConnectionId(id)) return { ok: false, error: "id" };
  return {
    ok: true,
    body: {
      id,
      connectorId: input.connectorId,
      label,
      settings: buildSettings(input.manifest?.settings, input.settings),
      secrets: buildSecrets(input.manifest?.secrets, input.secretDrafts, input.secretKeys),
      sections: input.sections,
      enabled: input.enabled,
    },
  };
}
