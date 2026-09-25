// Connector-only PRs (Phase 8 drop-in proof) may touch one connector folder,
// the single registry import, and docs. Optional `actions` / `act` files
// inside that folder (e.g. server/connectors/plane/actions.ts) are allowed.
// Everything else is a mixed PR and this check stays out of the way.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const SHARED = new Set([
  "types.ts",
  "registry.ts",
  "contract-suite.ts",
  "contract-suite.test.ts",
  "capture.ts",
  "capture.test.ts",
  "change-cursor.ts",
  "change-cursor.test.ts",
  "builtin",
]);

function connectorPackage(path) {
  const match = /^server\/connectors\/([^/]+)\//.exec(path);
  if (!match || SHARED.has(match[1])) return null;
  return match[1];
}

export function connectorOnlyProblems(paths) {
  const files = [...new Set(paths.map((path) => path.replace(/\\/g, "/")).filter(Boolean))];
  const connectors = new Set();
  let registry = false;
  const extras = [];
  for (const file of files) {
    if (file === "server/connectors/registry.ts") {
      registry = true;
      continue;
    }
    const id = connectorPackage(file);
    if (id) {
      connectors.add(id);
      continue;
    }
    if (file === "docs/connectors.md" || file.startsWith("docs/")) continue;
    extras.push(file);
  }
  if (connectors.size !== 1 || !registry) return [];
  const [id] = connectors;
  return extras.map((file) => (
    `${file}: connector-only PRs may touch server/connectors/${id}/**, one registry.ts line, and docs`
  ));
}

function changedFiles() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const base = process.env.GITHUB_BASE_SHA
    || (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "");
  if (!base) return null;
  try {
    const output = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    console.warn(`connector path check skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function main() {
  const files = changedFiles();
  if (!files) {
    console.log("connector path check skipped (no base or file list)");
    return;
  }
  const problems = connectorOnlyProblems(files);
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`connector path check passed (${files.length} file${files.length === 1 ? "" : "s"})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
