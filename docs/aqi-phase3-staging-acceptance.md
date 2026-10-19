# AQi Phase 3 staging acceptance

This is the controlled acceptance procedure for the AQi Phase 3 hardening work. It is a plan, not
evidence that staging has run. Nothing here authorizes a production migration, push or deployment.

## 1. Environment separation

Create a **separate Supabase project** for staging. Never point staging at the production project or
at the n8n appointment database.

| Variable | Staging requirement |
| --- | --- |
| `DATABASE_URL` | Staging Supabase pooled/direct connection; host must match the staging project ref |
| `DATABASE_DRIVER` | `postgres` |
| `AUTH_PROVIDER` | `supabase` (the local synthetic provider is refused in production) |
| `NEXT_PUBLIC_SUPABASE_URL` / publishable key | Staging project |
| Supabase secret key | Staging project only, server-side |
| `CRON_SECRET` | A new random staging value; if omitted the tick endpoint returns 503 |
| `DATABASE_SSL_CA_FILE` | Supabase root CA, so TLS is verified |
| DeepSeek credential | Staging integration row or staging secret; never copy a live key into a document |

Deploy staging as a Vercel Preview/Staging environment with its own domain. Production is a separate
project and must not share the staging database or storage bucket.

## 2. Backup and restore verification

1. Take a fresh backup of the staging database (or the production snapshot used to seed staging) with
   `pg_dump --format=custom --no-owner`.
2. Verify the archive with `pg_restore --list` and record the TOC entry count.
3. Restore it into an empty staging database.
4. Run `npm run db:migrate` and confirm the schema version list is complete.
5. Restore the same archive into a second scratch database and repeat once, proving the procedure is
   repeatable. Do not test restore against production.

## 3. Migration sequence

Hosted production applied `0061` on 2026-10-19 and `0063` later the same day, after explicit
authorization and a fresh backup. The migration set is **0063_aqi_phase3_hardening**:

- `0061` adds the Phase 3 tables, seed library and tips.
- `0063` adds `aqi_knowledge_versions` and publishes a new `create-contact` version whose completion
  is `contact_created`, while archiving the seeded v1. It never mutates v1.
- `0063` depends on `0061`; the runner enforces that prerequisite.
- `0059`, `0060` and `0062` are already applied on production. Do not assume that from numbering:
  read the actual ledger first with a read-only query.
- Apply to staging in order with `npm run db:migrate`; do not use `--only` unless the ledger has been
  inspected and the missing set is known.
- `0063` was applied to production on 2026-10-19 under explicit authorization, after a backup and
  read-only schema verification. A staging copy still needs its own run; do not re-apply it blindly.

Verification after migration:

```sql
select version from schema_migrations order by version;
select count(*) from aqi_tutorials where status = 'published';       -- 16
select count(*) from aqi_tutorial_versions where status = 'published'; -- 16
select count(*) from aqi_contextual_tips;                             -- 6
select relname, relrowsecurity from pg_class
 where relnamespace = 'public'::regnamespace and relname like 'aqi_tutorial%';
select has_table_privilege('iaq_app_user','aqi_knowledge_documents','select'); -- false
select has_table_privilege('iaq_app_user','aqi_knowledge_versions','select');  -- false
```

Rollback `0063` only with `supabase/rollbacks/0063_aqi_phase3_hardening.down.sql`; it preserves
progress and refuses to restore v1 if v2 has been edited. Test it in a transaction or scratch database.

## 4. Storage

- The `company-documents` bucket must exist and be **private**.
- Platform knowledge objects use `platform/aqi/<document-id>/<filename>` and must not be inserted
  into `private_files`; they are not client documents.
- Client-owned `knowledge_documents` and their storage keys must never be visible in AQi Management or
  returned as platform knowledge.
- Upload one PDF, one DOCX, one TXT/CSV/Markdown file. Confirm signature validation, extraction to a
  **draft**, review, publish, retrieval and archive. A failed extraction must leave the entry
  unpublished.
- Confirm an object is not publicly readable without an authorized server path.

## 5. Test tenant and users

Create fictional staging users only:

| User | Role | Purpose |
| --- | --- | --- |
| `aqi-owner@staging.invalid` | Client owner | Contact tutorial, completion proof, cross-tenant denial |
| `aqi-sales@staging.invalid` | Sales rep | Normal tutorial path, tips, resume |
| `aqi-manager@staging.invalid` | Manager | Permission boundary, no platform knowledge |
| `aqi-super@staging.invalid` | Agency Super Admin | Tutorial management, knowledge review/history, Insights |

