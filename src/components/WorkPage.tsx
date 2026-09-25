import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, RefreshCw } from "lucide-react";
import { api, openThread, useStore } from "@/state/store";
import { createSerialRefresh, startWorkFallbackPoll, subscribeWorkOverviewLive, WORK_FALLBACK_POLL_MS } from "@/lib/serial-refresh";
import { formatQuestionAnswers } from "../../shared/ask-question";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { canSubmitScopeChoice, scopeChoiceLabel } from "../../shared/team-backlog";
import type { BacklogScope } from "../../shared/team-backlog";
import type { WorkOverview, WorkOverviewCard, WorkOverviewEntry, WorkQueue } from "../../shared/work-overview";
import { SkillRequestPreview } from "./SkillRequestPreview";
import { loadTaskConnectors, type TaskConnectorManifest } from "./work/model";

export { WORK_FALLBACK_POLL_MS };

const labels: Record<WorkQueue, string> = {
  "needs-you": "Needs You", waiting: "Waiting on Others", working: "Working", completed: "Completed",
};
const kindLabels: Record<WorkOverviewEntry["kind"], string> = { task: "Task", goal: "Goal", source: "Source" };
const statusLabels: Record<string, string> = {
  active: "In progress", blocked: "Blocked", "needs-input": "Needs input", completed: "Completed",
  cancelled: "Stopped", queued: "Queued", running: "Working", waiting: "Waiting", failed: "Failed",
  working: "Working", idle: "Idle", paused: "Paused", stopped: "Stopped", open: "Open",
};
const scanStatusLabels: Record<string, string> = {
  "not-scanned": "not scanned", stale: "stale", incomplete: "incomplete", complete: "complete",
};
const activeQueues: WorkQueue[] = ["needs-you", "waiting", "working", "completed"];

export function workEntryChip(entry: Pick<WorkOverviewEntry, "kind" | "status">): string {
  const status = entry.kind === "source" ? entry.status : (statusLabels[entry.status] ?? entry.status);
  return `${kindLabels[entry.kind]} · ${status}`;
}

export function workGateText(gate: { detail: string; decisionMaker: string }): string {
  return `${gate.detail} · ${gate.decisionMaker}`;
}

export function workScanText(scan: NonNullable<WorkOverviewEntry["scan"]>): string {
  const count = `${scan.itemCount} ${scan.itemCount === 1 ? "item" : "items"}`;
  const when = scan.completedAt ? ` · last complete ${new Date(scan.completedAt).toLocaleString()}` : " · no complete scan yet";
  const errors = scan.errors.length ? ` · ${scan.errors.join("; ")}` : "";
  return `Scan: ${scanStatusLabels[scan.status] ?? scan.status} · ${count}${when}${errors}`;
}

function requestDetails(card: WorkOverviewCard["card"]): string {
  if (card.fullRequest) return card.fullRequest;
  const proposal = card.routineRequest ?? card.profileRequest ?? card.teamSetupRequest ?? card.skillRequest ?? card.questionRequest;
  return proposal ? JSON.stringify(proposal, null, 2) : card.subtitle;
}

