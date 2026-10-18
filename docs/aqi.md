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
| Conversation persistence, search/pagination, rename, delete and history | Locally/browser verified: owner-scoped titles, keyset pagination, inline rename with saving/error states and a destructive confirmation with immediate `Deleting…` |
| Stable welcome and suggested-question loading | Browser verified: deterministic greeting on first paint, reserved skeletons, no header/footer shift, cached suggestions and permission-filtered questions |
| Automatic conversation titles | Locally/browser verified: configured model or deterministic fallback, persisted provenance, neutral title for a greeting, manual rename always wins and deletion cannot be recreated |
| Close/reopen conversation lifecycle | Browser verified: messages, title, unsent draft and scroll restored; no save confirmation when the panel is closed |
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
| Migration 0051 (conversation title provenance) | **Prepared locally only**; not applied to the hosted project |
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

Migration 0051 adds conversation title provenance:

- `aqi_conversations.title_source` — `default`, `auto` or `manual`. New conversations default to
  `default`; a rename sets `manual`; successful automatic naming sets `auto`.
- `aqi_conversations.title_generated_at` — when the automatic title was persisted.
- Existing non-placeholder titles are backfilled as `manual`, so a migration can never cause a real
  name to be overwritten by later generation.
- Rollback: [`0051_aqi_conversation_titles.down.sql`](../supabase/rollbacks/0051_aqi_conversation_titles.down.sql).
  Prepared and tested locally; **not applied to the hosted project**.

## API

- `GET /api/aqi/bootstrap?path=…` — fast welcome payload: sanitized identity, approved suggestions,
  the verified page label and allowed paths. Provider health is deliberately excluded. No
  instructions, keys or other users' data.
- `GET /api/aqi/health` — provider availability and (for a Super Admin only) diagnostics, resolved
  independently from the welcome.
- `POST /api/aqi/chat` — same-origin, authenticated SSE turn.
- `GET/POST /api/aqi/conversations` — list/create the signed-in person's conversations. The list
  accepts `q` (title search), `before` (last-activity cursor) and `limit`, and returns `hasMore`.
- `GET/PATCH/DELETE /api/aqi/conversations/[id]` — read with older-message cursor; rename (returns the
  stored title and marks it manual); delete.
- `POST /api/aqi/conversations/[id]/title` — best-effort automatic naming. It is called after a turn
  has rendered, is rate limited, and updates only an owner-scoped conversation that still has a
  `default` title. A deleted conversation is never recreated.
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
  follow-up and citation style. Complex requests have a separate admin-configurable token budget
  because reasoning tokens count against the provider output budget; the same budget is reserved in
  cost accounting.
- Adjacent citations are spaced and standalone citation lines are removed so `[K1][K4]` cannot render
  as the misleading number “14”.
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

## Welcome, suggestions and conversation lifecycle

**Why the old welcome changed.** The panel first rendered a hardcoded greeting and an empty
“Try asking” area, then replaced both when one bootstrap response returned. That response also
included provider credential resolution, so a slow provider lookup delayed the suggestions; the
client used two effects (sometimes issuing duplicate requests) and refetched on every open. The
header subtitle was derived from that late page value, and the footer moved as suggestions appeared.

The current behavior is deterministic and independent of provider timing:

- The welcome is fixed copy — “Hey! How can I help you today?” and “Ask me anything about
  iAcquireOS.” It is rendered on first paint and is never replaced by a model or a config paragraph.
  AQi does not call an LLM to greet someone.
- The header identity is fixed: **AQi**, badge **Platform guide**, subtitle **Your iAcquireOS
  assistant**. Current-page awareness is a separate, fixed-height hint (“Viewing: Integrations”) that
  appears only after the server verifies that the person may open that route. It never changes the
  header's height, and unverified routes are never named.
- `/api/aqi/bootstrap` contains only the fast welcome data; `/api/aqi/health` resolves provider
  availability separately. The two requests cannot block each other. Results are cached for 60
  seconds per page, and opening the panel while the idle prefetch is in flight joins that request
  instead of duplicating it.
