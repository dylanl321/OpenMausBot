import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlOmb } from "../control-omb.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.OMB_UI_E2E === "1";
const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlOmb(["ui", verb, "--ui", handle, ...args]) as Promise<{ result?: any; snapshot?: string }>;

/** The real renderer is mounted by the disposable control-omb UI fixture.
 * Only its Work HTTP response is replaced with synthetic cards; no running
 * workspace or external Jira/GitLab account is contacted. */
(enabled ? it : it.skip)("handles full Work requests, inline approval/denial/answers and paged refresh", async () => {
  const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-omb.ts"), "ui", "launch"], {
    cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errors = "";
  let handle: string | undefined;
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { errors += String(chunk); });
  try {
    await expect.poll(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(errors);
      try { handle = (JSON.parse(output) as { ui: string }).ui; return Boolean(handle); }
      catch { return false; }
    }, { timeout: 180_000, interval: 500 }).toBe(true);
    const goal = { kind: "goal", id: "fixture-goal", team: "Delivery", title: "Finish the team backlog", status: "waiting",
      queue: "needs-you", owner: { id: "lead", name: "Delivery lead" }, detail: "Review pending decisions",
      nextCheckpoint: "Current-head review", evidence: [], updatedAt: 3, threadId: "fixture-thread", revision: 1,
      scan: { status: "incomplete", itemCount: 2, errors: ["Jira page 2 unavailable"], completedAt: 1 } };
    const source = { ...goal, kind: "source", id: "source-item", title: "PAY-1 · Refund correction", status: "In Progress",
      queue: "waiting", detail: "Verify the refund", evidence: ["Observed on Jira"], threadId: "fixture-thread" };
    const card = (id: string, request: string) => ({ entryId: goal.id, threadId: "fixture-thread", messageId: `message-${id}`,
      canAct: true, decisionMaker: "Requester", card: { title: `Decision ${id}`, subtitle: "Short summary", fullRequest: request,
        options: ["Allow", "Deny"], tool: "Bash", requestId: id } });
    const full = `Full request: ${"verify exact arguments ".repeat(100)}`;
    const question = { entryId: goal.id, threadId: "fixture-thread", messageId: "message-q", canAct: true,
      decisionMaker: "Requester", card: { title: "Choose project", subtitle: "Which project?", options: [], requestId: "q",
        questionRequest: { version: 1, questions: [{ question: "Which project?", options: [{ label: "PAY" }, { label: "OPS" }] }] } } };
    const other = { ...card("other", "Only Security can decide this"), canAct: false, decisionMaker: "Security" };
    const script = `(() => {
      const native = window.fetch.bind(window);
      const goal = ${JSON.stringify(goal)};
      const source = ${JSON.stringify(source)};
      let cards = ${JSON.stringify([card("approve", full), card("deny", "Deny these exact arguments"), question, other])};
      window.__workDecisions = [];
      window.fetch = (input, init) => {
        const path = String(input);
        if (path.startsWith('/api/work/overview')) {
          const page = new URL(path, location.origin).searchParams.has('cursor');
          const result = { entries: page ? [source] : [goal], cards: page ? [] : cards,
            teams: ['Delivery'], counts: { 'needs-you': 1, waiting: 1, working: 0, completed: 0 },
            ...(!page ? { nextCursor: '100' } : {}) };
          return Promise.resolve(new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        if (path === '/api/threads/fixture-thread/respond') {
          const decision = JSON.parse(init.body);
          window.__workDecisions.push(decision);
          cards = cards.filter(item => item.card.requestId !== decision.requestId);
          return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return native(input, init);
      };
      return true;
    })()`;
    expect((await ui("eval", handle!, "--js", script)).result).toBe(true);
    await ui("click", handle!, "--name", "Tools");
    await ui("click", handle!, "--name", "Work");
    await expect.poll(async () => (await ui("eval", handle!, "--js",
      `document.querySelector('[data-work-card="approve"] pre')?.textContent`)).result, { timeout: 15_000 }).toBe(full);
    expect((await ui("snapshot", handle!)).snapshot).toContain("Jira page 2 unavailable");
    await ui("eval", handle!, "--js", `document.querySelector('[data-work-card="approve"] button:last-child').click()`);
    await ui("eval", handle!, "--js", `document.querySelector('[data-work-card="deny"] button:first-of-type').click()`);
    await expect.poll(async () => (await ui("eval", handle!, "--js", "window.__workDecisions")).result.length,
      { timeout: 10_000 }).toBe(2);
    await ui("type", handle!, "--name", "Which project?", "--text", "PAY");
    await ui("click", handle!, "--name", "Send answer");
    await expect.poll(async () => (await ui("eval", handle!, "--js", "window.__workDecisions")).result.length,
      { timeout: 10_000 }).toBe(3);
    expect((await ui("eval", handle!, "--js", "window.__workDecisions")).result).toEqual([
      expect.objectContaining({ requestId: "approve", behavior: "allow" }),
      expect.objectContaining({ requestId: "deny", behavior: "deny" }),
      expect.objectContaining({ requestId: "q", behavior: "answer", message: expect.stringContaining("PAY") }),
    ]);
    expect((await ui("snapshot", handle!)).snapshot).toContain("Decision-maker: Security");
    await ui("click", handle!, "--name", "Load more work");
    await expect.poll(async () => (await ui("snapshot", handle!)).snapshot, { timeout: 10_000 }).toContain("PAY-1 · Refund correction");
    await ui("click", handle!, "--name", "Refresh Work");
    expect((await ui("snapshot", handle!)).snapshot).toContain("PAY-1 · Refund correction");
  } finally {
    await waitForExit(child, { signal: "SIGINT", graceMs: 10_000 });
  }
}, 240_000);
