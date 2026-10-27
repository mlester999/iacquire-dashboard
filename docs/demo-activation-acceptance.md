# External demo: final integration acceptance (2026-10-27)

Landing page `https://iacquire-os.vercel.app` (repository `mlester999/iacquire-os-landing-page`) to portal `https://www.iacquire.online` (this repository). Companion documents: `docs/demo-external-registration.md` (the contract) and `docs/demo-funnel.md`.

**Verdict: NO-GO for public demo readiness.** The isolated end-to-end test passes (33 of 33, plus 22 of 23 error cases with the 23rd a wrong expectation of mine). Resend reports the sender domain verified, **but no real email has been sent**, and **nothing has been tested on production**. Public readiness needs the controlled production smoke test in section 6, and four approvals (section 7). Everything below that says "verified" says where it was verified.

## 1. The three kinds of evidence (never merged)

| Kind | Status | What it proves | What it does not |
| --- | --- | --- | --- |
| **Isolated tests** (local PostgreSQL 18 with all 108 migrations, the real portal and the real landing page code, captured email, a local mock model) | **Passed** | The signed contract, the landing page's signer, the email link, the explicit confirmation, the exact 24-hour window, the ten-message quota, return access, expiry, Super Admin visibility, and every failure answer | Anything about the real environment variables, the real Resend delivery, real latency, or the real model |
| **Real Resend verification** | **Domain verified (read-only). No email sent.** | Resend's own API says `iacquire.online` is `verified`, sending enabled, DKIM and both SPF records verified; public DNS shows the DKIM key, the return-path MX and SPF, and a DMARC record | That the portal's production key is the one that was queried; that a real message reaches an inbox, passes DKIM/SPF/DMARC at the receiver, or avoids spam |
| **Production smoke test** | **Not done** (needs approval) | Nothing yet | Everything about production behaviour with the gates on |

## 2. Audit result, item by item

| # | Item | Result |
| --- | --- | --- |
| 1 | Deployed commits | **Portal:** `www.iacquire.online` serves deployment `iacquire-dashboard-5rcoplxrj`, built from `master` at `afffe2a`, which is `origin/master`. **Landing:** `iacquire-os.vercel.app` serves `iacquire-m0hzuuqat`, built from `iacquire-os-landing-page` `master` at `5cd3cb2`, which is that repository's HEAD ("fix: align demo registration with application API"). Both Ready |
| 2 | Production environment names | See section 3. Names are as the code expects. **Vercel returns the literal text `[SENSITIVE]` for sensitive variables, so no secret value, and no gate value, can be read or compared from outside.** |
| 3 | HMAC secret name and contract | Names: landing `IACQUIREOS_BACKEND_SIGNING_SECRET`, portal `DEMO_REGISTRATION_SIGNING_SECRET`, both set. The contract matches in code and in the isolated run (`HMAC-SHA256("<timestamp>.<requestId>.<rawBody>")`, headers `IACQUIREOS-Request-Id`, `-Timestamp`, `-Signature: t=…,v1=…`). **That the two production values are equal cannot be checked without enabling the gates**: the portal answers the gate before it checks a signature. The portal also carries an extra, unused `IACQUIREOS_BACKEND_SIGNING_SECRET` that no code reads. The portal's own secret is at least 32 characters (the app boots; the schema refuses a shorter one); the landing page's length is unknown, and the landing page answers 503 to everything if it is under 32 bytes |
| 4 | Canonical origin | **`https://www.iacquire.online` is canonical** (the apex 308-redirects to it, including POSTs). **Defect found:** the portal's `APP_URL` is `https://iacquire.online/` (apex, trailing slash), so verification links in emails would point at the apex and cost a redirect, and the landing page's `NEXT_PUBLIC_APP_ORIGIN` is the apex too. Nothing breaks (same-site writes accept both aliases, tested in `src/server/security/portal-origin.ts`) but it is not canonical. Correct on approval. The landing page's endpoint, `IACQUIREOS_DEMO_REGISTER_URL`, is already `https://www.iacquire.online/api/public/demo/register`, which matters because it refuses redirects |
| 5 | Migrations through 0113 | Present on production (read-only): ledger 108 rows including `0113_demo_registration_requests`; table present. Nothing was reapplied |
| 6 | Isolated end-to-end | Section 4 |
| 7 | Registration, verification, 24 h, ten messages, return, expiry, Super Admin | Section 4 |
| 8 | Error handling | Section 5 |
| 9 | Resend sender | Section 1. \`EMAIL_PROVIDER=resend\`, \`EMAIL_FROM="iAcquire <no-reply@iacquire.online>"\` on the portal, which matches the verified domain. The demo link goes through \`sendEmail\` directly: it is **not** behind \`RESEND_WRITES_ENABLED\` (that switch gates the messaging transport only), so **enabling the gates sends real email** |
| 10 | Super Admin settings | Supported and tested: `enabled`, `aiEnabled`, `windowHours` (24; 1 to 168), `messageLimit` (10; 1 to 100), extension and extra-message ceilings, daily start cap (50) and message cap (300), `consultationUrl` (https only), retention days, blocked domains; the prospect's own window and limit are copied when they confirm, so changing a number never moves someone who already started. Consultation booking and the optional purchase are CTAs in the room (the purchase opens the existing purchase-intent flow; live payment providers are off). **The room is four parts (your window, a guided tour of six employees, the AI chat, and the book-or-buy next steps); the code's tour has six steps, not four. If "four-step" is a product requirement, that is a spec question for you, not something to guess** |
| 11 | Production gates (not touched) | Inferred from behaviour, because the values are hidden: `/demo` says "The demo is not open right now"; `GET /api/public/demo/history` answers 404 `not_available`; `POST /api/public/demo/register` answers 503 `unavailable`; the Super Admin settings have **no saved row** (everything off by default); there are no prospects, no sessions, no demo emails. Consistent with everything off. Which of the three environment switches is off cannot be told apart from outside |
| 12 to 13 | Smoke plan, activation, rollback, monitoring | Sections 6 to 9 |

## 3. Environment variable names (names only)

**Portal (`iacquire-dashboard`), Production:** `DEMO_ENABLED`, `DEMO_PUBLIC_DISABLED`, `DEMO_REGISTRATION_ENABLED`, `DEMO_REGISTRATION_SIGNING_SECRET`, `DEMO_REGISTRATION_ALLOWED_ORIGINS` (= `https://iacquire-os.vercel.app`, readable and correct), `DEMO_REGISTRATION_MAX_SKEW_SECONDS`, `DEMO_VERIFICATION_TTL_HOURS`, `IACQUIREOS_BACKEND_SIGNING_SECRET` (unused), `EMAIL_PROVIDER` (`resend`), `EMAIL_FROM`, `RESEND_API_KEY`, `APP_URL` (`https://iacquire.online/`: **to correct**), `NEXT_PUBLIC_SITE_URL` (`https://www.iacquire.online`), and the database, Supabase, language-model and other variables. `RESEND_WRITES_ENABLED` is unset (irrelevant to the demo link, see item 9).

