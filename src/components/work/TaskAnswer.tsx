import { useState } from "react";
import type { WorkItem } from "../../../shared/work-item";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";

export function TaskAnswer({ item }: { item: WorkItem }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (item.status !== "needs-input") return null;

  const submit = async () => {
    const answer = text.trim();
    if (!answer) return;
    setPending(true);
    setError("");
    try {
      await api(`/api/work-items/${item.id}/answer`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: item.revision, text: answer }),
      });
      setText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPending(false);
    }
  };

  return <form data-task-answer={item.id} className="mt-2 space-y-1.5" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p className="whitespace-pre-wrap text-xs text-warning">{item.detail || t("work.status.needs-input")}</p>
    <label className="block">
      <span className="sr-only">{t("work.answer")}</span>
      <textarea value={text} onChange={event => setText(event.target.value)} rows={3} required
        placeholder={t("work.answerPlaceholder")}
        className="w-full resize-y rounded-md border border-hairline/50 bg-app px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none" />
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <button type="submit" disabled={pending || !text.trim()}
        className="rounded-md border border-hairline/50 bg-raised px-2 py-1 text-[11px] text-ink hover:bg-raised-hover disabled:opacity-50">
        {t("work.answerSubmit")}
      </button>
      <span className="text-[10.5px] text-ink-secondary">{t("work.answerHelp")}</span>
    </div>
    {error && <p role="alert" className="text-xs text-danger">{error}</p>}
  </form>;
}
