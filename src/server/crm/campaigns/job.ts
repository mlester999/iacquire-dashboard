import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { checkOrgAutomation } from "@/server/automation/gate";
import { systemActor } from "@/server/crm/actor";
import { emitEvent } from "@/server/crm/events";
import { assertNativeOwner } from "@/server/crm/workspace";
import { nativeAutomationRefusal } from "@/server/crm/provider-guard";
import { tokenValuesFor } from "@/server/crm/message-templates";
import { getConsent } from "@/server/messaging/contacts";
import { evaluateSend, queueOutbound, type SendRequest } from "@/server/messaging/send";
import { describeMissing, renderMessage, type CustomValueTokenDef, type TokenKey } from "@/lib/messaging/tokens";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";
import { formatDateTime } from "@/lib/utils";
import {
  CAMPAIGN_COLUMNS, MAX_RECIPIENTS, MAX_WAIT_MS, audienceOutcomeSql, businessValuePhrase, businessValuesNow, campaignApprovalHash, changedBusinessValues, channelProblems,
  loadAudienceList, loadCampaignTemplate, messageProblems, personOutcome, publishedClientRate, providerLabel, templateProblems, unitFor, unitLabel, usedBusinessValues,
  wordingStillApproved, bindingChanges, readBinding,
  type ApprovalBinding, type AudienceOutcome, type BusinessValues, type CampaignRow, type CampaignTemplate, type ExclusionReason,
} from "@/server/crm/campaigns/rules";
import {
  holdQueuedMessages, notice, readNotice, readWaitUntil, refreshCounts, releaseHeldMessages, setNotice, stopCampaign, voidApproval, type CampaignNotice,
} from "@/server/crm/campaigns/state";

// The campaign sending job (registered in src/server/ops/tick.ts as "crmCampaigns", between the workflow runs and the dispatcher).
//
//  * A scheduled campaign whose time has come starts: its approval is checked against what would be sent now (any change voids it), and the
//    Smart List is read once. Everyone on it is recorded as a recipient: pending when they may receive it, excluded (with the reason) when not.
//  * Pending recipients are queued at most rate_per_minute in any minute. Each is checked again at that moment (consent, opt-outs, an address,
//    the details the message needs) and queued through the normal outbound path (queueOutbound → evaluateSend: marketing consent, suppression,
//    quiet hours, business hours, the program-message frequency limit, credits, budget) as the system acting on the owner's approval, never
//    as an AI. The message's dedupe key camp:<campaign>:<contact> makes a second message to the same person impossible.
//  * Someone the rules ask to wait (quiet hours in their time zone, spacing between messages) stays pending until then. When it is the whole
//    workspace that waits (business hours, a provider switch) the campaign waits instead of checking people one by one.
//  * Running out of credits, the budget, the channel, the published price or the approved wording stops the campaign (paused, with the
//    reason, owners notified). Nothing more is queued until a person resumes it.
//  * Delivery, bounces and unsubscribes are read back from the messages and consent history onto the recipients (reconcileCampaign), and the
//    campaign completes, emitting campaign.sent, once nobody is pending and nothing it queued is still waiting to leave.

const CAMPAIGNS_PER_TICK = 10;
/** The most people one campaign's turn looks at in one tick, whatever happens to them, so a tick stays short. */
const MAX_EVALUATIONS_PER_TICK = 300;
/** The most messages one campaign queues in one tick (rate_per_minute also applies). */
const MAX_QUEUED_PER_TICK = 200;
/** How long a campaign waits before checking again when the workspace is paused. */
const PAUSE_RECHECK_MS = 5 * 60_000;
const RECONCILE_EVERY = "1 minute";
const RECONCILE_FOR = "14 days";

export interface CampaignJobResult {
  started: number;
  queued: number;
  excluded: number;
  waiting: number;
  completed: number;
  stopped: number;
  reconciled: number;
}

interface Prepared {
  c: CampaignRow;
  org: { id: string; name: string; timezone: string };
  template: CampaignTemplate & { version: NonNullable<CampaignTemplate["version"]> };
  /** The person whose approval the campaign acts on (author of its messages, never an AI). */
  approverId: string | null;
  ratePerMinute: number;
  /** The business details and configuration values the owner approved: every message is checked against them before it is queued. */
  approvedValues: BusinessValues;
}

type Step = "none" | "not_sending" | "queued" | "linked" | "excluded" | "waiting" | "workspace_waits" | "stopped";

const zero = (): CampaignJobResult => ({ started: 0, queued: 0, excluded: 0, waiting: 0, completed: 0, stopped: 0, reconciled: 0 });

