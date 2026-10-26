# Purchase intents

A purchase intent is the verified path from an invited buyer to a client workspace. It freezes the approved commercial offer, gives the buyer one public link, and records payment evidence from one of two sources: a Super Admin who checked the money, or PayMongo's **signed** notice for an online checkout the buyer opened from that link. Only then does it use the existing client-creation and billing services to make the workspace. It is not a second billing system and it does not create a client from a demo prospect.

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Price snapshot | US$1,499 setup and optional US$299/month, frozen in the row; the database refuses any other amount | — | The commercial terms are the founder's already-stated model |
| Public link | Random 32-byte token, SHA-256 stored, expiry, rotation, rate limits, `noindex`/`no-store`/`no-referrer` | — | — |
| Buyer confirmation | Writes `started`, is idempotent, creates no account and takes no payment | — | — |
| Verified payment, by hand | A Super Admin records the checked amount, method, external reference, date and note; the amount must equal the frozen fee | — | — |
| Verified payment, online | One hosted PayMongo checkout per intent, the amount copied by the database from the frozen fee and converted at the agency's stored rate; only a correctly signed notice that matches the reference, mode, currency and amount marks it paid | The signed notices were produced by `scripts/paymongo-sim.mjs` (loopback, made-up keys) and by hand-written fixtures; PayMongo itself was never called | A PayMongo account (test keys first), its webhook secret, the exchange rate, and for live keys the agency's payment and tax review |
| Workspace creation | Creates the client through `createClientTenant`, then the canonical setup payment, clears setup, and opens AI provisioning. By a Super Admin, or by itself if the inviting Super Admin allowed it | The invitation email goes through the configured capture/provider path; no real email was sent | The client invitation and email provider are the same production approvals as ordinary client creation |
| Maintenance plan | The buyer's choice is frozen and shown; it is **not** auto-subscribed from a purchase. A plan the client later holds can be paid for online, month by month (see `docs/billing-and-entitlements.md`) | No card-on-file recurring charge exists | A recurring-billing decision and a provider account |
| Refund, dispute, mismatch | Before the workspace exists: the purchase is put on hold, the team is told, nothing is created. After it exists: reported on the workspace's own payment, nothing changes | PayMongo's real refund and dispute payloads were never seen | Counsel and a provider account |

## The flow

1. A manager with `agency.prospects.view` sees the list; a Super Admin with `agency.prospects.manage` creates an invitation. The API returns the public URL **once**; only its hash is stored. The Super Admin may allow the workspace to be created by itself after a verified online payment (this needs the billing and client-creation permissions as well, because the system will act with them).
2. The buyer opens `/purchase/<token>`, sees the frozen price and confirms. That records `started`; it creates no user, organization, payment, subscription or entitlement.
3. **Online:** when the Super Admin has switched online checkout on and PayMongo is ready, the confirmed buyer sees "Pay US$1,499 securely online". Pressing it opens one hosted checkout and sends the buyer to PayMongo. Nothing is charged by this site, and this site never sees a card. PayMongo charges Philippine pesos, so the dollar fee is converted at the agency's published rate; the rate, its source and its date are stored with the checkout. Backing out and pressing again reopens the same checkout, so a second tab or press never charges twice.
4. PayMongo tells the application (a signed webhook) that the checkout was paid. The checkout is found by the id we stored, then the reference, mode, currency and amount must equal what we stored. Only then is the intent `payment_verified` with `payment_source = provider`. The page the buyer returns to (`/purchase/return/<checkout reference>`) reads that stored status; coming back proves nothing, and it never says "paid" on its own.
5. If the inviting Super Admin allowed it, the workspace is created now, under that person's permissions **read again at that moment** (a person's decision does not outlive their access). Otherwise a Super Admin presses "Create client workspace".
6. **By hand:** a Super Admin checks the money in the bank, PayPal or PayMongo dashboard and records the evidence; recording it closes any online checkout that is open so the buyer cannot pay twice. The amount must be exactly the frozen setup fee.

The statuses are `invited`, `started`, `payment_verified`, `provisioned`, `cancelled` and `expired`. An open link past its day reads as expired even before a job writes that word. A verified payment is never cancelled quietly: with no hold it needs the refund path; with a hold it can be closed without a workspace (below), which reads "Closed after payment". The online checkouts have their own statuses: `creating`, `pending`, `paid`, `failed`, `cancelled`, `expired`, `mismatch`, `refunded`, `disputed`.