- Suggested questions still come from the Super Admin's published configuration, ordered page → role
  → global, deduplicated, limited to four. They are additionally filtered by verified capability:
  a client without `integrations.view` is never offered an integrations question, and a page-scoped
  question requires that page's permission. Generic platform questions remain available to everyone.
- While suggestions load, four skeleton cards occupy the final card geometry; the footer is anchored
  with `mt-auto`, so the support link does not move. Loaded cards have a stable minimum height and
  two-line clamp. Reduced-motion users get the same layout with animation suppressed.
- If no authorized suggestions exist, the “Try asking” heading is omitted and a neutral fallback is
  shown. If retrieval fails, the fallback plus a **Reload suggestions** action is shown; raw backend
  details are never displayed and the composer stays usable. Clicking a suggestion sends it with a
  lock that prevents a rapid second send, and the normal user/thinking states provide the feedback.
- Conversations are automatically persisted from the first message; there is no separate temporary
  chat store. Closing the panel never deletes or discards the conversation, unsent draft or title.
  Deleting is an explicit, owner-scoped action.

## Automatic conversation titles

- A title is generated after the first meaningful turn has already rendered. Greetings, thanks and
  clarification-only messages do not trigger naming and keep the neutral “New conversation” title.
- The generator uses the existing configured LLM integration (no new provider), a bounded 1,200
  character transcript, `maxTokens: 40` and an 8-second timeout. Model output is sanitized: 2–7 words,
  no quotes, markdown, URLs, greetings, generic labels or contact details. If the provider is absent,
  fails, times out or returns an unusable title, a deterministic title is derived from the topic
  (for example “Troubleshooting Automation Issues”).
- `title_source` is the race guard. Automatic naming updates only a row that is still `default`; a
  manual rename sets `manual` and always wins. The update is an owner-scoped `UPDATE` (never an
  insert), so a deleted conversation cannot be recreated. Generation is coalesced per conversation
  inside the process and rate limited per user.
- The history list updates in place when the title arrives; no page refresh is required. A refresh
  during generation is repaired the next time the conversation is opened, once, and never on every
  message.

## Conversation history, rename and delete

- History is owner- and organization-scoped, newest first, with a keyset cursor on `last_message_at`
  and a `hasMore` flag. Search is server-side over the stored title, so generated and manually
  renamed conversations are both findable.
- Each row shows the title, relative last activity, an active indicator, and rename/delete actions
  with accessible labels and tooltips. Actions are always visible on touch and reveal on hover/focus
  on desktop. Long titles wrap to two lines and truncate gracefully.
- Rename is inline: the field is pre-filled and focused, Enter saves, Escape cancels, the length is
  validated to 120 characters, an empty name is rejected, a spinner shows while saving, duplicate
  requests are ignored and a friendly error keeps the editor open. The stored title is returned and
  applied locally.
- Delete opens a compact `alertdialog`: the conversation title, the permanence warning, Cancel and a
  destructive **Delete conversation** action. It traps focus, auto-focuses Cancel, closes on Escape
  when idle, and ignores Escape while the request is pending. Clicking Delete immediately changes the
  action to **Deleting…** with a spinner, disables it and keeps the dialog open until the server
  confirms. Success removes the row, clears the active selection, restores focus to the history
  search and announces “Conversation deleted.”; failure keeps the row and dialog, shows “Couldn't
  delete this conversation. Please try again.” and allows a retry.

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
- “Run test” calls the real configured provider with the same intent prompt, page context, published
  knowledge, link validation and citation rendering as a live turn. It shows the detected intent,
  word count, formatted answer and source list, and does not save a conversation. Quick conversation
  probes include greetings and a navigation question.
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
- Hosted migrations through 0049 are applied. Prepared migrations 0050 (conversational knowledge)
  and 0051 (conversation titles) are **local only** and have not been applied to the hosted project.
  The deployed application build still needs to be promoted before the new budget and attachment
  code is live.
