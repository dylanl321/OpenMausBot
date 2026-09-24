import { Radar } from "lucide-react";
import { t } from "@/lib/i18n";
import type { Routine } from "@/lib/routines";
import { pollingRoutineHint } from "./model";

export function ConvertToWatchHint({
  routine,
  onConvert,
}: {
  routine: Routine;
  onConvert: (routine: Routine) => void;
}) {
  if (!pollingRoutineHint(routine)) return null;
  return (
    <div className="mt-2 flex items-start gap-2 rounded-lg bg-accent/5 px-2.5 py-2 text-[11.5px] leading-relaxed text-ink-secondary" data-convert-to-watch="">
      <Radar size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <span>
        {t("watches.convert.hint")}
        {" "}
        <button
          type="button"
          onClick={() => onConvert(routine)}
          className="font-medium text-accent hover:underline"
          aria-label={t("watches.convert.actionFor", { name: routine.name })}
        >
          {t("watches.convert.action")}
        </button>
      </span>
    </div>
  );
}
