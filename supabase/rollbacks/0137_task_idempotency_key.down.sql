do $$
begin
  if exists (select 1 from tasks where idempotency_key is not null) then
    raise exception 'Rollback refused: task idempotency keys exist; export them before rollback';
  end if;
end $$;

drop index tasks_org_idempotency_key;
alter table tasks drop column idempotency_key;
