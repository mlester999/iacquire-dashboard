# AQi — platform assistant (Phase 2)

AQi is the official iAcquireOS platform assistant. It is **not** one of the AI employees and it
does **not** use the Hermes employee gateway. It has its own identity, configuration versions,
knowledge, conversations, messages, feedback and usage records.

## Status

| Capability | Status |
| --- | --- |
| AQi identity, floating launcher and chat panel | Locally verified |
| Real provider request path + token streaming | **Live controlled probe passed** against the existing production DeepSeek credential: `deepseek-flash`, OpenAI format, `OK` response and one real SSE delta; no customer data |
| Streaming fallback for a non-SSE JSON answer | Locally verified |
| Conversation persistence, rename, delete, history | Locally verified; only explicitly saved chats appear in history |
| Chat close, temporary conversation state and explicit Save/Discard/Delete | **Locally/browser verified**: X only hides; the app-shell mount keeps messages, draft, scroll position and active streaming; Close, Save, Discard and Delete are separate actions |
| Hosted migration 0052 | **Prepared/local only**; `saved_at`/`saved_by`, existing conversations backfilled as saved. Not applied to hosted |
| Context-aware suggestions and approved route registry | Locally verified |
| Platform knowledge retrieval with role/page scoping | Locally verified |
| Super Admin configuration, knowledge, suggestions and publishing | Locally verified |
| Feedback and usage events | Locally verified |
| AQi budgets, model pricing, token-aware context and atomic spend reservations | Locally verified; migration 0048 **applied hosted 2026-10-18** |
| Support escalation through the existing Support system | Locally verified with explicit consent and duplicate suppression |
| Citation validation and stale-knowledge warnings | Locally verified |
| Intent-aware greetings, response length and page-context restraint | Locally verified; real DeepSeek greeting returned 8 words with no knowledge/page prompt |
| Clickable authorized navigation | Locally verified; real DeepSeek navigation answer produced a validated `Integrations` markdown link |
| Polished citations and source preview | Locally/browser verified: superscript markers, numbered readable source cards and preview modal |
| Copy, like/dislike and undo | Browser verified: real clipboard result, Copied! state, persisted selected feedback, reason + optional comment |
| RLS and user/tenant isolation | Locally verified |
| Provider resolution and role-aware errors | Locally verified with connected DeepSeek, status/credential failures, recovery after negative cache, client-safe messages and Super Admin diagnostics |
| Image, document and MP4 attachments | Locally verified: private storage, ownership, RLS, extraction, image dimensions, MP4 duration, history, deletion cleanup and cross-user denial |
| Emoji picker and composer | Locally/browser verified: categories, search, recent, cursor insertion, attachments, drag/drop, paste, progress, retry and mobile composer |
| AI image and video understanding | **Not implemented / not claimed**; media is stored, previewed and clearly marked as not inspectable by the current model |
| Live provider acceptance | **PASS (controlled provider probe)**; full AQi UI acceptance remains blocked by Vercel SSO |
| Hosted migration 0047 | **Applied 2026-10-18**; six AQi tables, RLS and seed data verified on the hosted project |
| Hosted migration 0048 | **Applied 2026-10-18**; budget/pricing tables and usage cost fields |
| Hosted migration 0049 | **Applied 2026-10-18**; private AQi attachment bucket, metadata, RLS and four policies |
| Production deployment | **`f74afac` deployed successfully by Vercel**; provider, budget, support, attachment/composer and GIF-removal changes are live. Conversational-intelligence changes in this working tree are **not deployed** |
| Production AQi provider | **Connected** (`deepseek-flash`, OpenAI format); controlled `llmComplete` and `llmStream` probes succeeded. The deployed build includes the resolution/error fixes |

## Reused infrastructure

- Existing server-side authentication, `OrgContext`, permission matrix and RLS.
- Existing LLM integration (`integration_connections` provider `llm`, Vault credentials) and the
  `resolveLlmConfig()` abstraction. AQi uses the same provider connection but its own model,
  instructions, knowledge and conversations.
