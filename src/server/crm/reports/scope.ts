import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { resolveCapabilities } from "@/server/crm/workspace";
import type { CrmActor } from "@/server/crm/actor";
import { resolveDates, todayIn, type ReportFilters, type ResolvedDates } from "@/components/crm/reports/spec";
import type { CapabilityProvider, CrmCapability, CrmMode } from "@/lib/crm/types";

/**
 * Everything a report section needs to run its queries: who is asking, the period as exact instants (the first moment of the first day
 * and the first moment after the last day, both in the workspace's time zone), the filters, and which system owns each capability.
 */
export interface ReportScope {
  actor: CrmActor;
  filters: ReportFilters;
  dates: ResolvedDates;
  /** Inclusive start. */
  startsAt: Date;
  /** Exclusive end. */
  endsAt: Date;
  timezone: string;
  mode: CrmMode;
  owners: Record<CrmCapability, CapabilityProvider>;
}

/** A time zone PostgreSQL knows, or UTC. A workspace with a broken zone setting still gets a report (in UTC) instead of an error. */
async function usableZone(db: Queryable, tz: string): Promise<string> {
  const { rows } = await db.query<{ ok: boolean }>("select exists (select 1 from pg_timezone_names where name = $1) as ok", [tz]);
  return rows[0]?.ok ? tz : "UTC";
}

export async function buildScope(actor: CrmActor, filters: ReportFilters, now: Date = new Date()): Promise<ReportScope> {
  // Trusted read of the workspace's own settings and the period's bounds; the actor was authorized for this organization by the caller.
  return withSystem(async (db) => {
    const timezone = await usableZone(db, actor.timezone || "UTC");
    const dates = resolveDates(filters, todayIn(timezone, now));
    const { rows } = await db.query<{ starts: Date; ends: Date }>(
      "select ($1::date::timestamp at time zone $3) as starts, (($2::date + 1)::timestamp at time zone $3) as ends",
      [dates.from, dates.to, timezone],
    );
    const ws = await db.query<{ mode: CrmMode }>("select mode from crm_workspaces where org_id = $1", [actor.orgId]);
    const caps = await db.query<{ capability: string; provider: CapabilityProvider }>("select capability, provider from crm_capability_providers where org_id = $1", [actor.orgId]);
    // A client without a workspace row is on iAcquire CRM: new workspaces always start native.
    const mode = ws.rows[0]?.mode ?? "native";
    return {
      actor,
      filters,
      dates,
      startsAt: new Date(rows[0].starts),
      endsAt: new Date(rows[0].ends),
      timezone,
      mode,
      owners: resolveCapabilities(mode, caps.rows),
    };
  });
}

/** Sums per currency, rounded to cents, sorted by currency code. Rows without a value are skipped, never counted as zero. */
export function byCurrency(rows: Array<{ currency: string | null; total: string | number | null }>): Array<{ currency: string; value: number }> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (r.total === null || r.total === undefined || !r.currency) continue;
    m.set(r.currency, (m.get(r.currency) ?? 0) + Number(r.total));
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, value: Math.round(value * 100) / 100 }));
}

export const num = (v: unknown) => Number(v ?? 0) || 0;
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);

/** A note for a section whose capability another system owns, so the numbers are read as "iAcquire's records only". */
export function ownerNote(scope: ReportScope, capability: CrmCapability, what: string): string[] {
  return scope.owners[capability] === "ghl" ? [`GoHighLevel owns ${what} for this workspace. These numbers cover what is recorded in iAcquire only.`] : [];
}
