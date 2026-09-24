import { CheckCircle2, Circle, CircleAlert, Loader2 } from "lucide-react";
import type { WorkItem } from "../../../shared/work-item";
import type { LinkedItem, TaskEvent } from "../../../shared/work-links";
import { t } from "@/lib/i18n";
import { LinkChip } from "./LinkChip";
import { taskCriteria, type TaskConnectorManifest } from "./model";

export function CriteriaList({ item, links = [], events = [], connectors = [] }: {
  item: WorkItem; links?: readonly LinkedItem[]; events?: readonly TaskEvent[]; connectors?: readonly TaskConnectorManifest[];
}) {
  return <ul aria-label={t("work.criteria")} className="space-y-2">
    {taskCriteria(item).map(criterion => {
      const Icon = criterion.state === "checked" ? CheckCircle2 : criterion.state === "blocked" ? CircleAlert
        : criterion.state === "in_progress" ? Loader2 : Circle;
      return <li key={criterion.id} data-criterion-id={criterion.id} data-criterion-state={criterion.state} className="min-w-0">
        <div className="flex items-start gap-2">
          <Icon size={14} aria-hidden="true" className={`mt-0.5 shrink-0 ${criterion.state === "checked" ? "text-success" : criterion.state === "blocked" ? "text-danger" : criterion.state === "in_progress" ? "animate-spin text-accent" : "text-ink-secondary"}`} />
          <div className="min-w-0 flex-1">
            <p className="break-words text-ink">{criterion.text}</p>
            <p className="text-[11px] text-ink-secondary">{t(`work.criterion.${criterion.state}`)}</p>
            {criterion.evidence.length > 0 && <div aria-label={t("work.evidenceFor", { text: criterion.text })} className="mt-1 flex flex-wrap gap-1">
              {criterion.evidence.map(id => {
                const link = links.find(candidate => candidate.id === id);
                if (link) return <LinkChip key={id} item={link} connectors={connectors} />;
                const event = events.find(candidate => candidate.id === id);
                return <span key={id} data-evidence-id={id} className="rounded-full border border-hairline/40 px-2 py-0.5 text-[11px] text-ink-secondary">{event?.summary ?? id}</span>;
              })}
            </div>}
          </div>
        </div>
      </li>;
    })}
  </ul>;
}
