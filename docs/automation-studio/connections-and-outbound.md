# Automation Studio: connections, HTTP requests and Slack

Written 2026-10-21 (Phase C). Everything here is built, tested against the real services with the network socket replaced, and **not yet applied to any
hosted database** (migration `0072` is local and test only). Gmail and Google Sheets are not built (see the end).

## What a person gets

- **Connections** (`/automation-studio/connections`): a workspace's own, named connections to an outside system. Two kinds:
  - **HTTP API**: a public https address, the methods it may be called with (GET, POST, PUT, PATCH, DELETE), and how requests are signed (bearer
    token, a custom header, basic auth, or nothing).
  - **Slack (incoming webhook)**: the webhook address from Slack, which posts to one channel.
- **Two new steps**: *HTTP request* and *Slack message*. Both name a connection by id; neither can carry an address, a token or a header that holds
  one. Both are premium (plan required) and are outside effects, so an owner approves the exact version before they run.
- **Verification**: a connection is `unverified` until a person sends its test and confirms it in a dialog that says exactly what will be sent where. A
  workflow cannot be published with an unverified connection; a published one waits (is held, not failed) if its connection later stops being verified.
- **Rotation and revocation**: replacing a secret makes the connection unverified again; revoking erases the ciphertext for good. Revoking never needs
  the plan, so a workspace whose plan lapsed can still cut a credential off.
- **Call log**: host, path (never the query), method, status, size, time and a redacted reason, for 30 days. Never a header, a body or a secret.

## The controls (and where they live)

| Risk | Control | Code | Test |
| --- | --- | --- | --- |
| The AI builder, or a person, aims a call at an internal address | A step names a *connection*, never an address. The connection's host is checked when it is saved (https, no IP literals, no `localhost`/`.internal`/`.local`, no credentials, port or query in the address, resolves only to public addresses) and again on every call | `src/lib/automation-studio/outbound.ts` (`hostProblem`, `parseConnectionBase`), `createConnection` | `tests/outbound-http.test.ts`, `tests/automation-studio-connections.test.ts` |
| DNS rebinding (a public name that later points inside) | The transport resolves the name once per request, refuses unless **every** address is public, and connects to the address it checked | `src/server/security/pinned-https.ts` (`request`, `checkedLookup`) | `outbound-http.test.ts` (resolver flips to a private address; a real local TLS server proves no connection is made) |
| Redirects into a private network | Redirects are never followed; a 3xx is a rejected, non-retryable result | `request`, `judgeResponse` | `outbound-http.test.ts` |
| Path tricks (`/../`, `//host`, absolute URLs, encoded dots) | `pathProblem` rejects them in the editor, the validator and at call time; the query is built with `URLSearchParams`; placeholders in a path are URL-encoded | `src/lib/automation-studio/outbound.ts`, `executors.ts` (`fillOutbound`) | `outbound-http.test.ts`, `automation-studio-connections.test.ts` |
| Unwanted methods and content | Each connection lists the methods it allows; a step using another is refused at validation and again at call time. Bodies are JSON, form or text only, 16 KB at most; a GET has no body | `connectionIssues`, `httpRequestIssues`, `performOutbound` | `automation-studio-connections.test.ts` |
| Credentials smuggled in as a "harmless header" | Only `Accept`, `Accept-Language`, `If-None-Match`, `Idempotency-Key` and `X-*` headers are allowed; `Authorization`, `Cookie`, `Host`, `Proxy-*` and the like are refused; any header value that looks like a secret is refused | `cleanStepHeaders` | `outbound-http.test.ts`, builder eval scenario `credential-in-chat` |
| A hanging or enormous answer | Timeouts of 1 to 30 s (15 by default); the answer is read up to 256 KB and the rest dropped | `HTTP_LIMITS`, `request` | `outbound-http.test.ts` (real server) |
| Secrets leaking | AES-GCM ciphertext in a column the application database role cannot read; shown once; the call log, step results, audit rows, notifications and errors hold only a last-four hint and a redacted excerpt | migration `0072`, `redact`, `safeExcerpt` | `automation-studio-connections.test.ts`, `automation-studio-migrations.test.ts` |
| Doing a non-repeatable thing twice | Every attempt of a step visit carries the same `Idempotency-Key`. A refusal that can pass (429, 503, 408, 425) is retried after the longer of the back-off and `Retry-After`. A server error on a POST, or a connection that dropped after the request left, is *unknown* and is never retried blindly: the run stops and says what to check. The person can mark a step "the other system ignores a repeat" to allow retries | `judgeResponse`, `judgeFailure`, `finishExternal` in `runner.ts` | `automation-studio-connections.test.ts` |
| One tenant starving the rest | At most 5 outside calls in flight per workspace, 60 calls a minute per connection, 5 tests an hour per connection, 30 new connections an hour per workspace, 20 live connections per workspace; calls are metered as `integration_calls` against the monthly limit | `performOutbound`, `rate-limit.ts` | `automation-studio-connections.test.ts` |
| Surprise side effects while testing | A test run (dry run) describes the call and sends nothing. The only real call outside a workflow is a connection's own test, which needs an explicit confirmation, is rate limited and audited | `execHttpRequest`, `execSlackMessage`, `testConnection` | `automation-studio-connections.test.ts`, `automation-studio-templates.test.ts` |
| Another workspace's connection | Every read and write is scoped by `org_id`; row-level security on both tables; `performOutbound` re-checks the owner of the connection | `src/server/automation-studio/connections.ts` | `automation-studio-connections.test.ts` (tenant isolation), `automation-studio-migrations.test.ts` |
| Plan lapses | Premium steps are paused, never failed; a queued run waits and a run mid-flight is held at the step; revocation still works | existing lifecycle | `automation-studio-connections.test.ts`, `automation-studio-operations.test.ts` |
| A model obeying text in workspace data | The builder is shown connection *names, kinds, hosts, allowed methods, status and ids* only, fenced and cleaned; it cannot see addresses, tokens or customer data | `builder/prompt.ts`, `builder/guard.ts` | builder eval scenario `injection-connection-name` |

