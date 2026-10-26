import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { notifyOrgRoles, notifyUser, type NotificationKind } from "@/server/notifications";
import { sanitizeErrorText } from "@/lib/ops";
import type { CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { applyContactTags } from "@/server/crm/tags";
import { moveOpportunityInTx } from "@/server/crm/opportunities";
import { createTaskInTx } from "@/server/crm/tasks";
import { addEvent, money, type ProposalRow, type SettingsRow } from "@/server/proposals/core";

// What a proposal does to the rest of the CRM: a line on the contact's and the deal's timeline, an event automations can start from, a notification to the people concerned, a
// task when somebody has to act, and (only if the owner turned them on) a tag and a deal stage. Each effect runs in its own savepoint: one that fails is written on the
// proposal's history as "effect_failed" and nothing else is lost, so a customer's answer or a send is never undone by a problem in a side effect.

export type Outcome = "approval_requested" | "sent" | "viewed" | "accepted" | "declined" | "expired" | "changes_requested" | "withdrawn";

const EVENT_TYPE: Record<Exclude<Outcome, "withdrawn">, string> = {
  approval_requested: "proposal.approval_requested", sent: "proposal.sent", viewed: "proposal.viewed", accepted: "proposal.accepted", declined: "proposal.declined", expired: "proposal.expired",
  changes_requested: "proposal.changes_requested",
};

const NOTIFY_KIND: Partial<Record<Outcome, NotificationKind>> = { viewed: "proposal_viewed", accepted: "proposal_accepted", declined: "proposal_declined", expired: "proposal_expiring", changes_requested: "proposal_changes_requested" };

export interface EffectOptions {
  /** accepted / declined: the answer was typed in by a person at the business, not given by the customer. It is worded that way everywhere. */
  recordedByPerson?: boolean;
  /** The person's name for the timeline, when a person did it. */
  byName?: string | null;
  /** The customer did it from their page: the event is credited to the contact, not to the system. */
  byCustomer?: boolean;
  /** Makes the dedupe keys of the event and the notice unique to one occurrence (a customer can ask for changes more than once). */
  occurrence?: string;
  /** accepted: the answer is a signature the customer's signing service reported (src/server/esign/apply.ts). It is worded that way, and announces signature.completed as well. */
  viaSignature?: { requestId: string; providerLabel: string };
}

function activityText(row: ProposalRow, outcome: Outcome, o: EffectOptions): { kind: string; summary: string } {
  const n = row.number;
  const recorded = o.recordedByPerson ? ` (recorded by ${o.byName ?? "a team member"}, not verified by the customer)` : "";
  switch (outcome) {
    case "sent": return { kind: "proposal.sent", summary: `Proposal ${n} sent` };
    // "Viewed" is what a browser did, not proof anyone read it.
    case "viewed": return { kind: "proposal.viewed", summary: `Proposal ${n} was opened in a browser` };
    case "accepted": return { kind: "proposal.accepted", summary: o.viaSignature ? `Proposal ${n} signed through ${o.viaSignature.providerLabel}` : `Proposal ${n} accepted${recorded}` };
    case "declined": return { kind: "proposal.declined", summary: `Proposal ${n} declined${recorded}` };
    case "expired": return { kind: "proposal.expired", summary: `Proposal ${n} expired without an answer` };
    case "changes_requested": return { kind: "proposal.changes_requested", summary: `The customer asked for changes to proposal ${n}` };
    case "withdrawn": return { kind: "proposal.withdrawn", summary: `Proposal ${n} withdrawn` };
    default: return { kind: "proposal.approval_requested", summary: `Proposal ${n} sent for approval` };
  }
}

/** Runs one effect in its own savepoint. A failure is recorded on the proposal and swallowed. */
async function guarded(db: Queryable, row: ProposalRow, effect: string, fn: () => Promise<void>): Promise<void> {
  await db.query("savepoint proposal_effect");
  try {
    await fn();
    await db.query("release savepoint proposal_effect");
  } catch (e) {
    await db.query("rollback to savepoint proposal_effect");
    await db.query("release savepoint proposal_effect");
    await addEvent(db, row.org_id, row.id, row.version, "effect_failed", { id: null, kind: "system" }, { effect, message: (e instanceof AppError ? e.message : sanitizeErrorText(e)).slice(0, 300) });
  }
}

async function skipped(db: Queryable, row: ProposalRow, effect: string, reason: string): Promise<void> {
  await addEvent(db, row.org_id, row.id, row.version, "effect_skipped", { id: null, kind: "system" }, { effect, reason });
}

interface DealFacts { status: string; pipeline: string; stage: string; owner: string | null }

async function dealOf(db: Queryable, row: ProposalRow): Promise<DealFacts | null> {
  if (!row.opportunity_id) return null;
  const { rows } = await db.query<{ status: string; pipeline_ref: string; stage_ref: string; assigned_user_id: string | null }>(
    "select status, pipeline_ref, stage_ref, assigned_user_id from crm_opportunities where id = $1 and org_id = $2 and provider = 'native' and archived_at is null", [row.opportunity_id, row.org_id],
  );
  return rows[0] ? { status: rows[0].status, pipeline: rows[0].pipeline_ref, stage: rows[0].stage_ref, owner: rows[0].assigned_user_id } : null;
}

/** Moves the deal to a configured open stage when that is a step forward in the deal's own pipeline; otherwise says why it did not. */
async function moveForward(db: Queryable, actor: CrmActor, row: ProposalRow, deal: DealFacts, stageId: string): Promise<void> {
  if (deal.status !== "open") return skipped(db, row, "stage_on_send", "The deal is already closed.");
  if (deal.stage === stageId) return;
  const { rows } = await db.query<{ id: string; pipeline_id: string; position: number }>("select id, pipeline_id, position from crm_pipeline_stages where org_id = $1 and id = any($2::uuid[]) and archived_at is null", [row.org_id, [stageId, deal.stage]]);
  const target = rows.find((r) => r.id === stageId);
  const current = rows.find((r) => r.id === deal.stage);
  if (!target) return skipped(db, row, "stage_on_send", "The stage chosen in the proposal settings no longer exists.");
  if (target.pipeline_id !== deal.pipeline) return skipped(db, row, "stage_on_send", "The deal is in a different pipeline from the stage chosen in the proposal settings.");
  if (current && current.position >= target.position) return skipped(db, row, "stage_on_send", "The deal is already further along than that stage.");
  await moveOpportunityInTx(db, actor, row.opportunity_id as string, { stageId });
}

export async function applyEffects(db: Queryable, actor: CrmActor, row: ProposalRow, outcome: Outcome, settings: SettingsRow, opts: EffectOptions = {}): Promise<void> {
  const deal = await dealOf(db, row);
  const link = `/proposals/${row.id}`;

  if (outcome !== "withdrawn") {
    const type = EVENT_TYPE[outcome];
    await guarded(db, row, "event", async () => {
      await emitEvent(db, actor, {
        type, entityType: "proposal", entityId: row.id, contactId: row.contact_id, dedupeKey: `${type}:${row.id}:${row.version}${opts.occurrence ? `:${opts.occurrence}` : ""}`, byContact: opts.byCustomer === true && Boolean(row.contact_id),
        // Ids and amounts only: no name, no address, no wording.
        payload: { proposalId: row.id, number: row.number, version: row.version, currency: row.currency, oneTimeTotalMinor: money(row.one_time_total_minor), monthlyTotalMinor: money(row.monthly_total_minor), yearlyTotalMinor: money(row.yearly_total_minor), opportunityId: row.opportunity_id },
      });
    });
    // A signature the signing service reported also starts the signing trigger. The proposal's own trigger above always fires, so a workflow that waits for an acceptance
    // is not missed by the way the customer accepted.
    if (outcome === "accepted" && opts.viaSignature) {
      const via = opts.viaSignature;
      await guarded(db, row, "signature_event", async () => {
        await emitEvent(db, actor, {
          type: "signature.completed", entityType: "proposal", entityId: row.id, contactId: row.contact_id, dedupeKey: `signature.completed:${row.id}:${row.version}`,
          payload: { proposalId: row.id, number: row.number, version: row.version, requestId: via.requestId, currency: row.currency, opportunityId: row.opportunity_id },
        });
      });
    }
  }

  if (outcome !== "approval_requested" && (row.contact_id || row.company_id || row.opportunity_id)) {
    const a = activityText(row, outcome, opts);
    await guarded(db, row, "timeline", () => recordActivity(db, actor, { ...a, contactId: row.contact_id, companyId: row.company_id, opportunityId: row.opportunity_id, refType: "proposal", refId: row.id, metadata: { number: row.number, version: row.version } }));
  }

  if (outcome === "sent") {
    if (settings.tagOnSendId && row.contact_id) {
      const tagId = settings.tagOnSendId;
      const contactId = row.contact_id;
      await guarded(db, row, "tag_on_send", async () => void (await applyContactTags(db, actor, [contactId], [tagId], "manual")));
    }
    if (settings.stageOnSendId && deal) {
      const stageId = settings.stageOnSendId;
      await guarded(db, row, "stage_on_send", () => moveForward(db, actor, row, deal, stageId));
    }
  }

  const kind = outcome === "accepted" && opts.viaSignature ? "signature_completed" : NOTIFY_KIND[outcome];
  if (kind) {
    await guarded(db, row, "notify", async () => {
      const who = opts.recordedByPerson ? "recorded" : "answered";
      const title = outcome === "accepted" ? (opts.viaSignature ? `${row.number} was signed` : who === "recorded" ? `Acceptance recorded for ${row.number}` : `${row.number} was accepted`)
        : outcome === "declined" ? (who === "recorded" ? `Decline recorded for ${row.number}` : `${row.number} was declined`)
        : outcome === "changes_requested" ? `Changes requested on ${row.number}` : outcome === "viewed" ? `${row.number} was opened in a browser` : `${row.number} expired without an answer`;
      const n = { kind, severity: "info" as const, title, body: row.title.slice(0, 200), link, dedupeKey: `proposal-${outcome}:${row.id}:${row.version}${opts.occurrence ? `:${opts.occurrence}` : ""}` };
      const people = [...new Set([row.owner_user_id, deal?.owner].filter((x): x is string => Boolean(x)))];
      // If nobody owns it, the owner and managers are told, so an answer is never lost.
      if (people.length) for (const id of people) await notifyUser(db, id, row.org_id, n);
      else await notifyOrgRoles(db, row.org_id, ["owner", "admin"], n);
    });
  }

  if ((outcome === "accepted" || outcome === "changes_requested") && row.owner_user_id) {
    const owner = row.owner_user_id;
    await guarded(db, row, "task", async () => {
      await createTaskInTx(db, actor, {
        title: outcome === "accepted" ? `Confirm next steps for ${row.number}` : `Review the changes asked for on ${row.number}`, assigneeId: owner,
        contactId: row.contact_id, companyId: row.company_id, opportunityId: row.opportunity_id,
      });
    });
  }

  if (outcome === "accepted" && settings.dealOnAccept === "won_stage" && deal) {
    await guarded(db, row, "deal_won", async () => {
      if (deal.status !== "open") return skipped(db, row, "deal_won", "The deal is already closed.");
      const won = (await db.query<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 and pipeline_id = $2 and kind = 'won' and archived_at is null order by position limit 1", [row.org_id, deal.pipeline])).rows[0];
      if (!won) return skipped(db, row, "deal_won", "The deal's pipeline has no Won stage.");
      await moveOpportunityInTx(db, actor, row.opportunity_id as string, { stageId: won.id });
    });
  }
}
