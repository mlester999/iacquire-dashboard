"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Hand, ListChecks, Lock, OctagonAlert, PauseCircle, ShieldAlert, SlidersHorizontal, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Textarea } from "@/components/ui/primitives";
import { StatusPill } from "@/components/ui/status";
import { IconTile } from "@/components/overview/panel";
import { Dialog, Switch } from "@/components/ui/overlays";
import { setAgentModeAction, setClientPauseAction } from "@/app/actions/automation";
import { cn } from "@/lib/utils";

export type AgentMode = "autonomous" | "approval_required" | "paused";

const MODES: Array<{ value: AgentMode; label: string; icon: React.ReactNode; summary: string; detail: string }> = [
  {
    value: "approval_required",
    label: "Approval required",
    icon: <ListChecks className="size-4" />,
    summary: "Prepares work and asks a person before acting.",
    detail: "Drafts replies, follow-ups and updates. Nothing reaches a customer or your CRM until an authorised person approves it.",
  },
  {
    value: "autonomous",
    label: "Autonomous",
    icon: <Zap className="size-4" />,
    summary: "Carries out approved, low-risk work on its own.",
    detail: "Works within verified connections, your messaging rules, business hours, consent, spending limits and iAcquire safety policy. Pricing, contracts, refunds and complaints still go to a person.",
  },
  {
    value: "paused",
    label: "Paused",
    icon: <PauseCircle className="size-4" />,
    summary: "Stops new work and customer contact.",
    detail: "No new autonomous jobs or customer messages. Work already queued re-checks this setting before it runs. You can still chat privately with this employee.",
  },
];

export function OperatingModeCard({
  agentId,
  displayName,
  mode,
  canPause,
  canGoAutonomous,
  autonomousBlockedReason,
  agencyPaused,
}: {
  agentId: string;
  displayName: string;
  mode: AgentMode;
  canPause: boolean;
  canGoAutonomous: boolean;
  autonomousBlockedReason: string | null;
  agencyPaused: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<AgentMode | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [reason, setReason] = React.useState("");

  async function change(next: AgentMode, extra: { confirmAutonomous?: boolean } = {}) {
    setPending(next);
    const result = await setAgentModeAction(agentId, next, { reason, ...extra });
    setPending(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setConfirming(false);
    setAcknowledged(false);
    setReason("");
    toast.success(result.data.changed ? `${displayName} is now ${MODES.find((m) => m.value === next)?.label.toLowerCase()}.` : "No change needed.");
    router.refresh();
  }

  function choose(next: AgentMode) {
    if (next === mode || !canPause) return;
    if (next === "autonomous") {
      if (!canGoAutonomous || autonomousBlockedReason) return;
      setConfirming(true);
      return;
    }
    void change(next);
  }

  return (
    <Card>
      <CardHeader className="flex-wrap">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile tone="primary">
            <SlidersHorizontal />
          </IconTile>
          <div className="min-w-0">
            <CardTitle>How {displayName} works</CardTitle>
            <CardDescription>Choose how much freedom this employee has. You can change it at any time and the change takes effect on queued work too.</CardDescription>
          </div>
        </div>
        <StatusPill tone={mode === "autonomous" ? "primary" : mode === "paused" ? "warning" : "neutral"}>{MODES.find((m) => m.value === mode)?.label}</StatusPill>
      </CardHeader>
      <CardContent className="space-y-4">
        {agencyPaused && (
          <p role="status" className="flex items-start gap-2 rounded-xl bg-danger-soft p-3 text-[13px] text-danger-ink">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            iAcquire has paused automation for your workspace. Customer messages and new autonomous work are on hold regardless of the setting below.
          </p>
        )}
        <div role="radiogroup" aria-label={`Operating mode for ${displayName}`} className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {MODES.map((option) => {
            const selected = option.value === mode;
            const blocked = option.value === "autonomous" && (Boolean(autonomousBlockedReason) || !canGoAutonomous);
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!canPause || pending !== null || (blocked && !selected)}
                onClick={() => choose(option.value)}
                className={cn(
                  "flex min-h-32 flex-col rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed",
                  selected ? "border-primary/50 bg-primary-soft/50 ring-1 ring-inset ring-primary/30" : "border-line bg-surface enabled:hover:-translate-y-px enabled:hover:border-line-strong enabled:hover:shadow-card disabled:opacity-60",
                )}
              >
                <span className="flex items-center gap-2.5 text-[14px] font-semibold">
                  <IconTile tone={selected ? (option.value === "paused" ? "warning" : "primary") : "neutral"} size="sm">
                    {option.icon}
                  </IconTile>
                  {option.label}
                  {pending === option.value && <span className="text-[11px] font-normal text-muted">Saving…</span>}
                  {selected && (
                    <StatusPill tone={option.value === "paused" ? "warning" : "primary"} size="sm" className="ml-auto">
                      Current
                    </StatusPill>
                  )}
                </span>
                <span className="mt-2.5 text-[13px] leading-relaxed text-ink-2">{option.summary}</span>
                {blocked && !selected ? (
                  <span className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-[12px] leading-relaxed text-warning-ink">
                    <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
                    {autonomousBlockedReason ?? "Only the business owner can enable this."}
                  </span>
                ) : (
                  <span className="mt-2 text-[12px] leading-relaxed text-muted">{option.detail}</span>
                )}
              </button>
            );
          })}
        </div>
        {!canPause && (
          <p className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-muted ring-1 ring-inset ring-line">
            <Lock className="size-3.5 shrink-0" aria-hidden /> Only owners and managers can change how an employee works.
          </p>
        )}
      </CardContent>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) setAcknowledged(false);
        }}
        title={`Let ${displayName} work autonomously?`}
        description="This employee will act on its own within your rules. You stay in control and can pause it instantly."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep approval required</Button>
            <Button variant="brand" disabled={!acknowledged} loading={pending === "autonomous"} onClick={() => change("autonomous", { confirmAutonomous: true })}>
              Enable autonomous mode
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="flex items-start gap-3 text-[13px] leading-relaxed">
            <input type="checkbox" className="mt-1 size-4" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
            <span>I understand {displayName} may contact customers and update records without asking each time, always inside my messaging rules, consent requirements and spending limits.</span>
          </label>
          <Field label="Note for the record (optional)" htmlFor="mode-reason">
            <Textarea id="mode-reason" rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

