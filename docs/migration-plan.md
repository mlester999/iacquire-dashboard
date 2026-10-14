# Supabase migration and rollback plan

Prepared after reviewing the existing migrations, custom and Supabase auth paths, tenant roles,
transaction wrapper, background reconciliation, and integration adapters. This is an extension of
the existing portal. No existing database or external service has been migrated by this work.

## Backup before changes

The source, local configuration, uploaded files and `.data` directory were backed up outside the
workspace to `../iAcquire-backups/iacquire-before-supabase-20261014-102923.tar.gz`.
SHA-256: `45F2A411E007DE78909005C50EC5D2B7127FC14BF7736B8DACC0F6F06ECB210B`.
The archive contains private local configuration; keep it private. This filesystem copy is a
recovery aid, not proof of a transaction-consistent database restore. Before migrating persistent
data, stop portal writes and obtain a logical export plus a tested restore as described in
`supabase-setup.md`. No old passwords, accounts, conversations or company records are deleted.

## Verified starting point

- Next.js 16.3.6; Supabase SSR 0.12.7 and Supabase JS 2.117.3 already installed.
- 159 tests pass in 9 suites before changes (embedded in-memory PostgreSQL; no live services).
- Migrations 0001–0007 contain 51 original tables; 0008 adds 8 setup tables and 0009 adds the
  Auth account migration ledger. Existing foreign keys and tenant constraints are retained.
- Supabase Auth is partially implemented. Production still has a legacy auth escape hatch;
  this will be removed. Local synthetic demos and tests retain an explicit local mode.
- SQL already runs in PostgreSQL. `withUser` sets a transaction-local application identity and
  restricted database role, so existing policy-protected business queries can be preserved.
  `withSystem` is privileged and every user-facing caller must validate authorization.
- Public Data API access is denied by 0009. Narrow JWT policies for private Storage and scoped
  setup updates will be provided; server business queries remain subject to the existing RLS role.
- Setup edits are persisted and transactional. Polling across processes supplements scoped SSE.
- Hermes contract corrections are retained. Unsupported external operations remain agency tasks.

## Additive implementation sequence

1. Preserve and correct fresh Supabase CLI compatibility of the base migrations.
2. Add integration metadata, checks and managed Vault credential references (0010).
3. Harden Supabase identity/configuration and private Storage policies (0011).
4. Add resumable preparation jobs, attempt history and immutable activation reviews (0012).
5. Extend the existing setup template and private setup evidence (0013).
6. Map existing profile IDs to Supabase Auth IDs; retain profile UUIDs and all dependent records.
   Existing scrypt hashes cannot be silently imported; use an audited password reset strategy.
7. Copy private files to tenant-prefixed Supabase buckets and reconcile inventory/checksums.
8. Re-run isolation, auth, adapter, typecheck, lint and build checks locally. Only after explicit
   project authorization apply migrations to a dedicated development Supabase project and run
   live acceptance checks. Production cutover and remote pushes require separate approval.

## Rollback and data preservation

Keep the old application and database offline but recoverable during the cutover. Take a final
write freeze and export before importing; compare every table's row count and critical foreign
keys. Auth mapping and Storage migration do not change original profile or organization UUIDs.
Never reset a persistent Supabase project. Additive tables can remain during code rollback;
export their new records before dropping anything. Restoring the old application after new
portal writes requires a reviewed reverse import, not simply switching connection strings.

The Hostinger appointment PostgreSQL container and n8n internal database remain separate and
untouched. No infrastructure service, workflow, outbound messaging or CRM write is activated.
