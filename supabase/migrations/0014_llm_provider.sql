-- Agency-level AI model (LLM) connection. The API key is stored as a Supabase Vault reference like
-- every other integration credential; only the endpoint, model and API format live in config.
alter table credential_references drop constraint credential_references_provider_check;
alter table credential_references add constraint credential_references_provider_check
  check (provider in ('hermes','ghl','n8n','llm','email','google_calendar','domain','external'));

alter table integration_connections drop constraint integration_connections_provider_check;
alter table integration_connections add constraint integration_connections_provider_check
  check (provider in ('supabase','hermes','ghl','n8n','llm','google_calendar','email','domain','external'));

-- One shared model connection for the agency; clients never hold model credentials.
alter table integration_connections add constraint integration_connections_llm_agency_only
  check (provider <> 'llm' or org_id is null);
