"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { saveProposalSettingsAction } from "@/app/actions/proposals";
import { formFromSettings, patchFromForm, sameForm, settingsIssues, type SavedSettings, type SettingsForm } from "@/lib/proposals/settings-form";
import { syncVersions } from "@/lib/social/edit-sync";

// The workspace's rules for proposals. Everything is off or at its safest until the owner changes it. There is no setting that lets an AI-written proposal go out without a
// person's approval, and none that lets anyone but a person at the business send a proposal: that is stated here so nobody looks for one.

function Check({ id, checked, onChange, disabled, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean; label: string; hint: string }) {
  return (
    <div className="relative flex items-start gap-3 py-1.5">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-['']">{label}</label>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{hint}</p>
      </div>
    </div>
  );
}

export interface SettingsPanelProps {
  settings: SavedSettings;
  /** The workspace's own currency: the approval amount is typed in it. */
  currency: string;
  canEdit: boolean;
  tags: Array<{ id: string; name: string }>;
  stages: Array<{ id: string; name: string; pipelineName: string }>;
}

export function ProposalSettingsPanel({ settings, currency, canEdit, tags, stages }: SettingsPanelProps) {
  const { run, busy } = useCrmAction();
  // The saved settings the form started from. A save is checked against this version, so edits made on top of old settings can never overwrite newer ones.
  const [loaded, setLoaded] = React.useState(settings);
  const [f, setF] = React.useState<SettingsForm>(() => formFromSettings(settings, currency));
  const base = formFromSettings(loaded, currency);
  const dirty = !sameForm(f, base);
  const issues = settingsIssues(f, currency);
  const invalid = Boolean(issues.approvalOver || issues.validityDays);
  const sync = syncVersions({ loadedVersion: loaded.version, currentVersion: settings.version, loaded: base, current: formFromSettings(settings, currency), mine: f, same: sameForm });
  const adopt = (s: SavedSettings) => {
    setF(formFromSettings(s, currency));
    setLoaded(s);
  };
  if (sync === "mark_current") setLoaded(settings);
  else if (sync === "adopt_current") adopt(settings);
  const set = (p: Partial<SettingsForm>) => setF((x) => ({ ...x, ...p }));

  async function save() {
    if (invalid) return;
    const saved = await run("save", () => saveProposalSettingsAction(patchFromForm(f, currency), loaded.version), "Settings saved.");
    if (saved && typeof saved === "object" && "version" in saved) adopt(saved as SavedSettings);
  }

  return (
    <form className="space-y-8" aria-label="Proposal settings" onSubmit={(e) => { e.preventDefault(); if (sync !== "conflict") void save(); }}>
      {sync === "conflict" && (
        <div role="alert" className="rounded-xl border border-warning-ink/30 bg-warning-soft px-3 py-2.5 text-[13px] text-warning-ink">
          <p className="font-medium">Someone else changed these settings while you were editing them.</p>
          <p className="mt-0.5">Your changes are kept below, but they cannot be saved over the newer settings. Load the latest settings, then make your changes again.</p>
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => adopt(settings)}>Load the latest settings</Button>
        </div>
      )}

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!canEdit}>
        <legend className="px-1 text-[15px] font-semibold text-ink">Approval</legend>
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">A proposal written by AI always needs a person&apos;s approval before it can be sent, and so does one written by someone who cannot send proposals. Only the owner or a manager approves. There is no setting that changes this.</p>
        <Field label="Which proposals get a second look" htmlFor="ps-mode">
          <Select id="ps-mode" value={f.approvalMode} onChange={(e) => set({ approvalMode: e.target.value as SettingsForm["approvalMode"] })}>
            <option value="ai_and_discounts">Only the ones that need it (AI drafts, discounts, large totals)</option>
            <option value="all">Every proposal</option>
          </Select>
        </Field>
        <Check id="ps-discount" checked={f.discountNeedsApproval} disabled={!canEdit} onChange={(v) => set({ discountNeedsApproval: v })} label="Review a proposal that gives a discount or sets a price below the price book" hint="Only the owner or a manager can give a discount in the first place; this makes sure another person looks at it before it goes out." />
        <Field label={`Review a proposal whose total is above (${currency})`} htmlFor="ps-over" optional error={issues.approvalOver ?? null} hint="Compared with each billing group's total (tax included) as a plain number, whatever currency the proposal is in. Leave it empty for no limit.">
          <Input id="ps-over" inputMode="decimal" value={f.approvalOver} onChange={(e) => set({ approvalOver: e.target.value })} className="text-[16px] sm:text-[14px]" />
        </Field>
        <Check id="ps-two" checked={f.twoPerson} disabled={!canEdit} onChange={(v) => set({ twoPerson: v })} label="Ask for a second person to approve every proposal" hint="The person who wrote a proposal, or sent it for approval, cannot approve it too. Leave this off if you are the only person who manages proposals." />
      </fieldset>

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!canEdit}>
        <legend className="px-1 text-[15px] font-semibold text-ink">AI help</legend>
        <Check id="ps-ai" checked={f.aiDraftsEnabled} disabled={!canEdit} onChange={(v) => set({ aiDraftsEnabled: v })} label="Let the AI write first drafts of proposals" hint="It picks items from your price book and writes the wording from your approved business knowledge. It never sets a price, a discount or a date, and what it states that your price book or knowledge does not back is removed. It can still get things wrong, so what it writes is a draft that a person edits and approves. It is off until you switch it on, and it uses your AI service credits." />
      </fieldset>

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!canEdit}>
        <legend className="px-1 text-[15px] font-semibold text-ink">Defaults</legend>
        <Field label="A new proposal is valid for (days)" htmlFor="ps-days" optional error={issues.validityDays ?? null} hint="Fills in the valid-until date on a new proposal. Leave it empty and a proposal has no date until someone sets one.">
          <Input id="ps-days" inputMode="numeric" value={f.validityDays} onChange={(e) => set({ validityDays: e.target.value })} className="text-[16px] sm:text-[14px]" />
        </Field>
      </fieldset>

      <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-4" disabled={!canEdit}>
        <legend className="px-1 text-[15px] font-semibold text-ink">Deals and tags</legend>
        <p className="text-[13px] text-muted">All of this is off by default. When a step fails, the proposal itself is not affected and the history says what failed.</p>
        <Field label="When a proposal is sent, add this tag to the customer" htmlFor="ps-tag" optional hint="A Blueprint can start a follow-up from the tag.">
          <Select id="ps-tag" value={f.tagOnSendId} onChange={(e) => set({ tagOnSendId: e.target.value })}>
            <option value="">Do nothing</option>
            {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            {f.tagOnSendId && !tags.some((t) => t.id === f.tagOnSendId) && <option value={f.tagOnSendId}>A tag that is no longer listed</option>}
          </Select>
        </Field>
        <Field label="When a proposal is sent, move the deal to this stage" htmlFor="ps-stage" optional hint="Only forward, within the deal's own pipeline, and never to Won or Lost.">
          <Select id="ps-stage" value={f.stageOnSendId} onChange={(e) => set({ stageOnSendId: e.target.value })}>
            <option value="">Do nothing</option>
            {stages.map((st) => <option key={st.id} value={st.id}>{st.pipelineName}: {st.name}</option>)}
            {f.stageOnSendId && !stages.some((st) => st.id === f.stageOnSendId) && <option value={f.stageOnSendId}>A stage that is no longer listed</option>}
          </Select>
        </Field>
        <Field label="When a proposal is accepted" htmlFor="ps-accept" hint="An acceptance is the customer's recorded answer, not payment or a signature.">
          <Select id="ps-accept" value={f.dealOnAccept} onChange={(e) => set({ dealOnAccept: e.target.value as SettingsForm["dealOnAccept"] })}>
            <option value="none">Do nothing to the deal</option>
            <option value="won_stage">Move the deal to the Won stage</option>
          </Select>
        </Field>
      </fieldset>

      {canEdit ? (
        <Button type="submit" variant="brand" loading={busy("save")} disabled={!dirty || invalid || sync === "conflict"}>Save settings</Button>
      ) : <p className="text-[12.5px] text-muted">Only the business owner can change these.</p>}
    </form>
  );
}