**Landing (`iacquire-os`), Production:** `IACQUIREOS_DEMO_REGISTER_URL` (`https://www.iacquire.online/api/public/demo/register`, correct), `IACQUIREOS_BACKEND_SIGNING_SECRET`, `DEMO_REGISTRATION_MODE`, `DEMO_REGISTRATION_TIMEOUT_MS`, `DEMO_RATE_LIMIT_MAX`, `DEMO_RATE_LIMIT_WINDOW_MS`, `NEXT_PUBLIC_APP_ORIGIN` (apex: cosmetic), `NEXT_PUBLIC_SITE_URL` (`https://iacquire-os.vercel.app`, which must equal the landing origin in production, and does).

## 4. The isolated end-to-end run

Environment: a throwaway PostgreSQL 18 with all 108 migrations and Supabase's compatibility layer; the real portal (Next dev server) and the real landing page (cloned at `5cd3cb2`) in the roles of production; `EMAIL_PROVIDER=capture`; an OpenAI-compatible mock model on the loopback so no model is billed; one seeded agency workspace (the chat needs one, production has one) and demo settings enabled. Run through `scripts/staging-demo-e2e.mjs --via-landing`, with the landing page's own signer.

**33 of 33 checks passed:**

* The landing form's own request is accepted: `202 {"ok":true}`.
* The verification email is captured and carries a one-use link.
* **Opening the link twice (GET) changes nothing:** the prospect stays `unverified`, no clock.
* **Only the explicit POST opens the demo**, sets the prospect's own cookie, and writes first access once; the window is **exactly 86,400 seconds**.
* **Exactly ten messages are accepted, the eleventh is refused (`limit_reached`)**, the database says ten used, and the room reports none left with the same allowance of ten.
* **Return access:** asking again inside the window is answered identically (202), a new link is captured, it opens the room on a new session, **first access, window end and messages used are unchanged**, and the used link cannot be used again.
* **Exact expiry:** the prospect was moved (migration 0113 forbids moving first access, so triggers were switched off in one transaction on the synthetic row, a staging-only technique) to six seconds before 24 hours; the room reads open, then, after the six seconds, **ended**, the chat is refused server-side (`window_ended`), a message is refused (`409 window_ended`), and **asking again after expiry is answered 202 but sends no email and does not reopen or extend the window**.