async function lockCampaign(db: Queryable, id: string, orgId: string, opts: { skipLocked?: boolean } = {}): Promise<CampaignRow | null> {
  const { rows } = await db.query<CampaignRow>(`select ${CAMPAIGN_COLUMNS} from crm_campaigns where id = $1 and org_id = $2 for update${opts.skipLocked ? " skip locked" : ""}`, [id, orgId]);
  return rows[0] ?? null;
}

/**
 * The binding the campaign would be approved under right now (the list's current filter, the version's frozen content hash, and the
 * business details and configuration values that wording uses, as they are now).
 */
export async function currentBinding(db: Queryable, c: Pick<CampaignRow, "org_id" | "channel" | "smart_list_id" | "template_id" | "template_version" | "scheduled_at" | "rate_per_minute">) {
  const list = await loadAudienceList(db, c.org_id, c.smart_list_id);
  const t = await loadCampaignTemplate(db, c.org_id, c.template_id, c.template_version);
  if (!list?.filter || !t?.version || !c.smart_list_id || !c.template_id || !c.template_version) return { list, template: t, binding: null, hash: null, customValues: [] };
  const now = await businessValuesNow(db, c.org_id, t.version);
  const binding: ApprovalBinding = {
    channel: c.channel, smartListId: c.smart_list_id, filter: list.filter, templateId: c.template_id, templateVersion: c.template_version,
    templateContentHash: t.version.contentHash, whatsappTemplateId: c.channel === "whatsapp" ? t.whatsappTemplateId : null,
    scheduledAt: c.scheduled_at ? new Date(c.scheduled_at).toISOString() : null, ratePerMinute: c.rate_per_minute, businessValues: now.values,
  };
  return { list, template: t, binding, hash: campaignApprovalHash(binding), customValues: now.customValues };
}

/**
 * Why a campaign that has started may not send another message: a business detail or configuration value its wording uses differs from
 * what the owner approved. Null when they are all the same.
 */
export function valuesChangedSinceApproval(approved: BusinessValues | undefined, current: BusinessValues, customValues: ReadonlyArray<CustomValueTokenDef>): string | null {
  const changed = changedBusinessValues(approved, current);
  if (!changed.length) return null;
  const what = changed.map((k) => businessValuePhrase(k, customValues));
  const list = what.length === 1 ? what[0] : `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}`;
  return `${list.replace(/^./, (s) => s.toUpperCase())} changed after the owner approved this campaign, so the approval no longer stands and nothing more is sent. Duplicate the campaign and request approval again to send the new wording.`;
}

/** Stops a started campaign whose approved content changed and withdraws the approval, so only a new approval can send it. */
async function voidStartedCampaign(db: Queryable, c: CampaignRow, detail: string, now: Date): Promise<void> {
  await voidApproval(db, c, detail, null);
  await stopCampaign(db, c, notice("approval_void", detail, now), { hold: true });
}

/** Puts a campaign whose approval no longer matches back to draft, withdrawing the approval with the reason. */
export async function returnToDraft(db: Queryable, c: CampaignRow, n: CampaignNotice, actorUserId: string | null): Promise<void> {
  await voidApproval(db, c, n.detail, actorUserId);
  await db.query("update crm_campaigns set status = 'draft', approved_hash = null where id = $1 and org_id = $2", [c.id, c.org_id]);
  c.status = "draft";
  c.approved_hash = null;
  await setNotice(db, c, n, { waitUntil: null });
}

/**
 * Checks a campaign that is due or sending and, when it is scheduled, starts it. Returns what the queue loop needs, or how it ended.
 * One transaction, holding the campaign's row.
 */
