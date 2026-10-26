# External marketing registration → iAcquireOS demo funnel

Status: **implemented and tested locally; not production-ready until the real sender domain and the hosted migrations are verified.** The separate Next.js marketing website can
now create a pending Demo Prospect through one signed server-to-server call, and the prospect then follows the existing emailed-link flow. No second prospect store, no second
authentication system, no client workspace and no demo clock at registration.

- Endpoint: `POST https://iacquire.online/api/public/demo/register` (source: `src/app/api/public/demo/register/route.ts`)
- Service: `src/server/demo/registration.ts` → `registerProspect` in `src/server/demo/public.ts`
- Verification link: `https://iacquire.online/demo/verify?token=…` (page). The button on that page POSTs to `/api/public/demo/verify`; only that POST consumes the link.
- Demo room: `https://iacquire.online/demo/room`
- Super Admin: `/admin/prospects` and `/admin/prospects/<id>`
- Migration: `0113_demo_registration_requests.sql` (+ rollback)

## What was already there, and what this adds

| Area | Before | This change |
| --- | --- | --- |
| Demo prospect registration | Existing browser form at `/demo` → `registerProspect` | A signed server-to-server route that calls the same service |
| Email verification | Existing one-use, hash-only link (48 h default), capture outbox, `/dev/mailbox` | Branded link now also produced for marketing registrations; same template |
| Demo sessions | Existing `iaq_demo` cookie, hash-only, 7 days | Unchanged |
| Access expiry | Existing 24-hour window from the explicit confirm | A database guard (`0113`) makes `verified_at` immutable and refuses shortening except a deliberate early end |
| Message quota | Existing 10-message allowance, atomic reservation, idempotency key | Unchanged; tested through the signed path |
| Four-step demo room | Existing guided tour, chat and CTAs | Unchanged |
| Demo & Prospects Super Admin | Existing `/admin/prospects` list and detail, extension controls | Unchanged; fields verified; "Create purchase invitation" link added |
| Email provider | Existing `sendEmail` (`capture` or Resend) | Reused; no provider change |
| Consultation booking | Existing `demo_settings.consultationUrl` CTA + `consultation_requested`/`consultation_done` | Unchanged (an approved external scheduler link) |
| Purchase intent | Existing `/admin/purchase-intents`, `/purchase/<token>`, verified payment, workspace creation | The Buy press opens that existing screen pre-filled; no new checkout |
| Rate limiting / audit | Existing `rate_limit_buckets`, `demo_events`, `audit_logs` | Two new buckets; replay ledger; existing timeline records `registered`/`verified` |
| Replay protection for marketing calls | None (no external call existed) | Request id ledger, 24 h, hashes only |

## The HTTP contract

### Request

```
POST /api/public/demo/register HTTP/1.1
Host: iacquire.online
Content-Type: application/json
IACQUIREOS-Request-Id: 5f0c1a2b9d8e4c7fa1b2c3d4e5f60718
IACQUIREOS-Timestamp: 1793002800
IACQUIREOS-Signature: t=1793002800,v1=<64 lowercase hex characters>

{"name":"Maria Santos","email":"maria@santoshome.com","business":"Santos Home Services","industry":"home_services","consent":true,"marketingOptIn":false,"utm_source":"google","utm_campaign":"demo-launch"}
```

| Header | Required | Rules |
| --- | --- | --- |
| `Content-Type` | yes | `application/json` only |
| `IACQUIREOS-Request-Id` | yes | `[A-Za-z0-9_-]{16,64}`, unique per logical request (a UUID without dashes is fine) |
| `IACQUIREOS-Timestamp` | yes | Unix seconds (10 or 13 digits); must equal the `t=` in the signature; within ±`DEMO_REGISTRATION_MAX_SKEW_SECONDS` (default 300) |
| `IACQUIREOS-Signature` | yes | `t=<unix>,v1=<hex>`; more than one `v1` is accepted (rotation) |
| `Origin` | no | If present it must be one of `DEMO_REGISTRATION_ALLOWED_ORIGINS`. A server-to-server call should send none. |

### Signature

```
v1 = HMAC-SHA256(key = DEMO_REGISTRATION_SIGNING_SECRET,
                 message = "<timestamp>.<requestId>.<rawBody>")
```

- Lower-case hex, 64 characters.
- `<rawBody>` is the **exact UTF-8 bytes** sent as the body. Serialize once and sign that same string; do not re-serialize the object.
- The server compares in constant time (`crypto.timingSafeEqual`, equal-length buffers) against every `v1`.
- No secret, authentication header or complete verification URL is logged.

### Body

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | 1–120 characters after cleaning; control and bidi characters removed |
| `email` | yes | A work address; normalized (lower case, plus tag removed, Gmail dots folded) is the one-demo key |
| `business` | yes | 1–160 characters |
| `industry` | yes | One of the demo industry keys (below) |
| `consent` | strongly recommended | `true` = the visitor accepted the notice. **Omitted**: a signed request is treated as the backend's attestation that the form showed the notice and the visitor accepted it; `false` is refused (422, `fields.consent`). The landing page should send `true` explicitly. |
| `marketingOptIn` | no | Boolean |
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `ref` | no | Strings up to 100 characters; only these keys are stored |
| `company_website` | no | Honeypot. A non-empty value is answered as accepted and nothing is stored or sent |

