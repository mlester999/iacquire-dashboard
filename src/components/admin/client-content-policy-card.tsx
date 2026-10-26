"use client";

import * as React from "react";
import { ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge, Field, Textarea } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils";
import { setClientContentPolicyAction } from "@/app/(admin)/admin/team/policy-actions";
import type { ClientContentPolicy } from "@/server/admin/client-content-policy";

// Founder decision D70 is open: should iAcquire staff need an audited support session to read a client's approvals, activity log, shared knowledge and leads, as they already do for CRM,
// inbox, calls and analytics? This card shows which way it is set (off, as before, until the founder decides) and lets a Super Admin change it with a written reason.
export function ClientContentPolicyCard({ initial, timeZone }: { initial: ClientContentPolicy; timeZone?: string }) {
  const [policy, setPolicy] = React.useState(initial);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const next = !policy.sessionRequired;
  const change = async () => {
    setBusy(true);
    const res = await setClientContentPolicyAction(next, note);
    setBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setPolicy(res.data);
    setNote("");
    toast.success(next ? "A support session is now needed to read a client's approvals, activity, knowledge and leads." : "Assigned staff read a client's approvals, activity, knowledge and leads as before.");
  };
  return (
    <section aria-labelledby="content-policy" className="rounded-2xl border border-line bg-surface p-4 shadow-soft sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="content-policy" className="flex items-center gap-2 text-[15px] font-semibold text-ink"><ShieldCheck className="size-4 text-primary" aria-hidden /> Reading a client&apos;s approvals, activity, knowledge and leads</h2>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
            A client&apos;s CRM, inbox, calls and analytics already need a support session: a reason, a time limit and a record. Approvals, the activity log, shared knowledge and leads do not, so staff assigned to
            a client can read them today. Whether that should change is the founder&apos;s decision (D70) and is still open, so this is set to today&apos;s behaviour.
          </p>
        </div>
        <Badge tone={policy.sessionRequired ? "success" : "neutral"}>{policy.sessionRequired ? "Support session required" : "Assigned staff can read (today)"}</Badge>
      </div>
      {policy.changedAt && (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-[13px] leading-relaxed text-ink-2">
          Last changed {formatDateTime(policy.changedAt, timeZone)}{policy.changedByName ? ` by ${policy.changedByName}` : ""}{policy.note ? `: ${policy.note}` : "."}
        </p>
      )}
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        {policy.sessionRequired
          ? "Staff who are not in a session on the client see none of it, and a dashboard count of it shows nothing for them. Turn it off to go back to today."
          : "Turning it on takes these four away from staff unless they open a support session on the client. Nothing already stored changes, and client members are never affected."}
      </p>
      <div className="mt-3 space-y-3">
        <Field label={policy.sessionRequired ? "Why are you turning it off?" : "Why are you turning it on?"} htmlFor="content-policy-note" hint="At least 10 characters. It goes in the audit log with your name.">
          <Textarea id="content-policy-note" rows={2} maxLength={400} className="text-[16px] sm:text-[14px]" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button variant={next ? "primary" : "secondary"} loading={busy} disabled={busy || note.trim().length < 10} onClick={() => void change()}>
          {next ? "Require a support session" : "Go back to assigned staff reading"}
        </Button>
      </div>
    </section>
  );
}
