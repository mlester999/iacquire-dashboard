-- Rollback for 0095_external_reviews.sql. NOT a migration: stop the scheduler's review jobs first, review, and run in one transaction.
-- Refuses when review reading has been used (a connection, a mirrored review or a reply exists), so a connected site, the reviews read from it and every reply a person
-- approved or posted are never dropped by accident. Likewise a survey answer that is waiting for a person to confirm whose it is (customer_feedback.possible_contact_id): the
-- possible match would be lost. An unused sign-in state is ephemeral and goes with its table; the per-workspace switch is configuration and is removed.

do $$
begin
  if exists (select 1 from review_connections)
     or exists (select 1 from external_reviews)
     or exists (select 1 from review_replies) then
    raise exception 'Rollback refused: review site connections, reviews read from a site or replies to them exist. Export them deliberately first.';
  end if;
  if exists (select 1 from customer_feedback where possible_contact_id is not null) then
    raise exception 'Rollback refused: survey answers waiting for someone to confirm whose they are exist. Confirm or dismiss them first.';
  end if;
end $$;

drop index if exists customer_feedback_possible_contact_idx;
alter table customer_feedback drop constraint customer_feedback_possible_contact_check, drop constraint customer_feedback_possible_contact_fk;
alter table customer_feedback drop column possible_contact_id;

drop policy if exists review_reply_events_select on review_reply_events;
drop policy if exists review_replies_select on review_replies;
drop policy if exists external_reviews_select on external_reviews;
drop policy if exists review_connections_select on review_connections;

drop table review_reply_events;
drop table review_replies;
drop table external_reviews;
drop table review_oauth_states;
drop table review_connections;

delete from org_features where feature = 'reputation_reviews';

-- After a rollback the ledger row remains: delete it so the migration can be applied again.
--   delete from schema_migrations where version = '0095_external_reviews';