async function prepare(id: string, orgId: string, now: Date, out: CampaignJobResult): Promise<Prepared | null> {
  return withSystem(async (db) => {
    const c = await lockCampaign(db, id, orgId, { skipLocked: true });
    if (!c || (c.status !== "scheduled" && c.status !== "sending")) return null;
    if (c.status === "scheduled" && c.scheduled_at && new Date(c.scheduled_at).getTime() > now.getTime()) return null;
    const org = (await db.query<{ id: string; name: string; timezone: string }>("select id, name, timezone from organizations where id = $1", [orgId])).rows[0];
    if (!org) return null;

    // A paused workspace (or iAcquire's own pause) holds every campaign, including what it queued and hasn't sent (the dispatcher doesn't
    // apply pauses to the system's own sends); it continues by itself when the pause is lifted.
    for (const scope of ["messaging", "outbound"] as const) {
      const gate = await checkOrgAutomation(db, orgId, scope);
      if (!gate.allowed) {
        await holdQueuedMessages(db, c);
        await setNotice(db, c, notice("workspace_paused", `${gate.detail} The campaign continues by itself when that is lifted.`, now), { waitUntil: new Date(now.getTime() + PAUSE_RECHECK_MS) });
        out.waiting += 1;
        return null;
      }
    }
    if (readNotice(c.counts)?.code === "workspace_paused") {
      await releaseHeldMessages(db, c, now);
      await setNotice(db, c, null, { waitUntil: null });
    }
    const stop = async (code: CampaignNotice["code"], detail: string, hold: boolean) => {
      await stopCampaign(db, c, notice(code, detail, now), { hold });
      out.stopped += 1;
      return null;
    };
    try {
      await assertNativeOwner(db, orgId, "contacts");
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      return stop("provider", `Campaigns send to your iAcquire CRM contacts. ${err.message}`, true);
    }
    // Hybrid CRM: GoHighLevel owning conversations means its own automations message these people, so an iAcquire campaign never sends too.
    // (While a provider switch cuts over, each message's own send check makes the campaign wait in place instead: see evaluateSend.)
    const conversationsElsewhere = await nativeAutomationRefusal(db, orgId, "conversations");
    if (conversationsElsewhere) return stop("provider", `${conversationsElsewhere} Move conversations to iAcquire in Settings → CRM Provider to send campaigns.`, true);

    const approval = c.approval_id
      ? (await db.query<{ status: string; decided_by: string | null; action: Record<string, unknown> }>("select status, decided_by, action from approval_requests where id = $1 and org_id = $2", [c.approval_id, orgId])).rows[0]
      : undefined;
    if (!approval || approval.status !== "approved" || !c.approved_hash) {
      return stop("approval_void", "The owner's approval of this campaign no longer stands, so nothing more is sent. Request approval again to continue.", true);
    }

    const { list, template: t, binding, hash, customValues } = await currentBinding(db, c);
    if (c.status === "scheduled") {
      if (!list || list.archived || !list.filter) return stop("list_unavailable", "The campaign's Smart List was deleted, so it can't start. Cancel it and create a new one with another list.", true);
      if (list.filterError) return stop("list_unavailable", `${list.filterError} The campaign can't start until then.`, true);
      if (!binding || hash !== c.approved_hash) {
        // Something the owner approved changed before it started (the list's filter, the wording, a value it uses): the approval no longer applies.
        const changed = binding ? bindingChanges(readBinding(approval.action.binding), binding, customValues) : ["the message"];
        await returnToDraft(db, c, notice("approval_void", `${changed.join(", ").replace(/^./, (s) => s.toUpperCase())} changed after the owner approved it, so it went back to draft and nothing was sent. Review it and request approval again.`, now), null);
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "message_blocked", severity: "warning", title: `Campaign “${c.name.slice(0, 80)}” needs approval again`, body: "What it would send changed after it was approved, so it didn't start.",
          link: `/crm/campaigns/${c.id}`, dedupeKey: `campaign-void:${c.id}:${c.approval_id}`,
        });
        out.stopped += 1;
        return null;
      }
    }
    // The wording is checked against what the owner approved (the binding recorded with the approval), whatever happened to the list since.
    const approved = readBinding(approval.action.binding);
    if (!t?.version || !approved?.templateContentHash || !wordingStillApproved(t, approved.templateContentHash, approved.whatsappTemplateId ?? null)) {
      return stop("template_changed", "The message template was edited, archived or is no longer approved, so this campaign's approved wording no longer stands. Nothing more is sent.", true);
    }
    // The business details and configuration values the wording uses are part of what was approved (a link, a promo code): once it has
    // started, a different value withdraws the approval instead of going out to the rest of the list.
    if (binding) {
      const drift = valuesChangedSinceApproval(approved.businessValues, binding.businessValues, customValues);
      if (drift) {
        await voidStartedCampaign(db, c, drift, now);
        out.stopped += 1;
        return null;
      }
    }
    const tp = await templateProblems(db, orgId, t, c.channel);
    if (tp.problems.length) return stop("template_changed", tp.problems[0], true);
    const mp = await messageProblems(db, orgId, t);
    // A business detail or required configuration value the message needs is empty: nothing goes out until someone fills it in.
    if (mp.problems.length) return stop("missing_values", mp.problems[0], true);
    const ch = await channelProblems(db, orgId, c.channel);
    if (ch.problems.length) return stop("channel", ch.problems[0], true);
    if (!(await publishedClientRate(db, ch.provider, unitFor(c.channel)))) {
      return stop("price", `iAcquire hasn't published a price for ${unitLabel(unitFor(c.channel)).toLowerCase()} through ${providerLabel(ch.provider)}, so nothing can be billed or sent.`, false);
    }

    if (c.status === "scheduled") {
      // Recipients are read from the list once, now: who is on it and, for each, whether they may receive it right now.
      const q = await audienceOutcomeSql(db, orgId, org.timezone, list!.filter!, c.channel, t.version.tokens);
      const total = Number((await db.query<{ n: string }>(`select count(*)::text as n from (${q.sql}) x`, q.params)).rows[0].n);
      if (total > MAX_RECIPIENTS) {
        return stop("too_large", `The list has ${total.toLocaleString("en-US")} people; one campaign goes to at most ${MAX_RECIPIENTS.toLocaleString("en-US")}. Narrow the list and create a new campaign.`, false);
      }
      const p = q.params.length;
      await db.query(
        `insert into crm_campaign_recipients (org_id, campaign_id, contact_id, status, reason)
         select $1, $${p + 1}::uuid, x.contact_id, case when x.outcome = 'eligible' then 'pending' else 'excluded' end, nullif(x.outcome, 'eligible')
         from (${q.sql}) x on conflict (campaign_id, contact_id) do nothing`,
        [...q.params, c.id],
      );
      await db.query("update crm_campaigns set status = 'sending', started_at = coalesce(started_at, $3) where id = $1 and org_id = $2", [c.id, orgId, now.toISOString()]);
      c.status = "sending";
      c.started_at = c.started_at ?? now;
      const counts = await refreshCounts(db, c, { notice: null, waitUntil: null });
      await recordAudit({ orgId, actorKind: "system", action: "crm.campaign_started", targetType: "crm_campaign", targetId: c.id, approvalId: c.approval_id, result: "success", metadata: { recipients: counts.total, eligible: counts.pending, excluded: counts.excluded } }, db);
      out.started += 1;
    }
    return { c, org, template: t as Prepared["template"], approverId: approval.decided_by, ratePerMinute: c.rate_per_minute, approvedValues: approved.businessValues ?? {} };
  });
}

