-- Complete runtime tool-inventory attestation for each AI employee.
--
-- `tool_inventory_*` records the last verified `GET /v1/tools?platform=api_server` snapshot.
-- The digest and expiry make readiness staleness-aware; the compact snapshot lets a Super Admin
-- see exactly which tools and toolsets were verified without exposing credentials or descriptions.
-- Live runs still re-verify the inventory immediately before submitting the run.
--
-- Additive and idempotent: no existing rows or constraints are changed.

alter table agent_instances
  add column if not exists tool_inventory_contract text
    check (tool_inventory_contract is null or char_length(tool_inventory_contract) <= 80),
  add column if not exists tool_inventory_digest text
    check (tool_inventory_digest is null or tool_inventory_digest ~ '^[0-9a-f]{64}$'),
  add column if not exists tool_inventory_verified_at timestamptz,
  add column if not exists tool_inventory_expires_at timestamptz,
  add column if not exists tool_inventory_tool_count integer
    check (tool_inventory_tool_count is null or tool_inventory_tool_count >= 0),
  add column if not exists tool_inventory_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(tool_inventory_snapshot) = 'object'),
  add column if not exists tool_inventory_detail text
    check (tool_inventory_detail is null or char_length(tool_inventory_detail) <= 500);

comment on column agent_instances.tool_inventory_contract is
  'Contract that produced the last verified complete runtime tool inventory (e.g. hermes.api_server.tool_catalog.v1).';
comment on column agent_instances.tool_inventory_digest is
  'SHA-256 digest of the last verified effective tool inventory. A run is refused when the live digest differs.';
comment on column agent_instances.tool_inventory_expires_at is
  'Freshness deadline for the persisted inventory attestation. Expired attestations do not authorize a run.';
comment on column agent_instances.tool_inventory_snapshot is
  'Compact verified inventory: contract, digest, profile, enabled toolsets and tool names. No credentials.';