- Existing safe Markdown renderer (raw HTML is escaped; links are protocol-checked).
- Existing shell, design primitives, dialogs and motion patterns.
- Existing support workflow (`/support`); AQi can create a real request only after explicit consent,
  through the existing Support service, and only reports the returned reference. It never claims a
  ticket exists without that result.

## Data model — migration 0047

`supabase/migrations/0047_aqi_assistant.sql` adds:

- `aqi_config_versions` — draft/published/archived configuration JSON, author and timestamps. One
  published version is enforced by a partial unique index.
- `aqi_knowledge_entries` — approved platform knowledge, category, optional route, optional role
  allowlist, source, status and version.
- `aqi_suggested_questions` — global, role and page questions with ordering and enabled state.
- `aqi_conversations` — user- and organization-scoped conversations.
- `aqi_messages` — user/assistant turns, streaming state, model, tokens, latency, page context and
  feedback.
- `aqi_usage_events` — privacy-conscious message/feedback/publish events.

The migration seeds a published AQi configuration, a set of approved platform articles and starter
questions. RLS allows a person to read/update/delete only their own conversations and messages;
published knowledge and configuration are readable, while all management writes go through
Super-Admin-checked server actions using the service role. Rollback:
`supabase/rollbacks/0047_aqi_assistant.down.sql`, which refuses while conversations exist.

Migration 0048 adds cost controls:

- `aqi_budgets` — global or organization monthly budget, per-user budget and enabled state.
- `aqi_model_prices` — configured input/output USD per million tokens. Missing pricing blocks a
  budgeted call rather than guessing.
- `aqi_usage_events` cost/reservation fields — reserved, recorded, released and failed spend,
  estimated-cost marker, configuration version and page route.

The budget reservation is made under a PostgreSQL advisory lock for the budget scope and includes
prior reservations, so two simultaneous turns cannot both pass the last of a budget. Provider
calls are rejected before they start when a budget is exhausted. See
[`0048_aqi_cost_controls.sql`](../supabase/migrations/0048_aqi_cost_controls.sql).

Migration 0049 adds private AQi chat attachments:

- `aqi_attachments` — conversation/message-scoped metadata, owner, organization, private-file reference,
  media kind, extraction status/text, image dimensions, video duration and soft-deletion state.
- A private `aqi-attachments` Storage bucket with a 50 MB object limit and image/document/video MIME
  allowlist.
- `app.file_permission` and the private-file bucket/size checks are widened only for this bucket and
  require a client `agents.use` permission. RLS restricts every row to its owner and conversation.
- Rollback: [`0049_aqi_attachments.down.sql`](../supabase/rollbacks/0049_aqi_attachments.down.sql),
  which refuses while attachment metadata exists.

Migration 0052 adds the explicit conversation lifecycle:

- `aqi_conversations.saved_at` — when the person explicitly saved the chat. `null` means the chat is
  temporary and never appears in history.
- `aqi_conversations.saved_by` — the person who saved it.
- Existing conversations are backfilled as saved, so the migration never makes previously visible
  history disappear.
- `aqi_conversations_saved_idx` supports the user/org history query.
- Rollback: [`0052_aqi_conversation_lifecycle.down.sql`](../supabase/rollbacks/0052_aqi_conversation_lifecycle.down.sql).
  Temporary rows are hidden from history immediately and are purged lazily after 24 hours of
  inactivity; saved rows are never touched by that cleanup.

## API

- `GET /api/aqi/bootstrap?path=…` — sanitized identity, suggestions, current page, allowed paths and
  provider health. No instructions, keys or other users' data.
- `POST /api/aqi/chat` — same-origin, authenticated SSE turn.
- `GET/POST /api/aqi/conversations` — list the signed-in person's **saved** conversations and start a
  temporary one. Listing also lazily purges stale temporary chats.
