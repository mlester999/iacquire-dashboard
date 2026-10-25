import Link from "next/link";
import { DoorClosed } from "lucide-react";
import type { OffboardingView } from "@/server/offboarding/service";
import { formatDate } from "@/lib/utils";

/** Shown to the owner on the overview once their workspace has been closed down, so the date their data is deleted is never a surprise. */
export function ClosingNotice({ view }: { view: OffboardingView | null }) {
  if (!view || view.status !== "retention") return null;
  return (
    <section aria-label="Workspace closed" role="status" className="flex items-start gap-3 rounded-2xl bg-warning-soft px-4 py-3.5 text-warning-ink">
      <DoorClosed className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-[14px] leading-relaxed">
        <p className="text-[14px] font-semibold">This workspace has been closed down</p>
        <p className="mt-1">AI employees and messaging are off. You can still download your data until {view.deleteAfter ? formatDate(view.deleteAfter, "UTC") : "the retention period ends"}, after which it is deleted. <Link href="/settings/data" className="font-semibold underline underline-offset-2">Your data</Link></p>
      </div>
    </section>
  );
}
