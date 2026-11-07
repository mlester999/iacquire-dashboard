"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Power, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { Field, Textarea } from "@/components/ui/primitives";
import { healthCheckAction, setAgentEnabledAction } from "@/app/(admin)/admin/actions";

export function AgencyWorkforceControls({
  agentId,
  orgId,
  slug,
  employeeName,
  enabled,
  dark = false,
}: {
  agentId: string;
  orgId: string;
  slug: string;
  employeeName: string;
  enabled: boolean;
  dark?: boolean;
}) {
  const router = useRouter();
  const [checking, setChecking] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const check = async () => {
    setChecking(true);
    const res = await healthCheckAction(agentId);
    setChecking(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.ok) toast.success(`${employeeName} passed its connection check`, { description: res.data.detail });
    else toast.warning(`${employeeName} did not pass its connection check`, { description: res.data.detail });
    router.refresh();
  };

  const toggle = async () => {
    setSaving(true);
    const res = await setAgentEnabledAction(orgId, agentId, !enabled, reason);
    setSaving(false);
    if (!res.ok) return toast.error(res.error);
    setConfirming(false);
    setReason("");
    toast.success(enabled ? `${employeeName} paused` : `${employeeName} enabled`, {
      description: enabled ? "Chat and automated work are now unavailable for this profile." : "It becomes usable after a successful connection check.",
    });
    router.refresh();
  };

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Link
          href={`/admin/employees/open?role=${encodeURIComponent(slug)}`}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-primary px-3 text-[13px] font-medium text-primary-on hover:bg-primary-strong"
        >
          <MessageSquare className="size-3.5" aria-hidden /> Chat
        </Link>
        <Link
          href={`/admin/employees/open?role=${encodeURIComponent(slug)}&to=manage`}
          className={dark
            ? "inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3 text-[13px] font-medium text-white hover:bg-white/15"
            : "inline-flex min-h-9 items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-[13px] font-medium text-ink-2 hover:bg-surface-2"}
        >
          <Settings2 className="size-3.5" aria-hidden /> Manage
        </Link>
        <Button size="sm" variant="secondary" onClick={check} loading={checking} className={dark ? "!border-white/20 !bg-white/10 !text-white hover:!bg-white/15" : undefined} aria-label={`Check connection for ${employeeName}`}>
          {!checking && <RefreshCw className="size-3.5" aria-hidden />} Check
        </Button>
        <Button size="sm" variant={enabled ? "ghost" : "secondary"} onClick={() => setConfirming(true)} className={dark ? "!text-white/75 hover:!bg-white/10 hover:!text-white" : undefined} aria-label={enabled ? `Pause ${employeeName}` : `Enable ${employeeName}`}>
          <Power className="size-3.5" aria-hidden /> {enabled ? "Pause" : "Enable"}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={enabled ? `Pause ${employeeName}?` : `Enable ${employeeName}?`}
        description={
          enabled
            ? "Chat and automated work stop immediately. Existing conversations and configuration stay in place, and you can enable the profile again."
            : "The profile becomes available for chat and automated work only after its connection check passes."
        }
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant={enabled ? "danger" : "brand"} loading={saving} disabled={reason.trim().length < 5} onClick={toggle}>
              {enabled ? "Pause profile" : "Enable profile"}
            </Button>
          </>
        }
      >
        <p className="text-[14px] leading-relaxed text-muted">
          This changes the profile&apos;s availability for the iAcquire internal workspace. It does not delete its history, knowledge or connection.
        </p>
        <Field label="Reason (kept in the audit log)" htmlFor={`agency-plan-reason-${agentId}`} className="mt-4">
          <Textarea id={`agency-plan-reason-${agentId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
        </Field>
      </Dialog>
    </>
  );
}
