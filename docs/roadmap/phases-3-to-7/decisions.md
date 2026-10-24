# Decisions

## D1. Website chat is a conversation channel of the Unified Inbox, not a parallel system (Phase 3)

`conversations.channel` gains `web_chat`. The shared provider `Channel` type (sms, whatsapp, email), `messaging_channels`, consent events, suppressions and templates do not change: a web chat reply is stored as a `conversation_messages` row (provider `web_chat`) and delivered to the open widget, never sent through a provider. This gives website chat the Inbox, takeover, pause, ownership fence, escalation, CRM context and lead-scoring events without touching the send chain that 124 files depend on. The cost is a `ConversationChannel` type for conversation rows, a branch at the top of `queueOutbound` (`queueWebChatOutbound`, which keeps the ownership fence, pause, escalation-pending check and automation gate), and a refusal in `evaluateSend`.

## D2. A web visitor is never merged into an existing contact

A visitor can type any email address or phone number. Matching it to an existing contact would let a stranger attach their conversation (and read the AI's context, which includes that contact's confirmed facts) to someone else's record. Chat sessions therefore get their own contact; an exact match with an existing contact is recorded as `possible_match_contact_id` for a person to review and merge with the existing merge tool. The Inbox shows that as a note with a link; nothing is linked automatically. Details a visitor types are stored as unverified and shown as unverified.

## D3. Tenant identity comes from the widget key plus an Origin allowlist, never the request body (revised)

