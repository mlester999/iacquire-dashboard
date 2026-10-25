# Journey verification (eight business journeys)

Last updated: 2026-10-25, branch `feat/phases-3-7`. For each journey: what is tested in Node on embedded Postgres, what was driven in a real browser against the isolated QA app, what is simulated, and what has **not** been shown. "Simulated provider" means a local stand-in written from documentation; a journey whose required external step used one is never marked "verified with the provider". Nothing here was pushed, deployed or run against a real provider.

`node scripts/journey-evidence.mjs` prints, per journey, how many test files and tests belong to it by file name, and counts of titles that mention each safety category. Treat the counts as a map to look at, not as proof: a title that does not say "provider failure" can still test one (the missed-call suite does), and a high count proves nothing about quality.

| # | Journey | Test files | Tests | Browser evidence (isolated app, 1280 and 375 px, axe) | Real provider evidence |
| --- | --- | ---: | ---: | --- | --- |
| 1 | Purchase to operational client | 37 | 473 | Purchase checkout 71 checks, held-purchase release and close, maintenance payment 20, onboarding (all 47 questions), demo funnel | None |
| 2 | Lead acquisition | 20 | 288 | Lead pages and Lead Sources (earlier phases); the website chat widget was **not** driven in a browser in this pass | None |
| 3 | Missed-call recovery | 5 | 108 | Phase 2 pages (earlier pass) | None (the SMS provider's write switch is off everywhere) |
| 4 | Automation Studio | 24 | 460 | Signed-in upgrade and editor QA (58 checks, earlier pass) | None (no n8n, Slack or HTTP target was called) |
| 5 | Social acquisition | 26 | 458 | Phase 4 pages (earlier pass) | None (simulated platform only) |
| 6 | Sales closing (proposal, signature, invoice, payment) | 106 | 1,983 | Invoice delivery (an accepted and a refused send), invoice from proposal, the public pay page | None (PandaDoc, PayMongo and PayPal adapters ran against replaced HTTP layers and a simulated provider) |
| 7 | Support and client operations | 55 | 985 | Requests: support, change, survey, issue report, feedback, attachments, reopen, notifications | None |
| 8 | Subscription lifecycle | 10 | 104 | Online plan payment, a walk-away, a replay, a refund report, the dialog at 375 px | None (simulated PayMongo) |

## What each journey proves, and what it does not

### 1. Purchase to operational client
* **Tested:** the frozen price; the public link (hash only, expiry, rotation); the buyer's confirmation; the online checkout (exact stored amount, the provider's signed notice as the only way to "paid", mismatch, wrong mode, replay, duplicate, late and cancelled-purchase payments, refund and dispute before and after the workspace exists); releasing or closing a held purchase; automatic provisioning under the inviter's re-read permissions, its failure and recovery; the canonical setup payment and clearance; six employees in "Setup required"; the payment gate on activation; cross-workspace and role refusals; audit and timeline rows.
* **Browser:** the whole buyer and Super Admin path, including the cancel-and-return case, the phone layout (one real defect found and fixed), the capture mailbox invitation.
* **Not shown:** PayMongo's real payload shapes; a real invitation email; the buyer accepting the invitation and setting a password in one run with the purchase (each piece is tested, the chain is not one test); any hosted migration.

### 2. Lead acquisition
* **Tested:** website chat sessions and the visitor-typed-contact consent rule, attribution and lead touches, lead sources with verified revenue, research requests and review queue (deterministic parts), scoring rules.
* **Not shown:** a real visitor on a real site; real lead research (needs a live Hermes profile); the chat widget in a browser under the kill switch and the daily cap.

### 3. Missed-call recovery
* **Tested** (`missed-call-detection`, `missed-call-recovery-engine`, `missed-call-ops`, `missed-calls-pure`): one case per missed call and per number, redelivery changes nothing, answered-after-all cancels the case, ambiguous numbers link nobody, withheld numbers get no message; the text goes only through the send chain, after the policy delay, quiet hours and opening hours, never without consent or after an opt-out, never into a conversation a person owns, one text under two workers, a provider that refuses the message is recorded as failed and not sent, the switch-off case fails honestly and tells the team; assignment with a stale version, role refusals, another workspace's cases invisible, activation by a person.
* **Not shown:** a real call or a real text; the scheduler (never run); revenue (the screen reports none it cannot see).

### 4. Automation Studio
* **Tested:** the engine, versions, connections, entitlement and lapse (a lapsed plan pauses Studio workflows only; core CRM, core AI schedules, external automations and data keep working), run history and retries.
* **Not shown:** a real n8n instance or Slack workspace; the 58-check browser run was an earlier pass and was not repeated.

### 5. Social acquisition
* **Tested:** accounts and their lifecycle, the publisher with its workspace gate, media storage entitlement, metrics, drafts and the invented-claims filter (a pattern list), tracked-link lead attribution, offboarding.
* **Not shown:** a real Meta account (blocked on app review); any live post.

### 6. Sales closing
* **Tested:** proposals (editor rules, link token, one-time code, acknowledgement), e-signature (state machine, voiding, copies), invoices (issue, frozen amounts, reminders on the consent chain), customer payments (adapters, webhooks, reconciliation), invoice from an accepted proposal, verified revenue.
* **Not shown:** PandaDoc, PayMongo or PayPal for a client; counsel-approved wording (blocked).

### 7. Support and client operations
* **Tested:** requests lifecycle, change orders and prerequisites, surveys (in-app, one question), workload, staff messages, Phase 6 cross-module operations, offboarding.
* **Browser:** the full Requests path including the internal note staying internal.
* **Not shown:** a real email or Slack notification delivery.

### 8. Subscription lifecycle
* **Tested:** requested, active, past due, expired, cancellation, grace, reactivation, renewal reminders, provider-verified periods (continue from the paid-through day or start today, replay, refund report, a plan that cannot take a payment), entitlement helper agreement across every gate, cross-workspace plan refusal.
* **Not built:** a charge the provider makes by itself (only a checkout per period exists); PayPal.
* **Not shown:** PayMongo itself.

## Open gaps across all eight

1. No journey has run against a real provider, and none can without the founder's approvals and accounts (`docs/roadmap/phases-3-to-7/blockers.md`).
2. The scheduler has never run, so every scheduled stage of every journey (renewal reminders, missed-call follow-ups, social publishing, reviews) is verified only through injected clocks.
3. Real AI behaviour (replies, research, drafts) is verified only against simulated models.
