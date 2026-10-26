"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { archiveCampaignAction, createCampaignAction, saveSocialSettingsAction } from "@/app/actions/social";
import { fieldsOfSettings, sameSettings, syncVersions, type SettingsFields } from "@/lib/social/edit-sync";
import { normalizeHashtags } from "@/lib/social/rules";
import type { CampaignView, SocialSettings } from "@/server/social/settings";

// The workspace's rules for social posts, and its campaigns. There is no setting that lets an AI-written post publish itself: that is stated here so nobody
// looks for one.

function Check({ id, checked, onChange, disabled, label, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled: boolean; label: string; hint: string }) {
  return (
    <div className="relative flex items-start gap-3 py-1.5">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]" />
      <div className="min-w-0">
        <label htmlFor={id} className="text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-['']">{label}</label>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{hint}</p>
      </div>
    </div>
  );
}

export function SettingsPanel({ settings, campaigns, canEdit, canCampaign }: { settings: SocialSettings; campaigns: CampaignView[]; canEdit: boolean; canCampaign: boolean }) {
  const { run, busy } = useCrmAction();
  // The saved settings the form started from. A save is checked against this version, so edits made on top of old settings can never overwrite newer ones.
  const [loaded, setLoaded] = React.useState(settings);
  const formOf = (s: SocialSettings) => ({ approvalForPublishers: s.approvalForPublishers, aiDraftsEnabled: s.aiDraftsEnabled, trackingLinks: s.trackingLinks, hashtags: s.defaultHashtags.map((h) => `#${h}`).join(" "), voice: s.brandVoiceNote ?? "" });
  const [d, setD] = React.useState(() => formOf(settings));
  const [name, setName] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [archive, setArchive] = React.useState<CampaignView | null>(null);
  const mine: SettingsFields = { approvalForPublishers: d.approvalForPublishers, aiDraftsEnabled: d.aiDraftsEnabled, trackingLinks: d.trackingLinks, hashtags: normalizeHashtags(d.hashtags.split(/[\s,]+/), 10), voice: d.voice };
  const dirty = !sameSettings(mine, fieldsOfSettings(loaded));
  // When the page brings newer settings (someone else saved, or a save was refused because they had), the form follows them if it has not been touched. With
  // unsaved edits it keeps them, and says they cannot be saved over the newer settings.
  const sync = syncVersions({ loadedVersion: loaded.version, currentVersion: settings.version, loaded: fieldsOfSettings(loaded), current: fieldsOfSettings(settings), mine, same: sameSettings });
  function adopt(s: SocialSettings) {
    setD(formOf(s));
    setLoaded(s);
  }
  async function save() {
    const saved = await run("save", () => saveSocialSettingsAction({ approvalForPublishers: d.approvalForPublishers, aiDraftsEnabled: d.aiDraftsEnabled, trackingLinks: d.trackingLinks, defaultHashtags: mine.hashtags, brandVoiceNote: d.voice || null }, loaded.version), "Settings saved.");
    // What the server stored is the base for the next save.
    if (saved && typeof saved === "object") setLoaded(saved as SocialSettings);
  }
  // Adjusting state while rendering is the pattern React documents for state that follows a prop: it re-renders at once, before anything is shown or painted,
  // and only while the saved version moves ahead of the base (the next render is in sync).
  if (sync === "mark_current") setLoaded(settings);
  else if (sync === "adopt_current") adopt(settings);

  return (
    <div className="space-y-8">
      <section aria-label="Approval and AI" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Approval and AI</h2>
        {sync === "conflict" && (
          <div role="alert" className="rounded-xl border border-warning-ink/30 bg-warning-soft px-3 py-2.5 text-[14px] text-warning-ink">
            <p className="font-medium">Someone else changed these settings while you were editing them.</p>
            <p className="mt-0.5">Your changes are kept below, but they cannot be saved over the newer settings. Load the latest settings, then make your changes again.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2" onClick={() => adopt(settings)}>Load the latest settings</Button>
          </div>
        )}
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[14px] text-ink-2">A post written by AI always needs a person&apos;s approval before it can be scheduled. A post written by someone who cannot publish does too. There is no setting that changes this.</p>
        <Check id="ss-appr" checked={d.approvalForPublishers} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, approvalForPublishers: v }))} label="Ask for a second person's approval on every post" hint="Even a post written by an owner or manager is reviewed by someone else before it can be scheduled. Leave this off if you are the only person who manages social media." />
        <Check id="ss-ai" checked={d.aiDraftsEnabled} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, aiDraftsEnabled: v }))} label="Let the AI suggest ideas and write draft captions" hint="It is told to write only from your approved business knowledge and not to invent testimonials, results, prices or offers, and suggestions that make claims the knowledge does not back are dropped. It can still get things wrong, so what it writes is a draft: a person edits it and approves it before anything is posted." />
        <Check id="ss-track" checked={d.trackingLinks} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, trackingLinks: v }))} label="Tag the links in posts so leads can be traced to them" hint="Adds source tags to a post's link. When a visitor arrives from it and leaves their details, the lead is recorded as coming from that post." />
        <Field label="Hashtags added to AI drafts" htmlFor="ss-tags" optional hint="Up to 10, separated by spaces.">
          <Input id="ss-tags" value={d.hashtags} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, hashtags: e.target.value }))} placeholder="#HarborHome" className="text-[16px] sm:text-[14px]" />
        </Field>
        <Field label="How your business sounds" htmlFor="ss-voice" optional hint="A sentence or two the AI should follow: warm and plain, formal, playful. It does not replace your approved brand voice knowledge.">
          <Textarea id="ss-voice" rows={3} maxLength={600} value={d.voice} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, voice: e.target.value }))} className="text-[16px] sm:text-[14px]" />
        </Field>
        {canEdit ? (
          <Button variant="brand" loading={busy("save")} disabled={!dirty || sync === "conflict"} onClick={save}>Save settings</Button>
        ) : <p className="text-[13px] text-muted">Only the business owner can change these.</p>}
      </section>

      <section aria-label="Campaigns" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Campaigns</h2>
        <p className="text-[13px] text-muted">A campaign groups posts and gives their links a campaign name, so lead reports can show which campaign brought a lead.</p>
        {campaigns.length === 0 ? <p className="text-[14px] text-ink-2">No campaigns yet.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {campaigns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[14px]">
                <span><span className="font-medium text-ink">{c.name}</span> <span className="text-muted">· tag “{c.utmCampaign}”{c.status === "archived" ? " · archived" : ""}</span>{c.goal && <span className="block text-[13px] text-ink-2">{c.goal}</span>}</span>
                {canCampaign && c.status === "active" && <Button size="sm" variant="ghost" onClick={() => setArchive(c)}>Archive</Button>}
              </li>
            ))}
          </ul>
        )}
        {canCampaign && (
          <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={async (e) => { e.preventDefault(); if (await run("campaign", () => createCampaignAction({ name, goal: goal || null }), "Campaign added.")) { setName(""); setGoal(""); } }}>
            <Field label="Campaign name" htmlFor="sc-name"><Input id="sc-name" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
            <Field label="Goal" htmlFor="sc-goal" optional><Input id="sc-goal" value={goal} maxLength={400} onChange={(e) => setGoal(e.target.value)} className="text-[16px] sm:text-[14px]" /></Field>
            <Button type="submit" variant="secondary" loading={busy("campaign")} disabled={!name.trim()}>Add campaign</Button>
          </form>
        )}
      </section>

      <ConfirmDialog
        open={Boolean(archive)} onOpenChange={(o) => !o && setArchive(null)} title={`Archive ${archive?.name ?? "this campaign"}?`} confirmLabel="Archive" loading={busy("archive")}
        description="New posts can no longer be added to it. Posts already in it, and the leads they brought, keep their link to it."
        onConfirm={async () => { if (!archive) return; await run("archive", () => archiveCampaignAction(archive.id), "Archived."); setArchive(null); }}
      />
    </div>
  );
}