External sites use a public widget key (`wk_` + 24 characters; not a secret, it names the widget) and the browser's Origin must be on the widget's allowlist (exact hosts, one-level `*.` wildcards; the workspace's own Website Studio hosts are allowed automatically). CORS is echoed only for an allowed origin. Browsers set Origin and cannot forge it; non-browser clients are limited by rate limits (per session, per address, per day), session tokens and the fact that the key grants only the visitor chat surface of one workspace.

**Revised from the first plan.** The first plan served Website Studio sites' chat same-origin (`/__iaq/chat`). The audit found that the site runtime database role `iaq_site_runtime` has no table privileges (by design), so it cannot serve chat. Website Studio sites therefore load the widget from the portal origin like any other site: the site's CSP `connect-src` gets only the portal origin, a nonce'd `<script>` is injected in `site-runtime/[host]/p/[[...path]]/page.tsx`, and the runtime role may call exactly one security-definer function, `app.site_chat_widget(p_host)`, which returns the public key for a verified host with a live publication whose workspace turned the chat on.

## D4. Attribution never invents

Touches record only what the visit carried (UTM, click ids, landing page, referrer) or an authorized person's manual choice, and say which (`known`, `inferred`, `unknown`). The classification precedence is manual, UTM, paid click id, referrer (inferred), channel for a phone call (inferred), unknown, and "direct" is never a result. The touch history is append-only; the first and latest pointers are recomputed from it, so a touch that arrives late but happened earlier becomes the first touch. Revenue is never shown: won deal value is labelled as deal value (verified revenue needs Phase 5 payments). Cost per lead needs a manually entered cost wholly inside the period and a single currency; return on spend needs verified revenue and a cost above zero, and says what is missing otherwise.

## D5. No new AI Employee identities

Website chat is answered by the conversation's AI employee (default `sales_assistant`; the Appointment Setter is selectable and reachable by handoff). No "website assistant" employee exists. The widget's `ai_enabled` switch is the autopilot authorization for the channel.

## D6. The visitor-facing AI sees only what the owner ticked

The generator receives only the company-knowledge sections selected for the widget, approved and not risk-flagged. A price is blocked unless it appears in the approved prices (`ungroundedAmounts`); instruction-leak text is blocked; the visitor's text is wrapped in a delimited block; failures become an internal note, an escalation and a visitor-visible system message. The real language model has never been evaluated against this prompt (only stubs and the simulated QA model), and that is stated everywhere it matters.

## D7. Visitor session tokens

An opaque 32-byte token, stored only as a sha256 hash, sent as a Bearer header, kept in `localStorage` only after the first message (so a visitor who never writes leaves nothing behind). The visitor's address is stored only as a keyed hash for rate limiting.

## D8. Retention and erasure are part of the feature

A daily job (`webChatRetention`) deletes anonymous chats after `anonymous_retention_days` and others after `retention_days`, and removes the chat-made contact only when it is still empty. `redactContact` also erases the contact's chat sessions and attribution touches.

## D9. Source names are stored normalized and read back readably

Stored source names are lower case with hyphens. The display label raises the first letter and reads hyphens as spaces ("trade-show" shows as "Trade show"); typing that label back stores the same name, so a label and its stored name never drift apart.

## D10. QA findings are fixed where they are found, including in Phase 1 and 2 code that the new feature exposes

Two small fixes landed in the Inbox thread. The scrollable message log was not keyboard-focusable (a gap already present in Phase 1; axe flagged it). System-authored messages were labelled "Teammate"; website chat adds system notices to the thread (for example "I've asked a team member to join"), so they now read "Automatic notice". One shell issue was found and left alone: the sidebar's AI-employee links have an accessible name that does not contain their visible text (axe `label-content-name-mismatch`, six or seven nodes on every portal page); it is not part of this work and is listed in `blockers.md`.

# Phase 4: AI social media manager

## D11. Meta first, behind an adapter, with a simulated twin that production refuses

Facebook Pages and Instagram professional accounts (reached through their linked Page) are the only providers. Every provider call goes through one adapter interface (`providers/types.ts`): `meta` talks to the Graph API, `simulated` is an in-process platform used by tests and browser QA and is refused in production (`simulatedAllowed`). The Meta adapter has only ever run against a replaced HTTP layer; endpoint and permission names must be re-read against Meta's current documentation before the app is submitted for review (stated in `meta.ts` and `meta-oauth.ts`). A future provider is another adapter; none is claimed.

## D12. An approval is of an exact version, and nothing the person did not read can go out

`social_posts.version` bumps on every change to what will be posted; an approval stores `approved_version`; a scheduled post must have `approved_version = version`. Any edit to caption, hashtags, link, media or account voids it and returns the post to draft. AI drafts (origin `ai`) always need a person's approval, whatever the settings (`approval_for_publishers` only adds a second person for people who could publish anyway), and a duplicate of an AI draft stays an AI draft. Approve belongs to the client's owner and admin; the agency never approves what a client publishes. Every approval, edit, schedule, cancel, retry and publication is a row in `social_post_events` with its actor.

## D13. Publishing is a leased, resumable, idempotent job with two write switches

One live job per post (partial unique index), an idempotency key of post:version:instant, a lease a restarted worker takes over, and `state` that records each provider step (container created, publish sent, provider post id, done) so a resumed job continues instead of repeating. A lost answer becomes `needs_reconciliation`: the publisher asks the platform whether the post exists before anything is re-sent, and a person resolves what it cannot decide. Real publishing needs both the environment switch `META_SOCIAL_WRITES_ENABLED` and an account whose adapter is `meta`; the scheduler jobs are off in production until their stage is started. A job also checks the workspace gate (`org-gate.ts`, the platform's outbound-automation rule) so a suspended, paused or shut-down client's posts stop. A post more than six hours past its time when first claimed is not sent (D20), so switching publishing on later never posts stale content.

## D14. Credentials are sealed server-side and never readable by the application role

Account credentials are AES-GCM sealed JSON in `social_accounts.credentials`, a column the application role has no grant on (column-level grant list in 0089); the sign-in state table is server-only (no grant at all) and holds the encrypted Page choices for ten minutes only. Nothing sealed is returned to a browser, a server-action result, an audit row or a log. Deauthorize and data-deletion callbacks verify Meta's signed request (HMAC-SHA256, constant time) and revoke by provider user.

## D15. Honest connection states and what stops publishing

`connected`, `needs_reauth`, `error`, `revoked`, `disconnected`. Disconnect, revoke and needs-reauth cancel queued jobs and fail the affected scheduled posts with a plain message ("Reconnect it and schedule it again"); a post whose outcome is unknown stays flagged for a person. A transient health failure does not change an account's state (review finding). Reconnecting a Page moves its unfinished posts to the new connection.

## D16. Media: managed storage with a cap, client drives as an honest "not available"

Uploads go to the private bucket `social-media` through the existing private-file service; reading needs `social.view`, writing `social.create`. Only managed-plan workspaces may upload, and managed storage is not unlimited: a per-workspace cap (default 2048 MB, `SOCIAL_MEDIA_STORAGE_MB`; the default is a proposal the founder must confirm). Google Drive and OneDrive appear as "not available yet" because no OAuth app exists. Files are validated by content (magic bytes, dimensions, EXIF orientation) and per platform (Instagram: JPEG, 4:5 to 1.91:1).

## D17. AI help is a user-invoked drafting helper, not a seventh employee

Ideas and captions are generated from approved, non-risk-flagged company knowledge only, tone and brand-voice note included, and the output is filtered for invented prices, percentages, offers, testimonials and statistics. Every result is a normal editable draft. It is not an AI Employee: no employee identity, tool or memory is involved. The only employee involvement is the Performance Analyst's read-only social review (failed or unconfirmed posts, approval backlog, accounts needing reconnection, and engagement or campaign patterns only where enough returned numbers exist). A dedicated social-media specialist employee is a possible future product decision and is not created here.

## D18. Analytics show only what the platform returned, and leads are tied to a post only by evidence

A metric the platform did not return is absent, never zero. Reach, impressions and clicks are not collected (insight permissions are not requested). A lead is tied to a post only when its own recorded visit (a Phase 3 `lead_touches` row) carried the post's tracking code in `utm_content`, and an outcome counts only if it happened after that visit. Posts that cannot carry a code (no link, links off, Instagram captions) read "Not tracked". Likes and views are never described as sales.

## D19. Social media belongs to the client workspace

Accounts, approvals and publishing are the client's; the section is hidden from and refused in agency workspaces. An agency-side surface for working inside a client's calendar is a possible later task.

## D20. Decisions taken after the Phase 4 review (summary of the fix brief)

* Overdue posts: more than six hours late at first claim means "not sent" with a notice (one constant).
* Links: https only, case-insensitive in the database, scheme lower-cased, validated before any write.
* A tracked link always carries its own code in `utm_content`.
* Token expiry: a warning to owners and admins seven days before a token or data-access expiry.
* AI helper: per-user hourly and per-workspace daily rate limits.
* Failure notifications and automation events are keyed per failed job, so a retry that fails again is announced again.

# Phase 5 Wave 1: decisions taken after the adversarial review (2026-10-24)

The review of proposals and signing, customer invoices and payments, reputation, AI metering and the consent rule for visitor-typed details found 43 defects. These are the decisions that shape what was built to fix them; the number in brackets is the one in the fix brief. The module documents say what the code does ([../../proposals.md](../../proposals.md), [../../invoices-and-payments.md](../../invoices-and-payments.md), [../../esignature.md](../../esignature.md), [../../voice-and-reviews.md](../../voice-and-reviews.md), [../../production-scheduler.md](../../production-scheduler.md)).

## D21. A closed dispute never restores money on a guess (fix brief D1)

The closing event carries an outcome. Won restores the payment; lost first records a refund with the source `chargeback` for the disputed amount, and the payment and invoice follow what the rows add up to; unknown or missing keeps the payment disputed, tells the owners and managers and shows it on the invoice. An owner can also open and close a dispute by hand (`invoices.refund`), which is the only way to represent a reversal that is never followed by a resolution.

## D22. A test payment belongs to a test invoice (fix brief D2)

Test-mode payments are recorded only on an invoice made on purpose as a test invoice (`customer_invoices.is_test`, in the unreleased `0093`); a test invoice is labelled everywhere, never reminded and never counted in receivables, overdue, verified revenue or the deal rule. A real invoice never gets a test payment. Built in `0093`: the mark is the owner's alone and fixed once the invoice leaves draft, the database refuses a test-mode payment on a real invoice and a live or hand-recorded payment on a test invoice, and a test invoice has its own `TEST-` numbers.

## D23. A PayPal delivery while real provider calls are off is refused, not stored (fix brief D3)

The route answers 503 with Retry-After before any outbound call and stores nothing; PayPal sends it again, and the scheduled read-back of open checkouts records the payment once `CUSTOMER_PAYMENTS_WRITES_ENABLED` is on. A PayMongo delivery is still recorded, because its signature is checked locally.

## D24. Agency read of proposal documents needs a support session; the proposal tables stay as built (fix brief D4)

The `proposal-documents` bucket requires an active support session for an agency caller (`app.file_permission`, migration `0090`). The proposal tables keep the `proposals.view` read policy, which does not: **a founder decision still open** (recorded in the header of `0091_proposals.sql` and the `proposals.view` note in `src/lib/permissions.ts`). No screen shows an agency person those records today.

## D25. The "typed by a visitor" fact belongs to the address and to the consent event (fix brief D5)

A merge never turns an unverified typed address, or the consent ticked with it, into a verified-looking one. The send rule reads the identity (`contact_identities.typed_by_visitor`, `verified`, `verified_via`), not the contact's `created_via`.

## D26. A public survey answer is attributed only through a verified identity (fix brief D6)

An answer that matches an existing customer only by a typed email or phone is stored unattributed, with the possible match kept for staff, and triggers nothing about that customer until a person confirms the match. A match to a verified identity attributes as before.

## D27. Holds and suspensions reach what is already queued (fix brief D7)

A person's hold on automatic messages withdraws already queued automatic review asks and invoice reminders in the same transaction and is checked again when the dispatcher sends. A suspended or archived workspace's queued review-batch messages are held (the batch job considers every workspace and lets its own gate park them), and system sends of scope retention and billing are gated on the workspace being allowed to send at dispatch.

## D28. Messages waiting for a sending window count against a batch's pace (fix brief D8)

Releasing the window never releases more than the approved pace per minute.

## D29. Every model call checks the workspace first and is metered (fix brief D9)

Lead scoring and every model call check the workspace is active and has credit before calling; the web chat reply check runs the shared claim check and covers singular currency words, every supported currency code and P/Php prefixes; the published token rate is per 1,000 tokens; the website assistant, onboarding assist and employee generator are metered; a source-scan test lists every file that imports `llmComplete`.

## D30. Reconnecting a review location adopts what is there; a reply permission error switches off replies only (fix brief D10)

Reconnecting the same location adopts the old mirror rows and replies and replaces the credentials in place. The Facebook sign-in can ask for the review permissions as an option, `canReply` comes from the Page's granted scopes, and a permission error while posting marks the reply failed and turns `can_reply` off without marking the connection as needing to be reconnected.

## D31. The public pages have their own emergency stops (fix brief D11)

`PROPOSALS_PUBLIC_DISABLED`, `INVOICES_PUBLIC_DISABLED` and `REVIEWS_PUBLIC_DISABLED`, all off by default: the customer's page and its routes answer "temporarily unavailable" before any database read. Each leaves alone what it should not stop (money that arrives, the team's own screens, requests and reminders already sent); the table is in [../../production-scheduler.md](../../production-scheduler.md).
