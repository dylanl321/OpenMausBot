/** Provider-agnostic watch cursors and last-seen snapshots.
 *
 * Connectors that only get "updated since" keep a bounded per-item snapshot
 * so they can fill `SourceChange.before`. The snapshot is encoded in the
 * cursor string the watch engine already stores, so the engine stays
 * provider-agnostic. Items that leave the current page are dropped.
 */
import type { StatusCategory, SyncedItem } from "../../shared/work-links.ts";
import type { SourceChange } from "../../shared/watches.ts";

export const MAX_SEEN_SNAPSHOTS = 200;

export interface SeenSnapshot {
  state?: StatusCategory;
  stateLabel?: string;
  assignee?: string;
  labels?: string[];
}

export interface ParsedChangeCursor {
  since: number;
  iso: string;
  seen: Map<string, SeenSnapshot>;
}

function labelsOf(item: SyncedItem): string[] | undefined {
  const raw = item.details?.labels;
  if (Array.isArray(raw) && raw.every(entry => typeof entry === "string")) return raw;
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(entry => entry.trim()).filter(Boolean);
  }
  return undefined;
}

export function parseChangeCursor(cursor: string | null | undefined): ParsedChangeCursor {
  if (!cursor?.trim()) return { since: 0, iso: "", seen: new Map() };
  const trimmed = cursor.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { at?: unknown; t?: unknown; seen?: unknown; s?: unknown };
      const at = typeof parsed.at === "string" ? parsed.at : typeof parsed.t === "string" ? parsed.t : "";
      const since = Date.parse(at);
      const raw = parsed.seen && typeof parsed.seen === "object" && !Array.isArray(parsed.seen)
        ? parsed.seen as Record<string, SeenSnapshot>
        : parsed.s && typeof parsed.s === "object" && !Array.isArray(parsed.s)
          ? parsed.s as Record<string, SeenSnapshot>
          : {};
      const seen = new Map<string, SeenSnapshot>();
      for (const [id, snap] of Object.entries(raw)) {
        if (!id || !snap || typeof snap !== "object") continue;
        seen.set(id, {
          ...(typeof snap.state === "string" ? { state: snap.state } : {}),
          ...(typeof snap.stateLabel === "string" ? { stateLabel: snap.stateLabel } : {}),
          ...(typeof snap.assignee === "string" ? { assignee: snap.assignee } : {}),
          ...(Array.isArray(snap.labels) && snap.labels.every(entry => typeof entry === "string")
            ? { labels: snap.labels } : {}),
        });
      }
      return {
        since: Number.isFinite(since) ? since : 0,
        iso: Number.isFinite(since) ? new Date(since).toISOString() : "",
        seen,
      };
    } catch {
      /* fall through to a plain timestamp */
    }
  }
  const since = Date.parse(trimmed);
  return {
    since: Number.isFinite(since) ? since : 0,
    iso: Number.isFinite(since) ? new Date(since).toISOString() : trimmed,
    seen: new Map(),
  };
}

export function encodeChangeCursor(
  at: number | string,
  seen: Map<string, SeenSnapshot>,
  liveIds?: Iterable<string>,
): string {
  const ms = typeof at === "number" ? at : Date.parse(at);
  const iso = Number.isFinite(ms) && ms > 0
    ? new Date(ms).toISOString()
    : typeof at === "string" && at ? at : new Date().toISOString();
  const live = liveIds ? new Set([...liveIds].filter(Boolean)) : null;
  const retained = new Map<string, SeenSnapshot>();
  for (const [id, snap] of seen) {
    if (live && live.size && !live.has(id)) continue;
    retained.set(id, snap);
  }
  const entries = [...retained.entries()].slice(-MAX_SEEN_SNAPSHOTS);
  if (!entries.length) return iso;
  return JSON.stringify({ at: iso, seen: Object.fromEntries(entries) });
}

/** True when `next` is the same moment or later than `previous`. */
export function cursorMovesForward(previous: string, next: string): boolean {
  if (previous === next) return true;
  const a = parseChangeCursor(previous).since;
  const b = parseChangeCursor(next).since;
  if (!previous.trim()) return true;
  return b >= a;
}

export function snapshotFromItem(item: SyncedItem): SeenSnapshot {
  const labels = labelsOf(item);
  return {
    ...(item.state?.category ? { state: item.state.category } : {}),
    ...(item.state?.label ? { stateLabel: item.state.label } : {}),
    ...(typeof item.details?.assignee === "string" ? { assignee: item.details.assignee } : {}),
    ...(labels?.length ? { labels } : {}),
  };
}

export function beforeFromSnapshot(seen?: SeenSnapshot): SourceChange["before"] {
  if (!seen) return undefined;
  const before: NonNullable<SourceChange["before"]> = {
    ...(seen.state ? { state: seen.state } : {}),
    ...(seen.stateLabel ? { stateLabel: seen.stateLabel } : {}),
    ...(seen.assignee ? { assignee: seen.assignee } : {}),
    ...(seen.labels?.length ? { labels: seen.labels } : {}),
  };
  return Object.keys(before).length ? before : undefined;
}

export function rememberSnapshot(
  seen: Map<string, SeenSnapshot>,
  item: SyncedItem,
): void {
  if (!item.externalId) return;
  seen.set(item.externalId, snapshotFromItem(item));
}

/** Mark a write as our own when the actor is a bot or the connection account. */
export function connectionActor(input: {
  name?: string;
  bot?: boolean;
  accountType?: string;
  accountId?: string;
  username?: string;
  email?: string;
  account?: {
    accountId?: string;
    username?: string;
    email?: string;
    displayName?: string;
    bot?: boolean;
  };
}): { name: string; isBot: boolean } {
  const name = (input.name ?? input.account?.displayName ?? input.username ?? "unknown").slice(0, 80);
  const account = input.account;
  const sameAccount = Boolean(account && (
    (input.accountId && account.accountId && input.accountId === account.accountId)
    || (input.username && account.username && input.username === account.username)
    || (input.email && account.email && input.email.toLowerCase() === account.email.toLowerCase())
  ));
  const isBot = input.bot === true
    || input.accountType === "app"
    || sameAccount
    || Boolean(account?.bot && (
      (input.username && input.username === account.username)
      || (input.name && input.name === account.displayName)
    ));
  return { name: name || "unknown", isBot };
}
