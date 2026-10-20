-- Rollback for 0066_notification_authorization.
--
-- This restores the previous broad read/update policies so the application can be rolled back to the
-- pre-0066 build. It deliberately keeps the audience column and the client associations already
-- backfilled: dropping them would destroy security evidence and make a later re-apply unable to tell
-- historical agency mail from account-level mail. The old policies ignore the column.

drop policy if exists notifications_select on notifications;
create policy notifications_select on notifications for select to iaq_app_user
  using (user_id = app.current_user_id());

drop policy if exists notifications_update on notifications;
create policy notifications_update on notifications for update to iaq_app_user
  using (user_id = app.current_user_id())
  with check (user_id = app.current_user_id());

drop index if exists notifications_user_audience_scope_idx;

revoke all on function app.notification_visible(uuid, text, uuid) from iaq_app_user, service_role;
drop function if exists app.notification_visible(uuid, text, uuid);