Industry keys: `real_estate`, `healthcare`, `home_services`, `agency`, `consulting`, `legal_finance`, `local_services`, `ecommerce`, `other`.

Body limit: **8192 bytes**. Larger bodies are refused before parsing.

### Responses

Every answer is JSON, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Content-Type-Options: nosniff`.
**No `Access-Control-Allow-*` header is ever sent**: a browser on another site cannot read this endpoint, and no wildcard CORS exists.

| Status | Body | When |
| --- | --- | --- |
| `202` | `{"ok":true}` | Accepted. **Identical** whether the mailbox was new, already known, already inside its window, blocked or on a blocked domain. This is the anti-enumeration answer. |
| `400` | `{"ok":false,"error":{"code":"bad_request","message":"…"}}` | Malformed JSON, or the body is not an object |
| `401` | `{"ok":false,"error":{"code":"unauthorized","message":"This request could not be verified."}}` | Any signature, timestamp or header problem (deliberately one answer) |
| `403` | `{"ok":false,"error":{"code":"origin_forbidden","message":"…"}}` | An `Origin` header that is not configured |
| `405` | same shape, `Allow: POST` | Anything other than POST |
| `409` | `{"ok":false,"error":{"code":"replayed_request","message":"…"}}` | The same request id was used with a different body |
| `413` | `{"ok":false,"error":{"code":"payload_too_large","message":"…"}}` | Over 8192 bytes |
| `415` | `{"ok":false,"error":{"code":"unsupported_media_type","message":"…"}}` | Not `application/json` |
| `422` | `{"ok":false,"error":{"code":"invalid","message":"…"},"fields":{"name":"…","email":"…"}}` | A field is missing or wrong; `fields` keys are `name`, `email`, `business`, `industry`, `consent` |
| `429` | `{"ok":false,"error":{"code":"rate_limited","message":"…"}}` + `Retry-After` | A limit below was reached |
| `503` | `{"ok":false,"error":{"code":"unavailable"}}` or `code:"capacity"` + `Retry-After` | Demo off / emergency stop / email provider failed / the platform's daily demo cap is used |

### Idempotency, retries and timeouts

- The request id is written to `demo_registration_requests` **before** any email is sent, and marked complete only when the registration was accepted.
- A retry with the **same id and same body** answers `202` without another email. A retry with the same id and a different body answers `409`.
- A claim that never completed (the process died between the claim and the email) is taken over after **two minutes**, so a retry with the same id is not lost. A fresh
  unfinished claim is treated as another copy of the same request already in flight and answered `202`.
- A request that was refused, or that failed transiently, gives the id back, so it can be retried unchanged.
- The backend sends the verification email before it answers. With the capturing provider the answer is immediate; with Resend the provider call has a 10 s ceiling, so the landing
  page's 8000 ms timeout can occasionally expire while the registration still succeeds. **Retry with the same request id**; the retry is safe and sends nothing twice.
- Backend limits (PostgreSQL fixed windows, shared across instances):
  - per mailbox: 3 registrations/hour (`demoStartByEmail`)
  - per signed caller: 240/minute (`demoRegisterByCaller`)
  - per marketing server address: 120/minute (`demoRegisterByIp`)
  - the platform's daily demo starts (`demo_settings.daily_start_cap`, default 50)
- The landing page's own `DEMO_RATE_LIMIT_MAX=5` / `DEMO_RATE_LIMIT_WINDOW_MS=60000` remains its visitor-facing limit. It is independent of these.

## Verification link and the 24-hour rule

1. Registration stores a pending prospect: `status = unverified`, `verified_at = null`, `window_ends_at = null`, `message_limit = 10`. No session, user, workspace, invitation
   or organization is created.
2. The email contains `https://iacquire.online/demo/verify?token=<43-char token>`. Only `sha256(token)` is stored; the token lives `DEMO_VERIFICATION_TTL_HOURS`
   (1–168, 48 by default), independently of the demo window.
3. **Opening the link (GET) changes nothing.** It reads whether the link is good and shows one button. A mail scanner that follows links cannot consume it.
4. Pressing the button POSTs the token in the body to `/api/public/demo/verify` (same-site form). That transaction locks the link, uses it once, writes `verified_at = now` and
   `window_ends_at = verified_at + 24 hours` from the copied settings, and starts the prospect's own `iaq_demo` session cookie.
5. The clock is never reset by refresh, login, a repeat verification, a resend, a new device, an extension or a conversion. Migration `0113` adds a database trigger that refuses
   any change to `verified_at`, any null window, and any shortening of `window_ends_at` while the demo is still active. A Super Admin's early end keeps the prospect's
   expired/consultation/purchase status and is allowed.