## What happens when it does not go to plan

| Situation | What the system does |
| --- | --- |
| Online checkout switched off, PayMongo not connected, no exchange rate, or live keys without the payment review | The buyer is not offered a Pay button and is told iAcquire will verify the payment another way; the Super Admin sees the reason in words |
| The buyer backs out of PayMongo's page | The return page says they left, nothing was charged and how to come back (it never claims the checkout is cancelled: only PayMongo's notice can say that). The purchase link still offers Pay and reopens the same checkout |
| The same signed notice arrives twice | Acknowledged and ignored; the event ledger makes retries and replays harmless |
| The paid amount or currency differs from what we stored | The checkout becomes `mismatch`, the purchase is put on hold, the team gets a critical notification, nothing is created |
| The mode (test or live) differs | Rejected |
| A refund or dispute is reported **before** the workspace exists | The checkout becomes `refunded` or `disputed`, the purchase is put on hold, the team is told, nothing is created or removed; a Super Admin then releases the hold or closes the purchase (below) |
| A refund or dispute is reported **after** the workspace exists | Reported on the workspace's own payment row (the payments screen shows "PayMongo reported a refund … nothing was changed automatically"); the workspace and the purchase do not change |
| Someone pays a checkout for a purchase that was already paid by hand, already provisioned, or cancelled | The payment is recorded on the checkout as a duplicate or late payment and the team is told to refund it in PayMongo; nothing new is created |
| Creating the workspace fails after a verified payment | The reason is written on the purchase and in its timeline, the team is told, "Create client workspace" finishes the same workspace (it never makes a second one), and the renewal sweep retries up to six times |
| The Super Admin who allowed automatic creation is no longer active, or lost the permissions | Nothing is created; the purchase waits for a person |
| A checkout nobody finished | Closed unpaid after 48 hours by the sweep; a payment that arrives for it later is still recorded, because the money is real whenever it comes |

**Resolving a hold.** A held purchase shows its reason in words and gives a Super Admin two ways out, each needing the person's own words and an audit row:

