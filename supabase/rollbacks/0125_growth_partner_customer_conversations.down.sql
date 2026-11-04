-- Restore the legacy schema safely by moving only Growth Partner widget selections to the previous default.
-- This rollback is for an isolated rehearsal; production migrations require the owner's explicit approval.
update web_chat_widgets
set ai_role_key = 'sales_assistant', updated_at = now()
where ai_role_key = 'growth_partner';

alter table web_chat_widgets
  drop constraint if exists web_chat_widgets_ai_role_key_check;

alter table web_chat_widgets
  add constraint web_chat_widgets_ai_role_key_check
  check (ai_role_key in ('sales_assistant', 'appointment_setter'));

alter table web_chat_widgets
  alter column ai_role_key set default 'sales_assistant';