6. Link expiry (`DEMO_VERIFICATION_TTL_HOURS`, 48 by default) and demo expiry (24 h from first entry) are independent. A link that expires before use leaves the prospect
   unconfirmed; asking again issues a new link.
7. After expiry the room is read-only (the stored conversation remains), the chat refuses with `window_ended` server-side, a return link is not sent, and the consultation CTA
   still works.

Return access inside the window uses a fresh `return` link (`requestReturnLink`, or registering the same mailbox again): it starts a new session, never a new window. The prospect
never has to keep the one-use verification token.

## Super Admin and conversion

`/admin/prospects` shows name, work email, business, industry, status, first access (`verified_at`), window end, messages used/allowance, consultation requested/held and
"Pressed Buy now". `/admin/prospects/<id>` adds the timeline and the existing extension controls (hours, extra messages, reason, caps).

The two CTAs stay the existing ones:

- **Book a free consultation** → `demo_settings.consultationUrl` (an approved https scheduler link) and `consultation_requested_at`.
- **Purchase iAcquireOS** → `purchase_started_at`; the prospect screen then links to `/admin/purchase-intents?prospect=<id>`, which pre-fills the existing purchase-invitation form.
  The existing service freezes US$1,499, creates `/purchase/<token>`, verifies the payment (PayMongo's signed notice or a Super Admin's checked evidence) and only then, through
  `createClientTenant`, creates the workspace. The demo creates no checkout, takes no payment and grants no workspace.

Separation is unchanged: a prospect is never a user; the demo tables grant nothing to any application, Data API or site role; the only door to a client workspace remains the
explicit conversion/purchase path.

## Cross-domain security

- HTTPS only in staging and production (`DEMO_REGISTRATION_ALLOWED_ORIGINS` refuses non-https except localhost outside production).
- The shared secret lives only on the marketing server and the iAcquireOS server. It is never a `NEXT_PUBLIC_*` value and never reaches a browser.
- No CORS header. The endpoint is for a server; a browser call from another origin is refused (`403`) if it reaches the handler at all.
- The application creates its own session after verification (`iaq_demo`, HttpOnly, SameSite=Lax, Secure in production). No marketing-domain cookie is set or read.
- The confirmation is a state-changing POST with the token in the body; the GET only reads. Safe redirects are relative (`/demo/room`), never attacker-supplied.
- Replay: bounded 24-hour ledger, 5-minute clock window. Tokens, secrets and full verification URLs are not logged.

## Environment contract

Never commit a real secret and never paste one into a chat. Generate the shared value once per environment, for example with `openssl rand -hex 32`, and store it in both hosts'
secret stores. Rotating it means updating both sides together (old signatures stop working immediately).

### Marketing website (Next.js)

```dotenv
# Public site address of the marketing site itself.
NEXT_PUBLIC_SITE_URL=https://www.iacquire.online

# The application's origin (the only place the demo lives).
NEXT_PUBLIC_APP_ORIGIN=https://iacquire.online

# The real endpoint (server-only use; the value is not secret).
IACQUIREOS_DEMO_REGISTER_URL=https://iacquire.online/api/public/demo/register

# SERVER-ONLY. Must equal the backend's DEMO_REGISTRATION_SIGNING_SECRET. 32+ random characters.
IACQUIREOS_BACKEND_SIGNING_SECRET=<shared secret>

DEMO_REGISTRATION_MODE=backend
DEMO_RATE_LIMIT_MAX=5
DEMO_RATE_LIMIT_WINDOW_MS=60000
DEMO_REGISTRATION_TIMEOUT_MS=8000
```

Local values: `NEXT_PUBLIC_APP_ORIGIN=http://localhost:3100` and
`IACQUIREOS_DEMO_REGISTER_URL=http://localhost:3100/api/public/demo/register`; use a local-only secret. Staging: the staging app origin and a staging-only secret. Production: as
above, with a production secret generated in the host and the Resend sender verified.

Only `IACQUIREOS_BACKEND_SIGNING_SECRET` needs filling in beyond the two origins; `DEMO_REGISTRATION_MODE`, the two rate-limit values and the timeout stay as they are.

### Vercel projects — complete checklist

Two Vercel projects, two environments. The shared secret is the **same value in both projects**, but it is set only in the server scope: never `NEXT_PUBLIC_*`, never
"Automatically expose System Environment Variables". Existing database, Supabase, scheduler and provider variables are unchanged and are not repeated here.

