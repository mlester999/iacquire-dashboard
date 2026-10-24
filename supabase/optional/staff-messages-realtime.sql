-- OPTIONAL, NOT A MIGRATION. Do not put this in supabase/migrations and do not run it from the migration runner.
--
-- The Realtime read policy for the private topic staffmsg:<user id> of staff Messages. The product does not use Supabase Realtime yet: staff Messages arrive by a visible-tab
-- poll and a server-sent stream (docs/staff-messages.md). Hosted Supabase Realtime has never been tried on a live project, so this file stays unapplied until the founder
-- approves a live-project test; the test is the checklist at the end of the page of docs/staff-messages.md called "Realtime".
--
-- Why it is not in 0096: a Realtime policy runs as the browser role (authenticated), which therefore has to be allowed to execute the function it calls, and this
-- repository's migration rehearsal refuses every new security-definer function that anon, authenticated or PUBLIC can run. The setup topic of 0011 was written before that rule.
--
-- What it allows: a signed-in browser may subscribe to ONE topic, its own (staffmsg: and its own user id), and only while it is an active agency account holding
-- agency.messages.use with the module switched on. The topic carries a revision number and nothing else (no message text, no name), exactly like the stream. A browser
-- cannot publish to it (the policy is for select only; the server publishes with the service role), and a person who is demoted, disabled or denied the permission
-- stops being allowed on the next check, because the function reads their standing every time.
--
-- Apply by hand, in the Supabase SQL editor or psql, as the database owner:  \i supabase/optional/staff-messages-realtime.sql
-- Remove with supabase/optional/staff-messages-realtime.down.sql.

create or replace function app.staff_topic_allowed(p_topic text) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce(p_topic = 'staffmsg:' || app.current_user_id()::text and app.staff_messages_allowed(), false)
$$;

revoke all on function app.staff_topic_allowed(text) from public, anon, authenticated;
grant execute on function app.staff_topic_allowed(text) to authenticated;

drop policy if exists iaq_staffmsg_realtime_read on realtime.messages;
create policy iaq_staffmsg_realtime_read on realtime.messages for select to authenticated
  using (extension = 'broadcast' and (select app.staff_topic_allowed(realtime.topic())));
