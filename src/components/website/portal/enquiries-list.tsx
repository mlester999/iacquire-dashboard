"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BellRing, BellOff, Clock, FileText, Inbox, Mail, MessageSquareWarning, Phone, Wrench } from "lucide-react";
import { markEnquirySpamAction } from "@/app/actions/website";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import { AvatarTile, InfoChip, StatusPill } from "@/components/ui/status";
import { displayPhone } from "@/components/website/render/parts";
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
    <ul className="card-surface divide-y divide-line overflow-hidden rounded-2xl">
      {items.map((e) => {
        const s = STATUS[e.status];
        return (
          <li key={e.id} className="space-y-3 p-4 transition-colors hover:bg-surface-2/30 sm:p-5">
            <div className="flex items-start gap-3">
              <AvatarTile name={e.name} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
                  <p className="min-w-0 break-words text-[15px] font-semibold" title={e.name}>{e.name}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={s.tone}>{s.label}</StatusPill>
                    <InfoChip icon={<Clock />}>{relativeTime(e.createdAt)}</InfoChip>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {e.email && <InfoChip icon={<Mail />} className="max-w-full">{e.email}</InfoChip>}
                  {e.phone && <InfoChip icon={<Phone />}>{displayPhone(e.phone)}</InfoChip>}
                  {e.service && <InfoChip icon={<Wrench />}>{e.service}</InfoChip>}
                  <InfoChip icon={<FileText />}>{e.pageSlug === "home" ? "Home page" : `${e.pageSlug} page`}</InfoChip>
                </div>
              </div>
            </div>
            {e.message && <p className="whitespace-pre-wrap break-words rounded-xl bg-surface-2/70 p-3 text-[14px] leading-relaxed ring-1 ring-inset ring-line sm:ml-12">{e.message}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 sm:ml-12">
              {e.marketingOptIn
                ? <StatusPill tone="success" size="sm" icon={<BellRing className="size-3" aria-hidden />}>Agreed to updates and offers</StatusPill>
                : <StatusPill tone="neutral" size="sm" icon={<BellOff className="size-3" aria-hidden />}>No opt-in to updates or offers</StatusPill>}
              {canEdit && e.status !== "spam" && (
                <Button type="button" variant="secondary" size="sm" loading={busy === e.id} disabled={busy !== null} onClick={() => void spam(e.id)}>
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
