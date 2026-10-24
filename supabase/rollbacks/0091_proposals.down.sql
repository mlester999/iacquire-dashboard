-- Rollback for 0091_proposals.sql. NOT a migration: stop the scheduler's proposal jobs first, review, and run in one transaction.
-- Refuses when proposals have been used (a proposal, a price book entry, a tax rate, a template, an AI run, a stored proposal document or a message that delivered a proposal exists), so a client's price
-- book, a sent document or a customer's recorded decision is never dropped by accident. Decisions and events are append-only by design: a deliberate removal means
-- exporting them first and then disabling their append-only triggers for the session that clears them. Unused settings rows are configuration and go with their table.
-- The proposal-documents bucket and its access rule belong to 0090 and are left as they are.

do $$
begin
  if exists (select 1 from proposals)
     or exists (select 1 from proposal_catalog_items)
     or exists (select 1 from proposal_tax_rates)
     or exists (select 1 from proposal_templates)
     or exists (select 1 from proposal_ai_runs)
     or exists (select 1 from private_files where bucket = 'proposal-documents') then
    raise exception 'Rollback refused: proposals, price book entries, tax rates, templates, AI runs or stored proposal documents exist. Export them deliberately first.';
  end if;
  if exists (select 1 from notifications where kind in ('proposal_approval_requested', 'proposal_approval_decided', 'proposal_viewed', 'proposal_accepted', 'proposal_declined', 'proposal_changes_requested', 'proposal_expiring', 'signature_completed', 'signature_failed')) then
    raise exception 'Rollback refused: proposal notifications exist. Delete or archive them first.';
  end if;
  -- A delivery message outlives its proposal row in the send chain (the link between them is only a reference), so the messages are looked at on their own.
  if exists (select 1 from proposal_deliveries) or exists (select 1 from conversation_messages where scope = 'delivery') then
    raise exception 'Rollback refused: messages that delivered a proposal to a customer exist. Export or archive them first.';
  end if;
end $$;

drop policy if exists proposal_deliveries_select on proposal_deliveries;
drop policy if exists proposal_decisions_select on proposal_decisions;
drop policy if exists proposal_share_links_select on proposal_share_links;
drop policy if exists proposal_events_select on proposal_events;
drop policy if exists proposal_versions_select on proposal_versions;
drop policy if exists proposals_select on proposals;
drop policy if exists proposal_ai_runs_select on proposal_ai_runs;
drop policy if exists proposal_template_versions_select on proposal_template_versions;
drop policy if exists proposal_templates_select on proposal_templates;
drop policy if exists proposal_catalog_items_select on proposal_catalog_items;
drop policy if exists proposal_tax_rates_select on proposal_tax_rates;
drop policy if exists proposal_settings_select on proposal_settings;

drop table proposal_decisions;
drop table proposal_deliveries;
drop table proposal_link_sessions;
drop table proposal_link_challenges;
drop table proposal_share_links;
drop table proposal_events;
drop table proposal_versions;
drop table proposals;
drop table proposal_ai_runs;
drop table proposal_template_versions;
drop table proposal_templates;
drop table proposal_catalog_items;
drop table proposal_tax_rates;
drop table proposal_counters;
drop table proposal_settings;

drop function app.proposal_deliveries_guard();
drop function app.proposal_decisions_append_only();
drop function app.proposal_events_append_only();
drop function app.proposal_versions_frozen();

delete from role_permissions where permission in ('proposals.view', 'proposals.create', 'proposals.discount', 'proposals.approve', 'proposals.send', 'proposals.record_decision', 'proposals.catalog', 'proposals.settings');
-- A workspace a Super Admin had switched proposals on for loses that switch with the tables it was for, so applying 0091 again leaves it off (as 0093 and 0095 do for theirs).
delete from org_features where feature = 'proposals';

-- The notification kinds added by 0091 are removed from the live allow-list (every other kind is left exactly as it is).
do $$
declare
  def text;
  kinds text[];
  literal text;
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'notifications_kind_check' and c.conrelid = 'notifications'::regclass;
  if def is null then
    raise exception 'notifications_kind_check not found';
  end if;
  kinds := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if cardinality(kinds) = 0 then
    literal := substring(def from '''\{([^}]*)\}''::text\[\]');
    if literal is not null then
      kinds := string_to_array(literal, ',');
    end if;
  end if;
  if kinds is null or cardinality(kinds) < 20 then
    raise exception 'could not read the current notification kinds (read %); refusing to rewrite them', coalesce(cardinality(kinds), 0);
  end if;
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('proposal_approval_requested', 'proposal_approval_decided', 'proposal_viewed', 'proposal_accepted', 'proposal_declined', 'proposal_changes_requested', 'proposal_expiring', 'signature_completed', 'signature_failed') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- The delivery scope is taken out of the live list (every other scope is left exactly as it is, in the order it has).
do $$
declare
  def text;
  scopes text[];
begin
  select pg_get_constraintdef(c.oid) into def from pg_constraint c where c.conname = 'conversation_messages_scope_check' and c.conrelid = 'conversation_messages'::regclass;
  if def is null then
    raise exception 'conversation_messages_scope_check not found';
  end if;
  scopes := array(select m[1] from regexp_matches(def, '''([a-z0-9_]+)''::text', 'g') as m);
  if scopes is null or cardinality(scopes) < 5 then
    raise exception 'could not read the current message scopes (read %); refusing to rewrite them', coalesce(cardinality(scopes), 0);
  end if;
  scopes := array(select k from unnest(scopes) with ordinality as t(k, o) where k <> 'delivery' order by o);
  alter table conversation_messages drop constraint conversation_messages_scope_check;
  execute 'alter table conversation_messages add constraint conversation_messages_scope_check check (scope in (' || (select string_agg(quote_literal(k), ', ' order by o) from unnest(scopes) with ordinality as t(k, o)) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0091_proposals';
