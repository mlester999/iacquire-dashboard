import "server-only";
import { withSystem } from "@/server/db";
import { sanitizeErrorText } from "@/lib/ops";
import { systemActor } from "@/server/crm/actor";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { canTransition } from "@/lib/proposals/state";
import { daysBetween, todayIn, validityOn } from "@/lib/proposals/validity";
import { addEvent, loadProposalRow, readSettings } from "@/server/proposals/core";
import { applyEffects } from "@/server/proposals/crm-effects";
import { voidLiveRequestsInTx } from "@/server/esign/lifecycle";

// The two background jobs of proposals. Both are idempotent and safe to run twice, run only when the scheduler does (and, in a staged start, only when named in
// SCHEDULER_JOBS_ONLY), and touch only workspaces that a Super Admin switched proposals on for and that are not suspended, archived or paused by iAcquire (a shut-down client is).

/** A sent proposal that has not been answered is announced to its owner this many days before its last day (and on it). A PROPOSED default. */
export const EXPIRY_WARNING_DAYS = 2;
const BATCH = 200;

interface Candidate {
  id: string;
  org_id: string;
  org_name: string;
  timezone: string;
  valid_until: string;
}

export interface ExpiryResult {
  expired: number;
  warned: number;
  failed: number;
}

/**
 * Closes sent proposals whose valid-until date has passed in their workspace's own calendar (the whole of the last day still counts), and warns the owner of those about to. A
 * closed proposal's customer link stops working and the customer's page says it expired. Each proposal is one transaction of its own, so one that fails never holds back the rest.
 */
export async function expireDueProposals(opts: { now?: Date } = {}): Promise<ExpiryResult> {
  const now = opts.now ?? new Date();
  // Candidates by UTC date with room for every time zone; the workspace's own calendar decides below.
  const horizon = new Date(now.getTime() + (EXPIRY_WARNING_DAYS + 2) * 86_400_000).toISOString().slice(0, 10);
  const { rows } = await withSystem((db) => db.query<Candidate>(
    `select p.id, p.org_id, o.name as org_name, o.timezone, to_char(p.valid_until, 'YYYY-MM-DD') as valid_until
     from proposals p join organizations o on o.id = p.org_id
     where p.status = 'sent' and p.valid_until is not null and p.valid_until <= $1::date and o.status not in ('suspended', 'archived')
       and exists (select 1 from org_features f where f.org_id = p.org_id and f.feature = 'proposals' and f.enabled)
       and not exists (select 1 from automation_pauses ap join organizations apo on apo.id = ap.org_id where ap.active and ap.scope = 'agency' and (ap.org_id = p.org_id or apo.kind = 'agency'))
     order by p.valid_until, p.id limit ${BATCH}`,
    [horizon],
  ));
  const out: ExpiryResult = { expired: 0, warned: 0, failed: 0 };
  for (const c of rows) {
    const today = todayIn(c.timezone, now);
    const daysLeft = daysBetween(today, c.valid_until);
    const expired = validityOn(c.valid_until, now, c.timezone) === "expired";
    if (!expired && daysLeft > EXPIRY_WARNING_DAYS) continue;
    try {
      const did = await withSystem(async (db) => {
        const row = await loadProposalRow(db, c.org_id, c.id, true);
        // Anything that moved since the candidate list was read (answered, withdrawn, revised, given a new date) is left alone.
        if (!row || row.status !== "sent" || row.valid_until !== c.valid_until) return "skipped" as const;
        const actor = systemActor({ id: c.org_id, name: c.org_name, timezone: c.timezone });
        if (expired) {
          if (!canTransition(row.status, "expired")) return "skipped" as const;
          await db.query("update proposals set status = 'expired', closed_at = $3::timestamptz where id = $1 and org_id = $2 and status = 'sent'", [row.id, row.org_id, now.toISOString()]);
          // The link stops opening. The customer's page still says the proposal expired, because it reads the proposal's own status first.
          await db.query("update proposal_share_links set revoked_at = $3::timestamptz where proposal_id = $1 and org_id = $2 and revoked_at is null", [row.id, row.org_id, now.toISOString()]);
          // A signing request still out for the version ends with it; a signature that arrives afterwards is kept as the service's fact and not applied.
          await voidLiveRequestsInTx(db, row.org_id, row.id, "voided", "The proposal expired.", { userId: null, now });
          await addEvent(db, row.org_id, row.id, row.version, "expired", { id: null, kind: "system" }, { validUntil: c.valid_until });
          const after = await loadProposalRow(db, row.org_id, row.id);
          if (after) await applyEffects(db, actor, after, "expired", await readSettings(db, row.org_id));
          return "expired" as const;
        }
        const when = daysLeft <= 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
        const note = {
          kind: "proposal_expiring" as const, severity: "warning" as const, title: `${row.number} expires ${when}`,
          body: `${row.title.slice(0, 160)}. The customer has not answered yet.`, link: `/proposals/${row.id}`, dedupeKey: `proposal-expiring-soon:${row.id}:${row.version}`,
        };
        if (row.owner_user_id) await notifyUser(db, row.owner_user_id, row.org_id, note);
        else await notifyOrgRoles(db, row.org_id, ["owner", "admin"], note);
        return "warned" as const;
      });
      if (did === "expired") out.expired += 1;
      else if (did === "warned") out.warned += 1;
    } catch (e) {
      out.failed += 1;
      console.error("[iacquire] proposal expiry failed", { type: e instanceof Error ? e.name : "unknown", message: sanitizeErrorText(e).slice(0, 200) });
    }
  }
  return out;
}

export interface HousekeepingResult {
  challenges: number;
  sessions: number;
  codeEmails: number;
}

/**
 * Removes what the customer's page leaves behind once it is useless: emailed-code challenges and sessions a day after they ended, and the outbox copy of each code email an
 * hour after it was made (the code is in the text of that row, so it must not stay).
 */
export async function proposalHousekeeping(opts: { now?: Date } = {}): Promise<HousekeepingResult> {
  const now = (opts.now ?? new Date()).getTime();
  const day = new Date(now - 86_400_000).toISOString();
  const hour = new Date(now - 3_600_000).toISOString();
  return withSystem(async (db) => {
    const challenges = await db.query("delete from proposal_link_challenges where expires_at < $1::timestamptz", [day]);
    const sessions = await db.query("delete from proposal_link_sessions where max_expires_at < $1::timestamptz or expires_at < $1::timestamptz", [day]);
    const codeEmails = await db.query("delete from email_outbox where template = 'proposal_code' and created_at < $1::timestamptz", [hour]);
    return { challenges: challenges.rowCount ?? 0, sessions: sessions.rowCount ?? 0, codeEmails: codeEmails.rowCount ?? 0 };
  });
}
