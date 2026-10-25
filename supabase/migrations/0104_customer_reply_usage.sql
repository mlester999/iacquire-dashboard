-- 0104_customer_reply_usage.sql: AI replies to customers become visible to usage reporting and can be capped.
--
-- A reply the AI employee prepares for a customer (SMS, WhatsApp, email, website chat) started a model run but wrote no usage row, so it never appeared in a workspace's usage, in
-- fair use, or in /admin/usage, and nothing capped it except the credit balance. This adds:
--
--   * usage_events.kind 'customer_reply': one row per reply the employee prepared (with the model's token counts when it reported them);
--   * usage_limits.monthly_customer_replies: an OPTIONAL monthly cap. Null (the default) means nothing is capped and every screen says "No limit set", never "unlimited"; the number is
--     the founder's decision and no value is shipped.
--
-- Nothing here changes who may read usage (the existing policies cover the new kind) and no row is written by the migration.

alter table usage_events drop constraint usage_events_kind_check;
alter table usage_events add constraint usage_events_kind_check check (kind in ('agent_message', 'agent_run_failed', 'lead_research', 'help_request', 'crm_sync', 'customer_reply'));

alter table usage_limits add column monthly_customer_replies integer check (monthly_customer_replies is null or monthly_customer_replies >= 0);
