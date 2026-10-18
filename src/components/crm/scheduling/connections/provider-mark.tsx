import { CalendarDays, Cloud, Mail, Rss, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProviderKey } from "@/components/crm/scheduling/connections/status";

const STYLE: Record<ProviderKey | "icloud", { icon: typeof CalendarDays; tone: string }> = {
  google: { icon: CalendarDays, tone: "bg-[#e8f0fe] text-[#1a56c4] dark:bg-[#1a2a4a] dark:text-[#9bbcff]" },
  microsoft: { icon: Mail, tone: "bg-[#e6f2fb] text-[#0a5a9c] dark:bg-[#132a3d] dark:text-[#8cc6f2]" },
  icloud: { icon: Cloud, tone: "bg-[#eef0f4] text-[#3c4250] dark:bg-[#2a2d35] dark:text-[#c8ccd6]" },
  caldav: { icon: Server, tone: "bg-[#f1edff] text-[#5a3ee0] dark:bg-[#2a2347] dark:text-[#bcadff]" },
  ics: { icon: Rss, tone: "bg-[#fff1e5] text-[#a1440c] dark:bg-[#3a2616] dark:text-[#ffb98a]" },
};

/** A small, brand-neutral mark for a calendar provider (no third-party logos). Decorative: the name is always written next to it. */
export function ProviderMark({ provider, icloud, className }: { provider: ProviderKey; icloud?: boolean; className?: string }) {
  const s = STYLE[icloud ? "icloud" : provider];
  const Icon = s.icon;
  return (
    <span aria-hidden className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-xl", s.tone, className)}>
      <Icon className="size-[18px]" />
    </span>
  );
}