**Super Admin visibility** (the real admin services against the staging data): a Super Admin sees every prospect with status, first access, window end, messages used and allowance, consultation and purchase state, the timeline (`registered`, …), the daily summary against the caps, and the settings; **an agency staff member without the prospects permission and a client user are both refused.** (The screens themselves are covered by `tests/demo-pages.test.tsx`, `tests/demo-admin*.test.ts`; the repository's 23 demo test files, 509 tests, pass.)

**Defects found and fixed in the harness (none in the product):** the script posted the backend's field names to the landing form (which takes `fullName` and `businessName`), sent no `Origin` (the landing route correctly refuses that, 403), expected `200` where the landing returns `202`, crashed on an early failure (a variable used before its declaration), ordered the outbox by a random UUID, tried to move the clock back in a way migration 0113 correctly forbids, assumed chat stays sendable after the ten messages are used, and assumed the prospect's `status` flips at the boundary (it flips when the retention sweep runs; the access state is computed from the timestamps and is correct immediately).

## 5. Error handling

Backend, signed directly (`scripts/staging-demo-error-matrix.mjs`): a wrong signature, a stale timestamp and a tampered body are each **401 with one generic answer and nothing stored**; a wrong content type 415; an oversize body 413; the same request id with the same body 202 and **no second email**; the same id with a different body 409 `replayed_request`; invalid fields 422 with a `fields` map; consent false 422; a filled honeypot answered 202 with **nothing stored or sent**; malformed JSON 400; GET 405 with `Allow: POST`; a foreign `Origin` 403; **no `Access-Control-*` header on any answer**; and the **fourth registration for one mailbox in an hour 429 `rate_limited`** (three emails sent, not four).

Landing page: a valid form 202; an invalid email 400 with a field error; missing consent 400; a cross-origin browser post 403; the page's own per-visitor limit 429 after five in a minute; **a wrong signing secret and an unreachable backend each answer `503 {"ok":false}` "temporarily unavailable" and store nothing**, so the visitor is never shown a success. The form shows success only when the response is `ok` **and** `result.ok === true`, reuses its idempotency key on a retry, and shows an alert for every other outcome (`components/demo-registration-form.tsx`). The landing page's 21 own tests pass.

(The matrix ran as a script of the same cases before it was saved as `scripts/staging-demo-error-matrix.mjs`; the saved copy is a straight port with a safe-host guard, syntax-checked but not yet re-run. My expectation for the fourth registration was a 202; the contract says 429, and 429 is what the product does.)

## 6. Controlled one-account production smoke test (needs your approval, section 7)

Use one address you own. It writes real rows to the production database (one prospect, one outbox row, events), sends **real email** through Resend, and the AI messages are billed by the real model (ten messages is small, but it is real).

1. **Before:** approvals in section 7; a recorded backup is not needed (the writes are one prospect), but note the current counts: `select count(*) from demo_prospects, demo_registration_requests, email_outbox` (all 0 today).
2. **Set the safety ceilings first** in the Super Admin demo settings (still off): daily start cap **3**, daily message cap **25**, an https consultation link you approve, blocked domains empty. Leave **AI off** for the first pass.
3. **Switch on** (section 8, steps 1 to 4), then the Super Admin switch.
4. **Register** at `https://iacquire-os.vercel.app` with your address. Expect the message "If your request can proceed, we'll send a secure iAcquireOS demo link…". A 503 "temporarily unavailable" here means a gate or the secret is wrong (a 401 from the portal is shown the same way; the portal's function logs say which): do not retry blindly, use the rollback in section 9.
5. **The email:** arrives from `no-reply@iacquire.online`; check "Show original": `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`; the link host is `www.iacquire.online` (after the `APP_URL` correction); it did not land in spam.
6. **Open the link** (do not let a mail scanner be the test: open it once in a normal browser): the page shows one button and the demo has not started (Super Admin shows `unverified`).
7. **Press the button:** the room opens, the window end shows 24 hours from now; Super Admin shows `active`, first access, window end exactly +24 h.
8. **Ask again** (register the same address): the same answer; a return link arrives; it opens the same window. In the room, try the consultation and the optional purchase buttons (the purchase opens the purchase-intent screen; **take no payment**).
9. **Switch AI on** and send two or three messages, then watch the counter. (The tenth and eleventh refusal is already proven in isolation; do not spend ten real model calls to re-prove it.)
10. **Look as Super Admin** at `/admin/prospects`: the row, the timeline, the daily summary against the caps.
11. **Finish:** end the demo early from the prospect's detail ("end now"), confirm the room reads ended, **switch the Super Admin switch off**, and (your choice) erase the prospect. Record the Vercel log lines for `/api/public/demo/*` during the test.

## 7. Approvals this needs (none has been given)

1. Production environment changes: `APP_URL` to `https://www.iacquire.online`; the three demo switches set explicitly (`DEMO_PUBLIC_DISABLED=false`, `DEMO_ENABLED=true`, `DEMO_REGISTRATION_ENABLED=true`); the signing secret **set to the same new value on both projects** (this removes the unverifiable-equality risk by construction); optionally `NEXT_PUBLIC_APP_ORIGIN` on the landing page.
2. A redeploy of both projects to apply them (Vercel applies environment changes on the next deployment).
3. Production database writes for the smoke test (one prospect and its rows) and the Super Admin demo settings row.
4. One real email through Resend to your address, and a few real model messages.

## 8. Exact activation steps (after the smoke test passes, in this order)

1. Generate one secret of at least 32 characters (`node -e "console.log(require('crypto').randomBytes(36).toString('base64url'))"`) and set it as `DEMO_REGISTRATION_SIGNING_SECRET` on the portal and as `IACQUIREOS_BACKEND_SIGNING_SECRET` on the landing page, both as sensitive Production variables. Remove the portal's unused `IACQUIREOS_BACKEND_SIGNING_SECRET` or leave it equal.
2. Portal: `APP_URL=https://www.iacquire.online`, `DEMO_PUBLIC_DISABLED=false`, `DEMO_ENABLED=true`, `DEMO_REGISTRATION_ENABLED=true`; leave `DEMO_REGISTRATION_ALLOWED_ORIGINS=https://iacquire-os.vercel.app`, `EMAIL_PROVIDER=resend`.
3. Landing: `NEXT_PUBLIC_APP_ORIGIN=https://www.iacquire.online`; keep `DEMO_REGISTRATION_MODE=backend` and the `www` register URL.
4. Redeploy both; wait for Ready; `GET /api/health` on the portal.
5. Super Admin: set the ceilings (start cap and message cap to the numbers you choose for launch, start low), the consultation link, AI on or off, then the **demo switch on** (this is the last step, and the first one to reverse).
6. Run the smoke test's steps 4 to 8 once more with your address, then announce.

## 9. Rollback, fastest first

| Switch | Effect | Needs a deploy? |
| --- | --- | --- |
| Super Admin demo switch **off** (`/admin/prospects` settings) | Every public demo page and route answers "not open"; nothing is sent; prospects and settings are kept | **No** (a database row, instant) |
| Daily start cap **0** (settings) | No new demo starts; existing windows keep running | No |
| Landing `DEMO_REGISTRATION_MODE` to anything but `backend` | The landing form answers 503 "temporarily unavailable" and calls nothing | Yes (landing redeploy, about 30 s) |
| Portal `DEMO_REGISTRATION_ENABLED=false` | The signed door answers 503; the browser `/demo` form is unaffected | Yes |
| Portal `DEMO_PUBLIC_DISABLED=true` (the emergency stop) | Every public demo page and route answers "temporarily unavailable" before any database read | Yes |
| Rotate the signing secret | Invalidates every signed caller | Yes, both projects |
| `vercel rollback` | Previous deployment | Rollback command |

## 10. Monitoring

* **Health:** `GET /api/health` (`status`, `database`, `scheduler`).
* **The funnel (Super Admin):** `/admin/prospects` summary: today's starts and messages **against the caps**; blocked count.
* **Email:** `select status, count(*) from email_outbox where template = 'demo_link' group by 1` (watch `failed`), the `error` text on a failure (the provider's own reason), and the Resend dashboard for bounces and complaints. A burst of `failed` with "Provider responded 403" means the domain or key changed.
* **Abuse:** `demo_events` and `rate_limit_buckets` (the per-mailbox, per-caller and per-address buckets), `demo_registration_requests` for replays; `429` and `401` counts on `/api/public/demo/register` in the Vercel logs (a sustained 401 is a wrong or rotated secret, or someone guessing).
* **Cost:** the AI meter per workspace and the daily message cap.
* **Errors:** Vercel function logs for 5xx on `/api/public/demo/*` and on the landing page's `/api/demo/register`.
* **Not covered:** there is no paging and no error tracking (a standing gap); this list is read by a person.

## 11. Known gaps and open items

* **The scheduler has never run**, so the retention sweep that marks windows `expired` and clears stale or unconfirmed details does not run. Access is correct regardless (it is computed from the timestamps and enforced server-side, as the isolated test shows), but prospect details are not cleared on the retention schedule until the scheduler is started (a separate approval). Say so in the privacy notice's retention wording if the demo goes public before then.
* The signing-secret equality, the real Resend delivery and the real model answers are unverified until the smoke test.
* DMARC is `p=none` (monitoring only); consider `quarantine` once the first weeks of reports look clean.
* The Resend domain query used the key in the local environment file; the production variable is hidden, so it is assumed, not proved, to be the same key.
* "Four-step" (item 10) needs your definition.
* The landing page's `DEMO_REGISTRATION_TIMEOUT_MS` is hidden; its default (13 s, with one retry using the same request id) fits inside the portal's own 10 s email ceiling.