- `GET/PATCH/DELETE /api/aqi/conversations/[id]` — read with older-message cursor, rename, and delete a
  **saved** conversation.
- `POST /api/aqi/conversations/[id]/save` — explicitly promote a temporary chat to history.
- `POST /api/aqi/conversations/[id]/discard` — explicitly discard a temporary chat. The endpoint
  cannot delete a saved conversation.
- `POST /api/aqi/feedback` — thumbs up/down and optional comment.
- `POST /api/aqi/support` — explicit-consent escalation through the existing Support service,
  returning the real ticket reference or an honest failure.
- `POST /api/aqi/attachments` — same-origin authenticated multipart upload with server-side size,
  type, count, storage-quota and content validation.
- `GET/DELETE /api/aqi/attachments/[id]` — owner/conversation-authorized inline download (with video
  byte ranges) and deletion of unsent attachments.

All routes resolve the person from the session; none accepts a role or organization from the
browser. AQi never executes a model-generated tool call.

## Context and knowledge

The server builds the system prompt from:

1. immutable AQi policy (no action claims, no secrets, no cross-tenant data, no permission bypass);
2. the published editable identity/tone/greeting/instructions and conversation-behavior settings;
3. the server-resolved role, and only the routes that role may open — only for navigation/how-to turns;
4. published knowledge filtered by role and route, with `[K1]` source labels, only when the intent
   actually needs platform knowledge.

A lightweight classifier distinguishes greeting/small talk, clarification, navigation, how-to,
simple, complex, troubleshooting and follow-up turns. Greetings skip knowledge retrieval, page
context, route lists and citation rules, use a short output budget, and ask how AQi can help. A
greeting combined with a real question is classified by the question. Page context is injected only
for explicit page references such as “this page”. The prompt explicitly treats knowledge and user
text as data, not instructions. Unpublished knowledge and archived entries never reach ordinary users.

## Conversation behavior

- The intent classifier and `conversation behavior` settings control verbosity, greeting, navigation,
  follow-up and citation style.
- Responses must answer the question first and use plain conversational text for simple answers.
- Authorized internal paths are converted server-side to human-labelled Markdown links; unauthorized
  or external links are removed. The browser also validates links against the authorized route list.
- `[K#]` markers are internal. Valid markers are rendered as compact superscript numbers and the UI
  shows numbered, clickable source cards with a readable approved-source snippet; unsupported markers
  are removed. Sources are omitted when there are no valid citations.
- Casual replies never get a forced Sources section.
- The message toolbar supports real clipboard copy with a check/Copied state, persisted
  like/dislike, change/undo feedback, and a reason-plus-comment dislike form.
- Admin knowledge supports search and status filtering; conversation probes can test greetings and
  navigation without saving a conversation.

## Conversation lifecycle

AQi is mounted once at the application shell, not inside each page layout. Closing the panel,
expanding it, opening history, and moving between portal, chat and agency pages therefore keep the
same component and conversation in memory.

- **Close (X)** only hides the panel. It never deletes a message, resets the conversation, starts a new
  chat, aborts generation or shows a save prompt. Reopening restores the messages, active
  conversation, draft, attachment previews, feedback selections, scroll position and streaming state.
- **Save conversation** is explicit. A temporary chat is written while it is happening so streaming,
  attachments, feedback and budget accounting have real records, but it is hidden from history until
  the person saves it. Saving sets `saved_at` on the same conversation; it does not create a copy or a
  second provider request.
- **Discard unsaved chat** is explicit and only deletes temporary chats. It asks for confirmation when
  there is actual unsaved content. The discard endpoint cannot touch a saved conversation.
- **Delete conversation** is available only for saved history and requires confirmation. It deletes
  only the signed-in person's authorized row.
- **New chat** starts fresh. It asks before replacing an unsaved chat; saved conversations are never
  part of that replacement.
- A full browser refresh or tab end clears temporary UI state. Saved chats survive reloads and future
  visits. No chat content is stored in browser storage; temporary state is in-memory only.
