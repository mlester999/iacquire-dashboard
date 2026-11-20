do $$
begin
  lock table workspace_knowledge_sources, workspace_knowledge_versions in access exclusive mode;
  if exists (select 1 from workspace_knowledge_sources) then
    raise exception 'Rollback refused: workspace knowledge source records exist.';
  end if;
  drop trigger invalidate_workspace_knowledge_grant on workspace_oauth_connections;
  drop function app.invalidate_workspace_knowledge_grant();
  alter table workspace_oauth_connections drop column knowledge_retry_at, drop column grant_revision;
  drop function app.workspace_knowledge_for_partner(uuid, uuid);
  drop table workspace_knowledge_versions;
  drop table workspace_knowledge_sources;
end $$;
