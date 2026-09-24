import { useEffect, useRef, useState } from "react";
import { api, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import type { OngoingGoal } from "../../shared/ongoing-goal";

export function OngoingGoalPanel({ ownerBots, sourceThreadId, open, onClose, onOpen, initialObjective }: {
  ownerBots: Bot[];
  sourceThreadId: string;
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  initialObjective: string;
}) {
  const [goals, setGoals] = useState<OngoingGoal[]>([]);
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
    const refresh = () => { void api<{ goals: OngoingGoal[] }>("/api/goals")
      .then(result => { if (live) setGoals(result.goals.filter(goal => goal.sourceThreadId === sourceThreadId)); })
      .catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [sourceThreadId]);

  const refresh = async () => {
    const result = await api<{ goals: OngoingGoal[] }>("/api/goals");
    setGoals(result.goals.filter(goal => goal.sourceThreadId === sourceThreadId));
  };
  const create = async () => {
    if (creating) return;
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setCreating(false); }
  };
  const control = async (goal: OngoingGoal, action: "pause" | "resume" | "stop" | "wake") => {
    try {
      setError("");
      await api(`/api/goals/${goal.id}`, { method: "PATCH", body: JSON.stringify({ expectedRevision: goal.revision, action }) });
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  if (!open && !goals.length) return null;
  return (
    <section aria-label={t("goal.panel.title")} className="mb-2 rounded-xl border border-hairline/40 bg-card p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <strong>{t("goal.panel.title")}</strong>
        <button type="button" onClick={open ? onClose : onOpen} className="text-accent">{open ? t("goal.panel.close") : t("goal.panel.new")}</button>
      </div>
      {goals.slice(-5).map(goal => (
        <div key={goal.id} className="mt-2 border-t border-hairline/30 pt-2">
          <div className="font-medium">{goal.objective} · {goal.status}</div>
          <div className="text-ink-secondary">{goal.detail}</div>
          {!goal.criteriaPending && <div className="text-ink-secondary">{t("goal.panel.checks")}: {goal.acceptanceCriteria.join(" · ")}</div>}
          {goal.nextAction && <div>{t("goal.panel.next")}: {goal.nextAction}</div>}
          {goal.evidence.length > 0 && <div className="text-ink-secondary">{goal.evidence.slice(-3).join(" · ")}</div>}
          {goal.nextWakeAt && <div>{t("goal.panel.check")}: {new Date(goal.nextWakeAt).toLocaleString()}</div>}
          <div className="text-ink-secondary">{goal.actions}/{goal.maxActions} {t("goal.panel.actions")} · {goal.workItemIds.length} {t("goal.panel.linked")}</div>
          <div className="flex gap-3 text-accent">
            {(["working", "waiting"].includes(goal.status)) && <>
              <button type="button" onClick={() => { void control(goal, "wake"); }}>{t("goal.panel.checkNow")}</button>
              <button type="button" onClick={() => { void control(goal, "pause"); }}>{t("goal.panel.pause")}</button>
            </>}
            {(["paused", "needs-input"].includes(goal.status)) && <button type="button" onClick={() => { void control(goal, "resume"); }}>{t("goal.panel.resume")}</button>}
            {!(["completed", "stopped"].includes(goal.status)) && <button type="button" onClick={() => { void control(goal, "stop"); }}>{t("goal.panel.stop")}</button>}
          </div>
        </div>
      ))}
      {open && <div className="mt-3 grid gap-2 border-t border-hairline/30 pt-3">
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
