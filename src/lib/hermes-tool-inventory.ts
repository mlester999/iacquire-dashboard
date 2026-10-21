/** Shared, client-safe identity for the verified Hermes runtime tool catalog. */
export const TOOL_INVENTORY_CONTRACT = "hermes.api_server.tool_catalog.v1";

export interface PersistedToolInventory {
  last_health_ok?: boolean | null;
  tool_inventory_contract: string | null;
  tool_inventory_digest: string | null;
  tool_inventory_verified_at: Date | string | null;
  tool_inventory_expires_at: Date | string | null;
  tool_inventory_tool_count: number | null;
}

/**
 * A complete successful inventory remains a comparison baseline after its short attestation TTL.
 * This does not make it eligible for execution; callers must use toolInventoryReady or the live
 * Hermes run verifier before accepting or submitting work.
 */
export function toolInventoryRecorded(row: PersistedToolInventory): boolean {
  if (row.last_health_ok !== undefined && row.last_health_ok !== true) return false;
  if (row.tool_inventory_contract !== TOOL_INVENTORY_CONTRACT) return false;
  if (!row.tool_inventory_digest || !/^[0-9a-f]{64}$/.test(row.tool_inventory_digest)) return false;
  if (!row.tool_inventory_verified_at || !Number.isFinite(new Date(row.tool_inventory_verified_at).getTime())) return false;
  if (!row.tool_inventory_expires_at) return false;
  const expires = new Date(row.tool_inventory_expires_at);
  if (!Number.isFinite(expires.getTime())) return false;
  return Number(row.tool_inventory_tool_count ?? 0) > 0;
}

/** A stored inventory is execution-fresh only while its complete attestation is unexpired. */
export function toolInventoryReady(row: PersistedToolInventory, now = new Date()): boolean {
  if (!toolInventoryRecorded(row)) return false;
  return new Date(row.tool_inventory_expires_at as Date | string).getTime() > now.getTime();
}

export function toolInventoryNeedsRefresh(row: PersistedToolInventory, now = new Date()): boolean {
  return !toolInventoryReady(row, now);
}
