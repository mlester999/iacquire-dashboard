import "server-only";
import type { Queryable } from "@/server/db";
import { CAPABILITY_LABELS, type CapabilityProvider, type CrmCapability, type CrmMode } from "@/lib/crm/types";

// Small, dependency-free checks the senders, booking paths and workers use so that two systems never act on the same record
// (docs/crm-provider-switching.md, "Hybrid safety"). Kept apart from src/server/crm/provider-switch.ts, which imports the whole migration
// pipeline, so any worker can use these without pulling that in.
//
//   * While a provider switch is cutting over (crm_workspaces.switching), automations that could act twice hold and retry later.
//   * When GoHighLevel owns a capability, iAcquire's own automations for it refuse or skip, with the reason.
//   * When a provider switch moved a capability to iAcquire (a switch to 'native' whose moved set names it, not undone since), the
//     GoHighLevel-side paths that act for it (booking a GoHighLevel calendar) refuse. Every cutover writes an explicit row for all eleven
//     capabilities, the untouched ones included, so a row alone doesn't mean a switch moved that one: capabilities a switch never moved
//     keep their earlier behaviour (a native workspace booking its connected GoHighLevel calendar, for example).

/** SQL: true when the organization in `orgExpr` is switching providers right now. */
export const switchingSql = (orgExpr: string) => `exists (select 1 from crm_workspaces sw where sw.org_id = ${orgExpr} and sw.switching)`;

/** SQL: true when GoHighLevel owns `capability` for the organization in `orgExpr` (the same rule as resolveCapabilities). */
export function ghlOwnsSql(orgExpr: string, capability: CrmCapability): string {
  return `exists (select 1 from crm_workspaces gw left join crm_capability_providers gp on gp.org_id = gw.org_id and gp.capability = '${capability}'
    where gw.org_id = ${orgExpr} and (case when gw.mode = 'hybrid' then coalesce(gp.provider, 'native') else gw.mode end) = 'ghl')`;
}

export interface CapabilityOwnership {
  owner: CapabilityProvider;
  switching: boolean;
  /**
   * The capability has an owner row (crm_capability_providers). A cutover writes one for every capability, moved or not, so this says only
   * that some switch ran, not that one moved this capability (ghlPathRefusal checks that).
   */
  explicit: boolean;
}

/** Who owns a capability, whether a switch is in progress, and whether it has an explicit owner row. A workspace without a CRM row is native. */
export async function capabilityOwnership(db: Queryable, orgId: string, capability: CrmCapability): Promise<CapabilityOwnership> {
  const { rows } = await db.query<{ mode: CrmMode; switching: boolean; provider: CapabilityProvider | null }>(
    `select w.mode, w.switching, p.provider from crm_workspaces w left join crm_capability_providers p on p.org_id = w.org_id and p.capability = $2 where w.org_id = $1`,
    [orgId, capability],
  );
  const w = rows[0];
  if (!w) return { owner: "native", switching: false, explicit: false };
  const owner: CapabilityProvider = w.mode === "hybrid" ? (w.provider ?? "native") : w.mode === "ghl" ? "ghl" : "native";
  return { owner, switching: w.switching, explicit: w.provider !== null };
}

/**
 * Why GoHighLevel's side may not act for this capability here, or null. It refuses only when iAcquire owns the capability because a provider
 * switch moved it there: a switch to iAcquire whose moved set (`capabilities`, which the cutover overwrites with what actually moved) names
 * it and that wasn't rolled back or cancelled. A rollback restores the earlier owners exactly, so it needs no further check; and whenever
 * iAcquire owns it again after a later hand-back and return, the latest move of it was to iAcquire.
 */
export async function ghlPathRefusal(db: Queryable, orgId: string, capability: CrmCapability): Promise<string | null> {
  const o = await capabilityOwnership(db, orgId, capability);
  if (o.owner !== "native" || !o.explicit) return null;
  const moved = await db.query(
    "select 1 from crm_provider_switches where org_id = $1 and direction = 'native' and $2 = any(capabilities) and status in ('cutting_over', 'verifying', 'completed', 'rolling_back') limit 1",
    [orgId, capability],
  );
  if (!moved.rows.length) return null;
  return `${CAPABILITY_LABELS[capability]} are managed in iAcquire CRM for this workspace now, so iAcquire no longer books or changes them in GoHighLevel.`;
}

/**
 * Why a native sending channel (Resend, Twilio, Meta) can't send for this workspace, or null: GoHighLevel owns conversations here (in
 * GoHighLevel mode, or a hybrid that gave them to GoHighLevel), so iAcquire's own providers never send. For the channel settings to show
 * and to refuse switching such a channel on (the GoHighLevel transport is unaffected).
 */
export async function nativeChannelRefusal(db: Queryable, orgId: string): Promise<string | null> {
  const o = await capabilityOwnership(db, orgId, "conversations");
  if (o.owner === "ghl") return "Conversations are managed in GoHighLevel for this workspace, so iAcquire's own sending channels don't send. Messages go through GoHighLevel.";
  return null;
}

/** Why iAcquire's own automation for this capability must not act, or null. GoHighLevel owns it: refuse (with the reason), never act twice. */
export async function nativeAutomationRefusal(db: Queryable, orgId: string, capability: CrmCapability): Promise<string | null> {
  const o = await capabilityOwnership(db, orgId, capability);
  if (o.owner === "ghl") return `${CAPABILITY_LABELS[capability]} are managed in GoHighLevel for this workspace, so iAcquire doesn't act on them itself.`;
  return null;
}
