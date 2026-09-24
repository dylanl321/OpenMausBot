import { t } from "@/lib/i18n";
import type { SettingField, TaskConnectorSecret } from "../work/model";

export function ConnectionSettingFields({
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
    <div className="space-y-3" data-connection-settings="">
      {fields.map((field) => {
        const value = values[field.key];
        if (field.type === "boolean") {
          return (
            <label key={field.key} className="flex items-start gap-2.5" data-connection-setting={field.key}>
              <input
                type="checkbox"
                checked={value === true}
                onChange={(event) => onChange(field.key, event.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="block text-[12px] font-medium text-ink">{field.label}</span>
                {field.help && <span className="mt-0.5 block text-[11px] leading-relaxed text-ink-secondary">{field.help}</span>}
              </span>
            </label>
          );
        }
        if (field.type === "enum") {
          return (
            <label key={field.key} className="block" data-connection-setting={field.key}>
              <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{field.label}</span>
              <select
                aria-label={field.label}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.key, event.target.value || undefined)}
                className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none focus:border-accent/70"
              >
                <option value="">{t("taskConnections.choose")}</option>
                {(field.enum ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              {field.help && <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{field.help}</span>}
            </label>
          );
        }
        return (
          <label key={field.key} className="block" data-connection-setting={field.key}>
            <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{field.label}</span>
            <input
              aria-label={field.label}
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

/** Password fields keyed by manifest secret names. Saved values never render. */
export function ConnectionSecretFields({
  secrets,
  drafts,
  savedKeys,
  onChange,
}: {
  secrets: TaskConnectorSecret[];
  drafts: Record<string, string>;
  savedKeys: readonly string[];
  onChange: (key: string, value: string) => void;
}) {
  if (!secrets.length) return null;
  const saved = new Set(savedKeys);
  return (
    <div className="space-y-3" data-connection-secrets="">
      <p className="text-[11px] leading-relaxed text-ink-secondary">{t("taskConnections.editor.secretHelp")}</p>
      {secrets.map((secret) => {
        const kept = saved.has(secret.key);
        return (
          <label key={secret.key} className="block" data-connection-secret={secret.key}>
            <span className="mb-1.5 block text-[11.5px] font-medium text-ink-secondary">{secret.label}</span>
            <input
              aria-label={secret.label}
              type="password"
              autoComplete="new-password"
              value={drafts[secret.key] ?? ""}
              placeholder={kept ? t("taskConnections.editor.secretSaved") : undefined}
              onChange={(event) => onChange(secret.key, event.target.value)}
              className="w-full rounded-xl border border-hairline/60 bg-panel px-3.5 py-2.5 text-[13px] text-ink outline-none placeholder:text-ink-secondary/60 focus:border-accent/70"
            />
            {secret.help && <span className="mt-1.5 block text-[10.5px] leading-relaxed text-ink-secondary">{secret.help}</span>}
          </label>
        );
      })}
    </div>
  );
}
