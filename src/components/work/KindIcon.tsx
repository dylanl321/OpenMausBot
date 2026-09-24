import {
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  Hammer,
  Link2,
  MessageSquareText,
  Ticket,
  type LucideIcon,
} from "lucide-react";
import type { LinkKind } from "../../../shared/work-links";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

const ICONS: Record<LinkKind, LucideIcon> = {
  work_item: Ticket,
  change_request: GitPullRequest,
  commit: GitCommitHorizontal,
  build: Hammer,
  comment: MessageSquareText,
  document: FileText,
  link: Link2,
};

export function KindIcon({ kind, size = 14, className }: { kind: LinkKind; size?: number; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon data-kind={kind} size={size} aria-label={t(`work.kind.${kind}`)} className={cn("shrink-0", className)} />;
}
