-- Keep evidence-backed exclusions distinct from duplicates and evidence gaps.
-- This is an additive constraint update; existing lead history is preserved.
alter table public.leads
  drop constraint if exists leads_qualification_state_check;

alter table public.leads
  add constraint leads_qualification_state_check
  check (qualification_state in ('evidence_backed', 'needs_evidence', 'duplicate', 'possible_duplicate', 'disqualified'));
