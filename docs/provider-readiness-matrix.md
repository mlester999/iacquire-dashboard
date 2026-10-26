# Provider readiness matrix

Last updated: 2026-10-26, on `integrate/phases-3-7-workforce`. Ten questions per provider, answered from the code and the tests in this repository. The point of the document is to make "not verified" impossible to mistake for "works": a provider whose row says *fixtures* has never answered, and no row in this file says otherwise.

**Nothing here has been contacted for real.** There is no sandbox account connected, no hosted migration applied, and no live switch turned on. Every write switch in `.env.example` defaults to `false`.

## The ten questions

For each provider: **(1)** what the product uses it for; **(2)** the exact switch that keeps it off; **(3)** where the credential lives and how it is sealed; **(4)** what has actually run against it; **(5)** what the code verifies before trusting it; **(6)** how a failure is handled; **(7)** idempotency and replay; **(8)** rate limits and cost control; **(9)** the kill switch; **(10)** what is still needed before it can be turned on.

## Money

### PayMongo

| # | Answer |
| --- | --- |
| 1 | Agency purchase checkout and setup fee; maintenance plan periods; client invoice payments and top-ups; refunds and disputes (recorded, never applied) |
| 2 | `CUSTOMER_PAYMENTS_WRITES_ENABLED`, `CUSTOMER_PAYMENTS_LIVE_ENABLED`, and the per-connection status. Live mode additionally refuses a key that does not match the declared mode |
| 3 | Sealed with AES-256-GCM in `customer_payment_connections.credentials`; webhook secret sealed the same way; never echoed, logged or audited |
| 4 | **Fixtures only.** A local stand-in (`scripts/paymongo-sim.mjs`, refused outside loopback) and hand-written signed bodies. The payload shapes were written from documentation as remembered, not captured |
| 5 | Signed notice only: HMAC-SHA256 over `timestamp.body` with a timing-safe compare inside a 24-hour window, plus a test/live prefix check that must agree with the payload. A "success" return page proves nothing |
| 6 | A refused call is recorded as a failure with the provider's sanitised reason; a mismatch freezes the row into a hold with a critical notice |
| 7 | Event-id ledger row locked `FOR UPDATE`; unique keys on the checkout and the payment; a late or duplicate notice is ignored, not applied twice |
| 8 | Per-IP and per-invoice buckets; the amount is always read from our stored row, never from the event |
| 9 | The two switches plus the per-connection disconnect; the public invoice side has `INVOICES_PUBLIC_DISABLED` |
| 10 | Test keys, a webhook secret, and one sandbox run of checkout → paid → refund against a staging copy |

### PayPal

Two separate uses, with separate credentials and switches. **iAcquire's own money** (the setup-fee purchase checkout and the optional US$299/month maintenance subscription) uses the app's PayPal REST app, read from the server environment. **A client's invoices** use the client's own PayPal account, connected inside their workspace and sealed in the database.