- The production LLM connection is now `connected`, and controlled provider probes succeeded.
  The deployed AQi build is older than the resolution/error fixes, and the deployment URL is Vercel
  SSO protected, so the full deployed AQi UI was not tested from this environment.
- Phase 3 items (visual highlighting, guided tutorials, full Insights dashboard) are not built.

## Verification commands

```bash
npx vitest run tests/aqi-migration-0047.test.ts tests/aqi.test.ts tests/aqi-conversation.test.ts tests/aqi-attachments.test.ts tests/aqi-errors.test.ts tests/aqi-security.test.ts tests/aqi-llm-stream.test.ts tests/aqi-cost-controls.test.ts tests/aqi-support.test.ts tests/aqi-titles.test.ts tests/aqi-lifecycle.test.ts tests/aqi-migration-0051.test.ts
npm run typecheck
npm run lint
npm run build
```

Browser QA was run against an isolated PGlite database and a local SSE provider on port 3230. It
covered desktop and mobile launchers, streaming, feedback, support consent, close/reopen,
history, expansion, the Super Admin screen, retrieval preview, budgets and axe checks.

Result: **4 authenticated pages, 25 interactions, 0 console errors, 0 page errors, 0 failed requests,
0 axe violations**, including a 390 px mobile viewport with no horizontal overflow. The interactive
flow includes a short greeting with no sources, emoji insertion, image + document upload, attachment
history, clickable source preview, copy success and clipboard-failure handling, rapid feedback
deduplication, persisted like and dislike-with-reason feedback, reload restoration of citations and
feedback state, support consent, close/reopen, history, a real-provider admin greeting test,
conversation/knowledge controls, reduced-motion mobile keyboard focus and a keyboard-activated
authorized navigation link.

A separate 390 px browser run with no provider configured verified the client-facing unavailable
state: friendly copy, no `Super Admin`/API-key/configuration text, a functional **Try again**
action, 0 console errors and 0 axe violations.

The welcome/title/history lifecycle was verified in a second isolated PGlite database (seeded demo
tenants, real Chromium, local provider, 1440 px and 390 px), with a 2.2 s delayed welcome response,
a 3 s delayed title response and a 2.5 s delete response:

- **58 checks, 0 failures.** Welcome copy visible 154 ms after the launcher click; four skeletons
  while loading; the composer accepted text during the delay.
- Header height **91.5 px → 91.5 px** and the support link stayed at **y = 811.25 px** across the
  skeleton-to-loaded transition. Five rapid open/close cycles produced **zero** extra suggestion
  requests and kept the unsent draft.
- Empty suggestions hid “Try asking”; a simulated 500 showed a clean fallback with no backend text
  and a working composer; 390 px suggestions excluded an integrations question the member cannot
  use.
- A greeting produced **zero** title requests and kept “New conversation”. The first meaningful topic
  produced a title in history without a refresh. A manual rename beat a title response delayed by
  three seconds; empty and failed renames kept the editor and the original title.
- Delete showed **Deleting…** immediately, sent exactly one request, kept the dialog on failure with
  a friendly retry, removed the row only after success, returned focus to history search and trapped
  focus / handled Escape (including ignoring Escape while pending). The mobile delete dialog fitted
  the 390 px viewport (358 px wide).
- Close/reopen preserved messages and the unsent draft; **0 axe violations** on desktop and mobile;
  **0 page errors and 0 failed requests**. The console recorded only the four deliberately simulated
  HTTP 500 responses and one pre-existing `/login` hydration warning outside AQi.

The local browser provider is simulated. Live provider acceptance was a separate controlled probe
against the existing production DeepSeek credential: `llmComplete` returned `OK`, and `llmStream`
returned one real SSE delta with usage. The deployed AQi UI itself remains SSO-protected and was
not exercised through the browser.

Production audit, staging-first gate, backup/restore and real-provider acceptance steps:
[aqi-phase2-release-gate.md](aqi-phase2-release-gate.md).