| Variable | Landing project | Backend project | Production | Staging | Local |
| --- | --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | set (public) | — | `https://www.iacquire.online` | `https://staging.iacquire.online` (or the Vercel preview URL) | `http://localhost:3000` |
| `NEXT_PUBLIC_APP_ORIGIN` | set (public) | — | `https://iacquire.online` | `https://staging.iacquire.online` | `http://localhost:3100` |
| `IACQUIREOS_DEMO_REGISTER_URL` | set (server use) | — | `https://iacquire.online/api/public/demo/register` | `https://staging.iacquire.online/api/public/demo/register` | `http://localhost:3100/api/public/demo/register` |
| `IACQUIREOS_BACKEND_SIGNING_SECRET` | **set, Sensitive** | — | `<32+ random chars>` | a different staging secret | a local-only secret |
| `DEMO_REGISTRATION_MODE` | set | — | `backend` | `backend` | `backend` |
| `DEMO_RATE_LIMIT_MAX` | set | — | `5` | `5` | `5` |
| `DEMO_RATE_LIMIT_WINDOW_MS` | set | — | `60000` | `60000` | `60000` |
| `DEMO_REGISTRATION_TIMEOUT_MS` | set | — | `8000` | `8000` | `8000` |
| `APP_URL` | — | set | `https://iacquire.online` | `https://staging.iacquire.online` | `http://localhost:3100` |
| `DEMO_ENABLED` | — | set | `true` only after approval | `true` | `true` |
| `DEMO_PUBLIC_DISABLED` | — | set | `false` | `false` | `false` |
| `DEMO_REGISTRATION_ENABLED` | — | set | `true` only after approval | `true` | `true` |
| `DEMO_REGISTRATION_SIGNING_SECRET` | — | **set, Sensitive** | same value as the landing project | same staging value | same local value |
| `DEMO_REGISTRATION_ALLOWED_ORIGINS` | — | set | `https://www.iacquire.online` | the staging marketing origin | empty (server-to-server) |
| `DEMO_REGISTRATION_MAX_SKEW_SECONDS` | — | set | `300` | `300` | `300` |
| `DEMO_VERIFICATION_TTL_HOURS` | — | set | `48` | `48` | `48` |
| `EMAIL_PROVIDER` | — | set | `resend` after domain verification | `capture` until the staging domain is verified | `capture` |
| `EMAIL_FROM` | — | set | `iAcquire <no-reply@iacquire.online>` | the verified staging sender | `iAcquire <no-reply@example.test>` |
| `RESEND_API_KEY` | — | **set, Sensitive** | production key | staging key | empty |

Vercel notes: set each variable for the Production, Preview and Development scopes deliberately (a Preview deployment must not point at the production backend). Mark the two
secrets as **Sensitive**; a Vercel "Sensitive" value cannot be read back after saving, so store the generated value in the password manager first. Redeploy after changing any
value; Vercel does not hot-reload environment variables. `NEXT_PUBLIC_*` values are visible in the browser bundle — never put a secret there.

### Resend sender-domain requirements

The email service is the existing `src/server/email.ts` (Resend over HTTPS, `EMAIL_PROVIDER=resend`). Before a single real prospect email may be sent:

1. **Use a dedicated sending subdomain**, for example `mail.iacquire.online` or `send.iacquire.online`, not the root domain. Keeps the root's reputation separate and makes the
   records auditable. `EMAIL_FROM` must use that exact subdomain.
2. **Add the records Resend shows for that domain**, typically:
   - `MX  send.<domain>  10  feedback-smtp.<region>.amazonses.com` (bounce/complaint return path),
   - `TXT send.<domain>  v=spf1 include:amazonses.com ~all` (SPF),
   - `TXT resend._domainkey.<domain>  p=<the DKIM public key from the dashboard>` (DKIM),
   - `TXT _dmarc.<domain>  v=DMARC1; p=none; rua=mailto:dmarc@iacquire.online` (start at `p=none`, then tighten).
   Use the **exact** host, priority and values in the Resend dashboard for the chosen region; do not copy a generic value from a blog.
3. **Verify the domain in Resend** until it reads `verified`, and confirm the DKIM selector resolves (`dig TXT resend._domainkey.<domain>`).
4. **API key:** a sending-only key, stored as `RESEND_API_KEY` in the backend Vercel project (Sensitive), never in the landing project. A restricted key limits the blast radius
   if the backend is compromised.
5. **From/reply-to:** `EMAIL_FROM` must match the verified domain exactly (`iAcquire <no-reply@mail.iacquire.online>`). Do not use `onboarding@resend.dev`, a personal address, or
   an unverified root-domain sender in production.
6. **Test before launch:** send to a controlled mailbox, inspect `Authentication-Results` for `spf=pass`, `dkim=pass`, `dmarc=pass`, and check the link host is
   `https://iacquire.online` (not a Vercel preview host). Then run the staging E2E below.
7. **Webhook (optional):** `/api/webhooks/resend` is only needed for delivery/bounce events; then set `RESEND_WEBHOOK_SECRET` (`whsec_…`). Sending does not require it.
8. **Until all of the above is verified**, keep `EMAIL_PROVIDER=capture` in staging and production. A captured email is stored in `email_outbox`; the E2E can read it, and no
   prospect receives anything.

### iAcquireOS

