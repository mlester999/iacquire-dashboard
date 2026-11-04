-- 0123: retain which unified or legacy runtime owns a research request so retries stay tenant-bound.
-- Existing requests remain Lead Hunter requests; no rows or jobs are started by this migration.

alter table lead_research_requests
  add column agent_role text not null default 'lead_hunter'
    references agent_roles(key) on update cascade on delete restrict;

alter table lead_research_requests
  add constraint lead_research_requests_agent_role_check
  check (agent_role in ('lead_hunter', 'growth_partner'));

comment on column lead_research_requests.agent_role is
  'The tenant runtime identity that owns this request and its retries; existing requests remain attached to Lead Hunter.';
