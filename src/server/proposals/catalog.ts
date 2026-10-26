import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { isCurrency } from "@/lib/money";
import { DOC_LIMITS, isBilling, type Billing } from "@/lib/proposals/doc";
import { assertProposalsEnabled } from "@/server/proposals/features";
import { money } from "@/server/proposals/core";

// The workspace's own tax rates and price book. Nothing is seeded and nothing is guessed: a price exists because a person typed it. Reading needs the proposals view
// permission; changing needs proposals.catalog, which the owner, the manager and (inside an audited support session) the agency have as a setup service.

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const cleanBlock = (s: string | undefined | null) => (s ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

// ---------------------------------------------------------------------------
// Tax rates
// ---------------------------------------------------------------------------

export interface TaxRateView {
  id: string;
  name: string;
  rateBps: number;
  archived: boolean;
  createdAt: string;
}

interface TaxRow { id: string; name: string; rate_bps: number; archived_at: Date | null; created_at: Date }
const toTax = (r: TaxRow): TaxRateView => ({ id: r.id, name: r.name, rateBps: r.rate_bps, archived: r.archived_at !== null, createdAt: new Date(r.created_at).toISOString() });

export async function listTaxRates(actor: CrmActor, opts: { includeArchived?: boolean } = {}): Promise<TaxRateView[]> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<TaxRow>(
      `select id, name, rate_bps, archived_at, created_at from proposal_tax_rates where org_id = $1 and ($2::boolean or archived_at is null) order by archived_at nulls first, lower(name)`, [actor.orgId, opts.includeArchived === true],
    );
    return rows.map(toTax);
  });
}

