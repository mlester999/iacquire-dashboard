import Link from "next/link";
import { PauseCircle } from "lucide-react";
import { INBOX_UNAVAILABLE_MESSAGE } from "@/lib/inbox";

/**
 * The inbox page while an operator has switched the inbox off. No data is read for it. Customer messages are still received and kept (the switch
 * only removes this screen), which is worth saying because it is the first thing someone wonders.
 */
export function InboxUnavailable() {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-dashed border-line-strong p-8 text-center">
      <PauseCircle className="mx-auto size-6 text-muted" aria-hidden />
      <h1 className="mt-3 text-[16px] font-semibold tracking-tight">Inbox</h1>
      <p role="status" className="mt-1 text-[13.5px] font-medium text-ink">{INBOX_UNAVAILABLE_MESSAGE}</p>
      <p className="mx-auto mt-2 max-w-xs text-[13px] leading-relaxed text-muted">Messages from your customers are still being received and kept. They will be here when the inbox is back.</p>
      <Link href="/overview" className="mt-4 inline-block text-[13px] font-medium text-primary hover:underline">Back to the overview</Link>
    </div>
  );
}
