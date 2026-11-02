import "server-only";
import { createHash } from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { launchNotificationsOn } from "@/server/setup/launch-notifications";
import { verifyCalendarInTx, type CalendarCheckKey } from "@/server/calendars/activation";

// A calendar that passed verification can stop being valid without anyone touching the calendar itself: a host's hours are removed, a host pauses or
// leaves, a Google or Microsoft account is disconnected or needs a new sign-in, a time zone stops being real, the last appointment type is archived.
// This module re-runs the same activation checks (verifyCalendarInTx, read-only) for the workspace's verified active calendars after such a change and
// says so ONCE per change: it compares a digest of the failing check keys with the one it stored last time, and only a difference is written,
// audited and notified. Re-running with nothing new changes nothing, so a retry or a second save never produces a second notice. It never touches a
// booking, a public page or a calendar's status: it only records what is true and tells the people who can fix it.

export interface CalendarDrift {
  calendarId: string;
  calendarName: string;
  failing: CalendarCheckKey[];
}

export interface ReverifyResult {
  /** Verified active calendars that were re-checked. */
  checked: number;
  /** Calendars whose set of failing checks changed to a non-empty set, with what now fails. */
  drifted: CalendarDrift[];
  /** Calendars that were failing and pass every check again. */
  recovered: string[];
  /** Calendars whose failing checks are exactly what was already recorded. */
  unchanged: number;
  /** Set when nothing was checked on purpose: the internal agency workspace and demo workspaces never get drift records or notices from this. */
  skipped?: "agency" | "demo" | "unknown_workspace";
}

/** What `verification.drift` holds while a calendar is failing: small, and never people's details. */
interface StoredDrift {
  at: string;
  failing: CalendarCheckKey[];
  digest: string;
  seq: number;
  reason: string;
  checks: Array<{ key: CalendarCheckKey; detail: string }>;
}

/** The same failing checks always give the same digest, whatever order they were found in. */
export function failingDigest(keys: readonly string[]): string {
  return createHash("sha256").update([...keys].sort().join(",")).digest("hex");
}

/** The digest of "nothing fails": what a calendar with no stored drift counts as. */
const HEALTHY_DIGEST = failingDigest([]);