```dotenv
# The public origin used in emails and links. This must be https://iacquire.online in production.
APP_URL=https://iacquire.online

# The demo's own switch and emergency stop (existing).
DEMO_ENABLED=true
DEMO_PUBLIC_DISABLED=false

# The signed marketing door.
DEMO_REGISTRATION_ENABLED=true
DEMO_REGISTRATION_SIGNING_SECRET=<same shared secret>
# The marketing site's own https origin(s), comma-separated. Leave empty for a strictly server-to-server call.
DEMO_REGISTRATION_ALLOWED_ORIGINS=https://www.iacquire.online
DEMO_REGISTRATION_MAX_SKEW_SECONDS=300
# How long the emailed link works. 1 to 168 hours; 48 by default. Independent of the 24-hour demo window.
DEMO_VERIFICATION_TTL_HOURS=48

# The existing email service. In local development/testing keep capture and read /dev/mailbox.
EMAIL_PROVIDER=resend
EMAIL_FROM=iAcquire <no-reply@iacquire.online>
RESEND_API_KEY=<server-only Resend key>
```

Sender-domain requirement: see **Resend sender-domain requirements** above. Until the domain is verified, keep `EMAIL_PROVIDER=capture` and do not promise deliverability.

The Super Admin's own demo settings must also be on, with `windowHours = 24`, `messageLimit = 10` and a `consultationUrl`: `/admin/prospects/settings`.

## Migration reconciliation (2026-10-26)

The demo migration was first written as `0105_demo_registration_requests`. That number is not safe: the AI Workforce work on the integration candidates uses `0105`–`0109`,
and the release-candidate branch also carries `0110`–`0112`. More importantly, numbers alone are not the contract. The runner records only the **four-digit prefix** in the
Supabase CLI ledger (`supabase_migrations.schema_migrations`) and treats a local file as applied when its prefix is present, so two files sharing a prefix let the second be
skipped silently. `tests/migration-prefixes.test.ts` fails on a duplicate prefix for exactly that reason. The demo migration is therefore **`0113`**, a prefix unused on every
local branch and tag at the time of the audit.

| Evidence (local git only; no hosted database was queried) | Result |
| --- | --- |
| `feat/external-demo-registration` before reconciliation | 99 migration files, last `0105_demo_registration_requests` |
| `codex/iacquire-release-reconcile` (candidate base) | 104 migration files, last `0109_employee_health_probe` |
| `integrate/phases-3-7-workforce` / tag `rc-2026-10-26` | 107 migration files, last `0112_client_content_policy` |
| `0100`–`0109` on the candidate vs the RC branch | byte-identical (same git blob SHA for every file) |
| `0110`–`0112` | only on the RC branch; **not** part of this candidate |
| `0113` | unused on every ref before this change |
| Production ledger, as recorded in `docs/ai-employee-execution-foundation.md` on the candidate | 98 entries through `0104_customer_reply_usage`; `0084` and `0105`–`0109` pending; `0110`–`0113` absent |
| Checksums stored by the ledger | **none**: the runner stores versions only, so file identity is a git-blob audit, not a database checksum |

Content hashes (SHA-256) of the files that matter here, read from the refs with `git show`:

| File | SHA-256 |
| --- | --- |
| `0100_demo_funnel.sql` | `9c45a4225c3de485a66d7113fcb129d3a9e128917126559ae883abe82e3a8b4a` |
| `0105_workforce_local_recurrence.sql` | `f20dd5b96107ada7d100fa66469d1e5de7b33249b99e035b5358bcfd8d3a04bb` |
| `0109_employee_health_probe.sql` | `d2099c82007007d00ffc468159d40657197824edf4a578b3e57f2265e9be9ee0` |
| `0113_demo_registration_requests.sql` | `2807e1c38066f79cdd7c9e4b904a3f6d8b96f361279aa83d9b7f9f87609e1edb` |
| old `0105_demo_registration_requests.sql` (on `feat/…`) | `2807e1c38066f79cdd7c9e4b904a3f6d8b96f361279aa83d9b7f9f87609e1edb` (identical: renumber only) |
| `0110`–`0112` (RC branch only) | `53087c55…`, `acec921e…`, `61d6958b…` |

Consequences: `0100_demo_funnel` is already in the recorded production ledger; `0113` is the only new file this candidate adds on that line. If the RC branch's `0110`–`0112`
are later brought in, they must be reviewed and applied as their own step; they do not collide with `0113`. Do not apply `0105`–`0109` from this candidate unless the workforce
release is approved, and never apply a second file with an already-used prefix.

## Required migrations

| Migration | Needed for | Applied to a hosted database? |
| --- | --- | --- |
| `0100_demo_funnel.sql` | The demo itself (existing) | **Yes, per the recorded ledger** (through `0104`); not re-queried here |
| `0113_demo_registration_requests.sql` | The replay ledger and the first-access guard | **No** |

`0113` is additive: one server-only table (`request_id_hash`, `body_sha256`, `received_at`, `completed_at`; RLS on, no grant, no policy), one index, one trigger function
(`app.demo_first_access_guard`) and its trigger. Rollback: `supabase/rollbacks/0113_demo_registration_requests.down.sql`. It refuses while the ledger holds rows; switch
`DEMO_REGISTRATION_ENABLED` off and let the 24-hour sweep clear them first.

Run `node scripts/rehearse-combined-migrations.mjs` on a scratch database before applying anything. Do not apply a hosted migration without approval.