- Streaming continues while the panel is hidden. An explicit **Stop** still cancels generation. If the
  page or session ends, the server records the partial answer as cancelled/failed and the next open
  shows the honest interrupted state.
- Logging out or changing accounts unmounts the widget and clears its in-memory state. Every save,
  discard, read and delete remains user- and organization-scoped under the existing RLS policies.

## Super Admin — `/admin/aqi`

The management screen has real tabs for Overview, Provider & model, Instructions, Conversation
behavior, Platform knowledge, Suggested questions, Testing & publishing, Version history, Usage &
health, Budgets & pricing and Messaging & attachments.

- Configuration saves create a draft; publishing archives the previous live version and records an
  audit event.
- Conversation behavior controls response verbosity, greeting style, navigation, follow-up and
  citation policy, safe fallback and role-aware guidance. These cannot override immutable security
  policy.
- Knowledge and suggested questions are editable, publishable, archivable, searchable and filterable;
  freshness review and source metadata remain visible.
- “Run test” calls the real configured provider with the editor's current configuration (including
  unsaved changes) and does not save a conversation. Quick conversation probes include greetings
  and a navigation question.
- Usage shows message/failure/rate-limit counts, helpful/not-helpful feedback, tokens, estimated cost,
  reservations and latency. Costs are computed from configured model prices, not invented provider
  invoices.
- Budgets & pricing configures a global monthly organization budget, a per-user budget, and model
  input/output prices. A budgeted call with no configured price is rejected.

## Attachments and composer

- Paperclip upload, multi-file selection, drag/drop, clipboard image paste, previews, upload progress,
  cancel and retry are implemented in the AQi composer.
- Images: PNG/JPEG/WebP, up to 10 MB and five per message by default.
- Documents: PDF/DOCX/TXT/CSV, up to 20 MB and five per message. PDF/DOCX text uses the existing bounded
  extraction pipeline; extracted document text is treated as untrusted evidence and cited as `[A1]`
  separately from platform knowledge `[K1]`.
- Video: MP4/WebM, up to 50 MB and 60 seconds, one per message. MP4 duration is parsed server-side;
  WebM is accepted only when its duration is readable. Video is playable in history but has no AI
  analysis.
- Emoji picker: categories, search, recent emoji through local storage, cursor insertion, Escape/outside
  close and keyboard buttons.
- The selected text model receives extracted document text only. It never receives image/video
  payloads and is instructed not to describe visual content. This is a stated limitation, not a fake
  vision capability.

## Modality matrix

