-- Refuse to discard durable connection history. Operator rollback can retain these tables
-- and disable registrations while active grants are reconciled by their owners.
do $$
begin
  lock table workspace_oauth_connections in access exclusive mode;
  if exists (select 1 from workspace_oauth_connections) then
    raise exception 'Rollback refused: workspace OAuth connection records exist.';
  end if;
  drop table workspace_oauth_states;
  drop table workspace_oauth_connections;
end $$;