/** The conversation a recipient's message goes in: their main thread for SMS and WhatsApp, a thread of this campaign's own for email. */
async function conversationFor(db: Queryable, orgId: string, contactId: string, channel: Channel, subject: string | null, campaignId: string): Promise<string> {
  const thread = channel === "email" ? `campaign:${campaignId}` : "main";
  const found = await db.query<{ id: string }>("select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and thread_key = $4", [orgId, contactId, channel, thread]);
  if (found.rows[0]) return found.rows[0].id;
  // Like a conversation the customer starts: a reply is handled the way the workspace handles any inbound message.
  const agent = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'sales_assistant' and enabled", [orgId]);
  const { rows } = await db.query<{ id: string }>(
    `insert into conversations (org_id, contact_id, channel, thread_key, subject, ai_agent_id, owner_kind) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
    [orgId, contactId, channel, thread, subject?.slice(0, 300) ?? null, agent.rows[0]?.id ?? null, agent.rows[0] ? "ai" : "unassigned"],
  );
  return rows[0].id;
}


async function exclude(db: Queryable, campaignId: string, orgId: string, contactId: string, reason: ExclusionReason | `blocked:${string}`) {
  await db.query("update crm_campaign_recipients set status = 'excluded', reason = $4, updated_at = now() where campaign_id = $1 and org_id = $2 and contact_id = $3", [campaignId, orgId, contactId, reason.slice(0, 120)]);
}

/** One pending recipient: checked again, queued, left out with the reason, asked to wait, or the campaign stopped. One transaction. */
async function queueNext(p: Prepared, now: Date): Promise<Step> {
  return withSystem(async (db): Promise<Step> => {
    const c = await lockCampaign(db, p.c.id, p.c.org_id);
    if (!c || c.status !== "sending") return "not_sending";
    const { rows } = await db.query<{ contact_id: string }>(
      `select contact_id from crm_campaign_recipients
       where campaign_id = $1 and org_id = $2 and status = 'pending'
         and (reason is null or reason not like 'waiting:%' or coalesce(nullif(split_part(reason, '|', 2), '')::timestamptz, '-infinity'::timestamptz) <= $3)
       order by (reason is not null), updated_at, contact_id limit 1 for update skip locked`,
      [c.id, c.org_id, now.toISOString()],
    );
    const contactId = rows[0]?.contact_id;
    if (!contactId) return "none";
    const t = p.template;
    const tokens: TokenKey[] = t.version.tokens;

    // The send rules again, for this person, now: they may have opted out or lost their address since the list was read.
    const outcome: AudienceOutcome = await personOutcome(db, c.org_id, contactId, c.channel, tokens);
    if (outcome !== "eligible") {
      await exclude(db, c.id, c.org_id, contactId, outcome);
      return "excluded";
    }
    const values = await tokenValuesFor(db, c.org_id, { contactId, timezone: p.org.timezone, now });
    // The values this message would carry are the ones the owner approved, read in this same transaction (a change since the campaign's
    // turn began is caught here, before anything is queued with it).
    const drift = valuesChangedSinceApproval(p.approvedValues, usedBusinessValues(values.values, values.customValues, t.version.subject, t.version.body), values.customValues);
    if (drift) {
      await voidStartedCampaign(db, c, drift, now);
      return "stopped";
    }
    const rendered = renderMessage({ subject: t.version.subject, body: t.version.body }, values.values, { customValues: values.customValues });
    if (!rendered.ok) {
      // A contact's own missing detail leaves them out; a business detail missing for everyone stops the campaign.
      if (!rendered.unknown.length && rendered.missing.every((k) => k.startsWith("contact."))) {
        await exclude(db, c.id, c.org_id, contactId, "missing_values");
        return "excluded";
      }
      await stopCampaign(db, c, notice(rendered.unknown.length ? "template_changed" : "missing_values", `${describeMissing(rendered.missing.filter((k) => !k.startsWith("contact.")), rendered.unknown, values.customValues)} Nothing more is sent until it is filled in.`, now), { hold: false });
      return "stopped";
    }

    const dedupeKey = `camp:${c.id}:${contactId}`;
    await db.query("savepoint campaign_queue");
    let req: SendRequest | null = null;
    let res: Awaited<ReturnType<typeof queueOutbound>>;
    try {
      const conversationId = await conversationFor(db, c.org_id, contactId, c.channel, rendered.subject, c.id);
      req = {
        orgId: c.org_id, conversationId, scope: "retention", purpose: "marketing", actor: { kind: "system", userId: p.approverId }, body: rendered.body,
        templateId: c.channel === "whatsapp" ? t.whatsappTemplateId : null, now, dedupeKey, businessHoursOnly: true,
      };
      res = await queueOutbound(db, req);
    } catch (err) {
      await db.query("rollback to savepoint campaign_queue");
      if ((err as { code?: string }).code !== "23505") throw err;
      // This person already has this campaign's message (the dedupe key is theirs): link it, never send a second one.
      const prior = await db.query<{ id: string; queued_at: Date | null }>("select id, queued_at from conversation_messages where org_id = $1 and dedupe_key = $2", [c.org_id, dedupeKey]);
      if (!prior.rows[0]) throw err;
      await db.query("update crm_campaign_recipients set status = 'queued', message_id = $4, queued_at = coalesce(queued_at, $5), reason = null, updated_at = now() where campaign_id = $1 and org_id = $2 and contact_id = $3", [
        c.id, c.org_id, contactId, prior.rows[0].id, prior.rows[0].queued_at ?? now,
      ]);
      return "linked";
    }

    if (res.status === "queued") {
      const m = (await db.query<{ send_after: Date }>("select send_after from conversation_messages where id = $1", [res.messageId])).rows[0];
      if (m && new Date(m.send_after).getTime() <= now.getTime() + 1000) {
        await db.query("release savepoint campaign_queue");
        await db.query("update crm_campaign_recipients set status = 'queued', message_id = $4, queued_at = $5, reason = null, updated_at = now() where campaign_id = $1 and org_id = $2 and contact_id = $3", [
          c.id, c.org_id, contactId, res.messageId, now.toISOString(),
        ]);
        return "queued";
      }
      // The rules said "not yet" (quiet hours, business hours, spacing): nothing is queued now, so the pace holds when they wait together.
      // Asked why before the attempt is undone (its conversation may be new); its credit hold is already counted, so credit isn't re-checked.
      const d = await evaluateSend(db, { ...req!, hasReservation: true });
      await db.query("rollback to savepoint campaign_queue");
      const asked = !d.allow && d.retryAt ? d.retryAt : m ? new Date(m.send_after) : new Date(now.getTime() + 15 * 60_000);
      // Never "again right now": that would only check the same person again in this tick.
      const retryAt = asked.getTime() > now.getTime() ? asked : new Date(now.getTime() + 60_000);
      const why = !d.allow ? d.reason : "later";
      if (c.started_at && retryAt.getTime() > new Date(c.started_at).getTime() + MAX_WAIT_MS) {
        await exclude(db, c.id, c.org_id, contactId, "wait_expired");
        return "excluded";
      }
      const tz = (await db.query<{ timezone: string | null }>("select timezone from contacts where id = $1 and org_id = $2", [contactId, c.org_id])).rows[0]?.timezone ?? null;
      const workspaceWide = why === "outside_business_hours" || why === "provider_switching" || (why === "quiet_hours" && (!tz || tz === p.org.timezone));
      await db.query("update crm_campaign_recipients set reason = $4, updated_at = now() where campaign_id = $1 and org_id = $2 and contact_id = $3", [
        c.id, c.org_id, contactId, `waiting:${why}|${retryAt.toISOString()}`.slice(0, 120),
      ]);
      if (workspaceWide) {
        await setNotice(db, c, null, { waitUntil: retryAt });
        return "workspace_waits";
      }
      return "waiting";
    }

    // Refused: nothing is kept from the attempt (no blocked message clutters the inbox); the recipient records why.
    await db.query("rollback to savepoint campaign_queue");
    const reason = res.reason ?? "blocked";
    const stopFor: Partial<Record<string, [CampaignNotice["code"], string, boolean]>> = {
      credits: ["credits", "Service credits ran out, so the campaign stopped. Messages already queued still go. Add credits, then resume it to continue.", false],
      budget: ["budget", "Sending more would pass this workspace's monthly spending limit, so the campaign stopped. Raise the limit or wait for next month, then resume it.", false],
      rate_not_published: ["price", "iAcquire hasn't published a price for this channel, so nothing more can be billed or sent.", false],
      channel_not_ready: ["channel", `${CHANNEL_LABELS[c.channel]} isn't verified and switched on for this workspace any more, so the campaign stopped.`, true],
      whatsapp_window_closed: ["template_changed", "The linked WhatsApp template is no longer approved, so the campaign stopped.", true],
    };
    const s = stopFor[reason];
    if (s) {
      await stopCampaign(db, c, notice(s[0], s[1], now), { hold: s[2] });
      return "stopped";
    }
    const map: Record<string, ExclusionReason> = {
      suppressed: "suppressed", retention_limit: "frequency_limit", template_mismatch: "template_mismatch", contact_unreachable: "not_linked",
    };
    if (reason === "no_consent") {
      const consent = await getConsent(db, c.org_id, contactId, c.channel, "marketing");
      await exclude(db, c.id, c.org_id, contactId, consent === "revoked" ? "consent_withdrawn" : "no_marketing_consent");
    } else await exclude(db, c.id, c.org_id, contactId, map[reason] ?? `blocked:${reason}`);
    return "excluded";
  });
}

