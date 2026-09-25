import { useEffect, useRef, useState } from "react";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { subscribeGoalLive } from "@/lib/goal-live";
import { createSerialRefresh, startWorkFallbackPoll } from "@/lib/serial-refresh";
import { useGoalCapabilities } from "@/lib/use-goal-capabilities";
import type { GoalCapabilities } from "@/lib/session";
import type { OngoingGoal } from "../../shared/ongoing-goal";

export function goalRequestError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function goalStatusLabel(status: string): string {
  switch (status) {
    case "working": return t("goal.status.working");
    case "waiting": return t("goal.status.waiting");
    case "paused": return t("goal.status.paused");
    case "needs-input": return t("goal.status.needs-input");
    case "completed": return t("goal.status.completed");
    case "stopped": return t("goal.status.stopped");
    default: return status;
  }
}

export async function loadThreadGoals(sourceThreadId: string, request: typeof api = api): Promise<OngoingGoal[]> {
  const result = await request<{ goals: OngoingGoal[] }>("/api/goals");
  return result.goals.filter(goal => goal.sourceThreadId === sourceThreadId);
}

export function OngoingGoalPanel({ ownerBots, sourceThreadId, open, onClose, onOpen, initialObjective, capabilities, initialGoals = [] }: {
  ownerBots: Bot[];
  sourceThreadId: string;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  initialObjective: string;
  capabilities?: GoalCapabilities;
  initialGoals?: OngoingGoal[];
}) {
  const sessionCaps = useGoalCapabilities();
  const caps = capabilities ?? sessionCaps;
  const [goals, setGoals] = useState<OngoingGoal[]>(initialGoals);
  const [objective, setObjective] = useState(initialObjective);
  const [ownerBotId, setOwnerBotId] = useState(ownerBots[0]?.id ?? "");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const requestId = useRef<string | null>(null);

  useEffect(() => { setObjective(initialObjective); requestId.current = null; }, [initialObjective]);
  useEffect(() => {
    if (!ownerBots.some(bot => bot.id === ownerBotId)) setOwnerBotId(ownerBots[0]?.id ?? "");
  }, [ownerBots, ownerBotId]);
  useEffect(() => {
    let live = true;
    const poll = createSerialRefresh(async request => {
      try {
        const next = await loadThreadGoals(sourceThreadId);
        if (live && poll.isCurrent(request)) { setGoals(next); setError(""); }
      } catch (cause) {
        if (live && poll.isCurrent(request)) setError(goalRequestError(cause));
      }
    });
    const refresh = () => { void poll.refresh(); };
    refresh();
    const stopPoll = startWorkFallbackPoll(refresh);
    const stopLive = subscribeGoalLive(frame => {
      if (frame.sourceThreadId === sourceThreadId) refresh();
    });
    return () => { live = false; poll.invalidate(); stopPoll(); stopLive(); };
  }, [sourceThreadId]);

  const refresh = async () => {
    setGoals(await loadThreadGoals(sourceThreadId));
  };
  const create = async () => {
    if (creating || !caps.canCreate) return;
    try {
      setError("");
      setCreating(true);
      requestId.current ??= crypto.randomUUID();
      await api("/api/goals", { method: "POST", body: JSON.stringify({
        requestId: requestId.current, ownerBotId, sourceThreadId, objective,
      }) });
      await refresh();
      requestId.current = null;
      onClose();
    } catch (cause) { setError(goalRequestError(cause)); }
    finally { setCreating(false); }
  };
  const control = async (goal: OngoingGoal, action: "pause" | "resume" | "stop" | "wake") => {
    if (action === "resume" ? !caps.canResume : !caps.canControl) return;
    try {
      setError("");
      await api(`/api/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: goal.revision, action }) });
      await refresh();
    } catch (cause) { setError(goalRequestError(cause)); }
  };

  if (!open && !goals.length && !error) return null;
  return (
    <section aria-label={t("goal.panel.title")} className="mb-2 rounded-xl border border-hairline/40 bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong>{t("goal.panel.title")}</strong>
        {(open || caps.canCreate) && <button type="button" onClick={open ? onClose : onOpen} className="text-accent">{open ? t("goal.panel.close") : t("goal.panel.new")}</button>}
      </div>
      {goals.length > 5 && <p className="mt-2 text-xs text-ink-secondary">{t("goal.panel.latest", { count: 5 })}</p>}
      {goals.slice(-5).map(goal => (
        <div key={goal.id} className="mt-2 border-t border-hairline/30 pt-2">
          <div className="font-medium">{goal.objective} · {goalStatusLabel(goal.status)}</div>
          <div className="text-ink-secondary">{goal.detail}</div>
          {!goal.criteriaPending && <div className="text-ink-secondary">{t("goal.panel.checks")}: {goal.acceptanceCriteria.join(" · ")}</div>}
          {goal.nextAction && <div>{t("goal.panel.next")}: {goal.nextAction}</div>}
          {goal.evidence.length > 0 && <div className="text-ink-secondary">{goal.evidence.slice(-3).join(" · ")}</div>}
          {goal.nextWakeAt && <div>{t("goal.panel.check")}: {new Date(goal.nextWakeAt).toLocaleString()}</div>}
          <div className="text-ink-secondary">{goal.actions}/{goal.maxActions} {t("goal.panel.actions")} · {goal.workItemIds.length} {t("goal.panel.linked")}</div>
          <div className="flex gap-3 text-accent">
            {caps.canControl && (["working", "waiting"].includes(goal.status)) && <>
              <button type="button" onClick={() => { void control(goal, "wake"); }}>{t("goal.panel.checkNow")}</button>
              <button type="button" onClick={() => { void control(goal, "pause"); }}>{t("goal.panel.pause")}</button>
            </>}
            {caps.canResume && (["paused", "needs-input"].includes(goal.status)) && <button type="button" onClick={() => { void control(goal, "resume"); }}>{t("goal.panel.resume")}</button>}
            {caps.canControl && !(["completed", "stopped"].includes(goal.status)) && <button type="button" onClick={() => { void control(goal, "stop"); }}>{t("goal.panel.stop")}</button>}
          </div>
        </div>
      ))}
      {open && caps.canCreate && <div className="mt-3 grid gap-2 border-t border-hairline/30 pt-3">
        {ownerBots.length > 1 && <label>{t("goal.panel.owner")}
          <select value={ownerBotId} onChange={event => { setOwnerBotId(event.target.value); requestId.current = null; }} className="w-full bg-inset p-2">
            {ownerBots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>}
        <label>{t("goal.panel.outcome")}<textarea value={objective} onChange={event => { setObjective(event.target.value); requestId.current = null; }} className="w-full bg-inset p-2" /></label>
        <p className="text-ink-secondary">{t("goal.panel.autoPlan")}</p>
        <button type="button" onClick={() => { void create(); }} disabled={creating || !ownerBotId || !objective.trim()} className="rounded-lg bg-accent p-2 text-white">{t("goal.panel.start")}</button>
      </div>}
      {error && <div role="alert" className="mt-2 text-danger">{error}</div>}
    </section>
  );
}
