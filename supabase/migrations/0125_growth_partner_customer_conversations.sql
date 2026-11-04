-- Let the single Growth Partner identity handle the existing customer conversation and website chat flows.
-- Existing widget selections remain untouched; a new widget row chooses Growth Partner when the workspace has one.
alter table web_chat_widgets
  alter column ai_role_key set default 'growth_partner';

alter table web_chat_widgets
  drop constraint if exists web_chat_widgets_ai_role_key_check;

alter table web_chat_widgets
  add constraint web_chat_widgets_ai_role_key_check
  check (ai_role_key in ('sales_assistant', 'appointment_setter', 'growth_partner'));