Do not use real client records. Use a dedicated staging tenant name such as `AQi Staging Tenant`.

## 6. Real provider and chat-to-tutorial acceptance

1. Configure the staging DeepSeek integration and run the provider health check.
2. Sign in as `aqi-sales`. Ask exactly: **“Show me how to create a contact.”**
3. Confirm AQi recognizes the intent, attaches the published `create-contact` guide action, and shows
   a **Show me** action. Opening it must require a click; no navigation may happen automatically.
4. Confirm the spotlight lands on the Contacts navigation item, then New contact, then the real form.
5. Use Next, Back, Pause, Exit and refresh. Confirm progress is stored server-side and resumes at the
   same step.
6. Create a contact yourself. Confirm completion says **Contact created — confirmed by the CRM** only
   after the CRM detail page exists; returning to an old contact or merely opening the list must say
   “not confirmed” and must not complete the tutorial.
7. Replay a `finish` tutorial. Confirm it says **Walkthrough finished**, not “verified”.
8. Repeat with a greeting, an ambiguous request, an archived tutorial slug and a user without the
   tutorial's role. Confirm no guide is offered and no unauthorized route is opened.
9. Simulate a provider failure. Confirm the chat shows a friendly unavailable message and the tutorial
   path is unaffected.
10. Publish a new tutorial version while a person is mid-walkthrough. Confirm the old attempt becomes
    unavailable with a restart option, never silently switching versions.

Record the real model, provider request id, timestamp and outcome. A mock QA provider is not live
acceptance.

## 7. Analytics and Insights

- Seed real staging events by running tutorials, tips, guidance offers, knowledge retrieval/misses,
  feedback and at least one completed contact tutorial.
- Open `/admin/aqi/insights`. Verify every card has a real source and that empty sections say
  “No reliable data for this period”.
- Apply **7/30/90 days** and a custom From/To range. Confirm UTC labels, invalid-range refusal,
  loading state, Reset and organization/role filters.
- Compare a few counts with direct, read-only SQL. Do not accept a fabricated or estimated metric.
- Confirm no conversation text, prompt, answer or free-text feedback comment is rendered.

## 8. Responsive and accessibility acceptance

Run the browser suite against staging with `AQI_QA_URL`, or run the documented manual matrix:

- 1440 px, 1024 px, 768 px and 390 px.
- Spotlight alignment, tooltip/target non-overlap, modal target, bottom sheet, sticky header,
  scrolling and tutorial controls.
- Keyboard only: Tab to Next/Back/Pause/Exit, Enter activation, Escape pause, focus restoration to
  AQi after close.
- Screen reader: announce step changes, completion wording and errors. A manual NVDA/VoiceOver session
  is required; axe alone is not a complete accessibility result.
- Reduced motion, contrast and 200% zoom.

## 9. Security acceptance

- A client owner cannot upload, list, restore or read platform knowledge or another tenant's data.
- A platform document upload stays draft until a Super Admin reviews and publishes it.
- Archived knowledge is not retrieved.
- RLS is enabled on tutorial, progress, preferences, tips, usage and knowledge-history tables.
- The browser cannot grant itself an `iaq_app_user` read on `aqi_knowledge_documents` or
  `aqi_knowledge_versions`.
- Tutorial event retention runs only through the authenticated scheduler; a normal user cannot invoke
  it. Confirm old events are deleted in bounded batches and progress is untouched.

## 10. Promotion

1. Record the staging commit, migration ledger, backup and acceptance evidence.
2. Obtain explicit authorization for the production migration and push.
3. Back up production, apply only the reviewed migration set, verify the schema read-only.
4. Push to `master`; Vercel's Production deployment is triggered by the push. Confirm the deployment
   status is `success` (the earlier `ddd1804` push was verified this way).
5. Smoke test `/api/health`, `/login`, `/admin/aqi`, one tutorial, one knowledge read and Insights.
6. Keep the previous deployment available for rollback. Do not delete production evidence or records.

## External blockers

- No staging Supabase project, staging Vercel environment or staging DeepSeek credential is configured
  in this workspace.
- Production is Vercel-SSO protected, so an authenticated post-deploy browser smoke test cannot be
  performed from this environment.
- A manual screen-reader session has not been performed here.
