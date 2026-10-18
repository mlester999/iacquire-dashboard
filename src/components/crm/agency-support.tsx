"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, Eye, LogOut, PencilLine, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, Field, Textarea } from "@/components/ui/primitives";
import { Segmented } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { endSupportSessionAction, startSupportSessionAction } from "@/app/actions/crm";
import { useCrmAction } from "@/components/crm/ui";

let clockSnapshot = Date.now();
const clockSubscribers = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function publishClock() {
  clockSnapshot = Date.now();
  for (const onChange of clockSubscribers) onChange();
}

function subscribeToClock(onChange: () => void) {
  clockSubscribers.add(onChange);
  if (clockTimer === null) clockTimer = setInterval(publishClock, 30_000);
  return () => {
    clockSubscribers.delete(onChange);
    if (clockSubscribers.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const currentTime = () => clockSnapshot;

/** Shown instead of a client's CRM until the agency person opens a support session with a reason the client can see. */
export function SupportGate({ orgId, orgName, canWrite }: { orgId: string; orgName: string; canWrite: boolean }) {
  const { run, busy } = useCrmAction();
  const [mode, setMode] = React.useState<"read" | "write">("read");
  const [reason, setReason] = React.useState("");
  return (
    <div className="mx-auto max-w-xl py-6">
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary"><ShieldAlert className="size-5" aria-hidden /></span>
          <div>
          <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">Open {orgName}&rsquo;s CRM</h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              Client records belong to the client. Access is time-limited, every page you open is recorded, and the client can see who opened their CRM and why under Support Access.
            </p>
          </div>
        </div>
        <form className="mt-5 space-y-4" onSubmit={async (e) => { e.preventDefault(); await run("start", () => startSupportSessionAction(orgId, mode, reason), mode === "write" ? "Support session started. The client's owner has been notified." : "Support session started."); }}>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-ink">Access</p>
            <Segmented id="sup-mode" ariaLabel="Access" value={mode} onChange={setMode} options={[{ value: "read", label: "View only · 60 min" }, ...(canWrite ? [{ value: "write" as const, label: "Make changes · 30 min" }] : [])]} />
            {!canWrite && <p className="mt-1.5 text-[12px] text-faint">Only agency super admins can open a session that changes client records.</p>}
            {mode === "write" && <p className="mt-1.5 text-[12.5px] text-warning-ink">The client&rsquo;s owner and managers are notified. Exports, deleting records and permission changes are never available to the agency.</p>}
          </div>
          <Field label="Why you need access" htmlFor="sup-reason" hint="The client sees this. For example: Fixing duplicate contacts from last week's import (ticket #482).">
            <Textarea id="sup-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </Field>
          <div className="flex justify-end gap-2">
            <Link href="/admin/crm" className="inline-flex min-h-11 items-center rounded-xl px-3 text-[13.5px] font-medium text-muted hover:text-ink sm:min-h-10">Back</Link>
            <Button type="submit" disabled={reason.trim().length < 5} loading={busy("start")}>Open CRM</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

/** The bar across an agency person's view of a client's CRM: what access they hold, why, and how long it lasts. */
export function SupportBanner({ orgId, mode, reason, expiresAt, initialNow }: { orgId: string; mode: "read" | "write"; reason: string; expiresAt: string; initialNow: number }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const now = React.useSyncExternalStore(subscribeToClock, currentTime, () => initialNow);
  const minutes = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now) / 60_000));
  React.useEffect(() => {
    if (minutes === 0) router.refresh();
  }, [minutes, router]);
  return (
    <div role="status" className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border px-4 py-2.5 text-[13px]", mode === "write" ? "border-warning/40 bg-warning-soft text-warning-ink" : "border-primary/25 bg-primary-soft/60 text-primary-ink")}>
      <span className="inline-flex items-center gap-1.5 font-semibold">{mode === "write" ? <PencilLine className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}{mode === "write" ? "Support session: can make changes" : "Support session: view only"}</span>
      <span className="min-w-0 flex-1 truncate opacity-90" title={reason}>{reason}</span>
      <span className="inline-flex items-center gap-1"><Clock className="size-3.5" aria-hidden />{minutes} min left</span>
      <Button size="sm" variant="secondary" loading={busy("end")} onClick={async () => { if (await run("end", () => endSupportSessionAction(orgId), "Support session ended.")) router.push("/admin/crm"); }}><LogOut className="size-4" />End session</Button>
    </div>
  );
}
