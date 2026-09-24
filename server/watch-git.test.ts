import { describe, expect, it } from "vitest";
import { diffGitHeads, gitSourceChange, parseLsRemote } from "./watch-git.ts";

describe("git ls-remote watch source", () => {
  it("parses heads and ignores tags or junk", () => {
    const heads = parseLsRemote([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/heads/feat/pay",
      "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1",
      "not-a-sha\trefs/heads/bad",
      "",
    ].join("\n"));
    expect(heads).toEqual({
      "refs/heads/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "refs/heads/feat/pay": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
  });

  it("emits branch.created for new heads and commit.pushed for moved heads", () => {
    const previous = { "refs/heads/main": "a".repeat(40) };
    const next = {
      "refs/heads/main": "b".repeat(40),
      "refs/heads/feat": "c".repeat(40),
    };
    const changes = diffGitHeads(previous, next, 10, "git:w1");
    expect(changes.map((change) => change.type).sort()).toEqual(["branch.created", "commit.pushed"]);
    expect(changes.find((change) => change.type === "commit.pushed")).toMatchObject({
      id: `refs/heads/main@${"b".repeat(40)}`,
      fields: { branch: "main", sha: "b".repeat(40) },
      item: { kind: "commit", externalId: "b".repeat(40) },
    });
    expect(gitSourceChange("branch.created", "refs/heads/feat", "c".repeat(40), 1, "git:w1").item.title).toBe("branch feat");
  });

  it("is idle when heads are unchanged", () => {
    const heads = { "refs/heads/main": "a".repeat(40) };
    expect(diffGitHeads(heads, { ...heads }, 1, "git:w1")).toEqual([]);
  });
});
