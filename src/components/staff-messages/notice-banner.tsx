import * as React from "react";
import { Info } from "lucide-react";
import { Badge } from "@/components/ui/primitives";
import { STAFF_MESSAGES_NOTICE_LINES, STAFF_MESSAGES_NOTICE_STATUS, STAFF_MESSAGES_NOTICE_VERSION } from "@/lib/staff-messages/notice";

/**
 * How these messages are kept and who can read them, shown to everyone who uses Messages. The wording is a DRAFT for counsel and is labelled as one on the screen: it says only
 * what the product does, makes no legal claim and is not a policy. It is a native disclosure (works without scripts, keyboard operable) that starts closed so it does not
 * push the conversations down on a phone.
 */
export function NoticeBanner({ className }: { className?: string }) {
  return (
    <details className={className} data-testid="messages-notice">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-[14px] text-ink-2 hover:bg-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <Info className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">How these messages are kept and who can read them</span>
        <Badge tone="warning">Draft</Badge>
      </summary>
      <div className="mt-2 rounded-xl border border-line bg-surface p-4 text-[14px] leading-relaxed text-ink-2">
        <p className="font-medium text-warning-ink">{STAFF_MESSAGES_NOTICE_STATUS}</p>
        <ul className="mt-3 list-disc space-y-2 pl-5">
          {STAFF_MESSAGES_NOTICE_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-muted">Wording version {STAFF_MESSAGES_NOTICE_VERSION}.</p>
      </div>
    </details>
  );
}
