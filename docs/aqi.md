# AQi — platform assistant (Phase 2 + Phase 3)

AQi is the official iAcquireOS platform assistant. It is **not** one of the AI employees and it
does **not** use the Hermes employee gateway. It has its own identity, configuration versions,
knowledge, conversations, messages, feedback and usage records. Phase 3 adds approved visual
guidance, interactive tutorials, onboarding, contextual tips, document-backed knowledge and the
Insights dashboard; the detailed Phase 3 record is [aqi-phase3.md](aqi-phase3.md).

## Status

| Capability | Status |
| --- | --- |
| Phase 3 visual guidance, tutorials, onboarding, tips, knowledge documents and Insights | **Implemented and locally/browser verified**; migration 0061 not applied hosted. See [aqi-phase3.md](aqi-phase3.md) |
| AQi identity, floating launcher and chat panel | Locally verified |
| Real provider request path + token streaming | **Live controlled probe passed** against the existing production DeepSeek credential: `deepseek-flash`, OpenAI format, `OK` response and one real SSE delta; no customer data |
| Streaming fallback for a non-SSE JSON answer | Locally verified |
| Conversation persistence, search/pagination, rename, delete and history | Locally/browser verified: owner-scoped titles, keyset pagination, inline rename with saving/error states and a destructive confirmation with immediate `Deleting…`. Only explicitly saved chats appear in history |
| Stable welcome and suggested-question loading | Browser verified: deterministic greeting on first paint, reserved skeletons, no header/footer shift, cached suggestions and permission-filtered questions |
| Automatic conversation titles | Locally/browser verified: configured model or deterministic fallback, persisted provenance, neutral title for a greeting, manual rename always wins and deletion cannot be recreated |
| Close/reopen conversation lifecycle | Browser verified: messages, title, unsent draft and scroll restored; no save confirmation when the panel is closed |
| Temporary vs saved conversation lifecycle | Browser verified: app-shell mount keeps one chat alive across close, history, expand and portal/admin navigation; new chats stay temporary; explicit Save, Discard and Delete are separate confirmed actions; refresh clears temporary UI state and saved chats remain |
| Context-aware suggestions and approved route registry | Locally verified |
| Platform knowledge retrieval with role/page scoping | Locally verified |
| Super Admin configuration, knowledge, suggestions and publishing | Locally verified |
| Feedback and usage events | Locally verified |
| AQi budgets, model pricing, token-aware context and atomic spend reservations | Locally verified; migration 0048 **applied hosted 2026-10-18** |
| Support escalation through the existing Support system | Locally verified with explicit consent and duplicate suppression |
| Citation validation and stale-knowledge warnings | Locally verified |
| Intent-aware greetings, response length and page-context restraint | Locally verified; real DeepSeek greeting returned 8 words with no knowledge/page prompt |
| Clickable authorized navigation | Locally verified; real DeepSeek navigation answer produced a validated `Integrations` markdown link |
| Polished citations and source preview | Locally/browser verified: clean answer text, numbered readable source cards and preview modal |
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
| Hosted migration 0050 | **Applied 2026-10-19**; two approved conversational knowledge rows added |
| Migration 0051 (conversation title provenance) | **Applied hosted 2026-10-19**; title provenance columns and backfill verified |
| Migration 0052 (conversation lifecycle) | **Applied hosted 2026-10-19**; `saved_at`/`saved_by`, saved index and backfill verified (2 existing conversations saved) |
| Production deployment | **`ceae6e5` deployed successfully by Vercel on 2026-10-19**; provider, budget, support, attachment/composer, GIF-removal, conversational-intelligence, title/lifecycle and migration 0050–0052 changes are live |
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
  Applied hosted 2026-10-19; tested locally.

Migration 0052 adds the explicit conversation lifecycle:

- `aqi_conversations.saved_at` — when the person explicitly saved the chat. `null` means the chat is
  temporary and never appears in history.
- `aqi_conversations.saved_by` — the person who saved it.
- Existing conversations are backfilled as saved, so the migration never makes previously visible
  history disappear.
- `aqi_conversations_saved_idx` supports the user/org history query.
- Rollback: [`0052_aqi_conversation_lifecycle.down.sql`](../supabase/rollbacks/0052_aqi_conversation_lifecycle.down.sql).
  Temporary rows are hidden from history immediately and purged lazily after 24 hours of inactivity;
  saved rows are never touched by that cleanup. Applied hosted 2026-10-19; tested locally.

## API

- `GET /api/aqi/bootstrap?path=…` — fast welcome payload: sanitized identity, approved suggestions,
  the verified page label and allowed paths. Provider health is deliberately excluded. No
  instructions, keys or other users' data.
- `GET /api/aqi/health` — provider availability and (for a Super Admin only) diagnostics, resolved
  independently from the welcome.
- `POST /api/aqi/chat` — same-origin, authenticated SSE turn.
- `GET/POST /api/aqi/conversations` — list the signed-in person's **saved** conversations and start a
  temporary one. The list accepts `q` (title search), `before` (last-activity cursor) and `limit`, and
  returns `hasMore`; it also lazily purges stale temporary chats.
