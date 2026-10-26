import Link from "next/link";
import { Plug } from "lucide-react";
import { EmptyState } from "@/components/ui/primitives";

/** Shown in place of a native screen when GoHighLevel owns that capability, so nobody edits the same records in two places. */
export function GhlOwnedNotice({ what, agency, href = "/sales" }: { what: string; agency?: boolean; href?: string }) {
  return (
    <EmptyState
      icon={<Plug className="size-5" />}
      title={`${what} are managed in GoHighLevel`}
      headingLevel={2}
      description={
        <>
          This workspace keeps {what.toLowerCase()} in its connected GoHighLevel location, so iAcquire shows them read-only and never writes them from here.
          {agency ? " Switching a capability to iAcquire is done from the CRM provider settings." : " An owner can move them to iAcquire from CRM provider settings."}
        </>
      }
      action={!agency ? <Link href={href} className="text-[14px] font-medium text-primary hover:underline">Open the GoHighLevel view</Link> : undefined}
    />
  );
}
