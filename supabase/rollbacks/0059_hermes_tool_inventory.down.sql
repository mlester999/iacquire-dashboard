-- Rollback for 0047_hermes_tool_inventory.sql.
--
-- Dropping these columns removes only the persisted inventory attestation. The live-run gate
-- re-reads the gateway inventory on every run, so removing the snapshot cannot authorize a run.
-- Do not roll this back while a deployment still writes the columns.

alter table agent_instances
  drop column if exists tool_inventory_detail,
  drop column if exists tool_inventory_snapshot,
  drop column if exists tool_inventory_tool_count,
  drop column if exists tool_inventory_expires_at,
  drop column if exists tool_inventory_verified_at,
  drop column if exists tool_inventory_digest,
  drop column if exists tool_inventory_contract;
