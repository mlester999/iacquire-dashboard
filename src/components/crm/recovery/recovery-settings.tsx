"use client";

import * as React from "react";
import { CheckCircle2, Circle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { SectionCard } from "@/components/crm/record-panels";
import { ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import { activateRecoveryPolicyAction, saveRecoveryPolicyAction } from "@/app/actions/missed-calls";
import { formatDateTime } from "@/lib/utils";
import {
  AFTER_HOURS_BEHAVIORS, AFTER_HOURS_LABELS, DEFAULT_MESSAGE_AFTER_HOURS, DEFAULT_MESSAGE_OPEN, POLICY_MODES, POLICY_MODE_HELP, POLICY_MODE_LABELS, SMS_CONSENT_BASIS_LABELS,
  policyProblems, renderWording, type MissedCallPolicy,
} from "@/lib/missed-calls/policy";
import { CALL_CLASSES, CALL_CLASS_HELP, CALL_CLASS_LABELS, type CallClass } from "@/lib/missed-calls/state";
import type { ReadinessItem } from "@/server/missed-calls/policy";
import type { CrmScope } from "@/server/crm/page";

// Recovery settings. Safe by default: off, team-only, nothing sent. Anything that changes what a caller receives asks a person to confirm again
// (Activate), and the checklist says plainly what is ready, what is not, and what is waiting on the platform rather than on the workspace.

const ROLE_LABELS: Record<string, string> = { owner: "Business owner", admin: "Managers", member: "Team members", sales_rep: "Sales reps", support: "Support", appointment_setter: "Appointment setters" };

function Check({ label, hint, checked, onChange, disabled, id }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id: string }) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-start gap-3 text-[14px] sm:min-h-0">
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span><span className="font-medium text-ink">{label}</span>{hint && <span className="block text-[13px] text-muted">{hint}</span>}</span>
    </label>
  );
}

