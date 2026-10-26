"use client";

import * as React from "react";
import Link from "next/link";
import { PhoneCall } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/primitives";
import type { CrmScope } from "@/server/crm/page";
import type { CallRecordView } from "@/server/crm/calls";
import { CallRow } from "@/components/crm/calls/calls-workspace";
import { CallDetailSheet } from "@/components/crm/calls/call-detail";
import { LogCallDialog } from "@/components/crm/calls/log-call-dialog";

/** The Calls section of a contact's profile: their recent calls (provider-reported and logged), opening each one, and logging a new one. */
export function ContactCalls({ scope, contact, calls, members }: { scope: CrmScope; contact: { id: string; name: string }; calls: CallRecordView[]; members: Array<{ id: string; name: string }> }) {
  const [logging, setLogging] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const canLog = Boolean(scope.can["contacts.edit"]) && !scope.readOnly;
  const canFollowUp = Boolean(scope.can["tasks.manage"]) && !scope.readOnly;
  const open = calls.find((c) => c.id === openId) ?? null;
  const fixed = React.useMemo(() => ({ id: contact.id, name: contact.name }), [contact.id, contact.name]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-muted">Matched to this contact by their exact phone number, or logged by your team.</p>
        <div className="flex items-center gap-2">
          {calls.length > 0 && <Link href={`${scope.base}/calls`} className="text-[14px] font-medium text-primary hover:underline">All calls</Link>}
          {canLog && <Button size="sm" variant="secondary" onClick={() => setLogging(true)}><PhoneCall className="size-4" aria-hidden />Log a call</Button>}
        </div>
      </div>
      {calls.length ? (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface" aria-label={`Calls with ${contact.name}`}>
          {calls.map((c) => <CallRow key={c.id} scope={scope} call={c} showContact={false} onOpen={() => setOpenId(c.id)} />)}
        </ul>
      ) : (
        <EmptyState compact icon={<PhoneCall className="size-5" />} title="No calls yet" description="Calls with this person appear here when your voice assistant reports them or your team logs one." />
      )}
      {canLog && <LogCallDialog scope={scope} open={logging} onOpenChange={setLogging} contact={fixed} members={members} canFollowUp={canFollowUp} />}
      <CallDetailSheet scope={scope} call={open} onClose={() => setOpenId(null)} canLog={canLog} canFollowUp={canFollowUp} members={members} />
    </div>
  );
}
