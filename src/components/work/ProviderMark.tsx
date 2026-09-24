import type { Provenance } from "../../../shared/work-links";
import { t } from "@/lib/i18n";
import type { TaskConnectorManifest } from "./model";

export function ProviderMark({ connector }: { connector?: TaskConnectorManifest }) {
  if (!connector) return null;
  if (connector.icon) {
    return <span data-provider={connector.id} title={connector.name} aria-label={connector.name}
      className="inline-flex size-3.5 shrink-0 text-ink-secondary [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: connector.icon }} />;
  }
  return <span data-provider={connector.id} title={connector.name} aria-label={connector.name}
    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm bg-raised text-[9px] font-semibold text-ink-secondary">
    {connector.name.slice(0, 1)}
  </span>;
}

export function ClaimedMarker({ provenance }: { provenance: Provenance }) {
  if (provenance !== "claimed") return null;
  return <span data-claimed="true" title={t("work.claimedHint")}
    className="rounded-full border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] font-medium text-warning">
    {t("work.claimed")}
  </span>;
}
