import {
  ArrowRightLeft,
  ListChecks,
  MessageSquareText,
  Package,
  RefreshCw,
  Scale,
  Shuffle,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { LinkedItem, TaskEvent } from "../../../shared/work-links";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { LinkChip } from "./LinkChip";
import type { TaskConnectorManifest } from "./model";
import { ClaimedMarker } from "./ProviderMark";

const ICONS: Record<TaskEvent["kind"], LucideIcon> = {
  tool: Wrench,
  output: Package,
  state_change: ArrowRightLeft,
  comment: MessageSquareText,
  handoff: Shuffle,
  decision: Scale,
  criterion: ListChecks,
  lifecycle: RefreshCw,
};

function actorLabel(actor: TaskEvent["actor"], bots: Array<{ id: string; name: string }>) {
  if (actor.type === "user") return t("work.actor.user");
  if (actor.type === "system") return t("work.actor.system");
  if (actor.type === "bot") return bots.find(bot => bot.id === actor.botId)?.name ?? actor.botId;
  return t("work.actor.connector", { name: actor.connectionId });
}

export function EventRow({ event, links = [], connectors = [] }: {
  event: TaskEvent; links?: readonly LinkedItem[]; connectors?: readonly TaskConnectorManifest[];
}) {
  const { state } = useStore();
  const Icon = ICONS[event.kind];
  const link = event.linkId ? links.find(candidate => candidate.id === event.linkId) : undefined;
  return <li data-event-id={event.id} data-event-kind={event.kind} className="flex min-w-0 gap-2 py-1.5">
    <Icon size={13} aria-label={t(`work.event.${event.kind}`)} className="mt-0.5 shrink-0 text-ink-secondary" />
    <div className="min-w-0 flex-1">
      <p className="break-words text-ink">{event.summary}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-secondary">
        <span>{actorLabel(event.actor, state.bots)}</span>
        {event.state && <span>{event.state}</span>}
        <ClaimedMarker provenance={event.provenance} />
      </p>
      {link && <div className="mt-1"><LinkChip item={link} connectors={connectors} /></div>}
    </div>
  </li>;
}
