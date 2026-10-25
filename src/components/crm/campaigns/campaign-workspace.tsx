"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Ban, Copy, FlaskConical, Pause, Pencil, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/overlays";
import { ConfirmDialog, ReadOnlyNotice, useCrmAction } from "@/components/crm/ui";
import type { FilterOptions } from "@/components/crm/filter-builder";
import { cancelCampaignAction, duplicateCampaignAction, pauseCampaignAction, resumeCampaignAction, testSendCampaignAction, type CampaignTestOutcome } from "@/app/actions/crm-campaigns";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { cn, relativeTime } from "@/lib/utils";
import type { CrmScope } from "@/server/crm/page";
import type { BuilderOptions, CampaignDetail, CampaignPreview, RecipientFilter, RecipientPage } from "@/server/crm/campaigns";
import { APPROVAL_STATE, CampaignStatusBadge, ChannelLabel, NOTICE_TITLE } from "@/components/crm/campaigns/parts";
import { CampaignBuilder } from "@/components/crm/campaigns/builder";
import { CampaignProgress, CampaignSummary, DeliveryLog } from "@/components/crm/campaigns/progress";

export interface CampaignWorkspaceProps {
  scope: CrmScope;
  campaign: CampaignDetail;
  options: BuilderOptions | null;
  filterOptions: FilterOptions;
  preview: CampaignPreview | null;
  recipients: RecipientPage | null;
  recipientFilter: RecipientFilter;
  testDestinations: Array<{ channel: Channel; address: string; label: string }>;
  /** The list's current filter, to describe the audience in words. */
  listFilter: unknown;
}