| # | Answer |
| --- | --- |
| 1 | The one-time purchase checkout (Orders v2, captured by the server after the buyer approves); the optional monthly maintenance plan (Subscriptions v1); and, for a client workspace, collecting on its own invoices from its own PayPal account |
| 2 | Own money: leave `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` unset and it reads "PayPal is not connected"; the Super Admin's "Allow buyers to pay online" switch (off by default) and "Allow clients to pay the maintenance plan automatically" switch (`agency_billing_settings.recurring_billing_enabled`, off by default) each have to be on, and the subscription also needs `PAYPAL_MAINTENANCE_PLAN_ID`. A client's own account: `CUSTOMER_PAYMENTS_WRITES_ENABLED` and `_LIVE_ENABLED` and the per-connection status. `PAYPAL_ENVIRONMENT` is `sandbox` unless the founder writes `live` (and records the payment review) |
| 3 | Own money: server environment only, never in the database or the browser. A client's account: client id and secret sealed with AES-256-GCM; the webhook id is stored beside the connection. Nothing is echoed, logged or audited |
| 4 | **Fixtures, and a runnable simulator.** The wire is replaced in tests by `tests/support/paypal-agency.ts` and `paypal-subscriptions.ts` (written from PayPal's documentation). `scripts/paypal-sim.mjs` is a stand-in PayPal on 127.0.0.1 (OAuth, Orders create/read/capture, the webhook signature check, the Billing Plan and Subscriptions calls, signed notices for completed, refunded and disputed payments and for failed, suspended and cancelled subscriptions). A real browser drove the purchase checkout and the maintenance subscription end to end against it: **89 checks, 0 console, page or server errors apart from a Next dev compile race that passed on rerun, 0 requests that left the machine** (`scripts/wave3-paypal-qa.mjs`). It proves the application's handling of PayPal-shaped answers. It proves nothing about PayPal's real payloads, which have never been captured |
| 5 | A delivery is verified by **asking PayPal** (`/v1/notifications/verify-webhook-signature`) with the body parsed as exactly one JSON object so no field can be appended; the transmission time must be within 72 hours; the certificate host must be paypal.com. The API origin is pinned to the declared environment, so a sandbox key cannot pass against the live origin. The buyer's approval link is checked to be an https paypal.com page before it is handed over or stored. Amount, currency and reference are compared with our own stored row; a mismatch holds the payment. Approval is never payment: the server captures and only a COMPLETED capture counts |
| 6 | A failed verification is a 4xx and changes nothing; a refused call is recorded with PayPal's sanitised reason; a subscription charge that fails while the plan is paid through a later day takes nothing from the plan and the page and the owner say so, three failures pause the agreement, a refund or dispute puts it on hold for a person |
| 7 | Unique `(provider, provider_event_id)` and `(provider, checkout id)` keys; the receipt is committed before it is applied and applied under a row lock; a second charge within ten days of an applied one is recorded and held, never added |
| 8 | Per-address bucket on the webhook before PayPal is asked; per-attempt buckets on the checkout; the price comes from our plan row and is proved equal to PayPal's plan before a subscription is opened |
| 9 | The two Super Admin switches; disconnecting a client's account; a held agreement stops new charges; the customer-payments master switch |
| 10 | A PayPal sandbox app, its webhook id, a billing plan created in the sandbox at US$299/month with no trial and no setup fee, and one end-to-end run: approve, capture, refund, subscribe, fail, cancel. Then a settle of the guesses listed at the top of `src/server/customer-payments/providers/paypal.ts` and `src/server/billing/providers/paypal-subscriptions.ts` |

The simulator is refused everywhere that matters: `PAYPAL_API_BASE` is rejected in production, for any address that is not this machine's, for the live environment and for a client id that is not the simulator's made-up one (`src/server/env.ts`, `tests/paypal-simulator-guard.test.ts`). It changes where the server's API calls go and nothing else: the approval links stay ordinary `https://www.sandbox.paypal.com` addresses that the application checks as it would in production, and the browser run answers requests to that host from the simulator itself.

## Documents and signature

### PandaDoc

| # | Answer |
| --- | --- |
| 1 | E-signature for proposals: create a document from our PDF, ask for a signature, receive the completion notice, store the signed copy |
| 2 | `ESIGN_WRITES_ENABLED`; the simulated provider is refused in production |
| 3 | Sealed API key per workspace connection |
| 4 | **A replaced HTTP layer only**; the stand-in provider runs in-process |
| 5 | Webhook body verified before being applied; a completion is re-read from the provider before the proposal is marked accepted |
| 6 | A refused request is held, not failed silently; an unknown outcome is looked up, never re-created |
| 7 | One request per proposal version; the provider's document id is stored; a repeat completion is a no-op |
| 8 | Per-workspace concurrency is bounded by the worker; no polling storm |
| 9 | `ESIGN_WRITES_ENABLED` plus disconnect |
| 10 | A sandbox account and key, a template that accepts our PDF, and one signed run |

## Channels

### Twilio (SMS / WhatsApp)

| # | Answer |
| --- | --- |
| 1 | SMS and WhatsApp messages through the messaging chain (recovery texts, reminders, follow-ups) |
| 2 | `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED` |
| 3 | Sealed credentials per workspace channel |
| 4 | Earlier phases ran against fixtures; today every test uses a recording transport |
| 5 | Delivery and failure callbacks are verified before they change a message's status |
| 6 | A refusal fails the message honestly and is visible; nothing claims it was sent |
| 7 | A message is sent once; a callback can only move it forward |
| 8 | Published unit rates and per-workspace credits; quiet hours and sending windows |
| 9 | The write switches plus the channel's own disable |
| 10 | A sender identity, an approved number, and one real send to our own phone |

### Resend (email)

| # | Answer |
| --- | --- |
| 1 | Invitations, proposal and invoice delivery, reminders, support replies |
| 2 | `RESEND_WRITES_ENABLED`; tests use `EMAIL_PROVIDER=capture`, which writes to `email_outbox` and sends nothing |
| 3 | Sealed API key |
| 4 | Capture provider only; the outbox records what would have been sent |
| 5 | Bounce and complaint callbacks are honoured; a hard bounce suppresses the address |
| 6 | A failed send is recorded as failed with its reason and retried a bounded number of times |
| 7 | One delivery row per message; a retry is a new linked message, never a silent second send |
| 8 | Unit rates and credits per workspace |
| 9 | The write switch; `EMAIL_PROVIDER=capture` is the emergency stop |
| 10 | A verified sending domain and one real message to ourselves |

### GoHighLevel

| # | Answer |
| --- | --- |
| 1 | The legacy CRM integration (contacts, pipelines, calendars) for workspaces that still use it |
| 2 | `GHL_WRITES_ENABLED` |
| 3 | Sealed location token |
| 4 | Earlier phases only, against fixtures |
| 5 | Webhook signatures verified; the mapped location is re-read before a write |
| 6 | A failed sync is recorded and retried; the native CRM stays authoritative where it is used |
| 7 | External ids are stored and matched, so a replay updates rather than duplicates |
| 8 | Per-location request budget |
| 9 | The write switch |
| 10 | A test location and one write round trip |

## Platforms with a review process

### Meta (social publishing, page reviews, WhatsApp)

| # | Answer |
| --- | --- |
| 1 | Publishing to a Facebook Page or Instagram; reading page reviews; WhatsApp messages |
| 2 | `META_SOCIAL_WRITES_ENABLED`, `META_REVIEWS_ENABLED`, `META_REVIEWS_REPLIES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED` |
| 3 | Sealed long-lived page token per connection |
| 4 | A **simulated platform** (`src/server/social/providers/simulated.ts`) and simulated reviews. No Meta app has ever been used |
| 5 | A post is published once and its id stored; the publisher retries an unknown outcome instead of posting twice |
| 6 | A refusal is stored with its reason; the workspace gate stops publishing when the plan lapses |
| 7 | Post id uniqueness; the durable publisher has its own state machine and lease |
| 8 | Media size and storage entitlement; per-workspace publishing limits |
| 9 | The four switches plus disconnect |
| 10 | App review, business verification, and one real post to a test Page |

### Google Business Profile

| # | Answer |
| --- | --- |
| 1 | Reading reviews from a location; replying (opt-in, per workspace) |
| 2 | `GOOGLE_BUSINESS_API_APPROVED`, `GOOGLE_BUSINESS_REPLIES_ENABLED` |
| 3 | Sealed OAuth refresh token |
| 4 | A simulated review site |
| 5 | A reply is posted once; the provider's echo is stored |
| 6 | A quota or approval error is reported plainly, never retried into a loop |
| 7 | Review id and reply id uniqueness |
| 8 | Per-location quota awareness; replies are one per review |
| 9 | The two switches |
| 10 | API access approval, OAuth verification, and one real review read and reply |

## Runtime and models

### Hermes (AI employee runtime)

| # | Answer |
| --- | --- |
| 1 | The six AI employees: health, tool inventory, chat, research, drafts |
| 2 | `WORKFORCE_WORKER_ENABLED`, the schedule/trigger/briefing switches, `WORKFORCE_HEALTH_PROBE_ENABLED`, `HERMES_PROVISIONER_ENABLED` |
| 3 | A sealed per-employee credential; the profile identity and tool digest are recorded |
| 4 | **A local mock** (`tests/support/mock-hermes.ts`). No live profile has ever answered for a client |
| 5 | Identity, API contract, tool inventory (read twice, digest pinned, contract checked) and a Super Admin acknowledgement for internal employees; the run gate re-reads all of it immediately before submitting |
| 6 | A failed check makes the employee Unavailable, never "online"; the probe alerts once at the threshold and once on recovery |
| 7 | Run ids and an idempotency key per purpose; a lease fences every write |
| 8 | Token metering per workspace; a pause stops jobs; per-role tool allowlists |
| 9 | The switches plus pausing the employee and suspending the workspace |
| 10 | Provisioning a profile on a VPS, a live evaluation, and the two-session memory canary |

### A language model (replies, drafts, research)

| # | Answer |
| --- | --- |
| 1 | Website chat replies, proposal and social drafts, lead scoring narrative, review replies |
| 2 | The model key is absent by default; every caller goes through the LLM gate |
| 3 | Environment secret, never in the database |
| 4 | **Simulated generators only**; no model key exists in any environment here |
| 5 | Output is grounded and checked (invented-claims filter, reply grounding); nothing the model says is trusted as an instruction |
| 6 | A failure is recorded and the feature says it could not answer |
| 7 | Metering per call; a retry is bounded |
| 8 | Per-workspace metering and caps; the website chat's daily allowance |
| 9 | Removing the key, plus each feature's own switch |
| 10 | A key, a cost ceiling, and an evaluation of the prompts that ship |

## What is verified today

| Category | What that means for every row above |
| --- | --- |
| Built | Yes, for all of them |
| Tested locally (embedded Postgres, replaced transports) | Yes |
| Browser-checked (isolated app, simulated providers) | Yes, for the money and document flows that have browser evidence |
| Run against a real sandbox | **No, for every provider** |
| Deployed / live | **No, for every provider** |

The single next action for any row is the one in its question 10; none of them can be done without the founder's account and approval (`docs/roadmap/phases-3-to-7/blockers.md`).
