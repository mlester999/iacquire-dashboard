# Purchase intents

A purchase intent is the verified path from an invited buyer to a client workspace. It freezes the approved commercial offer, gives the buyer one public link, records a Super Admin's verified payment evidence, and only then uses the existing client-creation and billing services to make the workspace. It is not a second billing system and it does not create a client from a demo prospect.

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Price snapshot | US$1,499 setup and optional US$299/month, frozen in the row; the database refuses any other amount | — | The commercial terms are the founder's already-stated model |
| Public link | Random 32-byte token, SHA-256 stored, expiry, rotation, rate limits, `noindex`/`no-store`/`no-referrer` | — | — |
| Buyer confirmation | Writes `started`, is idempotent, creates no account and takes no payment | — | — |
| Verified payment | A Super Admin records the checked amount, method, external reference, date and note; the amount must equal the frozen fee | No online checkout and no provider webhook auto-provisions; the existing PayMongo/PayPal adapters are not wired to an intent | A PayMongo/PayPal account and a signed webhook would be needed for automatic payment |
| Workspace creation | Creates the client through `createClientTenant`, then records the canonical setup payment through `recordManualPayment`, clears setup, and opens AI provisioning | The invitation email goes through the configured capture/provider path; no real email was sent | The client invitation and email provider are the same production approvals as ordinary client creation |
| Maintenance plan | The buyer's choice is frozen and shown; it is **not** auto-charged or auto-subscribed | There is no recurring billing mechanism for the US$299 plan in this flow | A recurring billing mechanism and founder approval are needed |
| Refunds and disputes | Not part of an intent; use the existing agency billing refund/dispute path after a workspace exists | — | Counsel and a provider account |

## The flow

1. A manager with `agency.prospects.view` sees the list; a Super Admin with `agency.prospects.manage` creates an invitation. The API returns the public URL **once**; only its hash is stored.
2. The buyer opens `/purchase/<token>`, sees the frozen price and confirms. That records `started`; it creates no user, organization, payment, subscription or entitlement.
3. A Super Admin checks the money in the bank, PayPal or PayMongo dashboard and records the evidence. The amount must be exactly the frozen setup fee.
4. The same Super Admin creates the workspace. This calls the existing `createClientTenant`, then `recordManualPayment`, so the setup fee is cleared only by the canonical payment row and the existing provisioning requests open. Repeating the action returns the same workspace and payment.

The statuses are `invited`, `started`, `payment_verified`, `provisioned`, `cancelled` and `expired`. An open link past its day reads as expired even before a job writes that word. A verified payment is never cancelled through this screen; use the refund path.

## Separation from prospects and clients

* The purchase intent lives in its own table and belongs to the agency workspace (`agency_org_id`), never to a client workspace.
* It is not a demo prospect: the demo funnel has its own tables, caps and retention. Converting a demo prospect remains a separate Super Admin action.
* A client organization is written only by `createClientTenant`, with the buyer's normal invitation and membership rules.
* The public page exposes one frozen offer for the token holder; it exposes no list, no other buyer and no internal note.

## Security

* Token: 32 random bytes, base64url; only `sha256(token)` is stored. The URL is marked `no-store`, `no-referrer` and `noindex` at the proxy, and the page is rate-limited per address.
* The public action accepts only a token-shaped value and writes only the started status; it cannot choose an amount, a company or a workspace.
* Reads: RLS on `purchase_intents` and `purchase_intent_events`, select-only for `iaq_app_user`, scoped to the one agency workspace and `agency.prospects.view`. No browser role has a grant.
* Writes: trusted server code only. Every admin action re-reads the signed-in person's active role and permissions; the service refuses managers for creating intent or recording payment, and requires the client-creation and billing permissions to provision.
* Audit: each transition writes a `purchase_intent_events` row and an `audit_logs` row. The timeline holds ids, fixed words, amounts and methods, never the raw token or the buyer's free-text note.
* The timeline table is append-only; the rollback refuses while any purchase row exists.
* A verified payment cannot be typed into a client-facing page; the public page never marks a payment as paid.

## Migration and rollback

`0101_purchase_intents.sql` adds `purchase_intents` and `purchase_intent_events`, the agency guard and event guards, the read policy and the `app.purchase_intents_allowed()` / `app.purchase_intent_agency_org()` helpers. `0101_purchase_intents.down.sql` refuses while any purchase or timeline row exists, then drops both tables and their functions. It has been rehearsed on embedded Postgres with the whole chain; it has not been applied to a hosted database.

## Tests

* `tests/purchase-intents-rules.test.ts` — frozen price and every transition.
* `tests/purchase-intents.test.ts` — creation, duplicate email, confirmation, rotation, expiry, wrong amount, verified payment, workspace creation, idempotency, cancellation, audit/timeline and role refusals on embedded Postgres.
* `tests/purchase-intents-migration.test.ts` — RLS, grants, policy scope, constraints, append-only timeline and rollback guard.
* `tests/tenant-isolation-generic.test.ts` — the schema-wide tenant policy guard, including both new tables.

## Not claimed

No online checkout was run, no provider webhook auto-provisioned a workspace, no real invitation email was sent, no recurring maintenance charge was created, and no hosted migration or production workspace exists. The $299 plan remains a recorded buyer choice and a documented option, not an automatic subscription.