/**
 * Moves each recipient whose message exists to what that message did: queued, sent, delivered, failed, bounced (the provider said the
 * address is bad), unsubscribed (they withdrew marketing consent after it was sent), or left out at send time (the dispatcher's final check).
 */
export async function reconcileCampaign(db: Queryable, c: Pick<CampaignRow, "id" | "org_id" | "channel">): Promise<number> {
  const res = await db.query(
    `update crm_campaign_recipients r set status = x.next, reason = x.next_reason, updated_at = now()
     from (
       select r2.contact_id,
         case
           when m.status in ('sent', 'delivered', 'read') and x2.unsubscribed then 'unsubscribed'
           when m.status in ('delivered', 'read') then 'delivered'
           when m.status = 'sent' then 'sent'
           when m.status in ('failed', 'blocked') and x2.bounced then 'bounced'
           when m.status = 'failed' then 'failed'
           when m.status = 'blocked' and m.blocked_reason in ('suppressed', 'no_consent', 'retention_limit', 'contact_unreachable', 'campaign_cancelled') then 'excluded'
           when m.status = 'blocked' then 'failed'
           else 'queued'
         end as next,
         case
           when m.status in ('sent', 'delivered', 'read') then null
           when m.status in ('failed', 'blocked') and x2.bounced then 'bounce'
           when m.status = 'failed' then 'provider_error'
           when m.status = 'blocked' then case m.blocked_reason
             when 'suppressed' then 'suppressed' when 'no_consent' then 'consent_withdrawn' when 'retention_limit' then 'frequency_limit'
             when 'contact_unreachable' then 'no_address' when 'campaign_cancelled' then 'campaign_cancelled'
             else left('blocked:' || coalesce(m.blocked_reason, 'unknown'), 120) end
           else null
         end as next_reason
       from crm_campaign_recipients r2
       join conversation_messages m on m.id = r2.message_id and m.org_id = r2.org_id
       cross join lateral (
         select
           exists (select 1 from contact_consent_events e where e.org_id = r2.org_id and e.contact_id = r2.contact_id and e.channel = $3 and e.purpose = 'marketing'
                   and e.status = 'revoked' and e.created_at >= coalesce(r2.queued_at, m.created_at)) as unsubscribed,
           exists (select 1 from suppressions s join contact_identities i on i.org_id = s.org_id and i.value = s.address and i.kind = $4
                   where s.org_id = r2.org_id and i.contact_id = r2.contact_id and s.channel = $3 and s.reason in ('bounce', 'invalid', 'complaint')
                   and s.created_at >= coalesce(r2.queued_at, m.created_at)) as bounced
       ) x2
       where r2.campaign_id = $1 and r2.org_id = $2 and r2.message_id is not null
     ) x
     where r.campaign_id = $1 and r.org_id = $2 and r.contact_id = x.contact_id and (r.status is distinct from x.next or r.reason is distinct from x.next_reason)`,
    [c.id, c.org_id, c.channel, c.channel === "email" ? "email" : "phone"],
  );
  return res.rowCount;
}

