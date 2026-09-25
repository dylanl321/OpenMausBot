import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";

import { cn } from "@/lib/cn";
import { randomId } from "@/lib/random-id";
import { mergeWizardRevision, seedFromRole, STARTER_TEAMS, WIZARD_ROLES } from "@/lib/setup-wizard";
import { communityWizardSeed } from "@/lib/team-import";
import { api, useStore, type Bot, type ModelSelection } from "@/state/store";
import type { WizardBot, WizardDestination, WizardDraft, WizardSeed } from "../../shared/setup-wizard";
import { visibilityFromForm, type VisibilityMode } from "./bot-settings/VisibilitySection";

interface GuideModel { instanceId: string; model: string; label: string; coordination: boolean; effortLevels: string[] }
interface GuideEngine { instanceId: string; label: string; driverKind: string; models: GuideModel[] }
interface GuideOptions { engines: GuideEngine[]; modelEngines: GuideEngine[]; maxBots: number }
interface CommunityEntry { slug: string; name: string; summary: string; members: number }

const field = "w-full rounded-lg border border-hairline/50 bg-inset px-3 py-2 text-[13px] text-ink focus:border-accent focus:outline-none";
const modelValue = (selection: ModelSelection) => `${selection.instanceId}\u0000${selection.model}`;
const visibleName = (section: string) => section || "General";

export interface SetupWizardResult { bots: Bot[]; section: string; chiefBotId: string | null; replayed: boolean }

export function setupGuideError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/forbidden|lacks the admin scope|\b403\b/i.test(message)) return "Setup Guide needs a workspace admin.";
  return message;
}