function checkRate(bps: unknown): number {
  if (typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new AppError("invalid_input", "A tax rate is between 0% and 100% (in basis points: 1200 is 12%).");
  return bps;
}

async function assertFreeTaxName(db: Queryable, orgId: string, name: string, exceptId?: string) {
  const taken = await db.query("select 1 from proposal_tax_rates where org_id = $1 and lower(name) = lower($2) and archived_at is null and ($3::uuid is null or id <> $3)", [orgId, name, exceptId ?? null]);
  if (taken.rows[0]) throw new AppError("conflict", "You already have a tax rate with that name.");
}

export async function createTaxRate(actor: CrmActor, input: { name: string; rateBps: number }): Promise<TaxRateView> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the tax rates.");
  const name = clean(input.name);
  if (!name || name.length > 60) throw new AppError("invalid_input", "Give the tax rate a name of up to 60 characters.");
  const rateBps = checkRate(input.rateBps);
  return crmWrite(actor, async (db) => {
    await assertFreeTaxName(db, actor.orgId, name);
    const { rows } = await db.query<TaxRow>("insert into proposal_tax_rates (org_id, name, rate_bps, created_by) values ($1, $2, $3, $4) returning id, name, rate_bps, archived_at, created_at", [actor.orgId, name, rateBps, actor.userId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.tax_rate_created", targetType: "proposal_tax_rate", targetId: rows[0].id, result: "success", metadata: { rateBps } }, db);
    return toTax(rows[0]);
  });
}

/** Changes a tax rate. Lines already on proposals keep the rate they were added with: only lines added from now on use the new one. */
export async function updateTaxRate(actor: CrmActor, id: string, patch: { name?: string; rateBps?: number; archived?: boolean }): Promise<TaxRateView> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the tax rates.");
  return crmWrite(actor, async (db) => {
    const cur = (await db.query<TaxRow>("select id, name, rate_bps, archived_at, created_at from proposal_tax_rates where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (!cur) throw new AppError("not_found", "That tax rate was not found.");
    const name = patch.name !== undefined ? clean(patch.name) : cur.name;
    if (!name || name.length > 60) throw new AppError("invalid_input", "Give the tax rate a name of up to 60 characters.");
    const rateBps = patch.rateBps !== undefined ? checkRate(patch.rateBps) : cur.rate_bps;
    const archived = patch.archived ?? cur.archived_at !== null;
    if (!archived) await assertFreeTaxName(db, actor.orgId, name, id);
    const { rows } = await db.query<TaxRow>(
      "update proposal_tax_rates set name = $3, rate_bps = $4, archived_at = case when $5 then coalesce(archived_at, now()) else null end where id = $1 and org_id = $2 returning id, name, rate_bps, archived_at, created_at",
      [id, actor.orgId, name, rateBps, archived],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.tax_rate_updated", targetType: "proposal_tax_rate", targetId: id, result: "success", metadata: { rateBps, archived } }, db);
    return toTax(rows[0]);
  });
}

// ---------------------------------------------------------------------------
// Price book
// ---------------------------------------------------------------------------

export interface CatalogItemView {
  id: string;
  name: string;
  description: string;
  unitLabel: string;
  unitPriceMinor: number;
  currency: string;
  billing: Billing;
  taxRateId: string | null;
  taxRateName: string | null;
  taxBps: number | null;
  version: number;
  archived: boolean;
}

interface ItemRow {
  id: string; name: string; description: string; unit_label: string; unit_price_minor: string; currency: string; billing: Billing; tax_rate_id: string | null;
  tax_name: string | null; tax_bps: number | null; version: number; archived_at: Date | null;
}
const ITEM_SELECT = `i.id, i.name, i.description, i.unit_label, i.unit_price_minor::text as unit_price_minor, i.currency, i.billing, i.tax_rate_id, t.name as tax_name, t.rate_bps as tax_bps, i.version, i.archived_at
  from proposal_catalog_items i left join proposal_tax_rates t on t.id = i.tax_rate_id and t.org_id = i.org_id`;
const toItem = (r: ItemRow): CatalogItemView => ({
  id: r.id, name: r.name, description: r.description, unitLabel: r.unit_label, unitPriceMinor: money(r.unit_price_minor), currency: r.currency, billing: r.billing,
  taxRateId: r.tax_rate_id, taxRateName: r.tax_name, taxBps: r.tax_bps, version: r.version, archived: r.archived_at !== null,
});

export async function listCatalogItems(actor: CrmActor, opts: { includeArchived?: boolean; currency?: string } = {}): Promise<CatalogItemView[]> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.view", "Your role can't see proposals.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<ItemRow>(
      `select ${ITEM_SELECT} where i.org_id = $1 and ($2::boolean or i.archived_at is null) and ($3::text is null or i.currency = $3) order by i.archived_at nulls first, lower(i.name)`,
      [actor.orgId, opts.includeArchived === true, opts.currency ?? null],
    );
    return rows.map(toItem);
  });
}

export interface CatalogItemInput {
  name: string;
  description?: string;
  unitLabel?: string;
  unitPriceMinor: number;
  currency: string;
  billing?: Billing;
  taxRateId?: string | null;
}

async function checkItem(db: Queryable, orgId: string, input: Required<Pick<CatalogItemInput, "name" | "unitPriceMinor" | "currency" | "billing">> & CatalogItemInput, keepTaxRateId: string | null) {
  const name = clean(input.name);
  if (!name || name.length > 120) throw new AppError("invalid_input", "Give the item a name of up to 120 characters.");
  const description = cleanBlock(input.description);
  if (description.length > 1000) throw new AppError("invalid_input", "An item's description can be at most 1,000 characters.");
  const unitLabel = clean(input.unitLabel) || "each";
  if (unitLabel.length > 30) throw new AppError("invalid_input", "A unit label can be at most 30 characters.");
  if (!Number.isSafeInteger(input.unitPriceMinor) || input.unitPriceMinor < 0 || input.unitPriceMinor > DOC_LIMITS.maxMinor) throw new AppError("invalid_input", "The price must be a whole number of minor units (cents), zero or more.");
  if (!isCurrency(input.currency)) throw new AppError("invalid_input", "Choose a currency iAcquire can total.");
  if (!isBilling(input.billing)) throw new AppError("invalid_input", "Choose whether the item is billed once, monthly or yearly.");
  const taxRateId = input.taxRateId ?? null;
  if (taxRateId && taxRateId !== keepTaxRateId) {
    if (!(await db.query("select 1 from proposal_tax_rates where id = $1 and org_id = $2 and archived_at is null", [taxRateId, orgId])).rows[0]) throw new AppError("invalid_input", "Choose one of your tax rates.");
  }
  return { name, description, unitLabel, taxRateId };
}

