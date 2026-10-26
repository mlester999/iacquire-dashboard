-- Rollback for 0105_demo_registration_requests.
--
-- The replay ledger is not a record a person owns (two hashes, deleted after a day), so it is dropped with the routing that used it. The first-access guard is removed with the
-- trigger: the service still never moves verified_at or window_ends_at backwards, but a future writer would no longer be stopped by the database. Rolling back therefore means
-- the external registration route must be switched off first (DEMO_REGISTRATION_ENABLED=false), which is what the check below asks for.

do $$
begin
  if exists (select 1 from demo_registration_requests) then
    raise exception 'rollback refused: the registration replay ledger still holds % request(s); wait for the 24-hour sweep or delete them deliberately',
      (select count(*) from demo_registration_requests);
  end if;
end $$;

drop trigger if exists demo_first_access_guard on demo_prospects;
drop function if exists app.demo_first_access_guard();
drop table if exists demo_registration_requests;
