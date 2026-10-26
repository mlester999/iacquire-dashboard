# Operating cost and usage safety

Written 2026-10-25 for branch `feat/phases-3-7`. This says what costs iAcquire money when a workspace uses the product, what stops a loop, an abusive visitor or a runaway job from spending it, and what is **deliberately not capped** because the founder has not chosen a number. It states nothing about what any provider charges: no rate is published in the code, so no operating-cost estimate is made here. Nothing below was measured against a real provider; every figure is a limit in this repository, tested on embedded Postgres with simulated providers.

## What costs money

| Cost | Where it starts | Who can start it |
| --- | --- | --- |
| Language-model calls (replies, drafts, summaries, scoring, research planning) | `llmComplete` and the Hermes reply path | A signed-in person, a scheduled job, a public visitor (website chat, prospect demo) |
| Outbound messages (SMS, WhatsApp, email) | The one send chain (`evaluateSend`, then the provider adapter) | A person, a workflow, a scheduled job, an AI employee |
| Payment-provider and signing-provider calls | The adapters under `src/server/customer-payments`, `src/server/esign`, `src/server/billing` | A person, a verified webhook, a scheduled reconcile |
| Storage and bandwidth | Uploads, social media, website assets | A person, a visitor (website) |
| Compute on the app host | Everything above plus exports, imports, PDF rendering | Anyone who can reach a route |

## What stands in front of each, in order

1. **A provider write switch (environment, default off).** `RESEND_WRITES_ENABLED` (email), `TWILIO_WRITES_ENABLED` (SMS and voice), `META_WHATSAPP_WRITES_ENABLED`, `GHL_WRITES_ENABLED`, `CUSTOMER_PAYMENTS_WRITES_ENABLED`, `ESIGN_WRITES_ENABLED`, `META_SOCIAL_WRITES_ENABLED`, `GOOGLE_BUSINESS_*`, `META_REVIEWS_*`. With a switch off the work waits or is refused honestly; nothing leaves.
2. **A workspace gate.** `modelGate` (`src/server/llm/gate.ts`): the workspace must be active, no pause may stop the kind of work, and work charged to credits needs credit. Jobs also pass the job gate (`src/server/automation/job-gate.ts`): a pause by the agency or the workspace stops AI work jobs, which it did not before 2026-10-25. A signed-in session of a suspended workspace is refused (`requireOrgContext`).
3. **A meter.** Every model call is recorded once, with the tokens the provider reported, under `ai:<feature>` (`src/server/llm/meter.ts`). `tests/llm-callers-metered.test.ts` scans the source: a caller that neither meters nor is listed with a reason fails the suite. Where no unit rate is published the line is recorded at zero cost; no price is invented. A provider that reports no token counts leaves a "no_usage" result, which is a gap in the data, not a free call.
4. **A rate limit or a cap** specific to the entry point (below).
5. **A kill switch** for the public surfaces: `WEBCHAT_PUBLIC_DISABLED`, `PROPOSALS_PUBLIC_DISABLED`, `INVOICES_PUBLIC_DISABLED`, `REVIEWS_PUBLIC_DISABLED`, `DEMO_PUBLIC_DISABLED` answer "temporarily unavailable" for every workspace before any database read.

## Limits that exist (`src/server/security/rate-limit.ts` and the module services)

* **Public visitors:** the prospect demo (6 starts an hour per address, 3 per mailbox, 6 messages a minute per prospect, 40 an hour per address); the website chat (per-workspace daily AI reply allowance `WEBCHAT_DAILY_AI_REPLIES`, proposed 500 per UTC day, plus a per-widget daily session limit and a per-session message limit); proposal pages (120 a minute per address before any token is looked up, per-token and per-code limits); the purchase link (view 120 per 15 minutes, start 10 an hour, checkout 12 an hour per address and 8 an hour per purchase, return 120 per 15 minutes); public booking, forms and the public CRM API each have their own.
* **People:** AI messages (30 a minute per user for an employee chat, 20 for help, 20 for AQi, 40 an hour for inbox AI, 20 an hour for AI help on requests, 25 an hour for onboarding assist per workspace, 40 for website assist), uploads (30 an hour), top-ups (10 an hour per workspace), and the sign-in, reset and invitation limits.
* **Automation Studio:** 60 outside calls a minute per connection, 5 confirmed tests an hour per connection, 30 connections an hour per workspace, 60 builder messages an hour per user, and the plan's own monthly limit.
* **Customer replies by an AI employee:** counted since migration 0104 (`customer_reply` usage kind), with an **optional** monthly cap per workspace (`usage_limits.monthly_customer_replies`). Null by default; when set and hard stop is on, no further model call is made for a customer message that month, an internal note is left and a person is asked to reply.
* **Scheduled work:** a tick budget; the scheduler is off in production, and `SCHEDULER_JOBS_ONLY` fails closed (a typo runs nothing). The three jobs that message customers (`invoiceReminders`, `reviewRequestBatches`, `customerPaymentReconcile`) are named by the founder before they join a stage.

## What is deliberately not capped

* **No platform usage limit ships.** Fair use is measured (storage, website bandwidth and requests, AI employee runs, lead research, stored messages) and every measure reads "No limit set" until the founder chooses numbers (`docs/fair-use-and-inactivity.md`). Warnings notify; only new uploads can be refused; nothing is switched off or billed because of usage.
* **No model price is published**, so `metered_usage_events` shows tokens at zero cost wherever no rate has been published for provider `llm` (neither the code nor any seed publishes one; what the hosted table holds was not read). Credits are therefore not consumed by model use until the founder publishes a rate.
* **The customer-reply cap is blank**, and the web chat allowance (500 a day) and the demo limits are proposals.

## Residual cost risks

1. **No hosted measurement.** Nothing here was measured against a real model, an SMS gateway or a database host. The meter's zero-cost lines will show volume, not money, until a rate is published; the founder should publish an `llm` rate (even a rough one) before the first live workspace so the credit balance means something.
2. **Public AI surfaces rely on the daily allowance and the kill switch.** A burst of distinct visitors can spend the whole day's allowance for one workspace in minutes (that is the allowance doing its job; it also means a chat widget on a busy site can run dry early). The platform-wide stop is the environment switch.
3. **The tick budget** (195 s of worst-case provider waits against a 120 s ceiling) needs a decision before the scheduler starts.
4. **Lead research (Hermes)** is bounded per workspace per hour (`researchByOrg`, 20) but its provider cost is unmeasured because no live profile exists.
5. **Storage:** social media has a managed cap (`SOCIAL_MEDIA_STORAGE_MB`, proposed 2048); document, proposal and website storage have measures but no cap.

## Tests that guard this

`llm-callers-metered`, `llm-callers`, `llm-usage`, `customer-reply-usage` (8), `ai-job-gate` (8), `webchat-switch`, `fair-use-inactivity`, `aqi-cost-controls`, `scheduler-job-allowlist` and `scheduler-job-allowlist-phases`, `environment-safety`, `payment-gate`, plus the rate-limit assertions in each module's own tests.