export async function createCatalogItem(actor: CrmActor, input: CatalogItemInput): Promise<CatalogItemView> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the price book.");
  return crmWrite(actor, async (db) => {
    const billing = input.billing ?? "one_time";
    const c = await checkItem(db, actor.orgId, { ...input, billing }, null);
    const { rows } = await db.query<{ id: string }>(
      "insert into proposal_catalog_items (org_id, name, description, unit_label, unit_price_minor, currency, billing, tax_rate_id, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
      [actor.orgId, c.name, c.description, c.unitLabel, input.unitPriceMinor, input.currency, billing, c.taxRateId, actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.catalog_item_created", targetType: "proposal_catalog_item", targetId: rows[0].id, result: "success", metadata: { currency: input.currency, billing, unitPriceMinor: input.unitPriceMinor } }, db);
    return toItem((await db.query<ItemRow>(`select ${ITEM_SELECT} where i.id = $1 and i.org_id = $2`, [rows[0].id, actor.orgId])).rows[0]);
  });
}

/**
 * Changes a price book item. `expectedVersion` stops two people overwriting each other. Proposals that already hold the item keep the price they were given: a new price
 * applies to lines added from now on, and a sent version never changes.
 */
export async function updateCatalogItem(actor: CrmActor, id: string, patch: Partial<CatalogItemInput> & { archived?: boolean }, expectedVersion: number): Promise<CatalogItemView> {
  await assertProposalsEnabled(actor.orgId);
  assertCan(actor, "proposals.catalog", "Only the business owner or a manager can change the price book.");
  return crmWrite(actor, async (db) => {
    const cur = (await db.query<ItemRow>(`select ${ITEM_SELECT} where i.id = $1 and i.org_id = $2 for update of i`, [id, actor.orgId])).rows[0];
    if (!cur) throw new AppError("not_found", "That item was not found.");
    if (cur.version !== expectedVersion) throw new AppError("conflict", "Someone else changed this item. Reload to see their changes, then try again.");
    const c = await checkItem(db, actor.orgId, {
      name: patch.name ?? cur.name, description: patch.description ?? cur.description, unitLabel: patch.unitLabel ?? cur.unit_label, unitPriceMinor: patch.unitPriceMinor ?? money(cur.unit_price_minor),
      currency: patch.currency ?? cur.currency, billing: patch.billing ?? cur.billing, taxRateId: patch.taxRateId !== undefined ? patch.taxRateId : cur.tax_rate_id,
    }, cur.tax_rate_id);
    const archived = patch.archived ?? cur.archived_at !== null;
    await db.query(
      `update proposal_catalog_items set name = $3, description = $4, unit_label = $5, unit_price_minor = $6, currency = $7, billing = $8, tax_rate_id = $9, version = version + 1,
         archived_at = case when $10 then coalesce(archived_at, now()) else null end where id = $1 and org_id = $2`,
      [id, actor.orgId, c.name, c.description, c.unitLabel, patch.unitPriceMinor ?? money(cur.unit_price_minor), patch.currency ?? cur.currency, patch.billing ?? cur.billing, c.taxRateId, archived],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "proposals.catalog_item_updated", targetType: "proposal_catalog_item", targetId: id, result: "success", metadata: { archived, priceChanged: patch.unitPriceMinor !== undefined && patch.unitPriceMinor !== money(cur.unit_price_minor) } }, db);
    return toItem((await db.query<ItemRow>(`select ${ITEM_SELECT} where i.id = $1 and i.org_id = $2`, [id, actor.orgId])).rows[0]);
  });
}