export function SetupWizardDialog({ initialDestination, initialSeed, onClose, onCreated }: {
  initialDestination: WizardDestination;
  initialSeed?: WizardSeed;
  onClose: () => void;
  onCreated?: (result: SetupWizardResult) => void;
}) {
  const { state, dispatch } = useStore();
  const dialog = useRef<HTMLDivElement>(null);
  const aborting = useRef<AbortController | null>(null);
  const [options, setOptions] = useState<GuideOptions | null>(null);
  const [catalog, setCatalog] = useState<CommunityEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [communityLoading, setCommunityLoading] = useState("");
  const [engineId, setEngineId] = useState("");
  const [seed, setSeed] = useState<WizardSeed | undefined>(initialSeed);
  const [goal, setGoal] = useState(initialSeed?.description ?? "");
  const [destination, setDestination] = useState<WizardDestination>(initialSeed && initialDestination.kind === "new"
    ? { kind: "new", name: initialDestination.name || initialSeed.name || "" } : initialDestination);
  const [phase, setPhase] = useState<"describe" | "questions" | "review" | "revision">("describe");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [draft, setDraft] = useState<WizardDraft | null>(null);
  const [lastSuggestion, setLastSuggestion] = useState<WizardDraft | null>(null);
  const [revision, setRevision] = useState<WizardDraft | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [audience, setAudience] = useState<VisibilityMode>("everyone");
  const [people, setPeople] = useState("");
  const [requestId, setRequestId] = useState(randomId);
  const [busy, setBusy] = useState<"assist" | "commit" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("[data-guide-goal]")?.focus();
    const controller = new AbortController();
    void api<GuideOptions>("/api/setup-wizard/options", { signal: controller.signal })
      .then(result => { setOptions(result); setEngineId(current => current || result.engines[0]?.instanceId || ""); })
      .catch(cause => { if (!controller.signal.aborted) setError(setupGuideError(cause)); });
    // An offline community catalog never prevents built-in templates or the
    // person's own request from being used.
    void api<{ teams: CommunityEntry[] }>("/api/team-library/catalog", { signal: controller.signal })
      .then(result => setCatalog(result.teams))
      .catch(() => { if (!controller.signal.aborted) setCatalogError(true); });
    return () => {
      controller.abort();
      aborting.current?.abort();
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    if (phase === "questions") dialog.current?.querySelector<HTMLElement>('[data-guide-answer="empty"]')?.focus();
    if (phase === "review") dialog.current?.querySelector<HTMLElement>("[data-guide-review-title]")?.focus();
  }, [phase, questions.length]);

  const close = () => {
    if (busy === "commit") return; // the receipt must stay available for a lost response retry
    aborting.current?.abort();
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && busy !== "commit") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const root = dialog.current;
    if (!root) return;
    const controls = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]')]
      .filter(item => item.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); root.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) { event.preventDefault(); first.focus(); }
  };

  const chooseSeed = (next: WizardSeed, team = false) => {
    setSeed(next); setGoal(next.description || `Set up ${next.name || "these roles"}`);
    if (team) setDestination({ kind: "new", name: next.name || "" });
    setQuestions([]); setAnswers([]); setDraft(null); setLastSuggestion(null); setRevision(null);
    setPhase("describe"); setError(""); setRequestId(randomId());
    dialog.current?.querySelector<HTMLElement>("[data-guide-goal]")?.focus();
  };

  const chooseCommunity = async (entry: CommunityEntry) => {
    setCommunityLoading(entry.slug); setError("");
    try {
      const manifest = await api(`/api/team-library/teams/${entry.slug}`);
      chooseSeed(communityWizardSeed(manifest), true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCommunityLoading(""); }
  };

  const models = options?.modelEngines.flatMap(engine => engine.models) ?? [];
  const activeEngineId = engineId || options?.engines[0]?.instanceId || "";
  const chosenDestination = phase === "describe" || phase === "questions" ? destination : draft?.destination ?? destination;
  const incumbent = state.bots.find(bot => bot.chiefOfStaff && (bot.section?.trim() || "") ===
    (chosenDestination.kind === "existing" ? chosenDestination.section : chosenDestination.name));

  const askGuide = async (feedback?: string) => {
    if (busy || !goal.trim() || !activeEngineId) return;
    const controller = new AbortController(); aborting.current = controller;
    setBusy("assist"); setError("");
    try {
      const response = await api<{ kind: "questions"; questions: string[] } | { kind: "draft"; draft: WizardDraft }>("/api/setup-wizard/assist", {
        method: "POST", signal: controller.signal, timeoutMs: 70_000,
        body: JSON.stringify({ instanceId: activeEngineId, goal: goal.trim(), destination: chosenDestination, seed,
          answers: questions.map((question, index) => ({ question, answer: answers[index]?.trim() || "No preference" })),
          ...(feedback ? { followUp: feedback.trim(), currentDraft: draft } : {}) }),
      });
      if (controller.signal.aborted) return;
      if (response.kind === "questions") {
        setQuestions(current => [...current, ...response.questions]);
        setPhase("questions");
      } else if (draft && feedback) {
        setRevision(response.draft); setPhase("revision");
      } else {
        setDraft(draft ? mergeWizardRevision(lastSuggestion, draft, response.draft) : response.draft);
        setLastSuggestion(response.draft); setPhase("review"); setRequestId(randomId());
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(setupGuideError(cause));
    } finally { if (aborting.current === controller) aborting.current = null; setBusy(null); }
  };

  const edit = (change: (current: WizardDraft) => WizardDraft) => {
    setDraft(current => current ? change(current) : current);
    setRequestId(randomId()); setError("");
  };
  const editBot = (key: string, patch: Partial<WizardBot>) => edit(current => ({ ...current,
    bots: current.bots.map(bot => bot.key === key ? { ...bot, ...patch } : bot) }));
  const addBot = () => edit(current => ({ ...current, bots: [...current.bots, {
    key: randomId(), name: "", title: "", description: "", soul: "",
    modelSelection: models[0] ? { instanceId: models[0].instanceId, model: models[0].model } : { instanceId: "", model: "" },
    appHints: [],
  }] }));

  const commit = async () => {
    if (!draft || busy) return;
    const visibility = visibilityFromForm(audience, people);
    if (!visibility.ok) { setError("Enter at least one email address or @domain for this visibility choice."); return; }
    setBusy("commit"); setError("");
    try {
      const result = await api<SetupWizardResult & { sections: string[] }>("/api/setup-wizard/commit", {
        method: "POST", timeoutMs: 70_000, body: JSON.stringify({ requestId, draft: { ...draft, visibility: visibility.visibility } }),
      });
      dispatch({ type: "sections", sections: result.sections });
      for (const bot of result.bots) dispatch({ type: "botAdded", bot, preserveSelection: true });
      if (result.bots[0]) dispatch({ type: "select", id: result.bots[0].id });
      try { onCreated?.(result); }
      catch (cause) { dispatch({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }); }
      onClose();
    } catch (cause) {
      setError(`${cause instanceof Error ? cause.message : String(cause)}. Retry uses the same request ID and cannot create a second batch.`);
    } finally { setBusy(null); }
  };

  const review = draft && phase !== "describe" && phase !== "questions";
  const visibilityReady = visibilityFromForm(audience, people).ok;
  const chiefReady = !draft?.chiefKey || (!incumbent && models.some(model => model.coordination &&
    draft.bots.some(bot => bot.key === draft.chiefKey && modelValue(bot.modelSelection) === modelValue(model))));

  return createPortal(<div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/65 p-3 sm:p-6"
    onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="setup-guide-title" aria-busy={busy !== null} tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex h-[min(830px,96dvh)] w-full max-w-[920px] flex-col overflow-hidden rounded-2xl border border-hairline/50 bg-panel text-ink shadow-2xl outline-none">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/40 px-5 py-4">
        <div className="flex items-center gap-2"><Sparkles size={19} className="text-accent" />
          <div><h2 id="setup-guide-title" className="text-[17px] font-semibold">Setup Guide</h2>
            <p className="text-[12px] text-ink-secondary">Draft first. Nothing is created until you review and confirm.</p></div>
        </div>
        <button type="button" aria-label="Close Setup Guide" disabled={busy === "commit"} onClick={close}
          className="rounded-lg p-2 text-ink-secondary hover:bg-raised disabled:opacity-50"><X size={18} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7">
        {!review && <div className="space-y-5">
          <label className="block text-[13px] font-medium">What should the bot or team help you do?
            <textarea data-guide-goal className={cn(field, "mt-2 min-h-24 resize-y")} value={goal} maxLength={4_000}
              onChange={event => setGoal(event.target.value)} placeholder="For example, research a market and bring me a sourced weekly brief." />
          </label>
          {phase === "describe" && <>
            <div><p className="mb-2 text-[12px] font-medium text-ink-secondary">Starter teams</p>
              <div className="grid gap-2 sm:grid-cols-3">{STARTER_TEAMS.map(team =>
                <button key={team.id} type="button" onClick={() => chooseSeed(team.seed, true)}
                  className="rounded-xl border border-hairline/40 bg-card px-3 py-3 text-left text-[13px] hover:border-accent/60">
                  <span className="font-medium">{team.label}</span><span className="mt-1 block text-[11px] text-ink-secondary">{team.seed.bots.length} editable roles</span>
                </button>)}</div></div>
            <div><p className="mb-2 text-[12px] font-medium text-ink-secondary">Single-bot roles</p>
              <div className="flex flex-wrap gap-2">{WIZARD_ROLES.map(role =>
                <button key={role.id} type="button" onClick={() => chooseSeed(seedFromRole(role))}
                  className="rounded-full bg-raised px-3 py-1.5 text-[12px] hover:bg-raised-hover">{role.title}</button>)}</div></div>
            <div><p className="mb-2 text-[12px] font-medium text-ink-secondary">Community templates</p>
              {catalogError ? <p role="status" className="text-[12px] text-ink-secondary">Community catalog is unavailable. Starter teams and your own request still work.</p>
                : catalog === null ? <p className="text-[12px] text-ink-secondary">Loading community templates…</p>
                  : <div className="flex flex-wrap gap-2">{catalog.length === 0 && <p className="text-[12px] text-ink-secondary">No community templates are listed yet.</p>}
                    {catalog.map(entry =>
                    <button key={entry.slug} type="button" disabled={Boolean(communityLoading)} onClick={() => void chooseCommunity(entry)}
                      title={entry.summary} className="rounded-full border border-hairline/40 px-3 py-1.5 text-[12px] hover:bg-raised disabled:opacity-50">
                      {communityLoading === entry.slug && <Loader2 size={12} className="mr-1 inline animate-spin" />}{entry.name}
                    </button>)}</div>}
              <p className="mt-1 text-[11px] text-ink-secondary">Only names and prompts seed this guide. Rooms, skills, routines and grants are not loaded.</p>
            </div>
          </>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] text-ink-secondary">Destination
              <select className={cn(field, "mt-1")} value={destination.kind} onChange={event => setDestination(event.target.value === "new"
                ? { kind: "new", name: seed?.name || "" } : { kind: "existing", section: initialDestination.kind === "existing" ? initialDestination.section : "" })}>
                <option value="existing">Existing team</option><option value="new">New team</option>
              </select>
            </label>
            {destination.kind === "existing" ? <label className="text-[12px] text-ink-secondary">Team
              <select className={cn(field, "mt-1")} value={destination.section} onChange={event => setDestination({ kind: "existing", section: event.target.value })}>
                {["", ...(state.sections ?? [])].map(name => <option key={name} value={name}>{visibleName(name)}</option>)}
              </select></label> : <label className="text-[12px] text-ink-secondary">New team name
              <input className={cn(field, "mt-1")} value={destination.name} maxLength={60} onChange={event => setDestination({ kind: "new", name: event.target.value })} placeholder="The guide can suggest one" />
            </label>}
          </div>
          {phase === "questions" && <fieldset className="space-y-3 rounded-xl bg-card p-4"><legend className="px-1 text-[13px] font-medium">A few questions before the draft</legend>
            {questions.map((question, index) => <label key={`${question}-${index}`} className="block text-[12px] text-ink-secondary">{question}
              <input data-guide-answer={answers[index] ? "filled" : "empty"} className={cn(field, "mt-1")} value={answers[index] ?? ""} maxLength={2_000}
                onChange={event => setAnswers(current => { const next = [...current]; next[index] = event.target.value; return next; })} placeholder="Your answer, or leave blank for no preference" />
            </label>)}</fieldset>}
          <label className="block text-[12px] text-ink-secondary">Guide engine
            <select className={cn(field, "mt-1")} value={activeEngineId} onChange={event => setEngineId(event.target.value)} disabled={!options?.engines.length || busy === "assist"}>
              {(options?.engines ?? []).map(engine => <option key={engine.instanceId} value={engine.instanceId}>{engine.label}</option>)}
            </select>
          </label>
          {options && options.engines.length === 0 && <p role="status" className="text-[13px] text-ink-secondary">Connect a supported engine in Settings → Engines to use the guide. Manual creation is still available.</p>}
          {options?.maxBots === 0 && <p role="status" className="text-[13px] text-ink-secondary">This workspace is at its bot limit; archive or remove a bot before creating more.</p>}
        </div>}

        {review && draft && <div className="space-y-5">
          <div tabIndex={-1} data-guide-review-title className="outline-none"><h3 className="text-[16px] font-semibold">Review your draft</h3>
            <p className="mt-1 text-[12px] text-ink-secondary">Every name, instruction and exact model remains editable. No existing bot or conversation is changed.</p></div>
          {phase === "revision" && revision && <div className="rounded-xl border border-accent/40 bg-accent/5 p-4 text-[13px]">
            <p className="font-medium">Proposed revision ready for review</p>
            <p className="mt-1 text-ink-secondary">{revision.bots.map(bot => `${bot.name} (${bot.title})`).join(", ")}. Your manual edits will be kept field by field.</p>
            <div className="mt-3 flex gap-2"><button type="button" onClick={() => { const merged = mergeWizardRevision(lastSuggestion, draft, revision);
              setDraft(merged); setLastSuggestion(revision); setRevision(null); setFollowUp(""); setRequestId(randomId()); setPhase("review"); }}
              className="rounded-lg bg-accent px-3 py-2 text-white">Apply revision</button>
              <button type="button" onClick={() => { setRevision(null); setPhase("review"); }} className="rounded-lg bg-raised px-3 py-2">Keep current draft</button></div>
          </div>}
          <fieldset disabled={busy === "commit" || phase === "revision"} className="space-y-5 disabled:opacity-70">
            <div className="grid gap-3 sm:grid-cols-2"><label className="text-[12px] text-ink-secondary">Destination
              <select className={cn(field, "mt-1")} value={draft.destination.kind} onChange={event => edit(current => ({ ...current,
                destination: event.target.value === "new" ? { kind: "new", name: seed?.name || "" } : { kind: "existing", section: "" },
                teamBrief: event.target.value === "new" ? current.teamBrief : "", chiefKey: null }))}>
                <option value="existing">Existing team</option><option value="new">New team</option></select></label>
              {draft.destination.kind === "new" ? <label className="text-[12px] text-ink-secondary">New team name
                <input className={cn(field, "mt-1")} value={draft.destination.name} maxLength={60} onChange={event => edit(current => ({ ...current,
                  destination: { kind: "new", name: event.target.value } }))} />
              </label> : <label className="text-[12px] text-ink-secondary">Existing team
                <select className={cn(field, "mt-1")} value={draft.destination.section} onChange={event => edit(current => ({ ...current,
                  destination: { kind: "existing", section: event.target.value }, chiefKey: null }))}>
                  {["", ...(state.sections ?? [])].map(name => <option key={name} value={name}>{visibleName(name)}</option>)}</select>
              </label>}
            </div>
            {draft.destination.kind === "new" ? <label className="block text-[12px] text-ink-secondary">Shared team brief
              <textarea className={cn(field, "mt-1 min-h-20")} value={draft.teamBrief} onChange={event => edit(current => ({ ...current, teamBrief: event.target.value }))} />
            </label> : <p className="text-[12px] text-ink-secondary">The existing {visibleName(draft.destination.section)} team’s shared brief stays unchanged.</p>}

            <div><div className="flex items-center justify-between"><h4 className="text-[13px] font-medium">New bots ({draft.bots.length}/8)</h4>
              <button type="button" disabled={draft.bots.length >= Math.min(8, options?.maxBots ?? 8)} onClick={addBot}
                className="flex items-center gap-1 text-[12px] text-accent disabled:opacity-50"><Plus size={14} /> Add bot</button></div>
              <div className="mt-2 space-y-3">{draft.bots.map((bot, index) => {
                const choice = models.find(option => modelValue(option) === modelValue(bot.modelSelection));
                return <section key={bot.key} aria-label={`Bot ${index + 1}`} className="rounded-xl border border-hairline/40 bg-card p-4">
                  <div className="mb-3 flex items-center justify-between"><span className="text-[13px] font-medium">Bot {index + 1}{draft.chiefKey === bot.key ? " · Chief of Staff" : ""}</span>
                    <button type="button" aria-label={`Remove ${bot.name || `bot ${index + 1}`}`} disabled={draft.bots.length <= 1} onClick={() => edit(current => ({ ...current,
                      bots: current.bots.filter(item => item.key !== bot.key), chiefKey: current.chiefKey === bot.key ? null : current.chiefKey }))}
                      className="rounded p-1.5 text-ink-secondary hover:bg-raised disabled:opacity-40"><Trash2 size={15} /></button></div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-[12px] text-ink-secondary">Name<input className={cn(field, "mt-1")} value={bot.name} maxLength={100} onChange={event => editBot(bot.key, { name: event.target.value })} /></label>
                    <label className="text-[12px] text-ink-secondary">Role<input className={cn(field, "mt-1")} value={bot.title} maxLength={200} onChange={event => editBot(bot.key, { title: event.target.value })} /></label>
                  </div>
                  <label className="mt-3 block text-[12px] text-ink-secondary">Description
                    <textarea className={cn(field, "mt-1 min-h-14")} value={bot.description} maxLength={4_000} onChange={event => editBot(bot.key, { description: event.target.value })} /></label>
                  <label className="mt-3 block text-[12px] text-ink-secondary">Standing instructions
                    <textarea className={cn(field, "mt-1 min-h-28")} value={bot.soul} onChange={event => editBot(bot.key, { soul: event.target.value })} /></label>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="text-[12px] text-ink-secondary">Exact engine and model
                    <select aria-label={`${bot.name || `Bot ${index + 1}`} model`} className={cn(field, "mt-1")} value={modelValue(bot.modelSelection)}
                      onChange={event => { const next = models.find(option => modelValue(option) === event.target.value);
                        if (next) editBot(bot.key, { modelSelection: { instanceId: next.instanceId, model: next.model } }); }}>
                      {!choice && <option value={modelValue(bot.modelSelection)}>Unavailable: {bot.modelSelection.model}</option>}
                      {options?.modelEngines.map(engine => <optgroup key={engine.instanceId} label={engine.label}>{engine.models.map(option =>
                        <option key={modelValue(option)} value={modelValue(option)}>{option.label}{option.coordination ? " · coordination" : ""}</option>)}</optgroup>)}
                    </select></label>
                    {choice?.effortLevels.length ? <label className="text-[12px] text-ink-secondary">Reasoning effort
                      <select className={cn(field, "mt-1")} value={bot.modelSelection.effort ?? ""} onChange={event => editBot(bot.key, { modelSelection: {
                        ...bot.modelSelection, ...(event.target.value ? { effort: event.target.value as ModelSelection["effort"] } : { effort: undefined }) } })}>
                        <option value="">Model default</option>{choice.effortLevels.map(level => <option key={level} value={level}>{level}</option>)}
                      </select></label> : null}</div>
                  {bot.appHints.length > 0 && <p className="mt-2 text-[11px] text-ink-secondary">Possible connections: {bot.appHints.join(", ")} (not connected)</p>}
                </section>;
              })}</div>
            </div>

            <div className="rounded-xl bg-raised/40 p-4 text-[12px]"><label className="block font-medium">Chief of Staff grant
              <select className={cn(field, "mt-2")} value={draft.chiefKey ?? ""} disabled={Boolean(incumbent && !draft.chiefKey)}
                onChange={event => edit(current => ({ ...current, chiefKey: event.target.value || null }))}>
                <option value="">No new Chief</option>{draft.bots.map(bot => {
                  const choice = models.find(model => modelValue(model) === modelValue(bot.modelSelection));
                  return <option key={bot.key} value={bot.key} disabled={Boolean(incumbent) || !choice?.coordination}>{bot.name || "Unnamed bot"}{choice?.coordination ? "" : " (needs coordination model)"}</option>;
                })}</select></label>
              {incumbent ? <p className="mt-2 text-ink-secondary">@{incumbent.name} remains this team’s Chief. This wizard cannot replace them.</p>
                : <p className="mt-2 text-ink-secondary">A selected Chief can coordinate and propose bot changes within this team. It receives no access to other teams. Turning this off removes the coordination-model requirement.</p>}
              {!chiefReady && <p role="alert" className="mt-2 text-danger">Choose a coordination-capable model for the selected Chief, or select No new Chief.</p>}
            </div>
            <div className="rounded-xl bg-raised/40 p-4 text-[12px]"><label className="font-medium">Admin-web visibility for every new bot
              <select className={cn(field, "mt-2")} value={audience} onChange={event => {
                setAudience(event.target.value as VisibilityMode); setRequestId(randomId()); setError("");
              }}>
                <option value="everyone">Everyone in this workspace</option><option value="admins">Admins only</option><option value="people">Specific people plus admins</option>
              </select></label>
              {audience === "people" && <label className="mt-2 block text-ink-secondary">Email addresses or @domains
                <textarea className={cn(field, "mt-1 min-h-16")} value={people} placeholder="person@example.com, @example.com"
                  onChange={event => { setPeople(event.target.value); setRequestId(randomId()); setError(""); }} /></label>}
              {audience === "people" && !visibilityReady && <p className="mt-1 text-danger">Enter at least one address before creating.</p>}
            </div>
          </fieldset>
          {phase !== "revision" && <div className="rounded-xl border border-hairline/40 p-4"><label className="text-[12px] font-medium">Ask for a revision
            <textarea className={cn(field, "mt-2 min-h-16")} value={followUp} maxLength={2_000} onChange={event => setFollowUp(event.target.value)}
              placeholder="For example, add a reviewer and make the instructions more concise." /></label>
            <button type="button" disabled={busy !== null || !followUp.trim()} onClick={() => void askGuide(followUp)}
              className="mt-2 flex items-center gap-1.5 rounded-lg bg-raised px-3 py-2 text-[12px] disabled:opacity-50">
              {busy === "assist" && <Loader2 size={13} className="animate-spin" />} Propose revision</button></div>}
        </div>}
      </div>
      {error && <p role="alert" className="max-h-20 overflow-y-auto border-t border-hairline/40 px-5 py-2 text-[12px] text-danger">{error}</p>}
      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-hairline/40 px-5 py-3">
        <p className="max-w-xl text-[11px] text-ink-secondary"><Check size={12} className="mr-1 inline" /> New bots start in Ask with apps, MCP servers, browser and computer access off. No rooms, routines, skills or credentials are added.</p>
        <div className="flex gap-2">
          {review && <button type="button" disabled={busy === "commit"} onClick={() => { setDestination(draft.destination); setPhase("describe"); }}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-[12px] text-ink-secondary hover:bg-raised"><ArrowLeft size={14} /> Back</button>}
          {!review ? <button type="button" disabled={!activeEngineId || !options?.maxBots || !goal.trim() || busy === "assist"} onClick={() => void askGuide()}
            className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">
            {busy === "assist" && <Loader2 size={14} className="animate-spin" />}{phase === "questions" ? "Continue" : "Draft setup"}</button>
            : <button type="button" disabled={busy !== null || phase === "revision" || !visibilityReady || !chiefReady || !draft?.bots.length || draft.bots.some(bot => !bot.name.trim() || !bot.title.trim() || !bot.soul.trim())}
              onClick={() => void commit()} className="flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50">
              {busy === "commit" && <Loader2 size={14} className="animate-spin" />}Create {draft?.bots.length ?? 0} {draft?.bots.length === 1 ? "bot" : "bots"}</button>}
        </div>
      </footer>
    </div>
  </div>, document.body);
}
