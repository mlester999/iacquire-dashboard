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
| Conversation persistence, rename, delete, history | Locally verified |
| Context-aware suggestions and approved route registry | Locally verified |
| Platform knowledge retrieval with role/page scoping | Locally verified |
| Super Admin configuration, knowledge, suggestions and publishing | Locally verified |
| Feedback and usage events | Locally verified |
| AQi budgets, model pricing, token-aware context and atomic spend reservations | Locally verified; migration 0048 **not applied hosted** |
| Support escalation through the existing Support system | Locally verified with explicit consent and duplicate suppression |
| Citation validation and stale-knowledge warnings | Locally verified |
| RLS and user/tenant isolation | Locally verified |
| Provider resolution and role-aware errors | Locally verified with connected DeepSeek, status/credential failures, recovery after negative cache, client-safe messages and Super Admin diagnostics |
| Live provider acceptance | **PASS (controlled provider probe)**; full AQi UI acceptance remains blocked by Vercel SSO |
| Hosted migration 0047 | **Applied 2026-10-18**; six AQi tables, RLS and seed data verified on the hosted project |
| Hosted migration 0048 | **Not applied**; local-only cost controls |
| Production deployment | `c3e1bdb` deployed successfully by Vercel; the AQi **base code** is live, but cost-control/support changes are committed only on the local branch and are not pushed/deployed |
| Production AQi provider | **Connected** (`deepseek-flash`, OpenAI format); controlled `llmComplete` and `llmStream` probes succeeded. The deployed AQi build predates the resolution/error fixes |

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

Migration 0048 adds local-only cost controls:

- `aqi_budgets` — global or organization monthly budget, per-user budget and enabled state.
- `aqi_model_prices` — configured input/output USD per million tokens. Missing pricing blocks a
  budgeted call rather than guessing.
- `aqi_usage_events` cost/reservation fields — reserved, recorded, released and failed spend,
  estimated-cost marker, configuration version and page route.

The budget reservation is made under a PostgreSQL advisory lock for the budget scope and includes
prior reservations, so two simultaneous turns cannot both pass the last of a budget. Provider
calls are rejected before they start when a budget is exhausted. See
[`0048_aqi_cost_controls.sql`](../supabase/migrations/0048_aqi_cost_controls.sql).

## API

- `GET /api/aqi/bootstrap?path=…` — sanitized identity, suggestions, current page, allowed paths and
  provider health. No instructions, keys or other users' data.
- `POST /api/aqi/chat` — same-origin, authenticated SSE turn.
- `GET/POST /api/aqi/conversations` — list/create the signed-in person's conversations.
- `GET/PATCH/DELETE /api/aqi/conversations/[id]` — read with older-message cursor, rename, delete.
- `POST /api/aqi/feedback` — thumbs up/down and optional comment.
- `POST /api/aqi/support` — explicit-consent escalation through the existing Support service,
  returning the real ticket reference or an honest failure.

All routes resolve the person from the session; none accepts a role or organization from the
browser. AQi never executes a model-generated tool call.

## Context and knowledge

The server builds the system prompt from:

1. immutable AQi policy (no action claims, no secrets, no cross-tenant data, no permission bypass);
2. the published editable identity/tone/greeting/instructions;
3. the server-resolved role, current curated route and only the routes that role may open;
4. published knowledge filtered by role and route, with `[K1]` source labels.

The prompt explicitly treats knowledge and user text as data, not instructions. Unpublished
knowledge and archived entries never reach ordinary users.

## Super Admin — `/admin/aqi`

The management screen has real tabs for Overview, Provider & model, Instructions, Platform
knowledge, Suggested questions, Testing & publishing, Version history, Usage & health and Budgets &
pricing.

- Configuration saves create a draft; publishing archives the previous live version and records an
  audit event.
- Knowledge and suggested questions are editable, publishable and archivable.
- “Run test” calls the real configured provider with the editor's current configuration (including
  unsaved changes) and does not save a conversation.
- Usage shows message/failure/rate-limit counts, tokens, estimated cost, reservations and latency.
  Costs are computed from configured model prices, not invented provider invoices.
- Budgets & pricing configures a global monthly organization budget, a per-user budget, and model
  input/output prices. A budgeted call with no configured price is rejected.

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
- Hosted cost-control migration 0048 is not applied; production currently uses migrations through
  0047. Do not deploy the budget UI without applying 0048 first.
- The production LLM connection is now `connected`, and controlled provider probes succeeded.
  The deployed AQi build is older than the resolution/error fixes, and the deployment URL is Vercel
  SSO protected, so the full deployed AQi UI was not tested from this environment.
- Phase 3 items (visual highlighting, guided tutorials, full Insights dashboard) are not built.

## Verification commands

```bash
npx vitest run tests/aqi-migration-0047.test.ts tests/aqi.test.ts tests/aqi-errors.test.ts tests/aqi-security.test.ts tests/aqi-llm-stream.test.ts tests/aqi-cost-controls.test.ts tests/aqi-support.test.ts
npm run typecheck
npm run lint
npm run build
```

Browser QA was run against an isolated PGlite database and a local SSE provider on port 3230. It
covered desktop and mobile launchers, streaming, feedback, support consent, close confirmation,
history, expansion, the Super Admin screen, retrieval preview, budgets and axe checks.

Result: **4 authenticated pages, 13 interactions, 0 console errors, 0 page errors, 0 failed requests,
0 axe violations**, including a 390 px mobile viewport with no horizontal overflow.

A separate 390 px browser run with no provider configured verified the client-facing unavailable
state: friendly copy, no `Super Admin`/API-key/configuration text, a functional **Try again**
action, 0 console errors and 0 axe violations.

The local browser provider is simulated. Live provider acceptance was a separate controlled probe
against the existing production DeepSeek credential: `llmComplete` returned `OK`, and `llmStream`
returned one real SSE delta with usage. The deployed AQi UI itself remains SSO-protected and was
not exercised through the browser.

Production audit, staging-first gate, backup/restore and real-provider acceptance steps:
[aqi-phase2-release-gate.md](aqi-phase2-release-gate.md).
