import type { LinkedItem } from "../../../shared/work-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { KindIcon } from "./KindIcon";
import { connectorFor, statusCategoryClass, type TaskConnectorManifest } from "./model";
import { ClaimedMarker, ProviderMark } from "./ProviderMark";

export function LinkChip({ item, connectors = [] }: { item: LinkedItem; connectors?: readonly TaskConnectorManifest[] }) {
  const connector = connectorFor(item, connectors);
  const body = <>
    <KindIcon kind={item.kind} size={12} />
    <span className="min-w-0 truncate">{item.title}</span>
    {item.state && <span className={cn("max-w-[8rem] truncate text-[10px]", statusCategoryClass(item.state.category))}>{item.state.label}</span>}
    <ClaimedMarker provenance={item.provenance} />
    <ProviderMark connector={connector} />
  </>;
  const className = "inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-hairline/40 bg-raised/50 px-2 py-0.5 text-[11px] text-ink";
  if (item.url) {
    return <a data-link-id={item.id} data-link-kind={item.kind} href={item.url} target="_blank" rel="noreferrer"
      aria-label={t("work.openLink", { title: item.title })} className={className}>{body}</a>;
  }
  return <span data-link-id={item.id} data-link-kind={item.kind} className={className}>{body}</span>;
}