export function RecoverySettings({ scope, policy, readiness, members, businessName, canConfigure }: {
  scope: CrmScope;
  policy: MissedCallPolicy;
  readiness: ReadinessItem[];
  members: Array<{ id: string; name: string }>;
  businessName: string;
  canConfigure: boolean;
}) {
  const { run, busy } = useCrmAction();
  const [f, setF] = React.useState<MissedCallPolicy>(policy);
  const [ack, setAck] = React.useState(Boolean(policy.consentAckAt));
  const [version, setVersion] = React.useState(policy.version);
  const set = <K extends keyof MissedCallPolicy>(k: K, v: MissedCallPolicy[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const problems = policyProblems(f, { acknowledged: ack });
  const disabled = !canConfigure || scope.readOnly;
  const wantsMessages = f.actionMessage && f.mode !== "manual";
  const activated = Boolean(policy.activatedAt);
  const dirty = JSON.stringify({ ...f, version: 0 }) !== JSON.stringify({ ...policy, version: 0 });

  const save = async () => {
    const out = await run("save", () => saveRecoveryPolicyAction(scope.orgId, {
      expectedVersion: version, enabled: f.enabled, mode: f.mode, classes: f.classes, abandonedMaxSeconds: f.abandonedMaxSeconds, delayMinutes: f.delayMinutes, maxAttempts: f.maxAttempts,
      attemptGapMinutes: f.attemptGapMinutes, responseWindowHours: f.responseWindowHours, caseExpiryHours: f.caseExpiryHours, afterHoursBehavior: f.afterHoursBehavior, actionTask: f.actionTask,
      taskDueMinutes: f.taskDueMinutes, actionNotify: f.actionNotify, notifyRoles: f.notifyRoles, assignUserId: f.assignUserId, actionOpportunity: f.actionOpportunity, actionFollowUp: f.actionFollowUp,
      actionMessage: f.actionMessage, messageChannels: f.messageChannels, messageOpen: f.messageOpen?.trim() || null, messageAfterHours: f.messageAfterHours?.trim() || null,
      smsConsentBasis: f.smsConsentBasis, acknowledgeCallerConsent: ack, actionAiCallback: f.actionAiCallback, routeAppointmentSetter: f.routeAppointmentSetter,
    }), "Saved.");
    if (out) setVersion(out.version);
  };

  return (
    <div className="space-y-5">
      {scope.readOnly && <ReadOnlyNotice />}
      {!canConfigure && !scope.readOnly && <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-muted" role="note">Only a workspace owner or manager can change these settings. You can see how they are set.</p>}

      <SectionCard title="Is it ready?">
        <ul className="space-y-2.5" aria-label="Readiness checklist">
          {readiness.map((i) => (
            <li key={i.key} className="flex items-start gap-2.5 text-[14px]">
              {i.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" role="img" aria-label="Ready" /> : <Circle className="mt-0.5 size-4 shrink-0 text-warning" role="img" aria-label={i.blocking ? "Needs attention" : "Not yet"} />}
              <span><span className="font-medium text-ink">{i.label}</span><span className="block text-[13px] text-muted">{i.detail}</span></span>
            </li>
          ))}
        </ul>
        {wantsMessages && (
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            {activated ? <Badge tone="success">Confirmed {formatDateTime(policy.activatedAt!, scope.timezone)}</Badge> : <Badge tone="warning">Not confirmed: no text will be drafted or sent</Badge>}
            {!activated && canConfigure && !dirty && (
              <Button size="sm" loading={busy("activate")} onClick={async () => { const o = await run("activate", () => activateRecoveryPolicyAction(scope.orgId, version), "Confirmed."); if (o) setVersion(o.version); }}>Confirm and activate</Button>
            )}
            {!activated && dirty && <span className="text-[13px] text-muted">Save your changes first, then confirm.</span>}
          </div>
        )}
      </SectionCard>

      <SectionCard title="When a caller is missed">
        <div className="space-y-4">
          <Check id="rp-enabled" label="Follow up missed calls" hint="Off by default. While it is off, calls are still listed here but nobody is told and nothing is sent." checked={f.enabled} disabled={disabled} onChange={(v) => set("enabled", v)} />
          <fieldset className="space-y-2" disabled={disabled}>
            <legend className="mb-1 text-[13px] font-medium text-ink-2">What it does</legend>
            {POLICY_MODES.map((m) => (
              <label key={m} className="flex min-h-11 items-start gap-3 text-[14px] sm:min-h-0">
                <input type="radio" name="rp-mode" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={f.mode === m} onChange={() => { set("mode", m); set("actionMessage", m !== "manual"); }} />
                <span><span className="font-medium text-ink">{POLICY_MODE_LABELS[m]}</span><span className="block text-[13px] text-muted">{POLICY_MODE_HELP[m]}</span></span>
              </label>
            ))}
          </fieldset>
          <fieldset className="space-y-1.5" disabled={disabled}>
            <legend className="mb-1 text-[13px] font-medium text-ink-2">Which missed calls</legend>
            {CALL_CLASSES.map((c: CallClass) => (
              <Check key={c} id={`rp-class-${c}`} label={CALL_CLASS_LABELS[c]} hint={CALL_CLASS_HELP[c]} checked={f.classes.includes(c)} onChange={(v) => set("classes", v ? [...f.classes, c] : f.classes.filter((x) => x !== c))} />
            ))}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Treat a call that ends within this many seconds, with nothing said, as hung up" htmlFor="rp-abandon"><Input id="rp-abandon" type="number" min={1} max={60} value={f.abandonedMaxSeconds} disabled={disabled} onChange={(e) => set("abandonedMaxSeconds", Number(e.target.value))} /></Field>
            <Field label="Wait before the first follow-up (minutes)" htmlFor="rp-delay"><Input id="rp-delay" type="number" min={0} max={1440} value={f.delayMinutes} disabled={disabled} onChange={(e) => set("delayMinutes", Number(e.target.value))} /></Field>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Your team">
        <div className="space-y-4">
          <Check id="rp-task" label="Create a call-back task" hint="One task per missed caller, linked to their contact." checked={f.actionTask} disabled={disabled} onChange={(v) => set("actionTask", v)} />
          {f.actionTask && <Field label="Due within (minutes)" htmlFor="rp-due" hint="A call that came in after hours is due when you open instead."><Input id="rp-due" type="number" min={5} max={10080} value={f.taskDueMinutes} disabled={disabled} onChange={(e) => set("taskDueMinutes", Number(e.target.value))} /></Field>}
          <Check id="rp-notify" label="Tell the team" hint="An in-app notice. It is not emailed unless people chose to be emailed everything." checked={f.actionNotify} disabled={disabled} onChange={(v) => set("actionNotify", v)} />
          {f.actionNotify && (
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1" disabled={disabled}>
              <legend className="mb-1 text-[13px] font-medium text-ink-2">Who</legend>
              {Object.entries(ROLE_LABELS).map(([role, label]) => (
                <Check key={role} id={`rp-role-${role}`} label={label} checked={f.notifyRoles.includes(role as MissedCallPolicy["notifyRoles"][number])} onChange={(v) => set("notifyRoles", (v ? [...f.notifyRoles, role] : f.notifyRoles.filter((r) => r !== role)) as MissedCallPolicy["notifyRoles"])} />
              ))}
            </fieldset>
          )}
          <Field label="Give new missed calls to" htmlFor="rp-owner" hint="Otherwise the contact's own owner, or nobody.">
            <Select id="rp-owner" value={f.assignUserId ?? ""} disabled={disabled} onChange={(e) => set("assignUserId", e.target.value || null)}>
              <option value="">The contact&apos;s owner</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </Field>
          <Check id="rp-opp" label="Note it on the caller's open deal" checked={f.actionOpportunity} disabled={disabled} onChange={(v) => set("actionOpportunity", v)} />
          <Check id="rp-follow" label="Remind the team if the caller never replies" hint="A task is created when the reply window ends without an answer." checked={f.actionFollowUp} disabled={disabled} onChange={(v) => set("actionFollowUp", v)} />
        </div>
      </SectionCard>

      <SectionCard title="Texting the caller">
        <div className="space-y-4">
          {f.mode === "manual" ? (
            <p className="flex items-start gap-2 text-[14px] text-muted"><Info className="mt-0.5 size-4 shrink-0" aria-hidden />Texting is off while the setting above is “{POLICY_MODE_LABELS.manual}”. Choose “{POLICY_MODE_LABELS.assisted}” or “{POLICY_MODE_LABELS.automatic}” to write the message.</p>
          ) : (
            <>
              <Field label="Message during opening hours" htmlFor="rp-open" hint={`Use {{business_name}} for “${businessName}”. Plain text, no links.`}>
                <Textarea id="rp-open" rows={3} maxLength={480} placeholder={DEFAULT_MESSAGE_OPEN} value={f.messageOpen ?? ""} disabled={disabled} onChange={(e) => set("messageOpen", e.target.value)} />
              </Field>
              <Field label="Message outside opening hours" htmlFor="rp-closed">
                <Textarea id="rp-closed" rows={3} maxLength={480} placeholder={DEFAULT_MESSAGE_AFTER_HOURS} value={f.messageAfterHours ?? ""} disabled={disabled} onChange={(e) => set("messageAfterHours", e.target.value)} />
              </Field>
              <p className="rounded-xl bg-surface-2 px-3 py-2 text-[13px] text-ink-2"><span className="font-medium">Preview:</span> {renderWording(f.messageOpen?.trim() || DEFAULT_MESSAGE_OPEN, { businessName })}</p>
              <Field label="Outside opening hours" htmlFor="rp-ah">
                <Select id="rp-ah" value={f.afterHoursBehavior} disabled={disabled} onChange={(e) => set("afterHoursBehavior", e.target.value as MissedCallPolicy["afterHoursBehavior"])}>
                  {AFTER_HOURS_BEHAVIORS.map((b) => <option key={b} value={b}>{AFTER_HOURS_LABELS[b]}</option>)}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Texts per missed call (at most)" htmlFor="rp-max"><Input id="rp-max" type="number" min={1} max={5} value={f.maxAttempts} disabled={disabled} onChange={(e) => set("maxAttempts", Number(e.target.value))} /></Field>
                <Field label="Minutes between texts" htmlFor="rp-gap" hint="Your platform may require longer."><Input id="rp-gap" type="number" min={15} max={10080} value={f.attemptGapMinutes} disabled={disabled} onChange={(e) => set("attemptGapMinutes", Number(e.target.value))} /></Field>
                <Field label="Wait for a reply (hours)" htmlFor="rp-window"><Input id="rp-window" type="number" min={1} max={336} value={f.responseWindowHours} disabled={disabled} onChange={(e) => set("responseWindowHours", Number(e.target.value))} /></Field>
              </div>
              <fieldset className="space-y-2" disabled={disabled}>
                <legend className="mb-1 text-[13px] font-medium text-ink-2">Who can be texted</legend>
                {(["recorded", "inbound_call"] as const).map((b) => (
                  <label key={b} className="flex min-h-11 items-start gap-3 text-[14px] sm:min-h-0">
                    <input type="radio" name="rp-basis" className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]" checked={f.smsConsentBasis === b} onChange={() => set("smsConsentBasis", b)} />
                    <span><span className="font-medium text-ink">{SMS_CONSENT_BASIS_LABELS[b]}</span>
                      {b === "recorded" && <span className="block text-[13px] text-muted">Recommended. A caller who has never agreed to be texted gets a call-back task instead.</span>}
                      {b === "inbound_call" && <span className="block text-[13px] text-muted">One service text about their own call. The rules differ by country and state: check them for where your callers are before choosing this.</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
              {f.smsConsentBasis === "inbound_call" && <Check id="rp-ack" label="I have checked the messaging rules where my callers are" hint="Recorded with your name when you save." checked={ack} disabled={disabled} onChange={setAck} />}
              <p className="text-[13px] text-muted">People who reply STOP, bounced numbers, quiet hours and your opening hours are always respected, and a teammate who takes the conversation stops automatic texts.</p>
            </>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Other options">
        <div className="space-y-4">
          <Check id="rp-aicall" label="Ask an AI employee to call back" hint="Not available yet: it needs an outbound-calling connection that has been verified, and none exists. Switching this on only records a blocked step on each case; nothing is ever called." checked={f.actionAiCallback} disabled={disabled} onChange={(v) => set("actionAiCallback", v)} />
          <Field label="Close a case that is still open after (hours)" htmlFor="rp-expiry"><Input id="rp-expiry" type="number" min={6} max={720} value={f.caseExpiryHours} disabled={disabled} onChange={(e) => set("caseExpiryHours", Number(e.target.value))} /></Field>
        </div>
      </SectionCard>

      {problems.length > 0 && canConfigure && <ul className="space-y-1 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[13px] text-danger-ink" role="alert">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      {canConfigure && !scope.readOnly && (
        <div className="sticky bottom-0 -mx-1 flex items-center gap-3 border-t border-line bg-bg/90 px-1 py-3 backdrop-blur">
          <Button loading={busy("save")} disabled={!dirty || problems.length > 0} onClick={save}>Save settings</Button>
          {dirty && <span className="text-[13px] text-muted">Unsaved changes</span>}
        </div>
      )}
    </div>
  );
}
