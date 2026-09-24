import type { WorkItem } from "../../../shared/work-item";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { progressCounts, progressSegments } from "./model";

const TONE = {
  done: "bg-success",
  active: "bg-accent",
  blocked: "bg-danger",
  pending: "bg-hairline/50",
} as const;

export function ProgressStrip({ item }: { item: WorkItem }) {
  const segments = progressSegments(item);
  const counts = progressCounts(item);
  if (segments.length === 0) return null;
  return <div className="mt-3 min-w-0" data-progress-strip
    aria-label={t("work.progress", { criteria: `${counts.criteriaDone}/${counts.criteriaTotal}`, assignments: `${counts.assignmentsDone}/${counts.assignmentsTotal}` })}>
    <div className="flex h-1.5 overflow-hidden rounded-full bg-hairline/30">
      {segments.map(segment => <span key={`${segment.source}:${segment.id}`} title={segment.label} data-progress-tone={segment.tone}
        data-progress-source={segment.source} className={cn("min-w-0 flex-1 first:rounded-l-full last:rounded-r-full", TONE[segment.tone])} />)}
    </div>
    <p className="mt-1 text-[11px] text-ink-secondary">
      {t("work.progressCriteria", { done: counts.criteriaDone, total: counts.criteriaTotal })}
      {counts.assignmentsTotal > 0 ? ` · ${t("work.progressAssignments", { done: counts.assignmentsDone, total: counts.assignmentsTotal })}` : ""}
    </p>
  </div>;
}
