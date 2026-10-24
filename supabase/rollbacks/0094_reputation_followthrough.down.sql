-- Rollback for 0094_reputation_followthrough.sql. NOT a migration: stop the scheduler's reputation jobs first, review, and run in one transaction.
-- Refuses when the follow-through has been used, so a customer's survey answer, an acknowledgement or a resolution note is never dropped by accident:
-- a feedback row that carries a zero-to-ten score, an escalation, an acknowledgement, a resolution or a reminder record, a link to the survey form submission it came from,
-- a low flag the old rule would not have set,
-- a review request that is a survey or began from a program or batch, a review request batch (or a request that carries one), or a notification of the six new kinds.
-- An unused settings row is configuration and goes with its table. The low flag of a feedback row that the old rule had already escalated (a rating of two or less) is derived data and does not stop the rollback.

do $$
begin
  if exists (
    select 1 from customer_feedback
    where scale <> 'csat5' or nps_score is not null or escalation_id is not null or acknowledged_at is not null or acknowledged_by is not null
       or resolved_at is not null or resolved_by is not null or resolution_note is not null or sla_notified_at is not null or form_submission_id is not null
       or (low_score and not (rating is not null and rating <= 2 and escalated_task_id is not null))
  ) then
    raise exception 'Rollback refused: private feedback with a zero-to-ten score, an escalation, an acknowledgement, a resolution, a reminder record or a survey form submission exists. Export it deliberately first.';
  end if;
  if exists (select 1 from crm_review_requests where kind <> 'review' or scale <> 'csat5' or requested_via in ('program', 'batch') or batch_id is not null) then
    raise exception 'Rollback refused: satisfaction surveys or requests started by a retention program or a batch exist. Export them deliberately first.';
  end if;
  if exists (select 1 from review_request_batches) then
    raise exception 'Rollback refused: review request batches exist. Export or cancel and delete them deliberately first.';
  end if;
  if exists (select 1 from notifications where kind in ('feedback_follow_up_overdue', 'review_needs_reply', 'review_reply_requested', 'review_reply_decided', 'review_reply_failed', 'review_connection_attention')) then
    raise exception 'Rollback refused: reputation notifications exist. Delete or archive them first.';
  end if;
end $$;

drop policy if exists reputation_settings_select on reputation_settings;
drop table reputation_settings;

drop policy if exists review_request_batch_items_select on review_request_batch_items;
drop table review_request_batch_items;
alter table crm_review_requests drop constraint crm_review_requests_batch_fk;
drop index if exists crm_review_requests_batch_idx;
alter table crm_review_requests drop column batch_id;
drop policy if exists review_request_batches_select on review_request_batches;
drop table review_request_batches;

alter table crm_review_requests drop constraint if exists crm_review_requests_requested_via_check;
alter table crm_review_requests add constraint crm_review_requests_requested_via_check check (requested_via in ('manual', 'workflow', 'api'));
alter table crm_review_requests drop column kind, drop column scale;

drop index if exists customer_feedback_period_idx;
drop index if exists customer_feedback_submission_idx;
drop index if exists customer_feedback_sla_idx;
drop index if exists customer_feedback_contact_idx;
alter table customer_feedback
  drop constraint customer_feedback_submission_source_check,
  drop constraint customer_feedback_submission_fk,
  drop constraint customer_feedback_escalation_fk,
  drop constraint customer_feedback_resolved_check,
  drop constraint customer_feedback_has_content_check,
  drop constraint customer_feedback_csat_scale_check,
  drop constraint customer_feedback_nps_scale_check;
alter table customer_feedback
  drop column scale, drop column nps_score, drop column low_score, drop column escalation_id, drop column acknowledged_at, drop column acknowledged_by,
  drop column resolved_at, drop column resolved_by, drop column resolution_note, drop column sla_notified_at, drop column form_submission_id;

delete from role_permissions where permission in ('reviews.view', 'reviews.respond', 'reviews.reply_publish');
-- A workspace a Super Admin had switched satisfaction surveys or review request batches on for loses those switches with the tables they were for, so applying 0094 again leaves it off.
delete from org_features where feature in ('reputation_surveys', 'reputation_batches');

-- The notification kinds added by 0094 are removed from the live allow-list (every other kind is left exactly as it is).
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
  kinds := array(select distinct k from unnest(kinds) as k where k not in ('feedback_follow_up_overdue', 'review_needs_reply', 'review_reply_requested', 'review_reply_decided', 'review_reply_failed', 'review_connection_attention') order by k);
  alter table notifications drop constraint notifications_kind_check;
  execute 'alter table notifications add constraint notifications_kind_check check (kind in (' || (select string_agg(quote_literal(k), ', ' order by k) from unnest(kinds) as k) || '))';
end $$;

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0094_reputation_followthrough';
