-- Rollback for 0063_aqi_phase3_hardening.
--
-- The knowledge history table is dropped. The seeded contact tutorial is restored to v1 only when
-- v2 is still the hardening version and has not been edited. User progress on v2 is preserved but
-- marked unavailable; it is never deleted.

do $$
declare
  v_tutorial_id uuid;
  v1_id uuid;
  v2 aqi_tutorial_versions%rowtype;
begin
  select id into v_tutorial_id from aqi_tutorials where slug = 'create-contact';
  if v_tutorial_id is null then
    drop table if exists aqi_knowledge_versions;
    return;
  end if;

  select * into v2
    from aqi_tutorial_versions
   where tutorial_id = v_tutorial_id and version = 2
   order by version desc limit 1;

  if v2.id is not null
     and v2.status = 'published'
     and v2.notes = 'Completion requires CRM confirmation'
     and v2.definition->'completion'->>'kind' = 'contact_created' then
    select id into v1_id
      from aqi_tutorial_versions
     where tutorial_id = v_tutorial_id and version = 1;
    if v1_id is not null then
      update aqi_tutorial_versions set status = 'archived' where id = v2.id;
      update aqi_tutorial_versions set status = 'published' where id = v1_id;
      update aqi_tutorials
         set published_version_id = v1_id, updated_at = now()
       where id = v_tutorial_id;
      update aqi_tutorial_progress
         set status = 'unavailable', unavailable_reason = 'version_changed', updated_at = now()
       where tutorial_id = v_tutorial_id and tutorial_version <> 1 and status in ('in_progress', 'paused');
    end if;
  end if;
end
$$;

drop table if exists aqi_knowledge_versions;
