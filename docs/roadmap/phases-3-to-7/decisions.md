# Decisions

## D1. Website chat is a conversation channel of the Unified Inbox, not a parallel system (Phase 3)

`conversations.channel` and `conversation_messages` gain `web_chat`. The shared provider `Channel` type (sms, whatsapp, email), `messaging_channels`, consent events, suppressions and templates do not change: a web chat reply is stored and delivered to the open widget, never sent through a provider. This gives website chat the Inbox, takeover, pause, ownership fence, escalation, CRM context and lead-scoring events for free, without touching the send chain that 124 files depend on. The cost is a `ConversationChannel` type for conversation rows and a small number of exhaustive maps that must learn `web_chat`.

## D2. A web visitor is never merged into an existing contact

A visitor can type any email address or phone number. Matching it to an existing contact would let a stranger attach their conversation (and read the AI's context, which includes that contact's confirmed facts) to someone else's record. Chat sessions therefore get their own contact; an exact match with an existing contact is recorded as a "possible match" for a person to review and merge with the existing merge tool. The AI's memory scope for a web chat is the session's contact only.

## D3. Tenant identity comes from the host or the widget key, never the request body

External sites use a public widget key (not a secret; it names the widget) plus an Origin allowlist. Website Studio sites use the host the proxy routed (same-origin `/__iaq/chat/*`). Browsers set Origin and cannot forge it, so the allowlist stops another site from embedding a tenant's widget; non-browser clients are limited by rate limits, session tokens and the fact that the key grants only the visitor chat surface.

## D4. Attribution never invents

Touches record only what the visit carried (UTM, click ids, landing page, referrer) or an authorized person's manual choice, and say which. First touch is never rewritten. Revenue shown is the value of deals marked won, labelled as deal value; it is not "revenue" until Phase 5 supplies verified payments. Cost per lead and ROI need explicit, manually entered campaign costs and are hidden when inputs are missing.

## D5. No new AI Employee identities

Website chat is answered by the conversation's AI employee (default `sales_assistant`, with the Appointment Setter reachable by handoff). No "website assistant" employee is created.
