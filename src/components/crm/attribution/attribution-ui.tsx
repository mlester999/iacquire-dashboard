"use client";

import * as React from "react";
import Link from "next/link";
import { Globe, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Input } from "@/components/ui/primitives";
import { useCrmAction } from "@/components/crm/ui";
import { recordSourceAction } from "@/app/actions/attribution";
import { CONFIDENCE_LABELS, sourceLabel, TOUCH_KIND_LABELS } from "@/lib/attribution/model";
import { relativeTime } from "@/lib/utils";
import type { TouchRecord } from "@/server/attribution/touches";
import type { WebChatContext } from "@/server/webchat/context";

// Where a lead came from, and how sure we are. A touch says what it carried; "Inferred" and "Not recorded" are shown as such, never dressed up as fact.

const CONFIDENCE_TONE = { known: "success", inferred: "warning", unknown: "neutral" } as const;

function Card({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="flex items-center gap-1.5 text-[14px] font-semibold"><Icon className="size-4 text-muted" aria-hidden />{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function describe(t: TouchRecord): string {
  const parts = [sourceLabel(t.source), t.medium, t.campaign].filter(Boolean);
  return parts.join(" · ");
}

function TouchLine({ label, t }: { label: string; t: TouchRecord }) {
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="w-20 shrink-0 text-muted">{label}</span>
      <span className="font-medium text-ink">{describe(t)}</span>
      {/* A touch with no source already reads "Not recorded"; a second badge saying the same would only repeat it. */}
      {t.confidence !== "unknown" && <Badge tone={CONFIDENCE_TONE[t.confidence]}>{CONFIDENCE_LABELS[t.confidence]}</Badge>}
      <span className="text-muted">{TOUCH_KIND_LABELS[t.kind]}, {relativeTime(t.occurredAt)}</span>
    </li>
  );
}

/** A person's own note of where a contact came from (a referral, a trade show). It is recorded as a touch like any other, marked as entered by hand. */
function RecordSource({ orgId, contactId }: { orgId: string | null; contactId: string }) {
  const { run, busy } = useCrmAction();
  const [open, setOpen] = React.useState(false);
  const [source, setSource] = React.useState("");
  const [campaign, setCampaign] = React.useState("");
  if (!open) return <Button variant="secondary" size="sm" className="mt-3" onClick={() => setOpen(true)}>Record a source</Button>;
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run("source", () => recordSourceAction(orgId, contactId, { source, campaign: campaign || null }), "Source recorded.")) { setOpen(false); setSource(""); setCampaign(""); }
      }}
    >
      <label className="block text-[12px] font-medium text-ink" htmlFor={`src-${contactId}`}>Where did they find you?</label>
      <Input id={`src-${contactId}`} list={`src-list-${contactId}`} value={source} maxLength={80} onChange={(e) => setSource(e.target.value)} placeholder="Referral, trade show, walk-in" required />
      <datalist id={`src-list-${contactId}`}>{["Referral", "Walk-in", "Trade show", "Event", "Phone", "Partner"].map((o) => <option key={o} value={o} />)}</datalist>
      <label className="block text-[12px] font-medium text-ink" htmlFor={`camp-${contactId}`}>Campaign or detail <span className="font-normal text-muted">(optional)</span></label>
      <Input id={`camp-${contactId}`} value={campaign} maxLength={120} onChange={(e) => setCampaign(e.target.value)} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="brand" loading={busy("source")} disabled={!source.trim()}>Save</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function AttributionCard({ first, latest, history, edit }: { first: TouchRecord | null; latest: TouchRecord | null; history: TouchRecord[]; edit?: { orgId: string | null; contactId: string } }) {
  if (!first) {
    return (
      <Card title="Where they came from" icon={MapPin}>
        <p className="text-[13px] text-muted">Nothing was recorded about how this contact found you. It is not guessed.</p>
        {edit && <RecordSource {...edit} />}
      </Card>
    );
  }
  const same = latest && latest.id === first.id;
  return (
    <Card title="Where they came from" icon={MapPin}>
      <ul className="space-y-1.5 text-[13px]">
        <TouchLine label="First touch" t={first} />
        {latest && !same && <TouchLine label="Latest touch" t={latest} />}
      </ul>
      {history.length > 2 && (
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-muted">All {history.length} touches</summary>
          <ul className="mt-1.5 space-y-1">
            {history.map((t) => (
              <li key={t.id} className="text-ink-2">{describe(t)} <span className="text-muted">({CONFIDENCE_LABELS[t.confidence].toLowerCase()}, {TOUCH_KIND_LABELS[t.kind].toLowerCase()}, {relativeTime(t.occurredAt)})</span></li>
            ))}
          </ul>
        </details>
      )}
      {edit && <RecordSource {...edit} />}
    </Card>
  );
}

export function WebChatCard({ view, crmHref }: { view: WebChatContext; crmHref: (id: string) => string }) {
  return (
    <Card title="Website chat" icon={Globe}>
      <div className="space-y-2 text-[13px]">
        <p className="text-ink-2">
          Started {relativeTime(view.startedAt)} on <span className="font-medium text-ink">{view.host}</span>{view.surface === "site" ? " (your Website Studio site)" : ""}
          {view.landingPath ? <> from <span className="font-medium text-ink">{view.landingPath}</span></> : null}.
        </p>
        {view.referrer && <p className="break-all text-muted">Arrived from {view.referrer}</p>}
        {view.possibleMatch && (
          <p role="note" className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-warning-ink">
            The details they typed match <Link href={crmHref(view.possibleMatch.id)} className="font-medium underline">{view.possibleMatch.name}</Link> in your CRM. Nothing was linked, because anyone can type anyone&apos;s details. Check before you reply; merge the two only if it is the same person.
          </p>
        )}
        <p className="text-muted">
          {view.leadCaptured ? "They left their details (unverified). " : "They have not left their details. "}
          {view.marketingOptIn ? "They asked to receive offers. " : ""}
          {view.handoffRequested ? "They asked for a person." : ""}
        </p>
        {view.qualification.length > 0 && (
          <dl className="space-y-1">
            {view.qualification.map((q) => (
              <div key={q.label}><dt className="text-muted">{q.label}</dt><dd className="font-medium text-ink">{q.answer}</dd></div>
            ))}
          </dl>
        )}
      </div>
    </Card>
  );
}
