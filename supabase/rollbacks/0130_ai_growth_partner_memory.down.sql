-- Rollback for 0130_ai_growth_partner_memory.sql. Never silently destroy saved workspace memory.
do $$
begin
  if exists (select 1 from public.ai_growth_partner_memories) then
    raise exception 'Rollback refused: AI Growth Partner memory exists. Export or explicitly remove it first.';
  end if;
end $$;

drop table if exists public.ai_growth_partner_memories;
