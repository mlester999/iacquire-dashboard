-- Rollback for 0115_client_business_credentials.sql. NOT a migration: review, and run in one transaction.
-- Removes the ledger of client business credentials with its guard. REFUSED while any credential is not revoked, so a credential an employee may still present is never silently
-- dropped: end them first (revokeClientBusinessCredentialsForOrg, or switch the client tier off and revoke per employee) and say why in the audit log.

do $$
begin
  if exists (select 1 from agent_business_credentials where status <> 'revoked') then
    raise exception 'Rollback refused: % client business credential(s) are not revoked. Revoke them first.',
      (select count(*) from agent_business_credentials where status <> 'revoked');
  end if;
end $$;

drop trigger if exists agent_business_credentials_guard on agent_business_credentials;
drop function if exists app.guard_agent_business_credential();
drop table if exists agent_business_credentials;
