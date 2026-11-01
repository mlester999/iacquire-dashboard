-- 0116_chat_message_evidence.sql — a marker on each reply that says what kind of thing the reply is (see src/lib/evidence-class.ts): a model response, a record retrieval, a proposed
-- change, an approved write, a completed action or a system notice. Additive: the column is nullable, a row written before this migration has none, and the interface renders no chip
-- for such a row (it never guesses).
--
-- Prerequisite: 0002_workforce (chat_messages and its role check, which already allows 'assistant' and 'notice'). Nothing else is needed, and no policy or grant changes: the
-- table-wide `grant select, insert ... to iaq_app_user` of 0002 already covers a new column, and the only insert policy (messages_insert) admits role = 'user' rows alone, so a
-- signed-in person can never write an assistant row, with or without a marker. Assistant and notice rows are written by the server (trusted connection) only.
--
--   * Only an 'assistant' or 'notice' row may carry a marker; a 'user' row with one is refused by the table itself.
--   * At most 2 KB, a JSON object, version 1, and one of the six known classes. The detailed shape (areas, ledger) is checked by the application's strict parser on every read.
--   * The check is added NOT VALID and then validated, so the table is not locked against writes for a full scan while it runs.
--
-- Rollback: supabase/rollbacks/0116_chat_message_evidence.down.sql (the marker is derived metadata, so dropping it loses no business record).

alter table public.chat_messages add column if not exists evidence jsonb;

comment on column public.chat_messages.evidence is
  'What kind of reply this is: {"v":1,"class":"model_response|record_retrieval|proposed_change|approved_write|completed_action|system_notice", ...}. Null on a user row and on a row written before 0116. Server-written only.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chat_messages_evidence_shape' and conrelid = 'public.chat_messages'::regclass) then
    alter table public.chat_messages add constraint chat_messages_evidence_shape check (
      evidence is null or (
        jsonb_typeof(evidence) = 'object'
        and pg_column_size(evidence) <= 2048
        and role in ('assistant', 'notice')
        -- coalesce: a missing key reads as null, and a check that evaluates to null passes.
        and coalesce(evidence ->> 'v', '') = '1'
        and coalesce(evidence ->> 'class', '') in ('model_response', 'record_retrieval', 'proposed_change', 'approved_write', 'completed_action', 'system_notice')
      )
    ) not valid;
  end if;
end $$;

alter table public.chat_messages validate constraint chat_messages_evidence_shape;
