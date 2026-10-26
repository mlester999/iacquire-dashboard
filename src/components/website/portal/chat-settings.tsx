"use client";

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleSlash, KeyRound, MessageCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyTextButton } from "@/components/ui/copy-button";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Select, Textarea } from "@/components/ui/primitives";
import { rotateWebChatKeyAction, saveWebChatSettingsAction } from "@/app/actions/webchat";
import { embedSnippet, INSTALL_STATE_LABELS, type QualificationQuestion } from "@/lib/webchat/rules";
import { relativeTime } from "@/lib/utils";
import type { WidgetView } from "@/server/webchat/config";
import type { ChatOverview, ChatWindowStats, HealthCheck } from "@/server/webchat/analytics";

// Website → Chat. Everything on this screen is either a setting that is saved, or a fact counted from stored records (or a check that says what it looked
// at). Nothing here says the chat "works" because a switch is on: the checks and the "last seen" line say whether it really loaded.

type Draft = {
  enabled: boolean; allowed: string; autoInstallSites: boolean; title: string; welcomeMessage: string; offlineMessage: string; brandColor: string; position: "bottom-right" | "bottom-left";
  launcherLabel: string; leadForm: "never" | "offer" | "required"; privacyNotice: string; privacyUrl: string; offerMarketingOptIn: boolean; aiEnabled: boolean; aiRoleKey: "sales_assistant" | "appointment_setter";
  offlineBehavior: "ai_answers" | "leave_message"; knowledgeSections: string[]; allowBooking: boolean; questions: Array<{ label: string; kind: "text" | "choice"; choices: string; required: boolean }>;
  dailySessionLimit: number; sessionMessageLimit: number; retentionDays: number; anonymousRetentionDays: number;
};

function toDraft(v: WidgetView): Draft {
  const s = v.settings;
  return {
    enabled: s.enabled, allowed: s.allowedOrigins.join("\n"), autoInstallSites: s.autoInstallSites, title: s.title, welcomeMessage: s.welcomeMessage, offlineMessage: s.offlineMessage, brandColor: s.brandColor,
    position: s.position, launcherLabel: s.launcherLabel, leadForm: s.leadForm, privacyNotice: s.privacyNotice, privacyUrl: s.privacyUrl ?? "", offerMarketingOptIn: s.offerMarketingOptIn, aiEnabled: s.aiEnabled,
    aiRoleKey: s.aiRoleKey, offlineBehavior: s.offlineBehavior, knowledgeSections: s.knowledgeSections, allowBooking: s.allowBooking,
    questions: s.qualificationQuestions.map((q: QualificationQuestion) => ({ label: q.label, kind: q.kind, choices: (q.choices ?? []).join(", "), required: q.required })),
    dailySessionLimit: s.dailySessionLimit, sessionMessageLimit: s.sessionMessageLimit, retentionDays: s.retentionDays, anonymousRetentionDays: s.anonymousRetentionDays,
  };
}

function toPatch(d: Draft) {
  return {
    enabled: d.enabled, allowedOrigins: d.allowed.split(/[\n,]/).map((x) => x.trim()).filter(Boolean), autoInstallSites: d.autoInstallSites, title: d.title, welcomeMessage: d.welcomeMessage,
    offlineMessage: d.offlineMessage, brandColor: d.brandColor, position: d.position, launcherLabel: d.launcherLabel, leadForm: d.leadForm, privacyNotice: d.privacyNotice, privacyUrl: d.privacyUrl.trim() || null,
    offerMarketingOptIn: d.offerMarketingOptIn, aiEnabled: d.aiEnabled, aiRoleKey: d.aiRoleKey, offlineBehavior: d.offlineBehavior, knowledgeSections: d.knowledgeSections as never, allowBooking: d.allowBooking,
    qualificationQuestions: d.questions.map((q) => ({ label: q.label, kind: q.kind, required: q.required, ...(q.kind === "choice" ? { choices: q.choices.split(",").map((c) => c.trim()).filter(Boolean) } : {}) })),
    dailySessionLimit: Number(d.dailySessionLimit), sessionMessageLimit: Number(d.sessionMessageLimit), retentionDays: Number(d.retentionDays), anonymousRetentionDays: Number(d.anonymousRetentionDays),
  };
}

