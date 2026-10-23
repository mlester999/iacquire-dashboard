"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/primitives";
import { ConfirmDialog, useCrmAction } from "@/components/crm/ui";
import { archiveCampaignAction, createCampaignAction, saveSocialSettingsAction } from "@/app/actions/social";
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
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{hint}</p>
      </div>
    </div>
  );
}

export function SettingsPanel({ settings, campaigns, canEdit, canCampaign }: { settings: SocialSettings; campaigns: CampaignView[]; canEdit: boolean; canCampaign: boolean }) {
  const { run, busy } = useCrmAction();
  const [d, setD] = React.useState({ approvalForPublishers: settings.approvalForPublishers, aiDraftsEnabled: settings.aiDraftsEnabled, trackingLinks: settings.trackingLinks, hashtags: settings.defaultHashtags.map((h) => `#${h}`).join(" "), voice: settings.brandVoiceNote ?? "" });
  const [name, setName] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [archive, setArchive] = React.useState<CampaignView | null>(null);
  const dirty = d.approvalForPublishers !== settings.approvalForPublishers || d.aiDraftsEnabled !== settings.aiDraftsEnabled || d.trackingLinks !== settings.trackingLinks || d.hashtags !== settings.defaultHashtags.map((h) => `#${h}`).join(" ") || d.voice !== (settings.brandVoiceNote ?? "");

  return (
    <div className="space-y-8">
      <section aria-label="Approval and AI" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Approval and AI</h2>
        <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">A post written by AI always needs a person&apos;s approval before it can be scheduled. A post written by someone who cannot publish does too. There is no setting that changes this.</p>
        <Check id="ss-appr" checked={d.approvalForPublishers} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, approvalForPublishers: v }))} label="Ask for a second person's approval on every post" hint="Even a post written by an owner or manager is reviewed by someone else before it can be scheduled. Leave this off if you are the only person who manages social media." />
        <Check id="ss-ai" checked={d.aiDraftsEnabled} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, aiDraftsEnabled: v }))} label="Let the AI suggest ideas and write draft captions" hint="It writes only from your approved business knowledge and never invents testimonials, results, prices or offers. What it writes is a draft for a person to edit." />
        <Check id="ss-track" checked={d.trackingLinks} disabled={!canEdit} onChange={(v) => setD((x) => ({ ...x, trackingLinks: v }))} label="Tag the links in posts so leads can be traced to them" hint="Adds source tags to a post's link. When a visitor arrives from it and leaves their details, the lead is recorded as coming from that post." />
        <Field label="Hashtags added to AI drafts" htmlFor="ss-tags" optional hint="Up to 10, separated by spaces.">
          <Input id="ss-tags" value={d.hashtags} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, hashtags: e.target.value }))} placeholder="#HarborHome" className="text-[16px] sm:text-[14px]" />
        </Field>
        <Field label="How your business sounds" htmlFor="ss-voice" optional hint="A sentence or two the AI should follow: warm and plain, formal, playful. It does not replace your approved brand voice knowledge.">
          <Textarea id="ss-voice" rows={3} maxLength={600} value={d.voice} disabled={!canEdit} onChange={(e) => setD((x) => ({ ...x, voice: e.target.value }))} className="text-[16px] sm:text-[14px]" />
        </Field>
        {canEdit ? (
          <Button variant="brand" loading={busy("save")} disabled={!dirty} onClick={() => run("save", () => saveSocialSettingsAction({ approvalForPublishers: d.approvalForPublishers, aiDraftsEnabled: d.aiDraftsEnabled, trackingLinks: d.trackingLinks, defaultHashtags: normalizeHashtags(d.hashtags.split(/[\s,]+/), 10), brandVoiceNote: d.voice || null }, settings.version), "Settings saved.")}>Save settings</Button>
        ) : <p className="text-[12.5px] text-muted">Only the business owner can change these.</p>}
      </section>

      <section aria-label="Campaigns" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
        <h2 className="text-[15px] font-semibold text-ink">Campaigns</h2>
        <p className="text-[12.5px] text-muted">A campaign groups posts and gives their links a campaign name, so lead reports can show which campaign brought a lead.</p>
        {campaigns.length === 0 ? <p className="text-[13px] text-ink-2">No campaigns yet.</p> : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {campaigns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-[13.5px]">
                <span><span className="font-medium text-ink">{c.name}</span> <span className="text-muted">· tag “{c.utmCampaign}”{c.status === "archived" ? " · archived" : ""}</span>{c.goal && <span className="block text-[12.5px] text-ink-2">{c.goal}</span>}</span>
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
