do $$
begin
  if exists (select 1 from organizations where creation_key is not null) then
    raise exception 'Rollback refused: tenant creation keys exist; export them first';
  end if;
end $$;

drop index organizations_creation_key_unique;
alter table organizations drop column creation_key;
