import { describe, expect, it } from "vitest";
import type { SyncedItem } from "./work-links.ts";
import {
  changeField,
  ignoreOwnBotWrite,
  inQuietHours,
  mapWebhookChange,
  matchWatchFilter,
  parseQuietHours,
  readJsonPath,
  renderWatchPrompt,
  type SourceChange,
} from "./watches.ts";

const item = (title = "PAY-140"): SyncedItem => ({
  kind: "work_item",
  title,
  externalId: title,
  updatedAt: 1,
  state: { label: "Ready", category: "todo" },
  details: { project: "PAY" },
});

const change = (overrides: Partial<SourceChange> = {}): SourceChange => ({
  id: "evt-1",
  type: "item.created",
  connectionId: "jira-acme",
  item: item(),
  actor: { name: "Ada", isBot: false },
  fields: { project: "PAY", priority: "high", "state.category": "todo" },
  at: 1,
  ...overrides,
});

describe("watch filter language", () => {
  it("matches all / any / not, eq / in / contains", () => {
    const created = change();
    expect(matchWatchFilter(created, {
      all: [
        { field: "state.category", in: ["todo", "in_progress"] },
        { field: "actor.isBot", eq: false },
      ],
    })).toBe(true);
    expect(matchWatchFilter(created, {
      all: [
        { field: "state.category", eq: "done" },
        { field: "actor.isBot", eq: false },
      ],
    })).toBe(false);
    expect(matchWatchFilter(created, {
      any: [
        { field: "type", eq: "item.labeled" },
        { field: "fields.project", eq: "PAY" },
      ],
    })).toBe(true);
    expect(matchWatchFilter(created, { not: { field: "actor.isBot", eq: true } })).toBe(true);
    expect(matchWatchFilter(created, { field: "item.title", contains: "pay" })).toBe(true);
    expect(matchWatchFilter(created, { field: "item.title", contains: "ENG" })).toBe(false);
  });

  it("matches changed-from / changed-to against before and after", () => {
    const moved = change({
      type: "item.state_changed",
      before: { state: "todo", stateLabel: "To Do", assignee: "Ada" },
      item: { ...item(), state: { label: "In Progress", category: "in_progress" } },
      fields: { assignee: "Bea" },
    });
    expect(matchWatchFilter(moved, { field: "state.category", changedFrom: "todo", changedTo: "in_progress" })).toBe(true);
    expect(matchWatchFilter(moved, { field: "state.category", changedFrom: "in_progress" })).toBe(false);
    expect(matchWatchFilter(moved, { field: "assignee", changedFrom: "Ada", changedTo: "Bea" })).toBe(true);
    expect(changeField(moved, "state.category")).toBe("in_progress");
    expect(changeField(moved, "before.state")).toBe("todo");
  });

  it("skips our own bot writes unless the filter names actor.isBot", () => {
    const botWrite = change({ actor: { name: "Scout", isBot: true } });
    expect(ignoreOwnBotWrite(botWrite)).toBe(true);
    expect(ignoreOwnBotWrite(botWrite, { field: "actor.isBot", eq: true })).toBe(false);
    expect(ignoreOwnBotWrite(change())).toBe(false);
  });
});

describe("webhook field map", () => {
  it("reads JSONPath-style paths and maps a payload into a SourceChange", () => {
    const payload = {
      delivery_id: "d-9",
      event: "item.created",
      issue: { key: "PAY-140", title: "Ready stories", fields: { project: "PAY" } },
      actor: { name: "Ada", bot: false },
    };
    expect(readJsonPath(payload, "$.issue.key")).toBe("PAY-140");
    expect(readJsonPath(payload, "issue.fields.project")).toBe("PAY");
    const mapped = mapWebhookChange({
      webhookId: "wh-1",
      deliveryId: "fallback",
      eventName: "ignored",
      payload,
      fieldMap: {
        id: "$.delivery_id",
        type: "$.event",
        title: "$.issue.title",
        externalId: "$.issue.key",
        "fields.project": "$.issue.fields.project",
        "actor.name": "$.actor.name",
      },
      at: 10,
    });
    expect(mapped).toMatchObject({
      id: "d-9",
      type: "item.created",
      connectionId: "webhook:wh-1",
      item: { title: "Ready stories", externalId: "PAY-140" },
      actor: { name: "Ada", isBot: false },
      fields: { project: "PAY" },
    });
  });

  it("falls back to the delivery id and flattens one payload level", () => {
    const mapped = mapWebhookChange({
      webhookId: "wh-1",
      deliveryId: "del-1",
      payload: { task: "brief", count: 2 },
      at: 3,
    });
    expect(mapped.id).toBe("del-1");
    expect(mapped.type).toBe("item.updated");
    expect(mapped.fields).toEqual({ task: "brief", count: 2 });
  });
});

describe("quiet hours and prompt interpolation", () => {
  it("parses wrapping quiet-hour windows against local clock minutes", () => {
    expect(parseQuietHours("22:00-07:00")).toEqual({ start: 22 * 60, end: 7 * 60 });
    const evening = new Date(2026, 8, 24, 23, 0, 0).getTime();
    const morning = new Date(2026, 8, 24, 6, 0, 0).getTime();
    const noon = new Date(2026, 8, 24, 12, 0, 0).getTime();
    expect(inQuietHours("22:00-07:00", evening)).toBe(true);
    expect(inQuietHours("22:00-07:00", morning)).toBe(true);
    expect(inQuietHours("22:00-07:00", noon)).toBe(false);
    expect(inQuietHours("09:00-17:00", noon)).toBe(true);
  });

  it("substitutes {{changes}} or appends a summary", () => {
    const changes = [change({ type: "commit.pushed", item: { kind: "commit", title: "commit abc1234", externalId: "abc1234", updatedAt: 1 } })];
    expect(renderWatchPrompt("Triage:\n{{changes}}", changes)).toBe("Triage:\ncommit.pushed commit abc1234 (abc1234)");
    expect(renderWatchPrompt("Triage", changes)).toBe("Triage\n\ncommit.pushed commit abc1234 (abc1234)");
  });
});