* **Release the hold** (needs the same billing and client-creation permissions as creating the workspace, because it re-enables that): "What did you check with the provider?" at least 10 characters. The hold is cleared; the checkout that paid goes back from `refunded` or `disputed` to `paid` (the person judged the report not to apply, and the workspace adopts that checkout as its evidence); a purchase that was never verified (a mismatch) lets the buyer try again; a verified online payment that the inviting Super Admin allowed to provision itself carries on at once, under that person's re-read permissions. The timeline says a person released the hold; the note is in the audit record, which only agency code reads.
* **Close without a workspace** (only while a hold exists on a verified payment): "Why is it being closed?" at least 10 characters. No workspace is created, the payment record stays on the purchase (migration 0103 relaxes 0101's rule to "verified or provisioned needs evidence"), any open checkout is closed, the status reads "Closed after payment", and the buyer's address may be invited again. A verified payment with **no** hold is still never cancelled quietly: use the refund path.

## Separation from prospects and clients

* The purchase intent lives in its own tables and belongs to the agency workspace (`agency_org_id`), never to a client workspace. Its online checkouts (`purchase_intent_checkouts`) cannot live in `payments`, which belongs to a client workspace that does not exist yet; when the workspace is created the checkout's evidence is **adopted** into that workspace's own payment row (`src/server/billing/provider-setup-payment.ts`), so a later refund or dispute notice for it finds the canonical row.
* It is not a demo prospect: the demo funnel has its own tables, caps and retention. Converting a demo prospect remains a separate Super Admin action.
* A client organization is written only by `createClientTenant`, with the buyer's normal invitation and membership rules.
* The public page exposes one frozen offer for the token holder; it exposes no list, no other buyer and no internal note.

## Security

* Token: 32 random bytes, base64url; only `sha256(token)` is stored. The URL is marked `no-store`, `no-referrer` and `noindex` at the proxy, and the page is rate-limited per address. The token is never given to PayMongo: the buyer comes back by the checkout's own reference.
* The public actions accept only a token-shaped value; they cannot choose an amount, a currency, a company or a workspace. Starting a checkout is limited to 12 per address per hour and 8 per purchase per hour, and a purchase may open at most 8 checkouts in its life.
* The amount is the database's: a trigger copies the frozen fee onto the checkout and refuses any other figure, and a checkout's terms never change after creation.
* Reads: RLS on the intent, checkout and timeline tables, select-only for `iaq_app_user`, scoped to the one agency workspace and `agency.prospects.view`. No browser role has a grant.
* Writes: trusted server code only. Every admin action re-reads the signed-in person's active role and permissions; the service refuses managers for creating intents or recording payment, and requires the client-creation and billing permissions to provision.
* Audit: each transition writes a `purchase_intent_events` row and an `audit_logs` row. The timeline holds ids, fixed words, amounts and methods, never the raw token or the buyer's free-text note. The timeline table is append-only.
* The simulated PayMongo (`PAYMONGO_API_BASE`) is refused in production, for any address that is not this machine's, and with any key that is not a test key (`src/server/env.ts`), and the isolated QA environment refuses every other PayMongo setting.
* The simulated PayPal (`PAYPAL_API_BASE`, `scripts/paypal-sim.mjs`) is refused in production, for any address that is not this machine's, for the live environment, and for a client id that is not the simulator's made-up one (`src/server/env.ts`); the isolated QA environment refuses every other PayPal setting (`tests/paypal-simulator-guard.test.ts`). It changes where the server's PayPal API calls go and nothing else: the approval links stay ordinary `https://www.sandbox.paypal.com` addresses that the application checks as it would in production, and the browser run answers those from the simulator itself (`scripts/wave3-paypal-qa.mjs`), passing nothing to the network.

## Migrations and rollback

`0101_purchase_intents.sql` adds `purchase_intents` and `purchase_intent_events`, the agency guard and event guards, the read policy and the `app.purchase_intents_allowed()` / `app.purchase_intent_agency_org()` helpers. `0103_purchase_checkouts.sql` adds `purchase_intent_checkouts` and its guard, the evidence-source, hold and provisioning-attempt columns on the intent, the new timeline kinds, the maintenance-period columns on `payments`, and the agency's checkout switch (off by default). Both have rollbacks in `supabase/rollbacks/` that refuse while any purchase, checkout, online-paid intent or maintenance-period payment exists. Both were rehearsed on embedded Postgres with the whole chain; **neither has been applied to a hosted database**.

## Tests

* `tests/purchase-intents-rules.test.ts` — frozen price and every transition.
* `tests/purchase-intents.test.ts` — creation, duplicate email, confirmation, rotation, expiry, wrong amount, verified payment, workspace creation, idempotency, cancellation, audit/timeline and role refusals on embedded Postgres.
* `tests/purchase-checkout.test.ts` — opening, resuming and failing a checkout; the exact amount and reference sent to the provider; the signed notice as the only way to "paid"; mismatch, wrong mode, replay, late and duplicate payments; refund and dispute before and after the workspace; automatic provisioning under the inviter's re-read permissions, its failure and recovery; the sweeps; the database protections.
* `tests/purchase-intents-migration.test.ts`, `tests/purchase-checkouts-migration.test.ts` — RLS, grants, policy scope, constraints, append-only timeline and the rollback guards.
* `tests/tenant-isolation-generic.test.ts` — the schema-wide tenant policy guard, including the new tables.
* Browser: `scripts/wave2-purchase-checkout-qa.mjs` (a real Chromium against the isolated QA app and the simulated PayMongo) drives the whole buyer and Super Admin journey, the hold, the walk-away and the phone layout. See `docs/roadmap/phases-3-to-7/verification-evidence.md` for what it did and did not show.

## Not claimed

PayMongo itself was never called: the signed notices that verify a payment in the browser run came from a simulator written from PayMongo's documentation, and the real payloads have never been seen from a PayMongo account. No real invitation email was sent, no card-on-file recurring charge exists, PayPal is only an adapter id (nothing creates a PayPal checkout), and no hosted migration or production workspace exists. The US$299 plan is a recorded buyer choice at purchase time and a plan the client can pay for month by month afterwards; it is not an automatic subscription.
