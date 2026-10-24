"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/overlays";
import { Badge, Field, Input } from "@/components/ui/primitives";
import { ConfirmDialog } from "@/components/crm/ui";
import { setMessagesEnabledAction, setRetentionAction } from "@/app/actions/staff-messages";
import { parseRetentionInput, RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from "@/lib/staff-messages/limits";
import { MESSAGES_HOME } from "@/lib/staff-messages/view";
import { NoticeBanner } from "@/components/staff-messages/notice-banner";
import { useAction } from "@/components/staff-messages/use-action";

// The Super Admin's page for staff Messages: the switch, and the one setting that deletes things. Everything else about Messages is decided by the code and the
// permissions, not here. The honest limits are on the page, not in a document: what is simulated, what is not built, what nobody has checked yet.

export interface SettingsPanelProps {
  enabled: boolean;
  retentionDays: number | null;
}

export function SettingsPanel({ enabled: initialEnabled, retentionDays: initialDays }: SettingsPanelProps) {
  const { run, busy } = useAction();
  const [enabled, setEnabled] = React.useState(initialEnabled);
  const [savedDays, setSavedDays] = React.useState<number | null>(initialDays);
  const [keep, setKeep] = React.useState<"forever" | "days">(initialDays === null ? "forever" : "days");
  const [daysText, setDaysText] = React.useState(initialDays === null ? "" : String(initialDays));
  const [confirm, setConfirm] = React.useState<null | "off" | "retention">(null);
  const [problem, setProblem] = React.useState<string | null>(null);

  const parsed = keep === "forever" ? null : parseRetentionInput(daysText);
  const daysInvalid = keep === "days" && (parsed === null || parsed === "invalid");
  const changed = !daysInvalid && parsed !== savedDays;

  const toggle = async (next: boolean) => {
    const res = await run("enabled", () => setMessagesEnabledAction(next), { success: next ? "Messages is on." : "Messages is off." });
    if (res.ok) setEnabled(next);
    setConfirm(null);
  };
  const saveRetention = async () => {
    if (parsed === "invalid") return;
    setProblem(null);
    const res = await run("retention", () => setRetentionAction(parsed), { quiet: true, success: parsed === null ? "Messages will be kept." : `Messages older than ${parsed} days will be deleted.` });
    if (res.ok) setSavedDays(parsed);
    else setProblem(res.error);
    setConfirm(null);
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href={MESSAGES_HOME} className="inline-flex min-h-11 items-center gap-1 text-[13px] font-medium text-primary-ink hover:underline sm:min-h-8">
          <ChevronLeft className="size-4" aria-hidden /> Back to Messages
        </Link>
        <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.03em] text-ink sm:text-[27px]">Messages settings</h1>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">For Super Admins. Messages is the agency team&apos;s own chat: direct messages, groups and channels. It is not shown to clients or their customers.</p>
      </div>

      <section aria-labelledby="settings-switch" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="settings-switch" className="text-[16px] font-semibold text-ink">Messages is {enabled ? "on" : "off"}</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
              {enabled
                ? "Everyone on the agency team who may use Messages sees it in the navigation. Switching it off hides it and refuses every request; nothing is deleted."
                : "Nobody can use it yet. Switching it on connects nothing outside iAcquire and sends no email."}
            </p>
          </div>
          <Switch checked={enabled} disabled={busy("enabled")} aria-label="Messages is on" onCheckedChange={(v) => (v ? void toggle(true) : setConfirm("off"))} />
        </div>
      </section>

      <section aria-labelledby="settings-keep" className="space-y-4 rounded-2xl border border-line bg-surface p-5">
        <div>
          <h2 id="settings-keep" className="text-[16px] font-semibold text-ink">How long messages are kept</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
            By default nothing is deleted. If you choose a number of days, the hourly clean-up deletes older messages and their files for good (a message that starts a thread waits until its newest
            reply is old enough). The clean-up runs only once the scheduler stage that names it has been started; until then nothing is deleted, whatever is chosen here.
          </p>
        </div>
        <fieldset className="space-y-1">
          <legend className="sr-only">Retention</legend>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-surface-2">
            <input type="radio" name="keep" className="size-5 accent-[var(--color-primary,#305ecb)]" checked={keep === "forever"} onChange={() => setKeep("forever")} />
            <span className="text-[14px] text-ink">Keep everything</span>
            {savedDays === null && <Badge tone="success">Now</Badge>}
          </label>
          <label className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2 hover:bg-surface-2">
            <input type="radio" name="keep" className="size-5 accent-[var(--color-primary,#305ecb)]" checked={keep === "days"} onChange={() => setKeep("days")} />
            <span className="text-[14px] text-ink">Delete messages older than a number of days</span>
            {savedDays !== null && <Badge tone="warning">Now {savedDays} days</Badge>}
          </label>
        </fieldset>
        {keep === "days" && (
          <Field label="Days" htmlFor="retention-days" hint={`A whole number from ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}.`} error={daysText.trim() !== "" && parsed === "invalid" ? `Enter a whole number from ${RETENTION_DAYS_MIN} to ${RETENTION_DAYS_MAX}.` : null}>
            <Input id="retention-days" inputMode="numeric" value={daysText} onChange={(e) => setDaysText(e.target.value)} className="max-w-40" autoComplete="off" />
          </Field>
        )}
        {problem && <p role="alert" className="text-[13px] text-danger-ink">{problem}</p>}
        <Button disabled={!changed} loading={busy("retention")} onClick={() => (parsed === null ? void saveRetention() : setConfirm("retention"))}>Save</Button>
      </section>

      <section aria-labelledby="settings-notice" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
        <h2 id="settings-notice" className="text-[16px] font-semibold text-ink">What staff are told</h2>
        <p className="text-[13.5px] leading-relaxed text-muted">Everyone who uses Messages can open this notice at the top of the page. Its wording is a draft for your counsel; nothing treats it as approved.</p>
        <NoticeBanner />
      </section>

      <section aria-labelledby="settings-limits" className="space-y-3 rounded-2xl border border-line bg-surface p-5">
        <h2 id="settings-limits" className="text-[16px] font-semibold text-ink">What to know before relying on it</h2>
        <ul className="list-disc space-y-2 pl-5 text-[13.5px] leading-relaxed text-ink-2">
          <li>Messages are protected by access rules, not by encryption. People who run the system, or anyone with a database backup, could read them.</li>
          <li>A Super Admin cannot open a direct message or a private group they are not part of. There is no way to read one for an investigation; that would need a decision and a build.</li>
          <li>Files are limited to 10 MB, five to a message, and a few safe types. They are not scanned for viruses, and a hosting platform may refuse uploads larger than a few megabytes.</li>
          <li>New messages reach an open page within seconds through a stream or a short poll. There are no typing indicators. Hosted real-time delivery has not been tested on a live project.</li>
          <li>Notices stay inside iAcquire and never carry the text of a message. No email is sent.</li>
        </ul>
      </section>

      <ConfirmDialog
        open={confirm === "off"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Switch Messages off?"
        description="It disappears from the navigation for everyone and every request is refused. Nothing is deleted, and it all comes back when you switch it on."
        confirmLabel="Switch off"
        danger
        loading={busy("enabled")}
        onConfirm={() => void toggle(false)}
      />
      <ConfirmDialog
        open={confirm === "retention"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete messages older than ${typeof parsed === "number" ? parsed : ""} days?`}
        description="Once the clean-up runs, every message older than this, and its files, is deleted for good. This cannot be undone and there is no export."
        confirmLabel="Save and allow deletion"
        danger
        loading={busy("retention")}
        onConfirm={() => void saveRetention()}
      />
    </div>
  );
}