- `GET/PATCH/DELETE /api/aqi/conversations/[id]` — read with older-message cursor; rename (returns the
  stored title and marks it manual); delete a **saved** conversation.
- `POST /api/aqi/conversations/[id]/save` — explicitly promote a temporary chat to history.
- `POST /api/aqi/conversations/[id]/discard` — explicitly discard a temporary chat. The endpoint
  cannot delete a saved conversation.
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
- `GET/POST /api/aqi/tutorials` — eligible tutorials, persisted state and onboarding summary, or
  start a published walkthrough. Eligibility is resolved from the server-side role, permissions,
  route access and CRM capability.
- `GET/POST /api/aqi/tutorials/[slug]` — the tutorial definition for an eligible person, or one
  progress action (`next`, `previous`, `pause`, `resume`, `exit`, `complete`, `skip`,
  `target_missing`, `route_verified`, `restart`, `viewed`). Progress writes are ownership-scoped and
  events are idempotent.
- `GET/POST /api/aqi/onboarding` — first-time preference and Start/Defer/Dismiss/Complete/Reset.
- `GET/POST /api/aqi/tips` — one configured tip for the authorized page, dismissal, an on/off
  preference and a 12-hour impression dedupe.
- `POST /api/aqi/guidance` — privacy-conscious guide offer/accept/decline signals.
- `GET /api/aqi/insights` — Super-Admin-only real aggregates with date, organization and role filters.
- `GET/POST /api/aqi/knowledge/documents` and `GET/DELETE /api/aqi/knowledge/documents/[id]` —
  Super-Admin-only document upload, listing, private download and archive. No normal browser role
  can read the metadata table.

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
- `[K#]` markers are internal. Valid markers are removed from answer prose, while the UI shows
  numbered, clickable source cards with a readable approved-source snippet. Unsupported markers are
  removed. Sources are omitted when there are no valid citations.
- Responses must answer the question first and use plain conversational text for simple answers.
- Responses avoid em dashes; the server replaces them with readable punctuation if the model uses one.
- Authorized internal paths are converted server-side to human-labelled Markdown links; unauthorized
  or external links are removed. The browser also validates links against the authorized route list.
- Casual replies never get a forced Sources section.
- The message toolbar supports real clipboard copy with a check/Copied state and immediate
  like/dislike feedback. The selected thumb and acknowledgement update before the database request
  finishes. Likes have a brief local confetti burst; dislikes have a gentle thumb dip. Reduced-motion
  preferences remove the movement and confetti.
- Votes still persist to `aqi_messages.feedback_rating` and optional details to `feedback_comment`.
  A dislike saves on the first click; **Skip** only dismisses its optional reason/comment form.
  Changes are serialized per message and rapid choices are coalesced, without locking other messages.
  Closing the panel leaves saves running. A failed latest save restores the last confirmed value and
  offers **Retry feedback**, including any details submitted with it.
- Completed answers can include three or four role-aware follow-up prompts. The provider returns
  them in a private response block that is removed before rendering and saving the answer. The
  prompts are stored with the message's existing JSON context and remain available in saved chat
  history; no migration is needed. When an answer resolves a substantive request without a useful
  next question, or a person may need human help, AQi offers an **Open Support** action that opens
  the existing support request flow. Greetings and thanks stay uncluttered. Missing or invalid
  prompt metadata falls back to that support action.
- File-size limits continue to be checked during upload. The composer no longer repeats those limits
  in the small helper text below AQi.
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
- AQi is mounted once at the application shell, not inside each page layout. Closing the panel,
  expanding it, opening history, and moving between portal, AI-employee chat and agency pages keep
  the same component and conversation in memory.
- **Close (X)** only hides the panel. It never deletes a message, resets the conversation, starts a
  new chat, aborts generation or shows a save prompt. Reopening restores messages, the active
  conversation, draft, attachment previews, feedback selections, title and scroll position.
- New chats are **temporary**. A turn is written while it is happening so streaming, attachments,
  feedback and budget accounting have real records, but the chat stays out of history until the person
  chooses **Save conversation**. Saving sets `saved_at` on the same row; it creates no copy and makes
  no second provider request.
- **Discard unsaved chat** is explicit and only deletes temporary chats. It asks for confirmation when
  there is actual unsaved content. **Delete conversation** is saved-history-only and always confirmed.
  **New chat** asks before replacing an unsaved chat; saved conversations are never part of that
  replacement.
- A full browser refresh or tab end clears temporary UI state; saved chats survive reloads and future
  visits. No chat content is stored in browser storage. Closing the panel while AQi is streaming keeps
  the request active; an explicit **Stop** still cancels, and an interrupted answer is shown honestly
  when the session ends.
- Logging out or changing accounts unmounts the widget and clears in-memory state. Every read, save,
  discard and delete remains user- and organization-scoped under the existing RLS policies.

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
- Temporary chat state is in memory at the application shell, never in `localStorage` or
  `sessionStorage`. Logging out or changing accounts unmounts it, and every save, discard, read and
  delete is still checked against the owner and organization on the server.
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
  Live provider acceptance was a separate controlled probe, not a full deployed-UI run.