/** Completes a sending campaign once nobody is pending and nothing it queued is still waiting to leave; otherwise recounts. */
async function finishIfDone(p: Prepared, now: Date, out: CampaignJobResult): Promise<void> {
  await withSystem(async (db) => {
    const c = await lockCampaign(db, p.c.id, p.c.org_id);
    if (!c || c.status !== "sending") return;
    await reconcileCampaign(db, c);
    const { rows } = await db.query<{ pending: string; waiting_next: Date | null; inflight: string }>(
      `select (select count(*) from crm_campaign_recipients where campaign_id = $1 and org_id = $2 and status = 'pending')::text as pending,
              (select min(coalesce(nullif(split_part(reason, '|', 2), '')::timestamptz, $3::timestamptz)) from crm_campaign_recipients
                 where campaign_id = $1 and org_id = $2 and status = 'pending' and reason like 'waiting:%') as waiting_next,
              (select count(*) from crm_campaign_recipients r join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
                 where r.campaign_id = $1 and r.org_id = $2 and r.status = 'queued' and m.status in ('queued', 'sending'))::text as inflight`,
      [c.id, c.org_id, now.toISOString()],
    );
    const pending = Number(rows[0].pending);
    const inflight = Number(rows[0].inflight);
    if (pending > 0 || inflight > 0) {
      // When everyone left is waiting for a later time, the campaign isn't looked at again until the first of them is due.
      const ready = Number((await db.query<{ n: string }>(
        `select count(*)::text as n from crm_campaign_recipients where campaign_id = $1 and org_id = $2 and status = 'pending'
           and (reason is null or reason not like 'waiting:%' or coalesce(nullif(split_part(reason, '|', 2), '')::timestamptz, '-infinity'::timestamptz) <= $3)`,
        [c.id, c.org_id, now.toISOString()],
      )).rows[0].n);
      const workspaceWait = readWaitUntil(c.counts);
      const wait = ready === 0 && rows[0].waiting_next && inflight === 0 ? new Date(rows[0].waiting_next) : workspaceWait && workspaceWait > now ? workspaceWait : null;
      await refreshCounts(db, c, { waitUntil: wait, reconciledAt: now });
      return;
    }
    await db.query("update crm_campaigns set status = 'completed', completed_at = $3 where id = $1 and org_id = $2 and status = 'sending'", [c.id, c.org_id, now.toISOString()]);
    const counts = await refreshCounts(db, c, { waitUntil: null, reconciledAt: now });
    const handed = counts.sent + counts.delivered + counts.unsubscribed;
    const actor = systemActor(p.org);
    await emitEvent(db, actor, {
      type: "campaign.sent", entityType: "campaign", entityId: c.id,
      payload: { campaignId: c.id, name: c.name, channel: c.channel, recipients: counts.total, sent: handed, failed: counts.failed + counts.bounced, excluded: counts.excluded, completedAt: now.toISOString() },
      dedupeKey: `campaign.sent:${c.id}`,
    });
    await recordAudit({ orgId: c.org_id, actorKind: "system", action: "crm.campaign_completed", targetType: "crm_campaign", targetId: c.id, approvalId: c.approval_id, result: "success", metadata: { recipients: counts.total, sent: handed, excluded: counts.excluded, failed: counts.failed + counts.bounced } }, db);
    await notifyOrgRoles(db, c.org_id, ["owner", "admin"], {
      kind: "system", severity: "success", title: `Campaign “${c.name.slice(0, 80)}” finished`,
      body: `${handed.toLocaleString("en-US")} sent, ${counts.excluded.toLocaleString("en-US")} left out by the send rules${counts.failed + counts.bounced ? `, ${(counts.failed + counts.bounced).toLocaleString("en-US")} not delivered` : ""}. Finished ${formatDateTime(now, p.org.timezone)}.`,
      link: `/crm/campaigns/${c.id}`, dedupeKey: `campaign-completed:${c.id}`,
    });
    out.completed += 1;
  });
}

