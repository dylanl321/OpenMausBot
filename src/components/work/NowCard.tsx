import type { WorkItem } from "../../../shared/work-item";
import type { TaskEvent } from "../../../shared/work-links";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { BotAvatar } from "../Avatar";
import { nowFrom } from "./model";

export function NowCard({ item, events = [] }: { item: WorkItem; events?: readonly TaskEvent[] }) {
  const { state } = useStore();
  const now = nowFrom(item, events);
  const bot = now ? state.bots.find(candidate => candidate.id === now.botId) : undefined;
  return <div data-now-card className="mt-3 min-w-0 rounded-lg border border-accent/20 bg-accent/5 p-2">
    <p className="text-[11px] font-medium uppercase tracking-wide text-accent">{t("work.now")}</p>
    {now ? <div className="mt-1 flex min-w-0 items-start gap-2">
      {bot && <BotAvatar bot={bot} size={18} state="happy" />}
      <p className="min-w-0 whitespace-pre-wrap break-words text-ink">{now.summary}</p>
    </div> : <p className="mt-1 whitespace-pre-wrap break-words text-ink-secondary">
      {item.status === "active" ? t("work.nowIdle") : (item.detail || t(`work.status.${item.status}`))}
    </p>}
  </div>;
}
