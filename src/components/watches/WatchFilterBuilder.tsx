import { Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { WatchFilter } from "@/lib/watches";
import {
  FILTER_FIELDS,
  buildFilter,
  emptyFilterRow,
  fieldLabel,
  flattenFilter,
  type FilterRow,
} from "./model";

const fieldClass = "min-w-0 rounded-lg border border-hairline/50 bg-panel px-2.5 py-2 text-[12px] text-ink outline-none focus:border-accent/70";

export function WatchFilterBuilder({
  filter,
  onChange,
}: {
  filter?: WatchFilter;
  onChange: (filter: WatchFilter | undefined) => void;
}) {
  const parsed = useMemo(() => flattenFilter(filter), [filter]);
  const [mode, setMode] = useState<"all" | "any">(parsed && parsed !== "complex" ? parsed.mode : "all");
  const [rows, setRows] = useState<FilterRow[]>(parsed && parsed !== "complex" ? parsed.rows : []);
  const [customFields, setCustomFields] = useState<Record<string, string>>({});

  if (parsed === "complex") {
    return (
      <div className="rounded-xl border border-hairline/45 bg-inset/40 px-3.5 py-3 text-[12px] leading-relaxed text-ink-secondary" data-watch-filter="complex">
        {t("watches.filter.complex")}
        <button
          type="button"
          className="ml-2 text-accent hover:underline"
          onClick={() => { setRows([emptyFilterRow()]); onChange(undefined); }}
        >
          {t("watches.filter.reset")}
        </button>
      </div>
    );
  }

  const commit = (nextMode: "all" | "any", nextRows: FilterRow[]) => {
    setMode(nextMode);
    setRows(nextRows);
    onChange(buildFilter(nextMode, nextRows));
  };

  return (
    <div className="space-y-3" data-watch-filter="">
      <div className="flex items-center gap-2">
        <span className="text-[11.5px] font-medium text-ink-secondary">{t("watches.filter.match")}</span>
        <div className="flex rounded-lg border border-hairline/50 bg-panel p-0.5">
          {(["all", "any"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={mode === choice}
              onClick={() => commit(choice, rows)}
              className={cn("rounded-md px-2.5 py-1 text-[11px] font-medium", mode === choice ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}
            >
              {t(choice === "all" ? "watches.filter.all" : "watches.filter.any")}
            </button>
          ))}
        </div>
      </div>
      {rows.map((row) => {
        const known = (FILTER_FIELDS as readonly string[]).includes(row.field);
        const custom = customFields[row.id] ?? (known ? "" : row.field);
        return (
          <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline/40 bg-inset/30 p-2.5" data-watch-filter-row={row.field}>
            <label className="flex items-center gap-1.5 text-[11px] text-ink-secondary">
              <input type="checkbox" checked={Boolean(row.not)} onChange={(event) => commit(mode, rows.map((item) => item.id === row.id ? { ...item, not: event.target.checked } : item))} />
              {t("watches.filter.not")}
            </label>
            <select
              aria-label={t("watches.filter.field")}
              value={known ? row.field : "__custom__"}
              onChange={(event) => {
                const next = event.target.value;
                if (next === "__custom__") {
                  setCustomFields((current) => ({ ...current, [row.id]: row.field }));
                  commit(mode, rows.map((item) => item.id === row.id ? { ...item, field: "" } : item));
                  return;
                }
                commit(mode, rows.map((item) => item.id === row.id ? { ...item, field: next } : item));
              }}
              className={fieldClass}
            >
              {FILTER_FIELDS.map((field) => <option key={field} value={field}>{fieldLabel(field)}</option>)}
              <option value="__custom__">{t("watches.filter.custom")}</option>
            </select>
            {!known && (
              <input
                aria-label={t("watches.filter.customField")}
                value={custom}
                placeholder="fields.priority"
                onChange={(event) => {
                  setCustomFields((current) => ({ ...current, [row.id]: event.target.value }));
                  commit(mode, rows.map((item) => item.id === row.id ? { ...item, field: event.target.value } : item));
                }}
                className={cn(fieldClass, "w-[140px]")}
              />
            )}
            <select
              aria-label={t("watches.filter.operator")}
              value={row.op}
              onChange={(event) => commit(mode, rows.map((item) => item.id === row.id ? { ...item, op: event.target.value as FilterRow["op"] } : item))}
              className={fieldClass}
            >
              <option value="eq">{t("watches.filter.eq")}</option>
              <option value="in">{t("watches.filter.in")}</option>
              <option value="contains">{t("watches.filter.contains")}</option>
              <option value="changed">{t("watches.filter.changed")}</option>
            </select>
            {row.op === "changed" ? (
              <>
                <input aria-label={t("watches.filter.changedFrom")} value={row.changedFrom} placeholder={t("watches.filter.from")} onChange={(event) => commit(mode, rows.map((item) => item.id === row.id ? { ...item, changedFrom: event.target.value } : item))} className={cn(fieldClass, "w-[110px]")} />
                <input aria-label={t("watches.filter.changedTo")} value={row.changedTo} placeholder={t("watches.filter.to")} onChange={(event) => commit(mode, rows.map((item) => item.id === row.id ? { ...item, changedTo: event.target.value } : item))} className={cn(fieldClass, "w-[110px]")} />
              </>
            ) : (
              <input
                aria-label={t("watches.filter.value")}
                value={row.value}
                placeholder={row.op === "in" ? t("watches.filter.inHint") : undefined}
                onChange={(event) => commit(mode, rows.map((item) => item.id === row.id ? { ...item, value: event.target.value } : item))}
                className={cn(fieldClass, "min-w-[120px] flex-1")}
              />
            )}
            <button type="button" aria-label={t("watches.filter.remove")} onClick={() => commit(mode, rows.filter((item) => item.id !== row.id))} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink">
              <X size={13} />
            </button>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => commit(mode, [...rows, emptyFilterRow()])}
        className="flex items-center gap-1.5 text-[12px] text-accent hover:underline"
      >
        <Plus size={13} />{t("watches.filter.add")}
      </button>
    </div>
  );
}