export function WorkCard({ pending, onResolved }: { pending: WorkOverviewCard; onResolved: () => Promise<void> }) {
  const { card, threadId, canAct } = pending;
  const [answer, setAnswer] = useState("");
  const [questionAnswers, setQuestionAnswers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const questions = card.questionRequest?.questions ?? [];
  const respond = async (behavior: "allow" | "deny" | "answer", message?: string) => {
    if (!card.requestId || busy) return;
    setError(""); setBusy(true);
    try {
      const sha = behavior === "allow" && card.skillRequest ? reviewedSkillSha256(card.skillRequest) : undefined;
      await api(`/api/threads/${threadId}/respond`, { method: "POST", body: JSON.stringify({
        requestId: card.requestId, behavior, ...(message ? { message } : {}), ...(sha ? { reviewedSha256: sha } : {}),
      }) });
      await onResolved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const submitQuestions = () => {
    const formatted = formatQuestionAnswers(questions, questions.map((question, index) => {
      const value = questionAnswers[index]?.trim() ?? "";
      return question.multiSelect ? value.split(",").map(part => part.trim()).filter(Boolean) : [value];
    }));
    if (formatted && questions.every((_, index) => questionAnswers[index]?.trim())) void respond("answer", formatted);
  };
  return <div className="mt-3 rounded-lg border border-hairline/50 bg-control/40 p-3" data-work-card={card.requestId}>
    <div className="text-sm font-medium text-ink">{card.title}</div>
    <pre tabIndex={0} aria-label="Request details" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-inset p-2 font-mono text-xs text-ink">{requestDetails(card)}</pre>
    {card.skillRequest && <SkillRequestPreview request={card.skillRequest} />}
    {!canAct ? <p className="mt-2 text-xs text-ink-secondary">Decision-maker: {pending.decisionMaker}</p>
      : questions.length ? <form onSubmit={event => { event.preventDefault(); submitQuestions(); }} className="mt-3 space-y-3">
        {questions.map((question, index) => <label key={`${question.question}:${index}`} className="block text-sm text-ink">
          <span>{question.question}</span>
          <input value={questionAnswers[index] ?? ""} onChange={event => setQuestionAnswers(values => {
            const next = [...values]; next[index] = event.target.value; return next;
          })} list={`work-question-${pending.messageId}-${index}`}
          placeholder={question.multiSelect ? "Enter choices separated by commas" : "Choose or type an answer"}
          className="mt-1 w-full rounded border border-hairline/50 bg-inset px-2 py-1.5 text-ink" />
          <datalist id={`work-question-${pending.messageId}-${index}`}>{question.options.map(option =>
            <option key={option.label} value={option.label}>{option.description}</option>)}</datalist>
        </label>)}
        <button type="submit" disabled={busy || !questions.every((_, index) => questionAnswers[index]?.trim())}
          className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">Send answer</button>
      </form> : card.tool || card.routineRequest || card.profileRequest || card.teamSetupRequest || card.skillRequest ? <div className="mt-3 flex gap-2">
        <button type="button" disabled={busy} onClick={() => void respond("deny", "Denied by the user.")}
          className="rounded border border-danger/50 px-3 py-1.5 text-sm text-danger disabled:opacity-40">Deny</button>
        <button type="button" disabled={busy || Boolean(card.skillRequest && !reviewedSkillSha256(card.skillRequest))}
          onClick={() => void respond("allow")}
          className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">Approve once</button>
      </div> : <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.options.map(option => <button type="button" key={option} disabled={busy}
          onClick={() => void respond("answer", option)} className="rounded border border-hairline/50 px-2 py-1 text-xs text-ink">{option}</button>)}
        <input aria-label="Custom answer" value={answer} onChange={event => setAnswer(event.target.value)}
          className="min-w-40 flex-1 rounded border border-hairline/50 bg-inset px-2 py-1.5 text-sm text-ink" />
        <button type="button" disabled={busy || !answer.trim()} onClick={() => void respond("answer", answer.trim())}
          className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">Answer</button>
      </div>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </div>;
}

export function WorkScopeForm({
  choices, connectors = [], selected, busy, onChange, onSubmit,
}: {
  choices: BacklogScope[];
  connectors?: readonly TaskConnectorManifest[];
  selected: string[];
  busy?: boolean;
  onChange: (ids: string[]) => void;
  onSubmit: () => void;
}) {
  return <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <p className="text-sm">Choose what this team should track:</p>
    {choices.map(choice => {
      const connector = connectors.find(item => item.id === choice.connectorId);
      return <label key={choice.id} className="flex items-start gap-2 text-sm"><input type="checkbox" checked={selected.includes(choice.id)}
        onChange={event => onChange(event.target.checked ? [...selected, choice.id] : selected.filter(id => id !== choice.id))} />
        <span>{scopeChoiceLabel(choice, connector?.name)} · {choice.query}</span></label>;
    })}
    <button type="submit" disabled={busy || !canSubmitScopeChoice(selected, choices)}
      className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">Use selected scopes</button>
  </form>;
}

function WorkRow({ entry, cards, refresh, connectors }: {
  entry: WorkOverviewEntry; cards: WorkOverviewCard[]; refresh: () => Promise<void>;
  connectors: readonly TaskConnectorManifest[];
}) {
  const { state, dispatch } = useStore();
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = async (path: string, body: unknown, method = "POST") => {
    setBusy(true); setError("");
    try { await api(path, { method, body: JSON.stringify(body) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <article className="rounded-xl border border-hairline/40 bg-card p-4 text-ink" data-work-entry={entry.id}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className="flex items-center gap-2 text-left font-medium hover:text-accent"
        onClick={() => openThread(dispatch, { botId: entry.owner.id, threadId: entry.threadId }, state)}>
        <span>{entry.title}</span><ChevronRight size={14} aria-hidden="true" />
      </button>
      <span className="rounded bg-control px-2 py-0.5 text-xs text-ink-secondary">{workEntryChip(entry)}</span>
    </div>
    <div className="mt-1 text-xs text-ink-secondary">{entry.team || "General"} · Owner: {entry.owner.name}</div>
    <p className="mt-2 whitespace-pre-wrap text-sm">{entry.detail}</p>
    {entry.nextCheckpoint && <p className="mt-2 text-xs text-ink-secondary">Next checkpoint: {entry.nextCheckpoint}</p>}
    {entry.scan && <p className="mt-2 text-xs text-ink-secondary" data-inventory-status={entry.scan.status}>
      {workScanText(entry.scan)}
    </p>}
    {entry.evidence.length > 0 && <details className="mt-2 text-xs text-ink-secondary"><summary className="cursor-pointer">Evidence ({entry.evidence.length})</summary>
      <ul className="mt-1 list-inside list-disc break-all">{entry.evidence.map((value, index) => <li key={`${value}:${index}`}>{value}</li>)}</ul></details>}
    {entry.gates?.map((gate, index) => <p key={`${gate.kind}:${gate.identity ?? ""}:${index}`} className="mt-2 text-xs text-warning">
      {workGateText(gate)}
    </p>)}
    {entry.canChooseScope && entry.choices?.length ? <WorkScopeForm choices={entry.choices} connectors={connectors}
      selected={selected} busy={busy} onChange={setSelected}
      onSubmit={() => { void action(`/api/goals/${entry.id}/scope-choice`, { expectedRevision: entry.revision, scopeIds: selected }); }} /> : null}
    {entry.canAnswerTask && <form className="mt-3 flex gap-2" onSubmit={event => {
      event.preventDefault(); if (answer.trim()) void action(`/api/work-items/${entry.id}/answer`, { expectedRevision: entry.revision, text: answer.trim() });
    }}><input aria-label="Task answer" value={answer} onChange={event => setAnswer(event.target.value)}
      className="min-w-0 flex-1 rounded border border-hairline/50 bg-inset px-2 py-1 text-sm text-ink" />
      <button type="submit" disabled={busy || !answer.trim()} className="rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40">Send answer</button></form>}
    {entry.canRenew && <button type="button" disabled={busy} onClick={() => void action(`/api/goals/${entry.id}`,
      { expectedRevision: entry.revision, action: "resume" }, "PATCH")}
      className="mt-3 rounded border border-warning/50 px-3 py-1.5 text-sm text-warning disabled:opacity-40">Renew limits</button>}
    {cards.map(card => <WorkCard key={`${card.threadId}:${card.messageId}`} pending={card} onResolved={refresh} />)}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
  </article>;
}

export function WorkPage() {
  const [team, setTeam] = useState("*");
  const [status, setStatus] = useState("all");
  const [pages, setPages] = useState(1);
  const [overview, setOverview] = useState<WorkOverview | null>(null);
  const [teamOptions, setTeamOptions] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [connectors, setConnectors] = useState<TaskConnectorManifest[]>([]);
  const fetchOverview = useCallback(async (isCurrent: (request: number) => boolean, request: number) => {
    let cursor: string | undefined;
    let result: WorkOverview | undefined;
    for (let page = 0; page < pages; page += 1) {
      const query = new URLSearchParams({ status, limit: "100" });
      if (team !== "*") query.set("team", team);
      if (cursor) query.set("cursor", cursor);
      const next = await api<WorkOverview>(`/api/work/overview?${query}`, { timeoutMs: 30_000 });
      result = result ? { ...next, entries: [...result.entries, ...next.entries], cards: [...result.cards, ...next.cards] } : next;
      cursor = next.nextCursor;
      if (!cursor || !isCurrent(request)) break;
    }
    if (isCurrent(request) && result) { setOverview(result); setTeamOptions(result.teams); setError(""); setLoading(false); }
  }, [team, status, pages]);
  const fetchOverviewRef = useRef(fetchOverview);
  fetchOverviewRef.current = fetchOverview;
  const poll = useRef<ReturnType<typeof createSerialRefresh> | null>(null);
  poll.current ??= createSerialRefresh(request => fetchOverviewRef.current(generation => poll.current!.isCurrent(generation), request));
  const refresh = useCallback(() => poll.current!.refresh(), []);
  useEffect(() => {
    let live = true;
    void loadTaskConnectors(path => api(path)).then(list => { if (live) setConnectors(list); });
    const update = () => { void refresh().catch(cause => { if (live) {
      setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false);
    } }); };
    update();
    const stopPoll = startWorkFallbackPoll(update);
    const stopLive = subscribeWorkOverviewLive(update);
    return () => { live = false; poll.current?.invalidate(); stopPoll(); stopLive(); };
  }, [refresh, team, status, pages]);
  const loadMore = () => {
    if (!overview?.nextCursor || loading) return;
    setLoading(true); setPages(count => count + 1);
  };
  return <main className="min-w-0 flex-1 overflow-y-auto bg-app px-5 py-6 text-ink" aria-label="Work">
    <div className="mx-auto max-w-5xl space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Work</h1><p className="text-sm text-ink-secondary">Tasks and goals across teams you can access.</p></div>
        <button type="button" aria-label="Refresh Work" onClick={() => void refresh().catch(cause => setError(String(cause)))}
          className="rounded p-2 text-ink-secondary hover:bg-raised"><RefreshCw size={18} /></button>
      </header>
      <div className="flex flex-wrap gap-3 text-sm">
        <label>Team <select aria-label="Filter team" value={team} onChange={event => { setPages(1); setOverview(null); setTeam(event.target.value); }}
          className="ml-2 rounded border border-hairline/50 bg-inset p-1.5 text-ink"><option value="*">All teams</option>
          {teamOptions.map(value => <option key={value} value={value}>{value || "General"}</option>)}</select></label>
        <label>Status <select aria-label="Filter status" value={status} onChange={event => { setPages(1); setOverview(null); setStatus(event.target.value); }}
          className="ml-2 rounded border border-hairline/50 bg-inset p-1.5 text-ink"><option value="all">All</option>
          {activeQueues.map(queue => <option key={queue} value={queue}>{labels[queue]}</option>)}</select></label>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {!overview && !error && <p className="text-sm text-ink-secondary">Loading work…</p>}
      {overview && activeQueues.filter(queue => status === "all" || status === queue).map(queue => {
        const entries = overview.entries.filter(entry => entry.queue === queue);
        return <section key={queue} aria-label={labels[queue]} className="space-y-3">
          <h2 className="flex items-center gap-2 border-b border-hairline/40 pb-2 text-lg font-medium">
            {queue === "needs-you" && <Check size={17} className="text-accent" />}{labels[queue]}
            <span className="text-xs text-ink-secondary">{overview.counts[queue]}</span>
          </h2>
          {entries.length ? entries.map(entry => <WorkRow key={entry.id} entry={entry} connectors={connectors}
            cards={overview.cards.filter(card => card.entryId === entry.id)} refresh={() => refresh()} />)
            : <p className="text-sm text-ink-secondary">No visible items in this queue.</p>}
        </section>;
      })}
      {overview?.nextCursor && <button type="button" disabled={loading} onClick={loadMore}
        className="rounded border border-hairline/50 px-4 py-2 text-sm text-ink disabled:opacity-40">{loading ? "Loading…" : "Load more work"}</button>}
    </div>
  </main>;
}
