"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Inbox, Mail, MessageSquareWarning, Phone } from "lucide-react";
import { markEnquirySpamAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { Badge, EmptyState } from "@/components/ui/primitives";
import { displayPhone } from "@/components/website/contact";
import { relativeTime } from "@/lib/utils";
import type { SubmissionView } from "@/server/websites/forms";

const STATUS = {
  received: { label: "Being added to contacts", tone: "warning" },
  processed: { label: "In your contacts", tone: "success" },
  failed: { label: "Couldn't be added", tone: "danger" },
  spam: { label: "Marked as spam", tone: "neutral" },
} as const;

/** Every enquiry from the website with what the visitor wrote. Nothing is sent to them from here; replies happen in the inbox. */
export function EnquiriesList({ items, canEdit }: { items: SubmissionView[]; canEdit: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const spam = async (id: string) => {
    setBusy(id);
    const res = await markEnquirySpamAction(id);
    setBusy(null);
    if (!res.ok) return void toast.error(res.error);
    toast.success("Marked as spam.");
    router.refresh();
  };
  if (items.length === 0) {
    return <EmptyState icon={<Inbox className="size-5" />} title="No enquiries yet" description="When someone fills in the form on your website, it shows up here and in your contacts." />;
  }
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {items.map((e) => {
        const s = STATUS[e.status];
        return (
          <li key={e.id} className="space-y-2 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[15px] font-semibold">{e.name}</p>
              <div className="flex items-center gap-2">
                <Badge tone={s.tone}>{s.label}</Badge>
                <span className="text-[12.5px] text-muted">{relativeTime(e.createdAt)}</span>
              </div>
            </div>
            <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
              {e.email && <span className="inline-flex items-center gap-1.5"><Mail className="size-3.5 text-muted" aria-hidden /> {e.email}</span>}
              {e.phone && <span className="inline-flex items-center gap-1.5"><Phone className="size-3.5 text-muted" aria-hidden /> {displayPhone(e.phone)}</span>}
              {e.service && <span>Needs: {e.service}</span>}
              <span className="text-muted">From {e.pageSlug === "home" ? "the home page" : `the ${e.pageSlug} page`}</span>
            </p>
            {e.message && <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2/70 p-3 text-[14px] leading-relaxed">{e.message}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-muted">
              <span>{e.marketingOptIn ? "Agreed to receive updates and offers." : "Did not opt in to updates or offers."}</span>
              {canEdit && e.status !== "spam" && (
                <Button type="button" variant="ghost" size="sm" loading={busy === e.id} disabled={busy !== null} onClick={() => void spam(e.id)}>
                  <MessageSquareWarning className="size-3.5" /> Mark as spam
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
