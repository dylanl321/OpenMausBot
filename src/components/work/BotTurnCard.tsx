import { t } from "@/lib/i18n";
import { LinkChip } from "./LinkChip";
import type { WorkerTurn } from "./bot-turn";
import type { TaskConnectorManifest } from "./model";

export function BotTurnCard({ turn, connectors = [], onRawReply, onToolLog }: {
  turn: WorkerTurn;
  connectors?: readonly TaskConnectorManifest[];
  onRawReply?: () => void;
  onToolLog?: () => void;
}) {
  return <section data-bot-turn={turn.id} data-bot-turn-live={turn.live || undefined} aria-label={t("work.botTurn")}
    className="min-w-0 max-w-[640px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-sm">
    {turn.plan && <div data-bot-turn-plan className="min-w-0">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("work.botTurnPlan")}</h3>
      <p className="mt-1 whitespace-pre-wrap break-words text-ink">{turn.plan}</p>
    </div>}
    {turn.tools.length > 0 && <div data-bot-turn-steps className={turn.plan ? "mt-2" : ""}>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("work.botTurnSteps")}</h3>
      <ul className="mt-1 space-y-1">{turn.tools.map(step => <li key={step.name} data-tool-name={step.name} className="min-w-0 text-ink">
        <span className="font-medium">{step.name}</span>
        {step.count > 1 && <span className="text-ink-secondary"> ×{step.count}</span>}
        {step.failed > 0 && <span className="text-danger"> · {t("toolDetail.failed")}</span>}
        {step.running && <span className="text-accent"> · {t("toolDetail.running")}</span>}
        {step.sample && <span className="mt-0.5 block truncate text-[11px] text-ink-secondary">{step.sample}</span>}
      </li>)}</ul>
    </div>}
    {turn.outputs.length > 0 && <div data-bot-turn-outputs className="mt-2 min-w-0">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-secondary">{t("work.outputs")}</h3>
      <div className="mt-1 flex min-w-0 flex-wrap gap-1.5">{turn.outputs.map(link => <LinkChip key={link.id} item={link} connectors={connectors} />)}</div>
    </div>}
    <div className="mt-2 flex flex-wrap gap-2">
      {turn.replyId && onRawReply && <button type="button" data-bot-turn-raw onClick={onRawReply}
        className="rounded-md border border-hairline/50 px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-raised">{t("work.botTurnRawReply")}</button>}
      {onToolLog && <button type="button" data-bot-turn-log onClick={onToolLog}
        className="rounded-md border border-hairline/50 px-2 py-0.5 text-[11px] text-ink-secondary hover:bg-raised">{t("work.botTurnToolLog")}</button>}
    </div>
  </section>;
}
