import type { BacklogGate } from "../../../shared/team-backlog.ts";
import { sourceIdentity } from "../../../shared/work-links.ts";
import { redactSecretsInText } from "../../redact.ts";
import type { ConnectionContext, ConnectorActInput, ConnectorActResult } from "../types.ts";

const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/i;

function siteUrl(ctx: ConnectionContext): string | null {
  const raw = String(ctx.settings.site ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return null;
  }
}

function identityOf(ctx: ConnectionContext, externalId: string): string {
  return sourceIdentity({ connectorId: "jira", connectionId: ctx.connectionId, externalId }) ?? externalId;
}

function gate(kind: BacklogGate["kind"], detail: string, decisionMaker: string, identity: string): BacklogGate {
  return { kind, detail: redactSecretsInText(detail).slice(0, 1000), decisionMaker, identity };
}

function authHeaders(ctx: ConnectionContext): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
  if (ctx.settings.edition === "datacenter") {
    const token = ctx.secret("token");
    if (!token) throw new Error("Jira token is unavailable");
    headers.authorization = `Bearer ${token}`;
    return headers;
  }
  const email = ctx.secret("email");
  const apiToken = ctx.secret("apiToken");
  if (!email || !apiToken) throw new Error("Jira credentials are unavailable");
  headers.authorization = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  return headers;
}

async function jiraFetch(ctx: ConnectionContext, path: string, init?: RequestInit): Promise<Response> {
  const site = siteUrl(ctx);
  if (!site) throw new Error("Connection has an invalid instance URL");
  return ctx.fetch(`${site}${path}`, {
    ...init,
    headers: { ...authHeaders(ctx), ...init?.headers },
  });
}

async function read(response: Response, label: string): Promise<Record<string, any>> {
  if (!response.ok) throw new Error(`${label} returned ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${label} returned an invalid response`);
  return body as Record<string, any>;
}

export async function actJiraComplete(ctx: ConnectionContext, input: ConnectorActInput): Promise<ConnectorActResult> {
  if (input.action !== "complete_work_item" || input.target.kind !== "work_item") {
    throw new Error("Unsupported Jira action");
  }
  if (!ISSUE_KEY.test(input.target.externalId)) throw new Error("Invalid Jira issue identity");
  const identity = identityOf(ctx, input.target.externalId);
  const prefix = ctx.settings.edition === "datacenter" ? "/rest/api/2" : "/rest/api/3";
  const base = `${prefix}/issue/${encodeURIComponent(input.target.externalId)}`;
  const get = (path: string, label: string) => jiraFetch(ctx, path).then(response => read(response, label));
  const issue = await get(`${base}?fields=status`, "Jira issue");
  if (issue.key !== input.target.externalId || !issue.fields?.status) throw new Error("Jira returned a different issue or no status");
  if (issue.fields.status.statusCategory?.key === "done") {
    return {
      changed: true,
      target: {
        state: "done", label: String(issue.fields.status.name ?? "Done"), observedAt: Date.now(),
        result: "Observed Jira done status",
      },
      gates: [],
    };
  }
  const transitions = await get(`${base}/transitions`, "Jira transitions");
  if (!Array.isArray(transitions.transitions)) throw new Error("Jira transitions are unavailable");
  const done = (transitions.transitions as Array<Record<string, any>>).filter(value => value.to?.statusCategory?.key === "done" &&
    /\b(?:done|complete(?:d)?|resolved|closed|shipped|delivered|accepted)\b/i.test(String(value.to?.name ?? "")) &&
    !/cancel|won'?t do|obsolete|reject|duplicate|invalid|declined|abandon/i.test(String(value.to?.name ?? "")) &&
    typeof value.id === "string");
  if (done.length !== 1) {
    return {
      changed: false,
      target: {},
      gates: [gate("policy", "Choose or configure a single valid Jira done transition for this issue.",
        "Jira project manager", identity)],
    };
  }
  if (input.mode !== "commit") return { changed: false, target: {}, gates: [] };
  const changed = await jiraFetch(ctx, `${base}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: done[0].id } }),
  });
  if (!changed.ok) throw new Error(`Jira transition returned ${changed.status}`);
  const observed = await get(`${base}?fields=status`, "Jira transition readback");
  if (observed.key !== input.target.externalId || observed.fields?.status?.statusCategory?.key !== "done") {
    throw new Error("Jira did not confirm a done status");
  }
  return {
    changed: true,
    target: {
      state: "done", label: String(observed.fields.status.name ?? "Done"), observedAt: Date.now(),
      result: "Observed Jira done status",
    },
    gates: [],
  };
}