/** One campaign: building and approving it before it starts; its progress and delivery log once it has. */
export function CampaignWorkspace({ scope, campaign, options, filterOptions, preview, recipients, recipientFilter, testDestinations, listFilter }: CampaignWorkspaceProps) {
  const router = useRouter();
  const { run, busy } = useCrmAction();
  const canManage = !!scope.can["campaigns.manage"] && !scope.readOnly && !scope.agency;
  const canSend = !!scope.can["campaigns.send"] && !scope.agency;
  const [editing, setEditing] = React.useState(false);
  const [confirm, setConfirm] = React.useState<null | "cancel" | "pause" | "resume">(null);
  const [testing, setTesting] = React.useState(false);
  const [destination, setDestination] = React.useState("");
  const [testResult, setTestResult] = React.useState<CampaignTestOutcome | null>(null);
  const s = campaign.status;
  const notStarted = !campaign.startedAt;
  const buildable = (s === "draft" || s === "awaiting_approval") || (editing && notStarted && (s === "scheduled" || s === "paused"));
  const showBuilder = buildable && options;
  const destinations = testDestinations.filter((d) => d.channel === campaign.channel);
  const base = `${scope.base}/campaigns`;

  const duplicate = async () => {
    const out = await run("duplicate", () => duplicateCampaignAction(scope.orgId, campaign.id), "Copied as a new draft.");
    if (out && typeof out === "object" && "id" in out) router.push(`${base}/${out.id}`);
  };
  const act = async () => {
    if (confirm === "pause") await run("pause", () => pauseCampaignAction(scope.orgId, campaign.id), (d) => (d.held ? `Paused. ${d.held} queued ${d.held === 1 ? "message is" : "messages are"} held.` : "Paused. Nothing more is queued."));
    else if (confirm === "resume") await run("resume", () => resumeCampaignAction(scope.orgId, campaign.id), (d) => (d.status === "sending" ? "Resumed. It continues at its approved pace." : "Resumed. It starts at its scheduled time."));
    else if (confirm === "cancel") await run("cancel", () => cancelCampaignAction(scope.orgId, campaign.id), (d) => (d.stopped ? `Cancelled. ${d.stopped} queued ${d.stopped === 1 ? "message was" : "messages were"} stopped.` : "Cancelled."));
    setConfirm(null);
  };
  const sendTest = async () => {
    if (!destination) return;
    setTestResult(null);
    const out = await run("test", () => testSendCampaignAction(scope.orgId, campaign.id, { destination }));
    if (out && typeof out === "object") setTestResult(out as CampaignTestOutcome);
  };

  return (
    <div className="space-y-5">
      <div>
        <Link href={base} className="inline-flex min-h-11 items-center gap-1.5 text-[14px] font-medium text-muted hover:text-ink sm:min-h-0"><ArrowLeft className="size-4" aria-hidden />Campaigns</Link>
        <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="break-words text-[20px] font-semibold tracking-[-0.03em] text-ink">{campaign.name}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-muted">
              <CampaignStatusBadge status={s} />
              <ChannelLabel channel={campaign.channel} />
              <span aria-hidden>·</span>
              <span>{APPROVAL_STATE[campaign.approval].label}</span>
              <span aria-hidden>·</span>
              <span suppressHydrationWarning>updated {relativeTime(campaign.updatedAt)}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage && campaign.message && (s === "draft" || s === "awaiting_approval" || s === "scheduled" || s === "paused") && (
              <Button variant="secondary" onClick={() => { setTesting(true); setTestResult(null); setDestination(destinations[0]?.address ?? ""); }}><FlaskConical className="size-4" aria-hidden />Send a test</Button>
            )}
            {canManage && notStarted && (s === "scheduled" || (s === "paused" && !editing)) && !editing && (
              <Button variant="secondary" onClick={() => setEditing(true)}><Pencil className="size-4" aria-hidden />Change it</Button>
            )}
            {canManage && (s === "scheduled" || s === "sending") && <Button variant="secondary" onClick={() => setConfirm("pause")}><Pause className="size-4" aria-hidden />Pause</Button>}
            {canSend && s === "paused" && <Button onClick={() => setConfirm("resume")}><Play className="size-4" aria-hidden />Resume</Button>}
            {canManage && <Button variant="ghost" loading={busy("duplicate")} onClick={duplicate}><Copy className="size-4" aria-hidden />Duplicate</Button>}
            {canManage && s !== "completed" && s !== "cancelled" && <Button variant="ghost" className="text-danger-ink" onClick={() => setConfirm("cancel")}><Ban className="size-4" aria-hidden />{s === "draft" ? "Discard" : "Cancel"}</Button>}
          </div>
        </div>
      </div>

      {!canManage && <ReadOnlyNotice>{scope.readOnly ? undefined : "You can see this campaign. Preparing campaigns needs “Prepare campaigns”."}</ReadOnlyNotice>}
      {s === "paused" && !canSend && canManage && <ReadOnlyNotice>Resuming sends to people, so only the workspace owner can resume it.</ReadOnlyNotice>}

      {campaign.notice && s !== "completed" && s !== "cancelled" && (
        <div className={cn("flex gap-2.5 rounded-2xl border px-4 py-3", campaign.notice.code === "paused" ? "border-line bg-surface-2" : "border-warning/30 bg-warning-soft")} role="status">
          <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", campaign.notice.code === "paused" ? "text-muted" : "text-warning-ink")} aria-hidden />
          <div className="min-w-0 text-[14px]">
            <p className={cn("font-semibold", campaign.notice.code === "paused" ? "text-ink" : "text-warning-ink")}>{NOTICE_TITLE[campaign.notice.code]}</p>
            <p className={cn("mt-0.5 leading-relaxed", campaign.notice.code === "paused" ? "text-ink-2" : "text-warning-ink")}>{campaign.notice.detail}</p>
            {campaign.notice.code === "credits" && <Link href="/settings/billing" className="mt-1 inline-block font-medium text-primary hover:underline">Add service credits</Link>}
            {campaign.notice.code === "missing_values" && /Configuration Values/.test(campaign.notice.detail) && <Link href={`${scope.base}/settings/values`} className="mt-1 inline-block font-medium text-primary hover:underline">Open Configuration Values</Link>}
          </div>
        </div>
      )}
      {s === "cancelled" && <p className="rounded-2xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">Cancelled{campaign.cancelledByName ? ` by ${campaign.cancelledByName}` : ""}. Nothing more is sent. Duplicate it to prepare it again.</p>}

      {showBuilder ? (
        <CampaignBuilder key={campaign.updatedAt} scope={scope} campaign={campaign} options={options} filterOptions={filterOptions} initialPreview={preview} canEdit={canManage} onDone={editing ? () => setEditing(false) : undefined} />
      ) : (
        <>
          {campaign.startedAt && <CampaignProgress campaign={campaign} timezone={scope.timezone} />}
          <CampaignSummary scope={scope} campaign={campaign} filterOptions={filterOptions} listFilter={listFilter} />
          {recipients && <DeliveryLog scope={scope} campaign={campaign} page={recipients} filter={recipientFilter} />}
        </>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "pause" ? "Pause this campaign?" : confirm === "resume" ? "Resume this campaign?" : s === "draft" ? "Discard this draft?" : "Cancel this campaign?"}
        description={
          confirm === "pause"
            ? "Nothing more is queued, and messages it queued that haven't left are held. Messages a provider already took can't be recalled."
            : confirm === "resume"
              ? "It continues at its approved pace. The approval and the approved wording are checked again, and every message is still checked against consent, opt-outs, quiet hours and credits before it leaves."
              : "Nobody else is sent this campaign, and messages it queued that haven't left are stopped. This can't be undone; you can duplicate it later."
        }
        confirmLabel={confirm === "pause" ? "Pause" : confirm === "resume" ? "Resume" : s === "draft" ? "Discard draft" : "Cancel campaign"}
        danger={confirm === "cancel"}
        loading={busy("pause") || busy("resume") || busy("cancel")}
        onConfirm={act}
      />

      <Dialog
        open={testing}
        onOpenChange={setTesting}
        title="Send a test"
        description={`Sends this campaign's message, filled in with sample contact details, to one of your workspace's approved ${CHANNEL_LABELS[campaign.channel]} test destinations. Customers never receive tests.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setTesting(false)}>Close</Button>
            <Button loading={busy("test")} disabled={!destination} onClick={sendTest}><FlaskConical className="size-4" aria-hidden />Send test</Button>
          </>
        }
      >
        {destinations.length ? (
          <div className="space-y-3">
            <Field label="Test destination" htmlFor="campaign-test-destination">
              <Select id="campaign-test-destination" value={destination} onChange={(e) => setDestination(e.target.value)}>
                {destinations.map((d) => <option key={d.address} value={d.address}>{d.label ? `${d.label} (${d.address})` : d.address}</option>)}
              </Select>
            </Field>
            {testResult && (
              <p role="status" className={cn("rounded-xl px-3 py-2 text-[13px]", testResult.ok && testResult.status !== "blocked" && testResult.status !== "failed" ? "bg-success-soft text-success-ink" : "bg-warning-soft text-warning-ink")}>
                {testResult.ok ? <><strong className="font-semibold">{testResult.statusLabel}.</strong> {testResult.detail}</> : testResult.detail}
              </p>
            )}
          </div>
        ) : (
          <p className="text-[14px] leading-relaxed text-ink-2">
            Your workspace has no approved {CHANNEL_LABELS[campaign.channel]} test destination yet. Add your own {campaign.channel === "email" ? "email address" : "number"} in{" "}
            <Link href={`${scope.base}/settings/communications`} className="font-medium text-primary hover:underline">Communication Settings</Link>.
          </p>
        )}
      </Dialog>
    </div>
  );
}
