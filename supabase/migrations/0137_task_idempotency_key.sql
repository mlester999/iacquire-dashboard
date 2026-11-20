alter table tasks
  add column idempotency_key text
  check (idempotency_key is null or char_length(idempotency_key) <= 200);

create unique index tasks_org_idempotency_key
  on tasks (org_id, idempotency_key)
  where idempotency_key is not null;

comment on column tasks.idempotency_key is
  'Optional key for collapsing retries of one logical task creation within a workspace.';