| Provider / model | Text | Uploaded images | Uploaded documents | Uploaded video |
| --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash` (production, live probe) | **Yes** | Stored/previewed; **not sent** | Extracted text sent as untrusted context | Stored/playable; **not analysed** |
| OpenAI-compatible (local SSE tests) | Yes | Not sent | Extracted text sent | Not analysed |
| Anthropic (local SSE tests) | Yes | Not sent | Extracted text sent | Not analysed |

No image/video payload is sent to a provider, and no vision or video-analysis capability is claimed.
GIF messaging is not offered in AQi.
The admin UI labels both as unavailable rather than implying they work. Document understanding is
text extraction, not a multimodal model call.

## Security and honest limits

- Client users cannot open `/admin/aqi`; the page and every action check `agency_super_admin`.
- Agency pages in the route registry check their actual agency permission, not just an agency role.
- Conversation queries are user-scoped and RLS-protected; a second person cannot read another
  person's AQi chat.
- Temporary chat state is in memory at the application shell, never in `localStorage` or
  `sessionStorage`. Logging out or changing accounts unmounts it, and the server still enforces
  ownership on every save, discard, read and delete.
- A temporary chat is never silently promoted to history. Only the explicit save endpoint sets
  `saved_at`; closing the panel or navigating cannot save or delete anything.
- The route registry rejects external, protocol-relative and unauthorized navigation.
- Raw AI HTML is never rendered. Images in model output are suppressed.
- AQi budgets are reserved under an advisory lock before the provider call; concurrent turns cannot
  both pass the last of a budget, and exhausted requests are rejected before provider work starts.
- No credentials are returned to the browser; provider errors are reduced to a safe message.
- Support escalation requires explicit consent, shares only the bounded conversation, and reports a
  ticket only when the existing Support service returns a reference.
- No live provider response has been verified in this environment. The local QA run used a local
  OpenAI-compatible SSE server and is labelled **locally verified**, not live acceptance.
- AQi knowledge document upload/reuse is not part of this phase; knowledge is managed as approved
  text entries. The workforce PDF/DOCX pipeline is separate.
- Feedback supports an optional comment after a thumbs-down; the comment is stored but not yet
  shown in an Insights dashboard (Phase 3).
- Provider selection is through the existing global LLM integration. The verified integration model
  is authoritative unless a Super Admin enables the explicit AQi model override.
- AQi accepts `connected` or `permission_limited` connections and routes DeepSeek through the
  OpenAI-compatible adapter. Resolution failures are categorized (`status_not_eligible`,
  `credential_unavailable`, `endpoint_not_allowed`, etc.) instead of collapsing to a generic
  “no provider” response.
- Failed resolutions are not cached. A successful resolution is cached briefly; integration tests
  and changes invalidate it.
- Draft tests use the editor's current configuration, including unsaved changes.
- Hosted migrations through 0049 are applied. Migrations 0050–0052 in this working tree are
  local/prepared only and must be released through the staging-first gate before they are relied on.
- The local browser QA provider is simulated. Live provider acceptance was a separate controlled
  probe against the existing production DeepSeek credential, not a full deployed-UI run.
- Phase 3 items (visual highlighting, guided tutorials, full Insights dashboard) are not built.
- Temporary state is per browser tab. Another tab does not see an unsaved chat, and closing the tab
  cannot restore it; stale temporary rows are hidden immediately and purged after 24 hours.
- AQi is mounted on portal, AI-employee chat and agency admin routes. Auth, setup/onboarding and
  customer website hosts deliberately do not render the launcher.

## Verification commands

```bash
npx vitest run tests/aqi-migration-0047.test.ts tests/aqi-migration-0052.test.ts tests/aqi-conversation-lifecycle.test.ts tests/aqi-lifecycle.test.ts tests/aqi.test.ts tests/aqi-conversation.test.ts tests/aqi-attachments.test.ts tests/aqi-errors.test.ts tests/aqi-security.test.ts tests/aqi-llm-stream.test.ts tests/aqi-cost-controls.test.ts tests/aqi-support.test.ts
npm run typecheck
npm run lint
npm run build
```

Browser QA was run against an isolated PGlite database and a local SSE provider on port 3231. It
covered desktop, a 390 px mobile viewport and the agency admin shell, including every lifecycle case:
messages surviving close/reopen, unsent drafts, in-app navigation, closing mid-stream, refresh reset,
explicit save surviving refresh, confirmed discard, confirmed saved-chat delete, account switching,
and eight rapid open/close cycles.

Result: **36 assertions passed, 0 console errors, 0 page errors, 0 failed requests, 0 axe
violations**. The flow included a short greeting with no sources, knowledge answer with sources,
the unsaved strip and Save conversation, history open, source/feedback behavior, the discard and
delete confirmations, mobile close/reopen with no horizontal overflow, and an admin chat surviving
navigation between admin pages. Closing AQi produced no confirmation dialog and no delete request.

The local browser provider is simulated. Live provider acceptance was a separate controlled probe
against the existing production DeepSeek credential: `llmComplete` returned `OK`, and `llmStream`
returned one real SSE delta with usage. The deployed AQi UI itself remains SSO-protected and was
not exercised through the browser.

Production audit, staging-first gate, backup/restore and real-provider acceptance steps:
[aqi-phase2-release-gate.md](aqi-phase2-release-gate.md).
