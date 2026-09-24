import type { CaptureRule } from "../types.ts";

const HASH = /\b([0-9a-f]{7,40})\b/;

function hashFrom(call: { output?: string; input?: string; summary?: string }): string | null {
  const source = `${call.output ?? ""}\n${call.summary ?? ""}\n${call.input ?? ""}`;
  if (source.includes("[… preview shortened]") && !HASH.test(call.output ?? "")) return null;
  return HASH.exec(call.output ?? "")?.[1] ?? HASH.exec(call.summary ?? "")?.[1] ?? null;
}

function branchFrom(call: { summary?: string; output?: string }): string | undefined {
  const command = call.summary ?? "";
  const named = /(?:\b(?:checkout|switch|push)\b[^\n]*\s)([A-Za-z0-9._/-]+)\s*$/.exec(command);
  return named?.[1];
}

export const gitCaptureRules: CaptureRule[] = [
  {
    match: { command: /^git commit\b/ },
    on: "completed",
    extract: call => {
      const hash = hashFrom(call);
      if (!hash) return null;
      const branch = branchFrom(call);
      return { externalId: hash, title: `commit ${hash.slice(0, 7)}`, ...(branch ? { details: { branch } } : {}) };
    },
    event: item => `committed ${item.externalId?.slice(0, 7)}`,
    produce: { kind: "commit" },
  },
  {
    match: { command: /^git push\b/ },
    on: "completed",
    extract: call => {
      const hash = hashFrom(call);
      const branch = branchFrom(call);
      if (!hash && !branch) return null;
      return {
        externalId: hash ?? branch!,
        title: hash ? `commit ${hash.slice(0, 7)}` : `branch ${branch}`,
        ...(branch ? { details: { branch } } : {}),
      };
    },
    event: item => `pushed ${item.title}`,
    produce: { kind: "commit" },
  },
];
