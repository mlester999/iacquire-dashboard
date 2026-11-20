"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function GrowthPartnerSectionUnavailable({ title }: { title: string }) {
  const router = useRouter();

  return (
    <div role="status" aria-label={`${title} unavailable`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/25 bg-warning-soft/45 px-4 py-3">
      <p className="text-[13px] leading-relaxed text-ink-2">Couldn&apos;t load this section.</p>
      <Button type="button" variant="ghost" size="sm" onClick={() => router.refresh()}>
        <RefreshCw className="size-4" aria-hidden /> Try again
      </Button>
    </div>
  );
}
