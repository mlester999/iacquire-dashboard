import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { contentHash } from "@/lib/proposals/hash";
import { isCurrency, type CurrencyCode } from "@/lib/money";
import { proposalProblems, type Problem } from "@/lib/proposals/problems";
import { freeze, sourceOf, type Frozen, type FreezeInput } from "@/lib/proposals/snapshot";
import { todayIn } from "@/lib/proposals/validity";
import { groupGrandTotals } from "@/lib/proposals/money";
import { loadVersionRow, rowDoc, type ProposalRow, type VersionRow } from "@/server/proposals/core";
import { signingStatus } from "@/server/proposals/signing";

// Freezing a version and checking it. A version row is written when a proposal is submitted for approval (the reviewer sees exactly what is frozen) or sent; it is written
// once and never changes. The proposal's working fields can change afterwards, but the version stays what was approved.

/** The workspace facts a frozen copy is filled in with. */
async function freezeInput(db: Queryable, row: ProposalRow): Promise<FreezeInput> {
  const org = (await db.query<{ name: string; website: string | null; timezone: string }>("select name, website, timezone from organizations where id = $1", [row.org_id])).rows[0];
  const senderId = row.owner_user_id ?? row.created_by;
  const sender = senderId ? (await db.query<{ n: string }>("select coalesce(nullif(full_name, ''), email::text) as n from users where id = $1", [senderId])).rows[0] : undefined;
  const deal = row.opportunity_id ? (await db.query<{ name: string }>("select name from crm_opportunities where id = $1 and org_id = $2", [row.opportunity_id, row.org_id])).rows[0] : undefined;
  return {
    number: row.number, title: row.title, currency: (isCurrency(row.currency) ? row.currency : "USD") as CurrencyCode, validUntil: row.valid_until, requiresSignature: row.requires_signature,
    client: { name: row.client_name, company: row.client_company, email: row.client_email },
    business: { name: org?.name ?? "", website: org?.website || null }, sender: { name: sender?.n ?? null }, dealName: deal?.name ?? null, doc: rowDoc(row),
  };
}

export interface Checked {
  problems: Problem[];
  /** The frozen copy as it would be made now; null when the figures cannot be worked out. */
  frozen: Frozen | null;
  timezone: string;
}

/** Everything wrong with a proposal as it stands, and the frozen copy it would make. `now` is injectable so a test (or the expiry job) can pin the date. */
export async function checkProposal(db: Queryable, row: ProposalRow, now = new Date()): Promise<Checked> {
  const input = await freezeInput(db, row);
  const tz = (await db.query<{ timezone: string }>("select timezone from organizations where id = $1", [row.org_id])).rows[0]?.timezone ?? "UTC";
  const archived = new Set((await db.query<{ id: string }>("select id from proposal_tax_rates where org_id = $1 and archived_at is not null", [row.org_id])).rows.map((r) => r.id));
  let frozen: Frozen | null = null;
  try {
    frozen = freeze(input);
  } catch {
    frozen = null;
  }
  // Only a proposal that needs a signature asks the question, so the common case reads nothing more.
  const signing = row.requires_signature ? await signingStatus(db, row.org_id) : ({ available: true } as const);
  const problems = proposalProblems({
    doc: input.doc, currency: row.currency, validUntil: row.valid_until, clientName: row.client_name, clientEmail: row.client_email, requiresSignature: row.requires_signature, origin: row.origin,
    today: todayIn(tz, now), signingAvailable: signing.available, signingWhy: signing.available ? undefined : signing.why, archivedTaxRateIds: archived, snapshot: frozen?.snapshot ?? null,
    missingTokens: frozen?.missing ?? [], unknownTokens: frozen?.unknown ?? [],
  });
  return { problems, frozen, timezone: tz };
}

/** The hash of the working fields as they are stored now: what sending compares with the version that was approved. */
export const sourceHashOf = (row: ProposalRow): string =>
  contentHash(sourceOf({ title: row.title, currency: row.currency, validUntil: row.valid_until, requiresSignature: row.requires_signature, clientName: row.client_name, clientCompany: row.client_company, clientEmail: row.client_email, doc: rowDoc(row) }));

/**
 * The frozen row for the proposal's current version, written now if it does not exist yet. If it exists, the working fields must still be what it was made from: the version
 * number moves whenever the wording does, so a mismatch means something changed the proposal without moving it, and nothing is approved or sent on top of that.
 */
export async function ensureVersion(db: Queryable, row: ProposalRow, userId: string | null, checked: Checked): Promise<VersionRow> {
  const existing = await loadVersionRow(db, row.org_id, row.id, row.version);
  const sourceHash = sourceHashOf(row);
  if (existing) {
    if (existing.source_hash !== sourceHash) throw new AppError("conflict", "This proposal was changed without a new version being made. Send it for approval again.");
    return existing;
  }
  if (!checked.frozen) throw new AppError("invalid_input", "The figures can't be worked out. Check the prices, quantities and discounts.");
  const { snapshot } = checked.frozen;
  const totals = groupGrandTotals(snapshot.groups);
  const hash = contentHash(snapshot);
  await db.query(
    `insert into proposal_versions (org_id, proposal_id, version, snapshot, content_hash, source_hash, one_time_total_minor, monthly_total_minor, yearly_total_minor, created_by)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
    [row.org_id, row.id, row.version, JSON.stringify(snapshot), hash, sourceHash, totals.one_time, totals.monthly, totals.yearly, userId],
  );
  return (await loadVersionRow(db, row.org_id, row.id, row.version)) as VersionRow;
}

/** The stored snapshot must still hash to what was recorded: a row edited behind the application's back is caught before it is approved, sent or shown. */
export function assertVersionIntact(v: VersionRow): void {
  if (contentHash(v.snapshot) !== v.content_hash) throw new AppError("internal", "A saved version of this proposal does not match its record. Contact support before sending it.");
}