export function EmergencyControls({
  messagingPaused,
  outboundPaused,
  agencyPaused,
  canPause,
}: {
  messagingPaused: boolean;
  outboundPaused: boolean;
  agencyPaused: boolean;
  canPause: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [messaging, setMessaging] = React.useState(messagingPaused);
  const [outbound, setOutbound] = React.useState(outboundPaused);

  async function toggle(scope: "messaging" | "outbound", paused: boolean) {
    setBusy(scope);
    const result = await setClientPauseAction(scope, paused);
    setBusy(null);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (scope === "messaging") setMessaging(paused);
    else setOutbound(paused);
    toast.success(paused ? "Paused. Queued sends are now blocked." : "Resumed.");
    router.refresh();
  }

  const anyPaused = messaging || outbound || agencyPaused;
  return (
    <section
      aria-label="Emergency controls"
      className={cn("rounded-2xl border p-4 sm:p-5", anyPaused ? "border-warning/40 bg-warning-soft/60" : "border-line bg-surface")}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-start gap-3">
          <IconTile tone={anyPaused ? "warning" : "neutral"}>
            {anyPaused ? <OctagonAlert /> : <Hand />}
          </IconTile>
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">{agencyPaused ? "Automation is on hold" : anyPaused ? "Some automation is paused" : "Emergency controls"}</h2>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted">
              {agencyPaused
                ? "iAcquire has paused automation for your workspace. Our team will be in touch. Private chat with your employees still works."
                : "Stop messages instantly if something looks wrong. These apply on our servers, so queued messages are blocked too."}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-w-[28rem]">
          <ControlSwitch id="pause-messaging" label="Pause customer-facing AI messaging" checked={messaging} disabled={!canPause || busy !== null} onChange={(next) => toggle("messaging", next)} />
          <ControlSwitch id="pause-outbound" label="Pause all outbound AI actions" checked={outbound} disabled={!canPause || busy !== null} onChange={(next) => toggle("outbound", next)} />
        </div>
      </div>
    </section>
  );
}

function ControlSwitch({ id, label, checked, disabled, onChange }: { id: string; label: string; checked: boolean; disabled: boolean; onChange: (next: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex min-h-12 items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2 text-[13px]">
      <span className="font-medium">{label}</span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} />
    </label>
  );
}
