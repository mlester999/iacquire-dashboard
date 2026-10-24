import * as React from "react";
import Link from "next/link";
import { LockKeyhole, MessagesSquare, PowerOff } from "lucide-react";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";

// The honest states of the Messages page when there is nothing to show: the module is switched off, the person may not use it, or the agency workspace is missing.
// The page never pretends a conversation list is empty when it could not be read.

export type UnavailableReason = "off" | "denied" | "no_agency";

export function MessagesUnavailable({ reason, superAdmin }: { reason: UnavailableReason; superAdmin: boolean }) {
  if (reason === "off") {
    return (
      <EmptyState
        headingLevel={2}
        icon={<PowerOff className="size-5" aria-hidden />}
        title="Messages is not switched on"
        description={
          superAdmin
            ? "Nothing has been deleted or lost. Switch it on in the Messages settings to let the team write to each other here."
            : "A Super Admin has not switched staff Messages on yet. Ask them if you need it."
        }
        action={superAdmin ? <ButtonLink href="/admin/messages/settings">Open Messages settings</ButtonLink> : undefined}
      />
    );
  }
  if (reason === "no_agency") {
    return (
      <EmptyState
        headingLevel={2}
        icon={<MessagesSquare className="size-5" aria-hidden />}
        title="There is nowhere to keep messages yet"
        description="The agency workspace has not been created, so Messages cannot start. A Super Admin can set it up."
      />
    );
  }
  return (
    <EmptyState
      headingLevel={2}
      icon={<LockKeyhole className="size-5" aria-hidden />}
      title="You can't use Messages"
      description="Your agency role does not include Messages. If you think this is a mistake, ask a Super Admin to check your permissions."
      action={<Link href="/admin" className="text-[13px] font-medium text-primary-ink underline">Back to the dashboard</Link>}
    />
  );
}
