import type { LinkedItem } from "../../../shared/work-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { KindIcon } from "./KindIcon";
import { connectorFor, statusCategoryClass, type TaskConnectorManifest } from "./model";
import { ClaimedMarker, ProviderMark } from "./ProviderMark";

export function LinkCard({ item, connectors = [] }: { item: LinkedItem; connectors?: readonly TaskConnectorManifest[] }) {
  const connector = connectorFor(item, connectors);
  const details = item.details ? Object.entries(item.details) : [];
  return <article data-link-id={item.id} data-link-kind={item.kind} className="min-w-0 rounded-lg border border-hairline/30 bg-raised/30 p-2">
    <div className="flex min-w-0 items-start gap-2">
      <KindIcon kind={item.kind} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {item.url
            ? <a href={item.url} target="_blank" rel="noreferrer" className="break-words font-medium text-ink hover:text-accent">{item.title}</a>
            : <span className="break-words font-medium text-ink">{item.title}</span>}
          <ClaimedMarker provenance={item.provenance} />
          <ProviderMark connector={connector} />
        </div>
        <p className={cn("text-[11px]", item.state ? statusCategoryClass(item.state.category) : "text-ink-secondary")}>
          {t(`work.kind.${item.kind}`)} · {t(`work.role.${item.role}`)}
          {item.externalId ? ` · ${item.externalId}` : ""}
          {item.state ? ` · ${item.state.label}` : ""}
        </p>
        {details.length > 0 && <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[11px] text-ink-secondary">
          {details.map(([key, value]) => <span key={key} className="contents">
            <dt className="font-medium">{key}</dt>
            <dd className="min-w-0 break-all">{String(value)}</dd>
          </span>)}
        </dl>}
      </div>
    </div>
  </article>;
}
