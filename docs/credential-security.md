# Credential security

New Hermes, GoHighLevel and n8n credentials use **managed Supabase Vault**. The portal calls the official Vault SQL functions on the server. Vault encrypts secrets using authenticated encryption and a Supabase-managed project key outside the database. Portal tables contain UUID references, fingerprints, scope metadata and rotation/revocation timestamps. They contain no new plaintext credential or application-encrypted secret. See [Supabase's Vault documentation](https://supabase.com/docs/guides/database/vault) for its encryption and key portability details.

`SECRET_STORE=vault` is the normal mode. Missing Vault produces a configuration error; the app does not choose weaker storage. `SECRET_STORE=test-memory` is accepted only under `NODE_ENV=test`; it is an explicitly synthetic, ephemeral test adapter, unsuitable for actual credentials. Global server configuration such as `SUPABASE_SECRET_KEY` belongs in secure hosting environment settings.

## Before saving a real credential

1. Connect only the development Supabase project you have approved. Follow `docs/supabase-setup.md`.
2. Enable the supported Supabase Vault extension through that project's dashboard. This repository does not create another secret-management service or change your VPS.
3. Apply migration `0010_secure_integrations.sql`. It closes Vault table/view/function access to browser and application user roles when Vault exists. If Vault is enabled afterward, apply the privilege lockdown shown below again before saving secrets.
4. Keep `vault` out of the Supabase exposed schemas. Only the trusted server connection may resolve secrets. The browser uses the authorized portal API.
5. Use HTTPS for the portal and trusted service gateways. Configure each exact Hermes/n8n host and optional port in `INTEGRATION_ALLOWED_HOSTS`.
6. Use different project keys and provider tokens for development and production. Review database query logging: parameter values and decrypted view contents must not be logged.

Privilege lockdown, run by the authorized project administrator after enabling Vault:

```sql
revoke all on all tables in schema vault from anon, authenticated, iaq_app_user;
revoke all on all functions in schema vault from anon, authenticated, iaq_app_user;
revoke usage on schema vault from anon, authenticated, iaq_app_user;
```

## Access and lifecycle

All configuration, connection tests, rotations and revocations recheck the actor's active database profile and require Agency Super Admin. Staff may inspect safe metadata for clients they are assigned to. Clients cannot read manager tables or credential references. Reference resolution compares both the provider and exact tenant before reading the secret.

The save API never echoes credentials. Password fields clear after submission and close. Existing keys are represented by a non-reversible fingerprint; no reveal control exists. Secrets never belong in URLs, localStorage, analytics, screenshots, tickets, source code or chat. Typed adapters return selected metadata and fixed error summaries. API results are additionally scrubbed if a provider reflects its configured key. Audit records cover saving, rotation, revocation and reference resolution without values.

**Configure / Rotate** saves a new managed reference, revokes the previous portal reference and invalidates health. **Disconnect** immediately blocks portal resolution. These operations do not revoke a token at its upstream provider; finish revocation in that provider's settings. Historical ciphertext/references are preserved for a reviewed retention process. An authorized security administrator can separately remove the revoked Vault secret after retention and rollback needs have been resolved. Deleting the portal record alone is not upstream revocation.

## Migrating earlier encrypted credentials

Earlier releases used `integration_credentials.ciphertext` with an application AES-GCM format. Migration 0010 preserves every existing value. New saves no longer use that mechanism. Production refuses to resolve legacy ciphertext. `ALLOW_LEGACY_CREDENTIAL_READS=true` is only for an explicit local development migration/demo; production rejects it.

Keep a secure backup of the old database **and its original APP_ENCRYPTION_KEY**. Move source data through the explicit application-data migration procedure first. Do not run migrations against your existing embedded directory. On the approved Supabase target, run the counts-only migration first:

```powershell
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/migrate-credentials-to-vault.ts
```

After checking the intended project, Vault configuration and migrated super-admin profile:

```powershell
node --env-file-if-exists=.env.local --conditions=react-server --import tsx scripts/migrate-credentials-to-vault.ts --apply --confirm-project <approved-project-ref>
```

The apply operation creates managed references, rebinds agent/location/connection records and revokes old portal references in one transaction. It retains old ciphertext and requires fresh provider checks. Any unsupported provider or decryption failure aborts the transaction. The script makes no Hermes, CRM or n8n calls. Do not remove the original key until migration and rollback recovery have been tested. Cross-project Vault restores require special key handling described by Supabase; copying encrypted rows is not sufficient.

## Rollback and verification

Prefer rolling back application code while retaining additive metadata. Restoring pre-migration code alone does not understand new reference-only rows. A full rollback requires your verified database backup, original key and corresponding old application version in a development environment. Do not drop credential/reference tables or delete Vault secrets casually.

`tests/integrations-security.test.ts` covers ownership, forged admin claims, RLS restrictions, absent secrets in responses, rotation, revocation and read-only adapters using synthetic data. These tests do not prove an actual Supabase Vault project, its encryption key lifecycle or live provider permissions. Live credential saves remain blocked until an approved development project is connected and tested.
