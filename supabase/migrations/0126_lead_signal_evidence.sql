-- Keep each prospect signal tied to its cited source and a server-recorded research time.
-- The older buying_signals text[] stays intact for compatibility with existing readers.
-- Existing qualification metadata stays NULL: the application derives its display from the legacy
-- evidence rather than writing an inferred qualification result during schema migration.
alter table public.leads
  add column if not exists signal_records jsonb not null default '[]'::jsonb
    check (case when jsonb_typeof(signal_records) = 'array' then jsonb_array_length(signal_records) <= 10 else false end and pg_column_size(signal_records) <= 16384),
  add column if not exists qualification_state text
    check (qualification_state in ('evidence_backed', 'needs_evidence', 'duplicate', 'possible_duplicate')),
  add column if not exists qualification_reasons text[],
  add column if not exists recommended_next_action text
    check (char_length(recommended_next_action) <= 300);

create index if not exists leads_org_qualification_created_idx
  on public.leads (org_id, qualification_state, created_at desc)
  where qualification_state is not null;
