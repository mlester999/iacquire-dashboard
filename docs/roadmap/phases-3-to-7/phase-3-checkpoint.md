# Phase 3 checkpoint report: AI website acquisition and lead attribution

Date: 2026-10-23. Branch `feat/phases-3-7` (local commits only), base `36bf78c`. Nothing pushed, deployed or applied to any hosted database.

## 1. What was built

**Embeddable AI website chat.**

* A widget script (`/widget/chat.js`, Shadow DOM, no secrets) that any website can embed with one `<script>` tag naming a public key. Website Studio sites get it automatically (nonce'd script, CSP extended by the portal origin only).
* A public API (`/api/public/webchat/*`): workspace named by the widget key plus the browser's Origin allowlist, CORS echoed only for allowed origins, per-session, per-address and per-day rate limits, 16 KB body cap, opaque hashed session tokens.
* Visitor flow: chat, optional lead form (never / offered / required) with workspace-defined qualification questions, privacy notice, consent recorded with the exact wording shown (marketing consent only from a ticked box), handoff to a person, offline and failure fallbacks, business hours.
* Safety: details a visitor types are unverified and never merged into an existing contact (a possible match is flagged for a person to review); the AI sees only the knowledge sections the owner ticked, cannot state a price that is not approved, cannot leak its instructions; every failure becomes an internal note, an escalation and an honest visitor message.
* The chat is a conversation of the Unified Inbox (channel `web_chat`): filter, thread, takeover, pause, ownership fence, escalation, customer drawer with the chat card and attribution, lead scoring (Phase 2), notification kind `web_chat_lead`.
* Management page (Website, Chat): install snippet, allowed sites, health checks that report evidence (last time a real page loaded the chat, whether the AI employee is on, whether credits and a calendar exist), look and wording, AI employee, form, knowledge, limits and retention, activity counts and recent chats.
* Retention job `webChatRetention` and erasure of chat and attribution data inside contact redaction.
* Five Automation Studio triggers: chat started, lead captured, qualification completed, booking requested, source recorded.

**Lead attribution and ROI.**

* Append-only `lead_touches` (form, chat, call, manual), each saying whether the source is known, inferred or unknown and from what evidence; first and latest touch recomputed from history; nothing is ever labelled "direct".
* Manual campaign costs (owners and managers, audited).
* Lead Sources & ROI report: leads, qualified, appointments, deals, won deal value (labelled as deal value), cost, cost per lead (only for an entered, single-currency cost wholly inside the period), return on spend (only with verified revenue, which does not exist until Phase 5; the report says "Needs verified payments"). Contact page card with history and a "Record a source" form.

Migrations: `0087_website_chat`, `0088_lead_attribution` with rollbacks that refuse while data exists. Next free number: 0089.

## 2. How it was verified

See `verification-evidence.md` for exact output. In short: full suite 327 files, 5,104 passed, 1 skipped, 0 failed; both typechecks clean; eslint 0 errors; clean build passed; migration rehearsal A-E ok on embedded Postgres; browser QA of the widget on a different origin and of the portal pages at 375 and 1280 px, light and dark, with axe and computed contrast. Browser QA found and fixed more than a dozen defects (the main ones are in the evidence file), including a real accessibility failure in the widget's dark mode, an iOS zoom trigger, a raw internal key shown in the Inbox thread, system notices labelled as a teammate, and a health line that disagreed with what the chat actually does.

## 3. Status by evidence class

Never collapsed: a feature is only as proven as its highest row that is checked.

| Capability | Built | Locally tested | Integration-tested (embedded Postgres, real internal services) | Browser-QA'd (isolated app, simulated model) | Real provider | Deployed | Production-verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Widget and public API | yes | yes | yes | yes (external origin) | no | no | no |
| Website Studio auto-install | yes | yes | yes | **no** | no | no | no |
| Lead capture, consent, possible match | yes | yes | yes | yes | no | no | no |
| AI replies (grounding, price and leak rules) | yes | yes (stubs) | yes (stubs) | yes (simulated model) | **no real model** | no | no |
| Handoff and Inbox display | yes | yes | yes | yes | n/a | no | no |
| Booking through chat | yes | yes (simulated provider) | partial | no | **no calendar** | no | no |
| Attribution touches and manual source | yes | yes | yes | yes | n/a | no | no |
| Sources report, costs, cost per lead | yes | yes | yes | yes | n/a | no | no |
| Return on spend / verified revenue | gated | yes (gate) | yes (gate) | yes (gate shown) | needs Phase 5 | no | no |
| Retention and erasure job | yes | yes | yes | no | n/a | no | no |
| Automation Studio triggers | yes | yes | yes | **no** (editor not opened) | n/a | no | no |
| Migrations 0087 and 0088 | yes | n/a | rehearsed up, down, up with data | n/a | n/a | **no** | no |

## 4. Status estimates

* **Feature completeness of Phase 3: about 90%.** Everything in the Phase 3 scope exists and works locally. The remaining tenth is: the Website Studio site path in a real browser, the five triggers in the Automation Studio editor, the native-calendar booking path through chat, and verified-revenue ROI, which is deliberately gated on Phase 5.
* **Production readiness of Phase 3: about 35%.** Method: fifteen gates, each counted only with evidence. Met (6): full suite green, typecheck and lint clean, clean build, migration rehearsal incl. RLS, browser QA with accessibility on an external origin, public-API abuse checks (Origin, body cap, bad key, rate-limit tests). Not met (9): real language model evaluated; Hermes provisioned; hosted migrations applied; deployed; scheduler job run live; Website Studio path browser-verified; load and latency measured for the public API (not measured at all); legal review of the privacy notice and consent wording; monitoring and alerting for the public endpoint (none added). The number is not precise; it is a count of gates, and the unmet ones are the ones that matter most for real visitors.

## 5. Blockers and approvals

Full list in `blockers.md`. The ones that decide whether Phase 3 can reach customers: founder approval to apply 0087 and 0088 to the hosted database (backup, dry run, one at a time) and to push; Hermes activation and a model evaluation; the scheduler stage that includes `webChatRetention`; legal review of the consent wording. None of these blocks local work on Phase 4.

## 6. Risks to know about

* The AI is the only thing standing between an anonymous visitor and a false statement on the business's behalf. The price, leak and knowledge-scope rules are tested against stubs; they have not been tested against a real model's behaviour.
* The public endpoint is unauthenticated by design. Rate limits are per session, per address hash and per day, tested; they have not been load-tested.
* The widget script is cached by browsers for five minutes, so a bad release takes that long to retract.

## 7. Next phase

Phase 4 (AI Social Media Manager): nothing exists in the tree. First step is an audit, then migration `0089`, then the durable, idempotent publishing pipeline built against a simulated provider only. No live publishing without approval.
