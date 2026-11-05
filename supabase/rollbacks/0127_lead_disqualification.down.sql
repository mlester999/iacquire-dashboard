-- Restore the qualification states accepted before the disqualification feature.
alter table public.leads
  drop constraint if exists leads_qualification_state_check;

alter table public.leads
  add constraint leads_qualification_state_check
  check (qualification_state in ('evidence_backed', 'needs_evidence', 'duplicate', 'possible_duplicate'));
