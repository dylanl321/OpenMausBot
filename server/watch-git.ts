/** Built-in git watch source: `ls-remote --heads` compared to a durable cursor. */
import type { SourceChange } from "../shared/watches.ts";

const SHA = /^[0-9a-f]{40,64}$/i;
const HEADS = "refs/heads/";

export type GitHeads = Record<string, string>;

export function parseLsRemote(stdout: string): GitHeads {
  const heads: GitHeads = {};
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const sha = line.slice(0, tab).trim().toLowerCase();
    const ref = line.slice(tab + 1).trim();
    if (!SHA.test(sha) || !ref.startsWith(HEADS)) continue;
    heads[ref] = sha;
  }
  return heads;
}

export function gitBranchName(ref: string): string {
  return ref.startsWith(HEADS) ? ref.slice(HEADS.length) : ref;
}

export function gitSourceChange(
  type: "commit.pushed" | "branch.created",
  ref: string,
  sha: string,
  at: number,
  connectionId: string,
): SourceChange {
  const branch = gitBranchName(ref);
  const short = sha.slice(0, 7);
  return {
    id: `${ref}@${sha}`,
    type,
    connectionId,
    item: {
      kind: "commit",
      title: type === "branch.created" ? `branch ${branch}` : `commit ${short} on ${branch}`,
      externalId: sha,
      updatedAt: at,
    },
    fields: { ref, sha, branch },
    at,
  };
}

/** New heads become `branch.created`; moved heads become `commit.pushed`. */
export function diffGitHeads(previous: GitHeads, next: GitHeads, at: number, connectionId: string): SourceChange[] {
  const changes: SourceChange[] = [];
  for (const [ref, sha] of Object.entries(next)) {
    const prior = previous[ref];
    if (!prior) changes.push(gitSourceChange("branch.created", ref, sha, at, connectionId));
    else if (prior !== sha) changes.push(gitSourceChange("commit.pushed", ref, sha, at, connectionId));
  }
  return changes;
}
