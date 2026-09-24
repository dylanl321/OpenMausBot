import { t } from "@/lib/i18n";
import type { SettingField } from "../work/model";

export function WatchScopeFields({
  fields,
  values,
  onChange,
}: {
  fields: SettingField[];
  values: Record<string, string | number | boolean | undefined>;
  onChange: (key: string, value: string | number | boolean | undefined) => void;
}) {
  if (!fields.length) return null;
  return (
    <div className="space-y-3" data-watch-scopes="">
      {fields.map((field) => {
        const value = values[field.key];
        const label = field.label;
        if (field.type === "boolean") {
          return (
            <label key={field.key} className="flex items-start gap-2.5" data-watch-scope={field.key}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(field.key, event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[12px] font-medium text-ink">{label}</span>
                {field.help && <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{field.help}</span>}
              </span>
            </label>
          );
        }
        if (field.type === "enum") {
          return (
            <label key={field.key} className="block" data-watch-scope={field.key}>
              <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{label}</span>
              <select
                aria-label={label}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.key, event.target.value || undefined)}
                className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70"
              >
                <option value="">{t("watches.choose")}</option>
                {(field.enum ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              {field.help && <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{field.help}</span>}
            </label>
          );
        }
        return (
          <label key={field.key} className="block" data-watch-scope={field.key}>
            <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{label}</span>
            <input
              aria-label={label}
              type={field.type === "number" ? "number" : "text"}
              value={value == null ? "" : String(value)}
              onChange={(event) => {
                if (field.type === "number") {
                  const next = event.target.value;
                  onChange(field.key, next === "" ? undefined : Number(next));
                  return;
                }
                onChange(field.key, event.target.value);
              }}
              className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
            {field.help && <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{field.help}</span>}
          </label>
        );
      })}
    </div>
  );
}