function storedDigestOf(verification: Record<string, unknown>): string {
  const drift = verification.drift;
  const digest = drift && typeof drift === "object" ? (drift as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest ? digest : HEALTHY_DIGEST;
}

function storedFailingOf(verification: Record<string, unknown>): string[] {
  const drift = verification.drift;
  const failing = drift && typeof drift === "object" ? (drift as { failing?: unknown }).failing : undefined;
  return Array.isArray(failing) ? failing.filter((k): k is string => typeof k === "string") : [];
}

/**
 * Re-runs the activation checks for every verified, active, non-archived calendar of `orgId` and records a change in what fails. "Verified" means it went through activation
 * (verified_at is set): a calendar nobody has ever verified has no baseline to drift from, so the launch panel (which judges it directly) is what speaks for it.
 *
 * On a change only: `verification.drift` is written (or removed on recovery), `crm.calendar_verification_drifted` or `crm.calendar_verification_recovered` is audited, and the
 * workspace's owners and admins get one notice whose dedupe key holds the digest and a per-calendar change counter (so the same state is never announced twice, while the
 * same problem coming back later is announced again). Calendar rows are locked in id order, so two checks running at once cannot both record the same change.
 *
 * Trusted code: runs as the system, every query names the workspace. `db` must be an open transaction handle that bypasses row security (withSystem), because the checks read
 * every host's connections and hours, which a member who only changed their own hours may not be allowed to see. The agency's own workspace and demo workspaces are skipped.
 */
export async function reverifyCalendarsAfterChange(db: Queryable, orgId: string, reason: string, opts: { now?: Date } = {}): Promise<ReverifyResult> {
  const now = opts.now ?? new Date();
  const result: ReverifyResult = { checked: 0, drifted: [], recovered: [], unchanged: 0 };
  const org = await db.query<{ kind: string; is_demo: boolean }>("select kind, is_demo from organizations where id = $1", [orgId]);
  if (!org.rows[0]) return { ...result, skipped: "unknown_workspace" };
  if (org.rows[0].is_demo) return { ...result, skipped: "demo" };
  if (org.rows[0].kind === "agency") return { ...result, skipped: "agency" };

  // The owners' and admins' notices below are sent only where launch notices were switched on (src/server/setup/launch-notifications.ts): the first pass over a client that was already
  // using the product must not tell it about a calendar it has lived with. The drift is recorded and audited either way.
  const notices = await launchNotificationsOn(orgId, db);
  const cals = await db.query<{ id: string; name: string; verification: Record<string, unknown> | null }>(
    `select id, name, verification from crm_calendars
      where org_id = $1 and status = 'active' and verified_at is not null and archived_at is null order by created_at, id for update`,
    [orgId],
  );
  for (const c of cals.rows) {
    const verification = await verifyCalendarInTx(db, orgId, c.id, now);
    result.checked += 1;
    const failingChecks = verification.checks.filter((x) => !x.ok);
    const failing = failingChecks.map((x) => x.key).sort();
    const digest = failingDigest(failing);
    const stored = c.verification ?? {};
    if (digest === storedDigestOf(stored)) {
      result.unchanged += 1;
      continue;
    }
    const seq = (Number(stored.driftSeq) || 0) + 1;
    const previous = storedFailingOf(stored);
    if (failing.length) {
      const drift: StoredDrift = { at: now.toISOString(), failing, digest, seq, reason: reason.slice(0, 60), checks: failingChecks.map((x) => ({ key: x.key, detail: x.detail.slice(0, 200) })) };
      await db.query("update crm_calendars set verification = verification || jsonb_build_object('drift', $3::jsonb, 'driftSeq', $4::int) where id = $1 and org_id = $2", [c.id, orgId, JSON.stringify(drift), seq]);
      await recordAudit({
        orgId, actorKind: "system", action: "crm.calendar_verification_drifted", targetType: "crm_calendar", targetId: c.id, result: "failure",
        metadata: { reason: drift.reason, failing, previous, digest },
      }, db);
      const lead = failingChecks.slice(0, 2).map((x) => x.detail).join(" ");
      if (notices) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "crm_calendar_sync",
          severity: "warning",
          title: `${c.name} no longer passes its checks`,
          body: `${lead} Bookings you already have are untouched; fix this so the calendar keeps working as it was set up.`,
          link: "/crm/calendars",
          dedupeKey: `calendar-drift:${c.id}:${digest}:${seq}`,
        });
      }
      result.drifted.push({ calendarId: c.id, calendarName: c.name, failing });
    } else {
      await db.query("update crm_calendars set verification = (verification - 'drift') || jsonb_build_object('driftSeq', $3::int) where id = $1 and org_id = $2", [c.id, orgId, seq]);
      await recordAudit({
        orgId, actorKind: "system", action: "crm.calendar_verification_recovered", targetType: "crm_calendar", targetId: c.id, result: "success",
        metadata: { reason: reason.slice(0, 60), previous, digest },
      }, db);
      if (notices) {
        await notifyOrgRoles(db, orgId, ["owner", "admin"], {
          kind: "crm_calendar_sync",
          severity: "success",
          title: `${c.name} passes its checks again`,
          body: "Every check that failed after the last change passes now.",
          link: "/crm/calendars",
          dedupeKey: `calendar-recovered:${c.id}:${storedDigestOf(stored)}:${seq}`,
        });
      }
      result.recovered.push(c.id);
    }
  }
  return result;
}

/**
 * The same re-check for a write path that has already committed: it opens its own system transaction, so it must not be called inside another one. The watch is advisory and
 * never fails the person's change: a problem is logged (without details, which could name records) and the next change, or the next pass, records the drift instead.
 */
export async function reverifyAfterCommit(orgId: string, reason: string, opts: { now?: Date } = {}): Promise<ReverifyResult | null> {
  try {
    return await withSystem((db) => reverifyCalendarsAfterChange(db, orgId, reason, opts));
  } catch (err) {
    console.warn(`[iacquire] calendar re-check after ${reason} failed; the next change will record it.`, { error: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}

/**
 * The same re-check from code that already holds a system transaction (a sync marking a sign-in as broken). It runs in a savepoint, so a failure in the check rolls back only
 * the check and never the caller's own change.
 */
export async function reverifyWithinTx(db: Queryable, orgId: string, reason: string, opts: { now?: Date } = {}): Promise<ReverifyResult | null> {
  try {
    await db.query("savepoint calendar_reverify");
    const res = await reverifyCalendarsAfterChange(db, orgId, reason, opts);
    await db.query("release savepoint calendar_reverify");
    return res;
  } catch (err) {
    await db.query("rollback to savepoint calendar_reverify").catch(() => undefined);
    console.warn(`[iacquire] calendar re-check after ${reason} failed; the next change will record it.`, { error: err instanceof Error ? err.name : "unknown" });
    return null;
  }
}
