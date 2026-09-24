import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LINK_ROLES, type LinkRole } from "../../../shared/work-links";
import { t } from "@/lib/i18n";

export function LinkItemDialog({ open, pending, error, onClose, onSubmit }: {
  open: boolean;
  pending: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (input: { refOrUrl: string; role: LinkRole; title?: string }) => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const [refOrUrl, setRefOrUrl] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<LinkRole>("reference");
  useEffect(() => {
    if (!open) return;
    setRefOrUrl("");
    setTitle("");
    setRole("reference");
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="link-item-title" tabIndex={-1}
        className="w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-4 shadow-2xl">
        <h2 id="link-item-title" className="text-[15px] font-semibold text-ink">{t("work.linkItem")}</h2>
        <p className="mt-1 text-[13px] text-ink-secondary">{t("work.linkItemHelp")}</p>
        <form className="mt-3 flex flex-col gap-3" onSubmit={event => {
          event.preventDefault();
          onSubmit({ refOrUrl: refOrUrl.trim(), role, ...(title.trim() ? { title: title.trim() } : {}) });
        }}>
          <label className="text-[13px] text-ink">{t("work.linkItemRef")}
            <input required value={refOrUrl} onChange={event => setRefOrUrl(event.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline/40 bg-raised/40 px-2 py-1.5 text-[13px] text-ink" />
          </label>
          <label className="text-[13px] text-ink">{t("work.linkItemTitle")}
            <input value={title} onChange={event => setTitle(event.target.value)}
              className="mt-1 w-full rounded-lg border border-hairline/40 bg-raised/40 px-2 py-1.5 text-[13px] text-ink" />
          </label>
          <label className="text-[13px] text-ink">{t("work.linkItemRole")}
            <select value={role} onChange={event => setRole(event.target.value as LinkRole)}
              className="mt-1 w-full rounded-lg border border-hairline/40 bg-raised/40 px-2 py-1.5 text-[13px] text-ink">
              {LINK_ROLES.map(value => <option key={value} value={value}>{t(`work.role.${value}`)}</option>)}
            </select>
          </label>
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-xl px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised">{t("work.linkItemCancel")}</button>
            <button type="submit" disabled={pending || !refOrUrl.trim()} className="rounded-xl bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50">{t("work.linkItemSubmit")}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