/** How many messages this campaign may queue now: rate_per_minute in any minute, and never more than that waiting for the dispatcher. */
async function queueBudget(p: Prepared, now: Date): Promise<number> {
  const { rows } = await withSystem((db) =>
    db.query<{ recent: string; backlog: string }>(
      `select (select count(*) from crm_campaign_recipients where campaign_id = $1 and org_id = $2 and queued_at > $3::timestamptz - interval '60 seconds')::text as recent,
              (select count(*) from crm_campaign_recipients r join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
                 where r.campaign_id = $1 and r.org_id = $2 and r.status = 'queued' and m.status = 'queued' and m.send_after <= $3)::text as backlog`,
      [p.c.id, p.c.org_id, now.toISOString()],
    ),
  );
  const rate = p.ratePerMinute;
  return Math.max(0, Math.min(rate - Number(rows[0].recent), rate - Number(rows[0].backlog), MAX_QUEUED_PER_TICK));
}

/** One campaign's turn: prepare (and maybe start), queue what the pace allows, then complete it or recount. */
export async function advanceCampaign(id: string, orgId: string, now: Date, out: CampaignJobResult = zero()): Promise<CampaignJobResult> {
  const p = await prepare(id, orgId, now, out);
  if (!p) return out;
  const budget = await queueBudget(p, now);
  let queued = 0;
  for (let i = 0; i < MAX_EVALUATIONS_PER_TICK && queued < budget; i += 1) {
    const step = await queueNext(p, now);
    if (step === "queued") {
      queued += 1;
      out.queued += 1;
    } else if (step === "excluded") out.excluded += 1;
    else if (step === "waiting") out.waiting += 1;
    else if (step === "linked") continue;
    else if (step === "stopped") {
      out.stopped += 1;
      return out;
    } else {
      if (step === "workspace_waits") out.waiting += 1;
      break;
    }
  }
  await finishIfDone(p, now, out);
  return out;
}