function Check({ id, checked, onChange, children, hint }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="relative flex items-start gap-3 py-1.5">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 rounded border-line-strong accent-[var(--color-primary,#2563eb)]" />
      <div className="min-w-0">
        {/* The label stretches over the whole row, so the tap target is the row and not only the 20px box. */}
        <label htmlFor={id} className="text-[14px] font-medium text-ink after:absolute after:inset-0 after:content-['']">{children}</label>
        {hint && <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{hint}</p>}
      </div>
    </div>
  );
}

const HEALTH_ICON = { ok: CheckCircle2, attention: AlertTriangle, off: CircleSlash } as const;
const HEALTH_TONE = { ok: "text-success-ink", attention: "text-warning-ink", off: "text-muted" } as const;

function Health({ checks }: { checks: HealthCheck[] }) {
  return (
    <ul className="space-y-2.5" aria-label="Chat health checks">
      {checks.map((c) => {
        const Icon = HEALTH_ICON[c.state];
        return (
          <li key={c.key} className="flex items-start gap-2.5 text-[14px]">
            <Icon className={`mt-0.5 size-4 shrink-0 ${HEALTH_TONE[c.state]}`} role="img" aria-label={c.state === "ok" ? "Working" : c.state === "attention" ? "Needs attention" : "Off"} />
            <div>
              <p className="font-medium text-ink">{c.label}</p>
              <p className="text-[13px] text-muted">{c.detail}{c.href ? <> <Link href={c.href} className="-my-2 inline-block py-2 font-medium text-primary-ink underline">Open</Link></> : null}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Stats({ s }: { s: ChatWindowStats }) {
  const cells: Array<[string, number, string?]> = [
    ["Chats", s.chats, "Visitors who wrote or left their details"], ["Visitor messages", s.visitorMessages], ["AI replies", s.assistantReplies], ["Team replies", s.teamReplies],
    ["Left details", s.leads, "Details are unverified"], ["Answered your questions", s.qualified], ["Asked for a person", s.handoffs], ["Booking requests", s.bookingsRequested, "Requested, not necessarily confirmed"],
  ];
  return (
    <div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {cells.map(([label, n, hint]) => (
          <div key={label} className="rounded-xl border border-line bg-surface-2 p-3">
            <dt className="text-[12px] text-muted">{label}</dt>
            <dd className="mt-0.5 text-[20px] font-semibold tabular-nums text-ink">{n}</dd>
            {hint && <dd className="text-[12px] text-muted">{hint}</dd>}
          </div>
        ))}
      </dl>
      <div className="mt-3 grid gap-3 text-[13px] sm:grid-cols-2">
        <div>
          <h3 className="font-medium text-ink">Where chats start</h3>
          {s.topPages.length === 0 ? <p className="text-muted">No pages recorded yet.</p> : <ul className="mt-1 space-y-0.5">{s.topPages.map((p) => <li key={p.path} className="flex justify-between gap-2"><span className="truncate text-ink-2">{p.path}</span><span className="tabular-nums text-muted">{p.chats}</span></li>)}</ul>}
        </div>
        <div>
          <h3 className="font-medium text-ink">Where visitors came from</h3>
          {s.topSources.length === 0 ? <p className="text-muted">Nothing recorded yet. Sources are never guessed.</p> : <ul className="mt-1 space-y-0.5">{s.topSources.map((p) => <li key={p.source} className="flex justify-between gap-2"><span className="truncate text-ink-2">{p.label}</span><span className="tabular-nums text-muted">{p.chats}</span></li>)}</ul>}
        </div>
      </div>
    </div>
  );
}

export function WebChatSettings({ view, overview, appOrigin, sections }: { view: WidgetView; overview: ChatOverview; appOrigin: string; sections: Array<{ key: string; label: string }> }) {
  const [saved, setSaved] = React.useState(() => toDraft(view));
  const [d, setD] = React.useState(saved);
  const [version, setVersion] = React.useState(view.settings.version);
  const [key, setKey] = React.useState(view.settings.publicKey);
  const [busy, setBusy] = React.useState<null | "save" | "rotate">(null);
  const [error, setError] = React.useState<string | null>(null);
  const [days, setDays] = React.useState<7 | 30>(7);
  const canEdit = view.canEdit;
  const dirty = JSON.stringify(d) !== JSON.stringify(saved);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const snippet = embedSnippet({ appOrigin: appOrigin || "https://your-portal-address", key });

  async function save() {
    setBusy("save");
    setError(null);
    try {
      const res = await saveWebChatSettingsAction(toPatch(d) as never, version);
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      setVersion(res.data.version);
      setSaved(d);
      toast.success("Chat settings saved");
    } catch {
      setError("That didn't go through. Check your connection and try again.");
    } finally {
      setBusy(null);
    }
  }

  async function rotate() {
    if (!window.confirm("Replace the chat key? Every page that still has the old snippet stops showing the chat until you paste the new one.")) return;
    setBusy("rotate");
    try {
      const res = await rotateWebChatKeyAction();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setKey(res.data.publicKey);
      setVersion(res.data.version);
      toast.success("New key created. Update the snippet on your website.");
    } finally {
      setBusy(null);
    }
  }

  const stats = days === 7 ? overview.last7 : overview.last30;
  const state = view.install.state;

  return (
    <div className="space-y-6">
      {!canEdit && <p role="note" className="rounded-xl bg-surface-2 px-4 py-3 text-[14px] text-muted">You can see how the chat is set up. A teammate who can edit the website changes it.</p>}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Installation</CardTitle>
              <CardDescription>The chat appears on the websites you allow. Websites you build with Website Studio get it automatically.</CardDescription>
            </div>
            <Badge tone={state === "installed" ? "success" : state === "waiting" ? "warning" : "neutral"}>{INSTALL_STATE_LABELS[state]}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Check id="wc-enabled" checked={d.enabled} onChange={(v) => set("enabled", v)} hint="Visitors cannot open the chat while this is off.">Show the chat to visitors</Check>
          <Field label="Websites that may use the chat" htmlFor="wc-allowed" hint="One address per line, for example www.example.com. Use *.example.com for every subdomain. Anything not listed cannot load your chat.">
            <Textarea id="wc-allowed" rows={3} value={d.allowed} onChange={(e) => set("allowed", e.target.value)} disabled={!canEdit} placeholder="www.example.com" />
          </Field>
          <Check id="wc-auto" checked={d.autoInstallSites} onChange={(v) => set("autoInstallSites", v)} hint={view.siteHosts.length ? `Includes ${view.siteHosts.join(", ")}.` : "You have no Website Studio site yet."}>Install on my Website Studio sites automatically</Check>
          <div>
            <p className="text-[14px] font-medium text-ink-2">Snippet for any other website</p>
            <p className="text-[13px] text-muted">Paste this just before the closing body tag. It contains your public chat key only, which is not a password.</p>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface-2 p-3 text-[12px]" tabIndex={0} aria-label="Chat snippet"><code>{snippet}</code></pre>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CopyTextButton text={snippet} label="Copy snippet" className="min-h-11 sm:min-h-8" />
              {canEdit && <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={rotate} loading={busy === "rotate"}><KeyRound className="size-4" aria-hidden />Replace the key</Button>}
              {view.settings.lastSeenAt && <span className="text-[13px] text-muted">Last loaded on {view.settings.lastSeenOrigin} {relativeTime(view.settings.lastSeenAt as unknown as string)}.</span>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Is it working?</CardTitle><CardDescription>Each line says what was looked at. A line that needs attention says what to do.</CardDescription></CardHeader>
        <CardContent><Health checks={overview.health} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Look and wording</CardTitle></CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-[1fr_300px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title" htmlFor="wc-title"><Input id="wc-title" value={d.title} maxLength={60} onChange={(e) => set("title", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Button label" htmlFor="wc-label"><Input id="wc-label" value={d.launcherLabel} maxLength={24} onChange={(e) => set("launcherLabel", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Welcome message" htmlFor="wc-welcome" className="sm:col-span-2"><Textarea id="wc-welcome" rows={2} value={d.welcomeMessage} maxLength={300} onChange={(e) => set("welcomeMessage", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Message when nobody can answer" htmlFor="wc-offline" className="sm:col-span-2" hint="Shown when the assistant is off or the business is closed and the chat only takes messages."><Textarea id="wc-offline" rows={2} value={d.offlineMessage} maxLength={300} onChange={(e) => set("offlineMessage", e.target.value)} disabled={!canEdit} /></Field>
            <Field label="Colour" htmlFor="wc-color"><div className="flex items-center gap-2"><input id="wc-color" type="color" value={d.brandColor} onChange={(e) => set("brandColor", e.target.value)} disabled={!canEdit} className="h-10 w-14 cursor-pointer rounded-lg border border-line-strong bg-surface" /><Input aria-label="Colour as hex" value={d.brandColor} maxLength={7} onChange={(e) => set("brandColor", e.target.value)} disabled={!canEdit} className="w-28" /></div></Field>
            <Field label="Position" htmlFor="wc-pos"><Select id="wc-pos" value={d.position} onChange={(e) => set("position", e.target.value as Draft["position"])} disabled={!canEdit}><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></Select></Field>
          </div>
          <div aria-label="Preview of the chat window" role="img" className="self-start rounded-2xl border border-line bg-surface-2 p-3">
            <div className="overflow-hidden rounded-xl border border-line bg-white shadow-soft">
              <div className="px-3 py-2.5 text-[14px] font-semibold" style={{ background: d.brandColor, color: "#fff" }}>{d.title || "Chat"}</div>
              <div className="space-y-2 bg-[#f6f7f9] p-3 text-[12px] text-[#334155]"><p className="max-w-[85%] rounded-xl border border-dashed border-[#cbd5e1] bg-white px-2.5 py-1.5">{d.welcomeMessage}</p><p className="ml-auto max-w-[70%] rounded-xl px-2.5 py-1.5 text-white" style={{ background: d.brandColor }}>Do you fix roofs?</p></div>
            </div>
            <div className={`mt-2 flex ${d.position === "bottom-left" ? "justify-start" : "justify-end"}`}><span className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-semibold text-white" style={{ background: d.brandColor }}><MessageCircle className="size-3.5" aria-hidden />{d.launcherLabel}</span></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>What the assistant does</CardTitle><CardDescription>It answers as the AI employee you choose, so taking over, pausing and handing back work exactly as they do in your Inbox.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <Check id="wc-ai" checked={d.aiEnabled} onChange={(v) => set("aiEnabled", v)} hint="When off, every chat goes to your team and visitors are told a person will reply.">Let the AI employee answer visitors</Check>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Which AI employee" htmlFor="wc-role"><Select id="wc-role" value={d.aiRoleKey} onChange={(e) => set("aiRoleKey", e.target.value as Draft["aiRoleKey"])} disabled={!canEdit}><option value="sales_assistant">Sales Assistant</option><option value="appointment_setter">Appointment Setter</option></Select></Field>
            <Field label="When the business is closed" htmlFor="wc-offb" hint="By your business hours in Messaging settings."><Select id="wc-offb" value={d.offlineBehavior} onChange={(e) => set("offlineBehavior", e.target.value as Draft["offlineBehavior"])} disabled={!canEdit}><option value="ai_answers">The assistant keeps answering</option><option value="leave_message">Only take a message and details</option></Select></Field>
            <Field label="Visitor details form" htmlFor="wc-lead"><Select id="wc-lead" value={d.leadForm} onChange={(e) => set("leadForm", e.target.value as Draft["leadForm"])} disabled={!canEdit}><option value="offer">Offer it during the chat</option><option value="required">Ask for details before chatting</option><option value="never">Never show it</option></Select></Field>
            <Field label="Privacy page" htmlFor="wc-priv" optional hint="An https address shown under the chat."><Input id="wc-priv" value={d.privacyUrl} onChange={(e) => set("privacyUrl", e.target.value)} disabled={!canEdit} placeholder="https://www.example.com/privacy" /></Field>
          </div>
          <Field label="Privacy notice shown to visitors" htmlFor="wc-notice"><Textarea id="wc-notice" rows={2} value={d.privacyNotice} maxLength={600} onChange={(e) => set("privacyNotice", e.target.value)} disabled={!canEdit} /></Field>
          <Check id="wc-book" checked={d.allowBooking} onChange={(v) => set("allowBooking", v)} hint="It offers only times your connected calendar says are free, and never says something is booked unless the booking rules did it.">Let the assistant take booking requests</Check>
          <Check id="wc-mk" checked={d.offerMarketingOptIn} onChange={(v) => set("offerMarketingOptIn", v)} hint="Adds an unticked box to the details form. Without it, no offers consent is ever recorded.">Offer a box to receive offers and news</Check>
          <fieldset>
            <legend className="text-[14px] font-medium text-ink-2">Questions in the details form (up to three)</legend>
            <div className="mt-2 space-y-2">
              {d.questions.map((q, i) => (
                <div key={i} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_130px_1fr_auto]">
                  <Input aria-label={`Question ${i + 1}`} placeholder="What do you need help with?" value={q.label} onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} disabled={!canEdit} />
                  <Select aria-label={`Question ${i + 1} type`} value={q.kind} onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, kind: e.target.value as "text" | "choice" } : x)))} disabled={!canEdit}><option value="text">Free text</option><option value="choice">Choices</option></Select>
                  <Input aria-label={`Question ${i + 1} choices`} placeholder="Choices, separated by commas" value={q.choices} disabled={!canEdit || q.kind !== "choice"} onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, choices: e.target.value } : x)))} />
                  <div className="flex items-center gap-3"><label className="flex min-h-11 items-center gap-1.5 text-[13px] sm:min-h-6"><input type="checkbox" checked={q.required} onChange={(e) => set("questions", d.questions.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} className="size-5" disabled={!canEdit} />Required</label>{canEdit && <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-8" onClick={() => set("questions", d.questions.filter((_, j) => j !== i))}>Remove</Button>}</div>
                </div>
              ))}
              {canEdit && d.questions.length < 3 && <Button variant="outline" size="sm" className="min-h-11 sm:min-h-8" onClick={() => set("questions", [...d.questions, { label: "", kind: "text", choices: "", required: false }])}>Add a question</Button>}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>What it may know</CardTitle><CardDescription>The assistant sees only the parts of your business knowledge you tick here, and only text that is approved. It never sees the rest, and it does not quote a price that is not written in your approved prices.</CardDescription></CardHeader>
        <CardContent>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="sr-only">Knowledge the chat may use</legend>
            {sections.map((s) => (
              <Check key={s.key} id={`wc-k-${s.key}`} checked={d.knowledgeSections.includes(s.key)} onChange={(v) => set("knowledgeSections", v ? [...d.knowledgeSections, s.key] : d.knowledgeSections.filter((x) => x !== s.key))} hint={s.key === "approved_pricing" ? "Visitors are anonymous. Tick this only if you are happy for anyone to be told these prices." : undefined}>{s.label}</Check>
            ))}
          </fieldset>
          <p className="mt-3 text-[13px] text-muted">Edit the text itself in <Link href="/employees" className="font-medium text-primary-ink underline">your AI employees&apos; knowledge</Link>.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Limits and retention</CardTitle><CardDescription>Limits stop abuse and runaway cost. Old chats are removed on a schedule once the scheduler is running.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="New chats per day" htmlFor="wc-daily"><Input id="wc-daily" type="number" min={1} max={5000} value={d.dailySessionLimit} onChange={(e) => set("dailySessionLimit", Number(e.target.value))} disabled={!canEdit} /></Field>
          <Field label="Messages per chat" htmlFor="wc-msgs"><Input id="wc-msgs" type="number" min={5} max={300} value={d.sessionMessageLimit} onChange={(e) => set("sessionMessageLimit", Number(e.target.value))} disabled={!canEdit} /></Field>
          <Field label="Keep chats for (days)" htmlFor="wc-ret" hint="After no activity."><Input id="wc-ret" type="number" min={7} max={730} value={d.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))} disabled={!canEdit} /></Field>
          <Field label="Keep chats with no details (days)" htmlFor="wc-anon"><Input id="wc-anon" type="number" min={1} max={365} value={d.anonymousRetentionDays} onChange={(e) => set("anonymousRetentionDays", Number(e.target.value))} disabled={!canEdit} /></Field>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/95 px-4 py-3 shadow-soft backdrop-blur">
          <p role="status" className="text-[14px] text-muted">{error ? <span className="text-danger-ink">{error}</span> : dirty ? "You have unsaved changes." : "All changes saved."}</p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => { setD(saved); setError(null); }} disabled={!dirty || busy !== null}>Discard</Button>
            <Button variant="brand" onClick={save} loading={busy === "save"} disabled={!dirty}>Save changes</Button>
          </div>
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><CardTitle>Activity</CardTitle><CardDescription>Counted from stored chats. Nothing here is estimated.</CardDescription></div>
            <div role="group" aria-label="Period" className="flex gap-1">
              {[7, 30].map((n) => <Button key={n} variant={days === n ? "soft" : "ghost"} size="sm" aria-pressed={days === n} onClick={() => setDays(n as 7 | 30)}>{n} days</Button>)}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <Stats s={stats} />
          <div>
            <h3 className="text-[14px] font-semibold text-ink">Recent chats</h3>
            {overview.recent.length === 0 ? (
              <p className="mt-2 text-[14px] text-muted">No chats yet. When a visitor writes, it appears here and in your Inbox.</p>
            ) : (
              <div className="mt-2 overflow-x-auto" role="region" aria-label="Recent website chats" tabIndex={0}>
                <table className="w-full min-w-[640px] text-left text-[14px]">
                  <caption className="sr-only">Recent website chats</caption>
                  <thead className="text-[12px] text-muted"><tr><th scope="col" className="py-1.5 pr-3 font-medium">Visitor</th><th scope="col" className="py-1.5 pr-3 font-medium">Started on</th><th scope="col" className="py-1.5 pr-3 font-medium">Messages</th><th scope="col" className="py-1.5 pr-3 font-medium">Status</th><th scope="col" className="py-1.5 font-medium"><span className="sr-only">Open</span></th></tr></thead>
                  <tbody>
                    {overview.recent.map((r) => (
                      <tr key={r.sessionId} className="border-t border-line align-top">
                        <td className="py-2 pr-3"><span className="font-medium text-ink">{r.contactName ?? "Website visitor"}</span>{r.leadCaptured && <Badge tone="success" className="ml-2">Left details</Badge>}</td>
                        <td className="py-2 pr-3 text-ink-2">{r.landingPath ?? "/"}<span className="block text-[12px] text-muted">{r.host} · {relativeTime(r.startedAt)}</span></td>
                        <td className="py-2 pr-3 tabular-nums">{r.messages}</td>
                        <td className="py-2 pr-3">{r.mode === "team" ? <Badge tone="primary">A person has it</Badge> : r.mode === "waiting" ? <Badge tone="warning">Waiting for a person</Badge> : <Badge>AI answering</Badge>}</td>
                        <td className="py-2 text-right">{r.conversationId ? <Link href={`/inbox?conversation=${r.conversationId}`} className="inline-flex min-h-11 items-center font-medium text-primary-ink underline sm:min-h-0">Open in Inbox</Link> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