## Staging deployment and E2E

Nothing in this section has been performed against a hosted database or a real provider; it is the approved sequence for when staging access is granted.

### 1. Read the ledger before changing anything (read-only)

```sql
-- The application ledger (full versions)
select version, applied_at from public.schema_migrations order by version;

-- The Supabase CLI ledger, if the project has one (prefix-only versions)
select version, name from supabase_migrations.schema_migrations order by version;
```

Expected baseline, from the candidate's own recorded production preflight: 98 application rows through `0104_customer_reply_usage`; `0084`, `0105`–`0109` pending; `0110`–`0112`
absent; `0113` absent. If the CLI ledger already contains `0113`, **stop**: a prefix with no recorded file means a manual migration used that number.

### 2. Deploy the candidate with the demo still closed

Deploy the reconciliation commit to a Vercel **Preview/Staging** project with `DEMO_REGISTRATION_ENABLED=false` and `DEMO_ENABLED=false`. The new route then answers `503`, and
nothing can send email while the schema is being applied.

### 3. Apply the migrations one at a time

The candidate carries the workforce migrations too. In order, on staging only, with a verified backup and approval:

```bash
npm run db:migrate -- --dry-run
npm run db:migrate -- --only 0084_restricted_hermes_provisioner
npm run db:migrate -- --only 0105_workforce_local_recurrence
npm run db:migrate -- --only 0106_workforce_chat_schedule_previews
npm run db:migrate -- --only 0107_workforce_chat_booking_previews
npm run db:migrate -- --only 0108_workforce_appointment_changes
npm run db:migrate -- --only 0109_employee_health_probe
npm run db:migrate -- --only 0113_demo_registration_requests
```

After each step, check `select version from public.schema_migrations order by version` and the CLI ledger prefix, then run the read-only preflight
(`node --env-file=.env --conditions=react-server --import tsx scripts/production-activation-preflight.ts --live`) and confirm no `prefixCollisions`. Do **not** apply `0110`–`0112`
from this candidate; they exist only on the release-candidate branch and need their own review.

`0084` is included in this candidate even though production does not have it. Its rollback refuses while active Hermes provisioning jobs exist; the combined rehearsal on the
candidate (and on its base commit, without `0113`) reports the same 0084-related D/E/F failures. That is a pre-existing release-gate issue with the candidate's 0084/ledger
expectations, not a defect in `0113`; it must be resolved before any production apply.

### 4. Turn on the demo, still without live email

1. `/admin/prospects/settings`: demo on, AI chat on only if a model is connected, `windowHours=24`, `messageLimit=10`, an approved `consultationUrl`.
2. Set `EMAIL_PROVIDER=capture`, `DEMO_ENABLED=true`, `DEMO_REGISTRATION_ENABLED=true`, the staging secret and the staging marketing origin, then redeploy.
3. Run the E2E below.

### 5. The safe staging E2E

`scripts/staging-demo-e2e.mjs` (also `npm run demo:e2e:staging`) drives the real staging app and covers registration → captured email → GET twice → explicit first entry →
exactly-24-hour timestamps → ten messages → server-side expiry → cleanup.

```bash
E2E_CONFIRM=staging \
E2E_ALLOWED_HOSTS=staging.iacquire.online \
E2E_BASE_URL=https://staging.iacquire.online \
IACQUIREOS_E2E_SIGNING_SECRET=<the staging shared secret> \
E2E_EMAIL_DELIVERY=capture \
E2E_EMAIL_SOURCE=db \
E2E_DATABASE_URL=<staging read/write URL, used only for the synthetic prospect> \
E2E_AI_MESSAGES=allow \
node scripts/staging-demo-e2e.mjs --allow-db-write --cleanup --report .data/e2e/staging-demo.json
```

What it asserts:

| Step | Assertion |
| --- | --- |
| 1 | the landing page's own route (`--via-landing https://…/api/demo-register`) or the backend accepts the signed registration; `202 {"ok":true}` |
| 2 | a `demo_link` email exists for the synthetic `@example.test` address and carries a 43-character token |
| 3 | two GETs of `/demo/verify?token=…` both show the button; the database still says `unverified`, `verified_at` and `window_ends_at` null |
| 4 | the explicit POST returns a session cookie; the room is open with `messagesLeft=10`; `window_ends_at - verified_at = 86,400,000 ms` |
| 5 | ten messages are accepted, the eleventh is `limit_reached`, and `messages_used=10` (needs `E2E_AI_MESSAGES=allow`; this calls the real staging model and costs money) |
| 6 | after a scoped update of that one synthetic prospect to an ended window, `/history` reads `ended` and a message is refused `window_ended` |
| 7 | `--cleanup` removes only that address's `demo_prospects` row (cascades) and its `demo_link` outbox rows |

Safety rails, enforced before the first request: production hosts are refused outright; the host must be in `E2E_ALLOWED_HOSTS`; `E2E_CONFIRM=staging`; the secret must be 32+
characters; live email needs `E2E_EMAIL_DELIVERY=live` **and** `E2E_ALLOW_LIVE_EMAIL=true`; every database write needs `--allow-db-write`; tokens, cookies, the secret and full
links are never printed; the address is always `@example.test`; a dry run (`--dry-run`) prints the plan without contacting anything.

