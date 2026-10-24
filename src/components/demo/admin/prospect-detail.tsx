import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge, Card } from "@/components/ui/primitives";
import { ProspectActions } from "@/components/demo/admin/prospect-actions";
import { availableActions, describeEvent, STATUS_LABEL, STATUS_TONE, windowWords } from "@/lib/demo/admin-view";
import { formatDateTime } from "@/lib/utils";
import type { ProspectDetail } from "@/server/demo/admin";

// One prospect: who they are, where their demo stands, what the team has done, and the buttons. Their conversation is not here: reading it is a button that records the read.
// Everything a prospect typed (name, address, business) is plain text in this page, never markup.

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-[13.5px] text-ink">{children}</dd>
    </div>
  );
}

const when = (iso: string | null, tz: string) => (iso ? formatDateTime(iso, tz) : "Not yet");

export function ProspectDetailView({
  detail,
  owners,
  caps,
  timeZone,
  now,
}: {
  detail: ProspectDetail;
  owners: Array<{ id: string; name: string }>;
  caps: { view: boolean; manage: boolean };
  timeZone: string;
  now: string;
}) {
  const p = detail.prospect;
  const clock = new Date(now);
  const actions = availableActions(
    {
      status: p.status,
      access: p.access,
      erased: p.erased,
      verified: p.verifiedAt !== null,
      messageCount: p.messageCount,
      consultationRequested: p.consultationRequestedAt !== null,
      consultationDone: p.consultationDoneAt !== null,
      conversionInProgress: p.conversionInProgress,
      converted: p.convertedOrgId !== null || p.status === "converted",
      extension: detail.extension,
    },
    caps,
  );
  const campaign = Object.entries(p.utm);
  return (
    <div className="space-y-5">
      <div>
        <Link href="/admin/prospects" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] text-muted hover:text-ink">
          <ArrowLeft className="size-4" aria-hidden />
          All prospects
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words text-[22px] font-semibold tracking-tight">{p.erased ? "Details erased" : (p.name ?? "No name")}</h1>
          <Badge tone={STATUS_TONE[p.status]}>{STATUS_LABEL[p.status]}</Badge>
        </div>
        {!p.erased && (
          <p className="break-words text-[13.5px] text-muted">
            {p.business ?? "No business"}
            {p.industryLabel ? `, ${p.industryLabel}` : ""}
          </p>
        )}
        <p className="text-[13px] text-ink-2">{windowWords(p, clock)}</p>
        {p.erased && <p role="status" className="rounded-xl border border-line bg-surface-2 px-4 py-3 text-[13.5px] text-ink-2">Their details and conversation were erased on {when(p.erasedAt, timeZone)}. Only dates, counts and the timeline remain.</p>}
        {p.conversionInProgress && <p role="status" className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-[13.5px] text-warning-ink">A workspace is being made for this prospect right now.</p>}
        {p.convertedOrgId && (
          <p className="text-[13.5px]">
            <Link href={`/admin/clients/${p.convertedOrgId}`} className="text-primary hover:underline">
              Open their client workspace
            </Link>
          </p>
        )}
      </header>

      <Card className="p-4">
        <h2 className="text-[15px] font-semibold text-ink">Details</h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {!p.erased && <Fact label="Email address">{p.email ?? "None"}</Fact>}
          <Fact label="Asked for a demo">{formatDateTime(p.createdAt, timeZone)}</Fact>
          <Fact label="Confirmed their address">{when(p.verifiedAt, timeZone)}</Fact>
          <Fact label="Demo window ends">{when(p.windowEndsAt, timeZone)}</Fact>
          <Fact label="Messages">
            {p.messagesUsed} of {p.messageAllowance} used{p.extraMessages ? ` (${p.extraMessages} added by the team)` : ""}
          </Fact>
          <Fact label="Extended">{p.extendedCount === 0 ? "Never" : `${p.extendedCount} time${p.extendedCount === 1 ? "" : "s"}, ${p.extendedHours} hours in all`}</Fact>
          <Fact label="Asked for a consultation">{p.consultationRequestedAt ? `${formatDateTime(p.consultationRequestedAt, timeZone)}${p.consultationDoneAt ? `, held ${formatDateTime(p.consultationDoneAt, timeZone)}` : ", not held yet"}` : "No"}</Fact>
          <Fact label="Pressed Buy now">{p.purchaseStartedAt ? formatDateTime(p.purchaseStartedAt, timeZone) : "No"}</Fact>
          <Fact label="Followed by">{p.ownerName ?? "Nobody yet"}</Fact>
          <Fact label="Agreed to the notice">
            {p.consentAt ? `${formatDateTime(p.consentAt, timeZone)} (version ${p.consentVersion ?? "unknown"})` : "No record"}
            {p.consentAt ? (p.marketingOptIn ? ", and ticked the marketing box" : ", did not tick the marketing box") : ""}
          </Fact>
          {p.accessRequestId && (
            <Fact label="Get-started form">
              Also asked through the form.{" "}
              <Link href="/admin/requests" className="text-primary hover:underline">
                Access requests
              </Link>
            </Fact>
          )}
          {campaign.length > 0 && <Fact label="Came from">{campaign.map(([k, v]) => `${k}: ${v}`).join(", ")}</Fact>}
        </dl>
      </Card>

      <ProspectActions
        id={p.id}
        actions={actions}
        owners={owners}
        ownerUserId={p.ownerUserId}
        extension={detail.extension}
        defaults={{ business: p.business ?? "", email: p.email ?? "" }}
        timeZone={timeZone}
      />

      <Card className="p-4">
        <h2 className="text-[15px] font-semibold text-ink">Timeline</h2>
        <ol className="mt-3 space-y-3" aria-label="Timeline">
          {detail.events.map((e) => {
            const words = describeEvent(e.kind, e.detail);
            const who = e.actorKind === "prospect" ? "the prospect" : e.actorKind === "system" ? "the system" : (e.actorName ?? "a team member");
            return (
              <li key={e.id} className="border-l-2 border-line pl-3">
                <p className="text-[13.5px] font-medium text-ink">{words.label}</p>
                {words.lines.map((l) => (
                  <p key={l} className="break-words text-[13px] leading-relaxed text-ink-2">
                    {l}
                  </p>
                ))}
                <p className="text-[12px] text-muted">
                  {formatDateTime(e.at, timeZone)} · {who}
                </p>
              </li>
            );
          })}
        </ol>
      </Card>
    </div>
  );
}
