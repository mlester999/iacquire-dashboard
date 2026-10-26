# External marketing registration → iAcquireOS demo funnel

Status: **implemented and tested locally; not production-ready until the real sender domain and the hosted migrations are verified.** The separate Next.js marketing website can
now create a pending Demo Prospect through one signed server-to-server call, and the prospect then follows the existing emailed-link flow. No second prospect store, no second
authentication system, no client workspace and no demo clock at registration.

- Endpoint: `POST https://iacquire.online/api/public/demo/register` (source: `src/app/api/public/demo/register/route.ts`)
- Service: `src/server/demo/registration.ts` → `registerProspect` in `src/server/demo/public.ts`
- Verification link: `https://iacquire.online/demo/verify?token=…` (page). The button on that page POSTs to `/api/public/demo/verify`; only that POST consumes the link.
- Demo room: `https://iacquire.online/demo/room`
- Super Admin: `/admin/prospects` and `/admin/prospects/<id>`
- Migration: `0105_demo_registration_requests.sql` (+ rollback)

## What was already there, and what this adds

| Area | Before | This change |
| --- | --- | --- |
| Demo prospect registration | Existing browser form at `/demo` → `registerProspect` | A signed server-to-server route that calls the same service |
| Email verification | Existing one-use, hash-only link (48 h default), capture outbox, `/dev/mailbox` | Branded link now also produced for marketing registrations; same template |
| Demo sessions | Existing `iaq_demo` cookie, hash-only, 7 days | Unchanged |
| Access expiry | Existing 24-hour window from the explicit confirm | A database guard (`0105`) makes `verified_at` immutable and refuses shortening except a deliberate early end |
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
5. The clock is never reset by refresh, login, a repeat verification, a resend, a new device, an extension or a conversion. Migration `0105` adds a database trigger that refuses
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

Sender-domain requirement: the `EMAIL_FROM` domain (`iacquire.online`) must be verified in Resend with SPF and DKIM, and DMARC should be published. Until that is verified, keep
`EMAIL_PROVIDER=capture` and do not promise deliverability.

The Super Admin's own demo settings must also be on, with `windowHours = 24`, `messageLimit = 10` and a `consultationUrl`: `/admin/prospects/settings`.

## Required migrations

| Migration | Needed for | Applied to a hosted database? |
| --- | --- | --- |
| `0100_demo_funnel.sql` | The demo itself (existing) | **No** (as recorded in the repository) |
| `0105_demo_registration_requests.sql` | The replay ledger and the first-access guard | **No** |

`0105` is additive: one server-only table (`request_id_hash`, `body_sha256`, `received_at`, `completed_at`; RLS on, no grant, no policy), one index, one trigger function
(`app.demo_first_access_guard`) and its trigger. Rollback: `supabase/rollbacks/0105_demo_registration_requests.down.sql`. It refuses while the ledger holds rows; switch
`DEMO_REGISTRATION_ENABLED` off and let the 24-hour sweep clear them first.

Run `node scripts/rehearse-combined-migrations.mjs` on a scratch database before applying anything. Do not apply a hosted migration without approval.

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
npx vitest run tests/demo-                          # 19 files, 484 tests
npx vitest run tests/demo-external-registration.test.ts tests/demo-registration-migration.test.ts
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

Migration rehearsal: `node scripts/rehearse-combined-migrations.mjs` passed sections A–F on the 99-file chain (0001..0105, 22954 final schema facts, 28 rollbacks from 0077,
0105 applied and rolled back with the 8,036 earlier rows unchanged). After the first-access trigger was adjusted to keep a Super Admin's early end working for consultation and
purchase statuses, sections B, C and D were re-run against the final `0105` file: **all passed in 203 s** (fresh-chain equality at every step, rollback to the exact prior schema,
forward again).

### Browser QA (isolated app, capturing email, made-up model)

- Desktop: `node scripts/wave2-demo-qa.mjs` at 1280 px drove settings → request → captured email → link twice (a scanner opens it) → button → room → ten messages and the refusal → return → CTAs → Super Admin → extension → early end → reopen → consultation held → not a fit. It recorded **34 of 36 checks passing**, 0 page errors, 0 server errors and 0 external requests, with 12 screenshots in `.data/wave2-qa/`.
  - The two checks that did not pass are harness false negatives, not funnel failures: the transcript check lost its panel to a Next.js Fast Refresh full reload, while `readTranscriptAction` returned 200 and the next check (a "read the conversation" timeline line) passed; the "not a fit" check inspected only the first 300 characters of the page (navigation), while `declineProspectAction` returned 200 and the status was written. Both checks should be tightened before they are quoted as a gate.
  - The console errors are the deliberate 429s from the six-a-minute message test, as designed.
- Mobile: `node scripts/wave2-demo-mobile-qa.mjs` at 375 × 812 **passed 12 of 12 checks**: the request page, the confirmation page (including a second GET that did not use the link) and the room have no horizontal overflow and no serious/critical axe violations, the form and its button are visible, and the entry button opens the room. Screenshots: `demo-mobile-form.png`, `demo-mobile-verify.png`, `demo-mobile-room.png`.

### Not tested here

- A real Resend send, SPF/DKIM/DMARC, and a real prospect address. The capturing outbox is what the tests read.
- Applying `0105` (or `0100`) to the hosted database. Only the embedded Postgres used by the suite ran it.
- A browser talking to the *signed marketing endpoint* through the real landing page: the landing page does not exist in this workspace. The browser runs above drive
  `/demo`, the emailed link and the room, which are the screens the signed registration sends a prospect to; they are unchanged by this work.
- Production rate-limit behavior under real multi-connection load; the suite runs one embedded connection.

## Not production-ready until

1. `0100` and `0105` are reviewed and applied to the hosted database (with approval and a rehearsal).
2. Resend's sender domain for `iacquire.online` is verified and a test message reaches a controlled inbox.
3. Both hosts hold the same generated secret, `DEMO_REGISTRATION_ENABLED=true`, and `APP_URL=https://iacquire.online`.
4. The landing page's server route is deployed and a staging end-to-end run (landing form → signed call → captured email → confirm → room) is recorded.
