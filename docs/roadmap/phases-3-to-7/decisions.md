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