- AQi knowledge document upload/reuse is not part of this phase; knowledge is managed as approved
  text entries. The workforce PDF/DOCX pipeline is separate.
- Feedback supports an optional comment after a thumbs-down; the comment is stored but deliberately
  not displayed in normal analytics. Use the knowledge review area or Support to investigate a
  specific report.
- Provider selection is through the existing global LLM integration. The verified integration model
  is authoritative unless a Super Admin enables the explicit AQi model override.
- AQi accepts `connected` or `permission_limited` connections and routes DeepSeek through the
  OpenAI-compatible adapter. Resolution failures are categorized (`status_not_eligible`,
  `credential_unavailable`, `endpoint_not_allowed`, etc.) instead of collapsing to a generic
  “no provider” response.
- Failed resolutions are not cached. A successful resolution is cached briefly; integration tests
  and changes invalidate it.
- Draft tests use the editor's current configuration, including unsaved changes.
- Hosted migrations through 0052 are applied; 0050–0052 were applied on 2026-10-19 and verified
  (`schema_migrations` has no AQi entries pending, the lifecycle columns/index exist, both existing
  conversations were backfilled as saved and the two conversational-knowledge rows were inserted).
  The deployed application build still needs to be promoted before the new budget and attachment
  code is live.
- The production LLM connection is now `connected`, and controlled provider probes succeeded.
  The deployed AQi build is older than the resolution/error fixes, and the deployment URL is Vercel
  SSO protected, so the full deployed AQi UI was not tested from this environment.
- Phase 3 visual guidance, tutorials, onboarding, contextual tips, knowledge documents, freshness
  review and the Insights dashboard are implemented and locally/browser verified. Migration `0061`
  is **not applied hosted**, and no staging or production deployment was made. See
  [aqi-phase3.md](aqi-phase3.md) for evidence and the remaining release gates.
- Temporary state is per browser tab. Another tab does not see an unsaved chat, and closing the tab
  cannot restore it; stale temporary rows are hidden immediately and purged after 24 hours.
- AQi is mounted on portal, AI-employee chat and agency admin routes. Auth, setup/onboarding and
  customer website hosts deliberately do not render the launcher.

## Verification commands

```bash
npx vitest run tests/aqi-migration-0047.test.ts tests/aqi-migration-0051.test.ts tests/aqi-migration-0052.test.ts tests/aqi-conversation-lifecycle.test.ts tests/aqi.test.ts tests/aqi-conversation.test.ts tests/aqi-attachments.test.ts tests/aqi-errors.test.ts tests/aqi-security.test.ts tests/aqi-llm-stream.test.ts tests/aqi-cost-controls.test.ts tests/aqi-support.test.ts tests/aqi-titles.test.ts tests/aqi-lifecycle.test.ts
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

The temporary/saved lifecycle was verified separately on a third isolated PGlite database (port 3231,
real Chromium, local SSE provider, 1440 px and 390 px, desktop and agency admin shells). It covered
every acceptance case:

- **38 assertions, 0 failures**, **0 console errors, 0 page errors, 0 failed requests and 0 axe
  violations**. Closing with X showed no confirmation, sent no delete/discard request and preserved
  messages; an unsent draft survived close/reopen.
- The same temporary conversation survived in-app navigation from `/overview` to `/workforce` and
  closing mid-stream; reopening showed the streamed answer without a duplicate provider response.
- Explicit **Save conversation** removed the “Not saved yet” strip; the saved chat appeared in history
  after a full refresh and opened with its messages. A refresh cleared the temporary chat and draft
  while the saved history remained.
- **Discard** showed “Discard this conversation?”, **Keep conversation** cancelled it, and the
  confirmed discard removed only that temporary chat. Deleting a saved conversation required
  confirmation, cancelled cleanly once, then removed only that row and left the other saved chat.
- Logging out and signing in as another account showed a clean AQi composer and no previous account's
  temporary or saved chat. Eight rapid open/close cycles produced one user message, one answer and one
  provider response with no extra requests. Mobile close/reopen kept the draft with no horizontal
  overflow; an admin chat stayed open and intact across an in-app admin page change.

The local browser provider is simulated. Live provider acceptance was a separate controlled probe
against the existing production DeepSeek credential: `llmComplete` returned `OK`, and `llmStream`
returned one real SSE delta with usage. The deployed AQi UI itself remains SSO-protected and was
not exercised through the browser.

Production audit, staging-first gate, backup/restore and real-provider acceptance steps:
[aqi-phase2-release-gate.md](aqi-phase2-release-gate.md).

The immediate-feedback update was checked with 7 UI regression cases and the 13 existing AQi
service cases (20 passed), plus typecheck and lint. A standalone browser harness rendered the real
feedback components with the app's styles at desktop and 390 px, including dark mode, reduced motion,
a delayed response and a deliberately failed save/retry. The acknowledgement appeared in 167 ms
while the mocked save took 3 seconds; there were 0 page errors, 0 axe violations and no horizontal
overflow. The only console error was the deliberate HTTP 500. This measures local interaction
responsiveness, not production database latency.