`--allow-db-write` moves the clock only for that synthetic prospect, using the documented early-end state (`status='expired'`, `window_ends_at` in the past) — not a backdoor in
the application. It cannot be used without the staging database URL, and it never touches another row.

## Landing-page patch

The marketing repo has no signed sender yet in this workspace. Add this server route and call it from the form. It keeps the secret on the server and signs the exact body.

```ts
// app/api/demo-register/route.ts (Node runtime; never import this from a client component)
import crypto from "node:crypto";

export const runtime = "nodejs";

const ENDPOINT = process.env.IACQUIREOS_DEMO_REGISTER_URL;
const SECRET = process.env.IACQUIREOS_BACKEND_SIGNING_SECRET;
const TIMEOUT_MS = Number(process.env.DEMO_REGISTRATION_TIMEOUT_MS ?? 8000);

function sign(timestamp: string, requestId: string, rawBody: string) {
  return crypto.createHmac("sha256", SECRET!).update(`${timestamp}.${requestId}.${rawBody}`).digest("hex");
}

export async function POST(request: Request) {
  if (!ENDPOINT || !SECRET) return Response.json({ ok: false, error: "not_configured" }, { status: 500 });
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return Response.json({ ok: false, error: "invalid" }, { status: 400 });

  // Serialize ONCE. This exact string is what is signed and sent.
  const rawBody = JSON.stringify({
    name: input.name,
    email: input.email,
    business: input.business,
    industry: input.industry,
    consent: input.consent === true,
    marketingOptIn: input.marketingOptIn === true,
    utm_source: input.utm_source,
    utm_medium: input.utm_medium,
    utm_campaign: input.utm_campaign,
    utm_content: input.utm_content,
    utm_term: input.utm_term,
    ref: input.ref,
    company_website: input.company_website,
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = crypto.randomUUID().replace(/-/g, "");
  const attempt = () =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "iacquireos-request-id": requestId,
        "iacquireos-timestamp": timestamp,
        "iacquireos-signature": `t=${timestamp},v1=${sign(timestamp, requestId, rawBody)}`,
      },
      body: rawBody,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });

  let response: Response;
  try {
    response = await attempt();
  } catch {
    // One safe retry: the same id and body can never send a second email.
    try {
      response = await attempt();
    } catch {
      return Response.json({ ok: false, error: "unavailable" }, { status: 504 });
    }
  }

  if (response.status === 202) return Response.json({ ok: true });
  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as { fields?: Record<string, string> };
    return Response.json({ ok: false, error: "invalid", fields: body.fields ?? {} }, { status: 422 });
  }
  if (response.status === 429) return Response.json({ ok: false, error: "rate_limited" }, { status: 429 });
  return Response.json({ ok: false, error: "unavailable" }, { status: 502 });
}
```

