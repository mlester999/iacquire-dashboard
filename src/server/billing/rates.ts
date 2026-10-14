import "server-only";
import { withSystem } from "@/server/db";
import { UNIT_LABELS } from "@/lib/billing";

export interface UnitRateRow {
  provider: string;
  unitType: string;
  label: string;
  wholesaleMicrosPerUnit: number;
  clientMicrosPerUnit: number;
  markupBps: number;
  version: number;
  publishedAt: string;
}

/** The rate currently in force for each provider and unit: what the provider charges us, and what the client is charged (wholesale times the approved markup). */
export async function listCurrentUnitRates(): Promise<UnitRateRow[]> {
  const { rows } = await withSystem((db) =>
    db.query<{ provider: string; unit_type: string; unit_label: string | null; w: string; c: string; markup_bps: number; version: number; published_at: Date }>(
      `select distinct on (r.provider, r.unit_type) r.provider, r.unit_type, r.unit_label, r.wholesale_micros_per_unit::text as w, r.client_micros_per_unit::text as c, v.markup_bps, v.version, r.published_at
       from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id order by r.provider, r.unit_type, v.version desc`,
    ),
  );
  return rows.map((r) => ({
    provider: r.provider, unitType: r.unit_type, label: r.unit_label ?? UNIT_LABELS[r.unit_type] ?? r.unit_type, wholesaleMicrosPerUnit: Number(r.w), clientMicrosPerUnit: Number(r.c), markupBps: r.markup_bps,
    version: r.version, publishedAt: new Date(r.published_at).toISOString(),
  }));
}