/** Records delivery, bounces and unsubscribes on recent campaigns' recipients and refreshes their counts. */
async function reconcileRecent(now: Date, out: CampaignJobResult): Promise<void> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string }>(
      `select id, org_id from crm_campaigns
       where started_at is not null and status in ('sending', 'paused', 'completed', 'cancelled')
         and (completed_at is null or completed_at > $1::timestamptz - interval '${RECONCILE_FOR}')
         and coalesce((counts->>'reconciledAt')::timestamptz, '-infinity'::timestamptz) < $1::timestamptz - interval '${RECONCILE_EVERY}'
       order by coalesce((counts->>'reconciledAt')::timestamptz, '-infinity'::timestamptz) limit 20`,
      [now.toISOString()],
    ),
  );
  for (const r of rows) {
    try {
      await withSystem(async (db) => {
        const c = await lockCampaign(db, r.id, r.org_id, { skipLocked: true });
        if (!c) return;
        await reconcileCampaign(db, c);
        await refreshCounts(db, c, { reconciledAt: now });
      });
      out.reconciled += 1;
    } catch (err) {
      console.error("[iacquire] reconciling a campaign failed", { campaignId: r.id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
}

/**
 * Scheduler entry point. Safe to run twice at once or back to back: each campaign is claimed with its row lock, each recipient moves
 * pending → queued in the same transaction as its message, and the message's dedupe key refuses a second one for the same person.
 */
export async function processCampaigns(opts: { now?: Date; limit?: number } = {}): Promise<CampaignJobResult> {
  const now = opts.now ?? new Date();
  const out = zero();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string; org_id: string }>(
      `select id, org_id from crm_campaigns
       where ((status = 'scheduled' and (scheduled_at is null or scheduled_at <= $1)) or status = 'sending')
         and coalesce((counts->>'waitUntil')::timestamptz, '-infinity'::timestamptz) <= $1
       order by coalesce(started_at, scheduled_at, updated_at) limit $2`,
      [now.toISOString(), Math.min(50, opts.limit ?? CAMPAIGNS_PER_TICK)],
    ),
  );
  for (const r of rows) {
    try {
      await advanceCampaign(r.id, r.org_id, now, out);
    } catch (err) {
      // One campaign failing never holds back the others; it is tried again on the next tick.
      console.error("[iacquire] advancing a campaign failed", { campaignId: r.id, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  await reconcileRecent(now, out);
  return out;
}