The form must show the demo notice (link it to the application's notice) and send `consent: true` only when the visitor accepted it. Set `runtime = "nodejs"`: `node:crypto` is not
available on the edge runtime. Never expose the secret through a `NEXT_PUBLIC_*` variable.

## Tests

Run from the repository root:

```
npx vitest run tests/demo-                          # 19 files, 486 tests
npx vitest run tests/demo-external-registration.test.ts tests/demo-registration-migration.test.ts
npx vitest run tests/migration-prefixes.test.ts
npx tsc --noEmit
```

`tests/demo-external-registration.test.ts` (25 tests) covers: accepted signed registration; the exact response JSON; no cross-domain readable headers; no address, id, token or
masked address in any answer; wrong secret / tampered body / malformed signature / missing header / stale and future timestamp; disabled switch and emergency stop; wrong media
type; oversized body; malformed JSON; field errors; forbidden and allowed origins; duplicate mailbox (one prospect, no reset, return link, `firstTime: false`); request-id
idempotency and conflict; crash recovery (a claim older than two minutes is taken over, a fresh one is answered without a second send); id release after a refusal; per-mailbox
and per-caller limits; blocked domain answered as accepted with no email; GET does not consume or start; exactly
one 24-hour window; single use; expired link; four simultaneous confirms produce one session and one window; ten messages across a new device/session and an eleventh refused;
server-side refusal at the exact 24-hour mark with the consultation still available; both CTAs recorded once; Super Admin list/detail fields; extension without moving first
access; no organizations, memberships, invitations or auth sessions; no logging; GET refused.

`tests/demo-registration-migration.test.ts` (9 tests) covers: RLS on with no policy, no grant to `public`/`anon`/`authenticated`/`iaq_app_user`/`iaq_site_runtime`; hash-only
columns; one row per request id; index and timestamp; `verified_at` immutable; window not removable or shortest except a deliberate early end; the rest of a prospect's life still
works; rollback refuses with rows and otherwise drops exactly the ledger, trigger and function.

The full demo suite (`tests/demo-*`, 486 tests) still passes, including the existing browser-form registration, chat, generator, retention, jobs, admin, isolation and page tests.

Migration rehearsal on the reconciliation branch (`reconcile/external-demo-registration`, 105 files, 0001..0113, gaps 0053, 0073–0076, 0110–0112): the chain has **no duplicate
number** (105 files, every number used once). What each section showed:

- **A** failed one stale expectation: it expects 80 files at `0086`, and this candidate's `0084` makes 81.
- **B and C passed**: the fresh chain applies all 105 files in order; after each of the 34 steps from 0077 the schema equals the fresh chain (674,188 facts compared).
- **D** failed on the candidate's pre-existing `0084` rollback guard (“finish or cancel active Hermes provisioning jobs”), which then cascades into 19 later comparisons. The
  **identical 20 failures** occur on the base commit `0534ccb9` without `0113`.
- **E** failed on its “0084 is reserved/absent” scenarios because `0084` is a normal file in this candidate; the **identical 5 failures** occur on the base.
- **F** failed its “ledger at `0086` has 80 rows” expectation (81 here); the **identical 2 failures** occur on the base.
- **`0113` itself is clean**: applied in 5 ms, one new table with RLS and no grants, the schema equals the fresh chain, rolled back in 799 ms to exactly the schema recorded before
  it, and all 8,036 earlier rows unchanged. The ledger then reads 105 rows ending `0113_demo_registration_requests`.

Those D/E/F failures are a release-gate problem with the candidate's `0084`/ledger expectations, not a defect introduced by the demo migration; they must be resolved before
any production apply. The renumbering itself is content-preserving: the SHA-256 of `0113_demo_registration_requests.sql` is identical to the old `0105_demo_registration_requests.sql`.

### Browser QA (isolated app, capturing email, made-up model)

These runs were made on `feat/external-demo-registration` at `c1f300d2`. They were **not re-run on the reconciliation commit** (`reconcile/external-demo-registration`), whose only
difference in the demo area is the migration number and the 253-commit integration base; re-running desktop and mobile QA is an explicit outstanding gate below.

- Desktop: `node scripts/wave2-demo-qa.mjs` at 1280 px drove settings → request → captured email → link twice (a scanner opens it) → button → room → ten messages and the refusal → return → CTAs → Super Admin → extension → early end → reopen → consultation held → not a fit. It recorded **34 of 36 checks passing**, 0 page errors, 0 server errors and 0 external requests, with 12 screenshots in `.data/wave2-qa/`.
  - The two checks that did not pass are harness false negatives, not funnel failures: the transcript check lost its panel to a Next.js Fast Refresh full reload, while `readTranscriptAction` returned 200 and the next check (a "read the conversation" timeline line) passed; the "not a fit" check inspected only the first 300 characters of the page (navigation), while `declineProspectAction` returned 200 and the status was written. Both checks should be tightened before they are quoted as a gate.
  - The console errors are the deliberate 429s from the six-a-minute message test, as designed.
- Mobile: `node scripts/wave2-demo-mobile-qa.mjs` at 375 × 812 **passed 12 of 12 checks**: the request page, the confirmation page (including a second GET that did not use the link) and the room have no horizontal overflow and no serious/critical axe violations, the form and its button are visible, and the entry button opens the room. Screenshots: `demo-mobile-form.png`, `demo-mobile-verify.png`, `demo-mobile-room.png`.

### Not tested here

- A real Resend send, SPF/DKIM/DMARC, and a real prospect address. The capturing outbox is what the tests read.
- Applying `0113` to the hosted database. Only the embedded Postgres used by the suite ran it; `0100` is recorded as already applied through `0104`, not re-queried here.
- The staging E2E (`scripts/staging-demo-e2e.mjs`): written and dry-run checked, never run against staging (no staging access or approval).
- Browser QA on the reconciliation commit (the earlier desktop/mobile evidence is from `c1f300d2`).
- A browser talking to the *signed marketing endpoint* through the real landing page: the landing page does not exist in this workspace. The browser runs above drive
  `/demo`, the emailed link and the room, which are the screens the signed registration sends a prospect to; they are unchanged by this work.
- Production rate-limit behavior under real multi-connection load; the suite runs one embedded connection.

## Not production-ready until

1. The candidate's pre-existing `0084`/rehearsal failures (sections A, D, E, F) are resolved or explicitly waived; this is independent of `0113` but blocks the release gate.
2. `0113` is reviewed and applied to staging, then production, after the approved sequence (with a verified backup and `--dry-run`). `0100` is already in the recorded ledger.
3. Resend's sending subdomain is verified (SPF, DKIM, DMARC) and a test message reaches a controlled inbox.
4. Both Vercel projects hold the same generated secret, `DEMO_REGISTRATION_ENABLED=true`, and `APP_URL=https://iacquire.online`.
5. The landing page's server route is deployed and the staging E2E (`scripts/staging-demo-e2e.mjs`) passes at least once, including the ten-message and expiry steps.
6. Desktop and mobile browser QA is re-run on the reconciliation commit.
