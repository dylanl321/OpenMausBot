import { createHash } from "node:crypto";
import type { CaptureRule } from "../types.ts";

const URL_RE = /https?:\/\/[^\s<>"')\]]+/;

export function plainUrl(text: string | undefined): string | null {
  if (!text || text.includes("[… preview shortened]")) {
    const before = text?.split("[… preview shortened]")[0] ?? "";
    const match = URL_RE.exec(before);
    return match && !match[0].endsWith("…") ? match[0] : null;
  }
  return URL_RE.exec(text)?.[0] ?? null;
}

export function urlLinkId(url: string): string {
  return `url:${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
}

/** Used only when no connector rule claimed the call. */
export const urlCaptureRule: CaptureRule = {
  match: {},
  on: "completed",
  extract: call => {
    const url = plainUrl(call.output) ?? plainUrl(call.input);
    if (!url) return null;
    return { externalId: urlLinkId(url), url, title: url };
  },
  event: item => `linked ${item.url ?? item.title}`,
  produce: { kind: "link" },
};