Not allowed even if an AI-generated workflow asks: any address that isn't a connection's host; any private, loopback, link-local or metadata address;
any method the connection doesn't list; any redirect; any credential in a step.

## Slack

- **Today: incoming webhooks.** The person pastes the webhook address (it must be `https://hooks.slack.com/services/T…/B…/…`). It is encrypted and
  never shown again. Messages are posted with the same pinned transport. Slack's answer must be the text `ok` to count as delivered; a 404/410/403
  means the webhook was removed and asks for attention at once. Message text is built from placeholders (contact and appointment fields only, and the shipped templates keep personal details out of it where a name is enough) and is escaped so a name can't mention a channel or a person (`<`, `>`, `&`).
- **Verification** posts one clearly labelled test message to the channel, after an explicit confirmation.
- **Future: Slack OAuth. Not built.** It would add a connection kind `slack_oauth` that stores a bot token (same encryption), a channel picker backed
  by `conversations.list`, and token rotation. It needs a Slack app registered by the founder (client id/secret, redirect URL, scopes
  `chat:write`, `channels:read`), and is a separate piece of work. Nothing in the product claims it exists.

## Data model (migration `0072_automation_connections`)

- `automation_connections`: org, kind (`http`, `slack_webhook`), name (unique among live), non-secret `settings` (host, path prefix, allowed methods,
  signing style, test path), `secret_ciphertext` (not readable by the app role), `secret_hint`, `secret_version`, status
  (`unverified`, `active`, `needs_attention`, `revoked`), verification, usage and failure counters.
- `automation_connection_calls`: the call log described above, cascade-deleted with the connection, pruned to 30 days.
- Both have row-level security (read needs "See automations"); only server code writes. The rollback refuses while any row exists.
- Code that reads the tables checks `to_regclass` first, so the application still works (with no connections) if it is deployed before the migration is
  applied. **Apply `0069`, `0070`, `0071`, `0072` in order before deploying** (the portal shell calls `app.automation_studio_plan()` from `0071` on every
  page).

## Where Gmail and Google Sheets stand

Not built. They need a Google Cloud OAuth app and Google's scope verification (Gmail's scopes are restricted and need a security assessment), which
only the founder can start. The Google Calendar OAuth plumbing is reusable. Until then, any tool with an HTTP API (and Sheets through a service that
exposes one) can be reached with an HTTP connection.
