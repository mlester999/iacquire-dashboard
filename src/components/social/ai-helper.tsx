"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { PLATFORM_LABELS, PLATFORM_LIMITS, type PostKind } from "@/lib/social/rules";
import { draftFromOptionAction, suggestCaptionsAction, suggestIdeasAction } from "@/app/actions/social";
import type { AccountView } from "@/server/social/accounts";
import type { CampaignView } from "@/server/social/settings";
import type { CaptionOption, IdeaSuggestion } from "@/server/social/ai";

// AI help with writing. It only ever creates a DRAFT, marked as AI-written; a person edits it and someone with approval rights approves it before anything can be
// scheduled. It writes from your approved business knowledge and is told not to invent testimonials, results, prices or offers. Suggestions that do make such
// claims are dropped, so you may get fewer than you asked for.

export function AiHelper({ accounts, campaigns, enabled, defaultAccountId, scheduleDay }: { accounts: AccountView[]; campaigns: CampaignView[]; enabled: boolean; defaultAccountId?: string | null; scheduleDay?: string | null }) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const usable = accounts.filter((a) => a.status === "connected" || a.status === "needs_reauth" || a.status === "error");
  const [accountId, setAccountId] = React.useState(defaultAccountId && usable.some((a) => a.id === defaultAccountId) ? defaultAccountId : usable[0]?.id ?? "");
  const [campaignId, setCampaignId] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [tone, setTone] = React.useState("friendly");
  const [ideas, setIdeas] = React.useState<IdeaSuggestion[] | null>(null);
  const [captions, setCaptions] = React.useState<{ runId: string; options: CaptionOption[]; kind: PostKind } | null>(null);
  const account = usable.find((a) => a.id === accountId);

  if (!enabled) {
    return <section aria-label="AI help" className="rounded-2xl border border-line bg-surface-2 p-4 text-[13px] text-ink-2">AI drafting is switched off for this workspace. The business owner can switch it on in the social media settings.</section>;
  }

  const defaultKind = (): PostKind => (account && PLATFORM_LIMITS[account.platform].kinds.includes("text") ? "text" : "image");

  async function getIdeas() {
    setCaptions(null);
    const r = await run("ideas", () => suggestIdeasAction({ accountId, campaignId: campaignId || null, topic: topic || null, tone }));
    if (r) setIdeas((r as { ideas: IdeaSuggestion[] }).ideas);
  }
  async function getCaptions(idea: IdeaSuggestion | null) {
    const kind = idea?.kind ?? defaultKind();
    const r = await run("captions", () => suggestCaptionsAction({ accountId, kind, idea: idea ? { title: idea.title, angle: idea.angle } : null, topic: idea ? null : topic || null, campaignId: campaignId || null, tone }));
    if (r) setCaptions({ runId: (r as { runId: string }).runId, options: (r as { options: CaptionOption[] }).options, kind });
  }
  async function makeDraft(i: number) {
    if (!captions) return;
    const r = await run(`draft-${i}`, () => draftFromOptionAction(captions.runId, i, { accountId, kind: captions.kind, campaignId: campaignId || null }), "Saved as an AI-written draft.");
    // The day chosen in the calendar only starts the schedule box on the draft's page; the page checks it again.
    if (r) router.push(`/social/posts/${(r as { id: string }).id}${scheduleDay ? `?date=${scheduleDay}` : ""}`);
  }

  return (
    <section aria-label="AI help" className="space-y-3 rounded-2xl border border-line bg-surface p-4">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold text-ink"><Sparkles className="size-4 text-violet-ink" aria-hidden />Get AI help</h2>
      <p className="text-[12.5px] text-muted">Written from your approved business knowledge. It only makes drafts: a person edits and approves them before anything is published.</p>
      <Field label="Account" htmlFor="ai-account">
        <Select id="ai-account" value={accountId} onChange={(e) => { setAccountId(e.target.value); setIdeas(null); setCaptions(null); }}>
          {usable.map((a) => <option key={a.id} value={a.id}>{a.name} ({PLATFORM_LABELS[a.platform]})</option>)}
        </Select>
      </Field>
      <Field label="What should it be about?" htmlFor="ai-topic" optional>
        <Input id="ai-topic" value={topic} maxLength={200} onChange={(e) => setTopic(e.target.value)} placeholder="Spring maintenance, a new service…" className="text-[16px] sm:text-[14px]" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Tone" htmlFor="ai-tone">
          <Select id="ai-tone" value={tone} onChange={(e) => setTone(e.target.value)}>
            {["friendly", "professional", "playful", "direct"].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </Select>
        </Field>
        <Field label="Campaign" htmlFor="ai-campaign" optional>
          <Select id="ai-campaign" value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">None</option>
            {campaigns.filter((c) => c.status === "active").map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" loading={busy("ideas")} disabled={!accountId} onClick={getIdeas}>Suggest ideas</Button>
        <Button variant="outline" loading={busy("captions")} disabled={!accountId || !topic.trim()} onClick={() => getCaptions(null)}>Write captions about this</Button>
      </div>

      {ideas && !captions && (
        <ul className="space-y-2" aria-label="Ideas">
          {ideas.map((idea, i) => (
            <li key={i} className="rounded-xl border border-line p-3 text-[13px]">
              <p className="font-medium text-ink">{idea.title}</p>
              <p className="mt-0.5 text-ink-2">{idea.angle}</p>
              {idea.callToAction && <p className="mt-0.5 text-muted">Call to action: {idea.callToAction}</p>}
              <Button className="mt-2" size="sm" variant="soft" loading={busy("captions")} onClick={() => getCaptions(idea)}>Write captions for this</Button>
            </li>
          ))}
        </ul>
      )}

      {captions && (
        <div role="group" className="space-y-2" aria-label="Caption options">
          <button type="button" className="inline-flex min-h-11 items-center text-[12.5px] font-medium text-primary-ink underline sm:min-h-8" onClick={() => setCaptions(null)}>Back to ideas</button>
          <ul className="space-y-2">
            {captions.options.map((o, i) => (
              <li key={i} className="rounded-xl border border-line p-3 text-[13px]">
                <p className="whitespace-pre-wrap text-ink">{o.caption}</p>
                {o.hashtags.length > 0 && <p className="mt-1 text-muted">{o.hashtags.map((h) => `#${h}`).join(" ")}</p>}
                <Button className="mt-2" size="sm" variant="soft" loading={busy(`draft-${i}`)} onClick={() => makeDraft(i)}>Save as a draft</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
