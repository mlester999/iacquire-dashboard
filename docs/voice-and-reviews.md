# Reviews and call activity (Native CRM, phase 5)

This covers two features of the native CRM:

- **Reviews**: public review links, review requests to customers, the customer's private feedback page, and private feedback.
- **Calls**: call records reported by the voice-AI providers (Vapi, Retell), calls logged by the team, and the workspace's voice connections.

Both work only on the workspace's own data. Neither uses GoHighLevel.

| Area | Code |
|---|---|
| Reviews service | `src/server/crm/reviews.ts` |
| Calls service | `src/server/crm/calls.ts` |
| Voice adapters | `src/server/integrations/voice/` (`vapi.ts`, `retell.ts`, `types.ts`, `handler.ts`) |
| Webhook routes | `/api/webhooks/vapi`, `/api/webhooks/retell` |
| Customer page | `/r/<token>`, which posts to `/api/public/reviews/feedback` and `/api/public/reviews/click` |
| Screens | CRM → Growth → **Reviews** (`/crm/reviews`) and **Calls** (`/crm/calls`); the **Calls** tab on a contact; agency mirror `/admin/clients/<id>/crm/reviews` and `/calls` |
| Workflow step | **Request a review** (`request_review`) |
| Tests | `tests/crm-reviews.test.ts`, `tests/crm-calls.test.ts` |

## Reviews

### Rules that always hold

1. **Everyone gets the same public review links.**
   - Every customer who is asked sees every active link, in the order the business set.
   - This holds before and after they give feedback, and whatever rating they give.
   - Nothing in the code decides who sees the links. The customer page renders them on its own, separately from the feedback form.
   - **Negative feedback is never used to hold back a public review.** Tests check this for a 1-star and a 5-star customer.
2. **Private feedback stays private.**
   - It is stored in `customer_feedback` (`source = 'review_request'`).
   - It is never published, never counted as a review, and never shown to other customers.
3. **No invented reviews or counts.**
   - iAcquire never writes, posts, imports or counts public reviews.
   - The most it knows is that a customer *opened* a review site's link from their page. The screens say that this is not the same as leaving a review.
4. **Consent first.**
   - A request is a service message (`purpose: service`), sent through the same gated outbound path as every message (`evaluateSend` / `queueOutbound`).
   - It is **refused with the reason** unless the contact has *granted* service consent on that channel. "Unknown" is not enough.
   - Opt-outs, quiet hours, the program-message frequency limit (`scope: retention`), the channel being enabled, and credits are all checked by the send path.

### Review links (`crm_review_destinations`)

- **Platforms:** Google, Facebook, Yelp, Tripadvisor, Trustpilot, Other.
- **Link checks:**
  - https only
  - no user name or password in the link
  - no IP address or local host name
  - at most 500 characters
  - for a named platform, the host must belong to that platform (for example a "Google" link must be on `google.*`, `g.page` or `goo.gl`)
- **Limits:** up to 10 links per workspace, of which at most 6 are shown to customers.
- **Managing them:** links can be reordered, hidden or removed.
- **Who:** only owners and managers in the client's own workspace (`reviews.manage`, a member actor). An iAcquire support session can view the links but not change them.

### Sending a request

**Template.** Use an approved **service** template that contains `{{review.link}}`. The token is defined in `src/lib/messaging/tokens.ts`, group "Review request".
- Only a review request has a value for `{{review.link}}`.
- In any other message it counts as missing, so that send is refused. A raw `{{…}}` is never sent.

**Before anything is created**, the request is refused (with the reason) when any of these apply:
- The template doesn't contain `{{review.link}}`.
- The template's purpose is marketing.
- No review link is switched on.
- The contact is archived.
- The contact has no address on the template's channel.
- The address is suppressed.
- Consent is not granted.
- The contact was asked in the last **30 days**, on any channel. Requests that never reached them don't count: cancelled ones, and ones whose message failed or was blocked.

**Preview.** The request dialog runs the same checks first (`previewReviewRequest`). It shows:
- the exact message, with `[review link]` where the customer's link goes
- each check, with whether it passed

**Token.**
- 32 random bytes, base64url, 43 characters.
- Only its **sha256** is stored (`crm_review_requests.token_hash`). The application role can't read that column.
- The link `<APP_URL>/r/<token>` is rendered into the message when it is queued.
- The message body therefore contains the link. Every place that shows message text to the team masks it as `[customer review link]` (`maskCustomerLinks` in `src/server/messaging/redact.ts`). That covers the inbox, the timeline, AI tools and exports.

**How the message is queued.**
- A `system` send acting on the person's decision, or on the owner's approval of a workflow version. It never goes through the AI gate.
- `scope: retention`. Business hours apply by default. Quiet hours always apply.
- A new conversation is created as unassigned, so a customer who replies reaches a person, not an AI employee.
- If the send path refuses, everything is rolled back, including any conversation it created.
- A send that only has to wait (quiet hours, business hours) is queued for later.

**Link lifetime.** The link takes feedback for **60 days**. After that, and after cancellation, the page still shows the public links but no form.

**Cancelling.** A request can be cancelled only while its message is still queued. The message is withdrawn and its credit hold released. A sent message can't be called back.

**Who can send.** Owners and managers in the client's workspace (`reviews.manage`, delegable). An agency support session can't send.

### The customer's page (`/r/<token>`)

**No session.** The token is the only authorization. It can only:
- record opens and clicks for its own request
- add feedback to its own request, once

**Two panels, always both shown:**
1. **Leave a public review.** Every active link. Each one is a form POST to `/api/public/reviews/click`, which:
   - records the click
   - redirects to the URL from the business's own list, by id. It never redirects to a URL taken from the request.
   - sends `Referrer-Policy: no-referrer`, so the review site never sees the private address
2. **Send private feedback.**
   - an optional 1–5 rating and an optional comment (at most 2,000 characters, control characters removed)
   - at least one of the two is required
   - posted to `/api/public/reviews/feedback`

**Other behaviour:**
- Works without JavaScript.
- Never indexed.
- No referrer is sent.
- Rate-limited per token: 60 page views, 10 feedback posts and 60 clicks an hour.
- The proxy allows `/r/` without sign-in.

**Escalation.** A rating of **2 or less**:
- creates a high-priority task due in one day, for the contact's owner (or unassigned)
- includes the comment in the task
- sets `customer_feedback.follow_up_status = 'escalated'` and `escalated_task_id`
- notifies the owner and managers

It changes nothing the customer sees.

### Statuses and reporting

**Stored status** (`crm_review_requests.status`):
- moves forward only: pending → queued → sent → opened → feedback_received → review_link_clicked
- or ends as failed or cancelled

**Shown status.** Lists combine the stored status with the message's own delivery state:
- a queued request whose message was sent shows **Sent**
- one whose message was blocked or failed shows **Not sent**

This means no background job is needed to copy delivery updates across.

**Reports** (CRM → Reviews):
- **Requests:** created, waiting, sent, opened, opened a review site, gave feedback, not sent. All for requests created in the period (7, 30, 90 days or 12 months).
- **Private feedback:** count, average rating, ratings by score, low ratings, and how many still need a follow-up.
- **Review sites opened, by site:** counted from `review.link_clicked` timeline entries.

**Caveats shown on screen:**
- "Opened" counts link opens. Email security scanners also open links.
- "Opened a review site" doesn't mean a review was posted.

Owners and managers mark feedback **new**, **acknowledged** or **resolved**. **Escalated** is set by the escalation itself.

### Google Business Profile: **Blocked**

iAcquire does **not** read, import, show, count or reply to Google reviews. Nothing scrapes Google.

What it needs:
1. **Google approval:** approved access to the Google Business Profile APIs (My Business Account Management / Business Information / Reviews). Google grants this per Google Cloud project, through its access request form.
2. **OAuth verification:** a verified OAuth consent screen with the `https://www.googleapis.com/auth/business.manage` scope.
3. **Per-client connection:** each client connects their Business Profile location.
4. **iAcquire work:** a connector that stores the OAuth credential in the vault and syncs reviews read-only.

None of this exists yet, and the Reviews screen says "Blocked". The business's Google review **link** (for example `https://g.page/r/…/review`) works as an ordinary review link.

## Calls

### What was verified, and where

Checked on **2026-10-16**, and fetched again on **2026-10-17** (the files were identical). Sources are the providers' own documentation and SDK source. Nothing was called with a real account.

#### Vapi

**Sources:**
- `docs.vapi.ai/server-url/server-authentication`
- `docs.vapi.ai/server-url/events`
- `github.com/VapiAI/server-sdk-typescript` → `src/api/types`:
  - `ServerMessageEndOfCallReport`
  - `ServerMessageStatusUpdate`
  - `ServerMessageStatusUpdateStatus`
  - `Call`, `Artifact`, `Analysis`
  - `HmacAuthenticationPlan` (with its `Algorithm` and `SignatureEncoding` types)
  - `BearerAuthenticationPlan`
  - `ServerMessageEndOfCallReportEndedReason`

**Message shape.** Each message is `{ "message": { "type": … } }`.

**`end-of-call-report`** is sent when the call ends and post-processing is done. It carries:
- `endedReason`
- `startedAt` and `endedAt` (ISO 8601)
- `call` (`id`, `type`, `assistantId`, `phoneNumberId`, `customer.number`)
- `customer`, `phoneNumber`
- `artifact.recordingUrl` and `artifact.transcript`
- `analysis.summary`

**`status-update`** carries `status`: `scheduled | queued | ringing | in-progress | forwarding | ended`.

**Authentication** is a credential attached to a saved assistant, phone number or Server Configuration:
- **Bearer Token:** by default `Authorization: Bearer <token>`. The header name and the prefix are configurable in Vapi.
- **Legacy `X-Vapi-Secret`:** a Bearer credential with that header name and no prefix.
- **HMAC:**
  - signature header (default `x-signature`)
  - timestamp header (default `x-timestamp`)
  - payload `{timestamp}.{body}` (default)
  - encoding hex (default)
  - algorithm sha256, sha512 or sha1
  - an optional signature prefix such as `sha256=`

**No credential on API-supplied URLs.** Vapi attaches the credential **only** when the server URL comes from the org's saved configuration. When the URL comes from the API request itself (a transient assistant), it is sent without one.

#### Retell

**Sources:**
- `docs.retellai.com/features/webhook-overview`
- `docs.retellai.com/features/secure-webhook`
- `docs.retellai.com/api-references/get-call` (spec revision `2026-10-16-5d9ba01`)
- `github.com/RetellAI/retell-typescript-sdk`: `src/lib/webhook_auth.ts` and `tests/webhook-auth.test.ts`

**Events:** `call_started`, `call_ended`, `call_analyzed` and `transcript_updated`.
- `call_started` is **not** sent for calls that never connect: `dial_failed`, `dial_no_answer`, `dial_busy`.
- `call_ended` and `call_analyzed` are always sent.

**Delivery:**
- Webhooks are sent in order, but not blocking.
- Without a 2xx within 10 seconds, a webhook is retried up to 3 times.
- The documented idempotency key is `event` + `call_id`.

**Call object fields:**
- `call_id`, `agent_id`
- `direction`, `from_number`, `to_number`
- `call_status` (`registered | not_connected | ongoing | ended | error`)
- `start_timestamp`, `end_timestamp`, `duration_ms` (milliseconds)
- `disconnection_reason` (enum)
- `recording_url`, `transcript`
- `call_analysis.call_summary`, `call_analysis.in_voicemail`

**Signature.** The header is `X-Retell-Signature: v=<unix ms>,d=<hex HMAC-SHA256(raw body + timestamp)>`.
- The key is the Retell API key that has the **webhook badge**.
- The timestamp must be within 5 minutes.
- The header format is strict: `^v=(\d+),d=([0-9a-f]+)$`, with a 64-character hex digest.
- The SDK's own test vector is pinned in `tests/crm-calls.test.ts`:
  - body `{"event":"call_ended"}`
  - key `test-api-key`
  - timestamp `1700000000000`
  - digest `07024cab…3321823e`

### Setting up a connection

**Choice made:** connections are managed in the **client's CRM**, under Calls → **Voice connections**.

**Who can change them:** only an **agency super admin inside a write support session** (`/admin/clients/<id>/crm/calls?tab=connections`). A connection holds a provider credential, so the session is recorded and the client's owner is told.

**What everyone else sees** (the client and read-only staff):
- the status
- the ids
- whether a credential is saved. The secret itself is never shown.
- whether recording links are kept
- the webhook address

**Per provider (one each):**
- **Ids:** assistant / phone-number ids for Vapi, agent ids for Retell. From 1 to 20.
  - An id can belong to **one workspace only**. Saving an id another workspace already uses is refused.
- **Credential:** stored in the vault (`saveCredential`, providers `vapi` / `retell`, replace-only).
  - Vapi: the auth mode plus the shared secret, as `{"mode","secret"}`. The mode is also kept in the credential's scopes, so the screen can show it without decrypting.
  - Retell: `{"apiKey"}`.
  - Changing the Vapi auth mode needs the secret again.
- **Keep links to recordings and transcripts** (`store_recordings`): only allowed after the admin confirms the assistant tells every caller that the call is recorded. It also decides whether the provider's call summary is kept (see below).

**At the provider:**
- **Vapi:**
  - Set the assistant's or phone number's Server URL to `<APP_URL>/api/webhooks/vapi`.
  - Attach a Bearer, X-Vapi-Secret or HMAC credential. For HMAC use SHA-256, hex, the default headers, and payload `{timestamp}.{body}`.
  - Set `serverMessages` to `["status-update","end-of-call-report"]`.
  - Point **only** these message types at iAcquire. The endpoint answers `assistant-request` and tool calls with "ignored", so Vapi would get no assistant from it.
- **Retell:**
  - Set the agent's (or the account's) webhook URL to `<APP_URL>/api/webhooks/retell`.
  - Keep `call_started`, `call_ended` and `call_analyzed` switched on.

**Disconnecting:** marks the connection disconnected and revokes the credential. Its events are then refused. Past calls stay.

### What happens to a webhook (`handleVoiceWebhook`)

1. **Parse.** The body is parsed (at most 2 MB). Only call activity is recorded: Vapi `status-update` and `end-of-call-report`; Retell `call_started`, `call_ended` and `call_analyzed`. Anything else gets 200 `ignored`.
2. **Find the workspace.** This is done **only** through `crm_voice_connections.external_ids`, using the assistant / phone-number ids (Vapi) or the agent id (Retell) on the call. Connections that are disconnected don't count.
   - No match: 404.
   - More than one match: 409.
3. **Authenticate** with that workspace's own credential from the vault. Every comparison is constant-time: both sides are hashed, then compared with `timingSafeEqual`.
   - **Vapi:** Bearer, X-Vapi-Secret, or HMAC (hex sha256 over `{timestamp}.{body}`, optional `sha256=` prefix). An HMAC timestamp may be in seconds or milliseconds and must be within 5 minutes.
   - **Retell:** `X-Retell-Signature`, as above.
   - Any failure: 401, and it is counted per connection and hashed client address (the first `X-Forwarded-For` entry from the trusted
     proxy). After 20 failures in 10 minutes that address gets 429 `rate_limited` (with `Retry-After`) for that connection **before** the
     vault is read, so forged requests can't keep decrypting the secret or writing `credential.resolved` audit rows. Requests that
     authenticate never count, so the provider's own events (from its own addresses) keep flowing.
4. **Record, in one transaction:**
   1. A receipt is written to `webhook_receipts`. The key is `<workspace id>:<call id>:<event>` (hashed if longer than 200 characters).
      - A redelivery or a replay inside the 5-minute window gets 200 `duplicate` and records nothing.
      - A Bearer request has no timestamp, so this receipt is its replay protection.
      - The key is scoped to the workspace, so one workspace's event can never use up another workspace's receipt.
   2. `recordVoiceEvent` creates the call record, or merges into the existing one, by `(provider, provider_call_id)`.
   3. The connection becomes `connected`, with `last_event_at`.

**Merge rules** (`recordVoiceEvent`):
- **Forward only:** ringing → in progress → final. A late "in progress" never re-opens an ended call.
- **Between two final statuses**, the more specific one wins. "completed" is the fallback, so it never replaces "voicemail" (for example when Retell's `call_analyzed` arrives before `call_ended`).
- **No wiping:** a later event never clears a value an earlier one recorded.
- **Other workspaces:** a call id already recorded for another workspace is **refused** (409) and never overwritten.
- **`call.completed`** is emitted once, when the record first reaches a final status (dedupe key `call.completed:<record id>`). A timeline entry is added to the contact, if one matched.

**Contact matching.**
- Only by the caller's **exact E.164 number**: the contact's phone or one of its phone identities, in that workspace.
- Exactly one contact must match.
- **Names are never used.** A number without `+` and a country code matches nobody.
- Unmatched calls show "Not linked". A person can link one to a contact by hand. A call that is already linked is never moved.

**Recordings, transcripts and summaries.**
- Kept only when the connection has `store_recordings` switched on.
- The provider's summary (Vapi `analysis.summary`, Retell `call_analysis.call_summary`) is a synopsis of what was said, so it counts as call content: it is stored only when `store_recordings` is on. Otherwise the record keeps the call's facts only (numbers, times, status, the provider's ended reason).
- Kept only as references:
  - `recording_ref`: the provider's https recording URL
  - `transcript_ref`: `<provider>:call/<call id>/transcript`, saying where the provider keeps it
- **The transcript text is never stored.**
- `recording_consent` records the basis:

| Value | When |
|---|---|
| `announced` | References are kept, and the setup confirmed callers are told the call is recorded. |
| `unknown` | The provider recorded the call, but this workspace keeps nothing of what was said (no recording or transcript reference, no summary). |
| `not_recorded` | The provider reported no recording or transcript. |

**Statuses.** The provider's own reason is kept as `disposition` and shown in words.

| Provider reason | Status |
|---|---|
| Vapi `voicemail`; Retell `voicemail_reached`, or `in_voicemail` set by `call_analyzed` | voicemail |
| `customer-did-not-answer`, `dial_no_answer` | no_answer |
| `customer-busy`, `dial_busy`, `user_declined` | busy |
| `manually-canceled`, `manual_stopped` | cancelled |
| Errors, failures to connect, and `not_connected` / `error` call status | failed |
| Any other way a connected call ended | completed |

### People and calls

**Log a call** (calls.view + contacts.edit). A person records:
- the contact
- the direction
- how it ended (completed / no answer / busy / voicemail / failed)
- when (it can't be in the future, or more than a year ago)
- the duration (only for an answered call)
- the number (E.164; the contact's phone by default)
- an outcome label and a summary
- whether it was recorded. A recording **link** is accepted only with consent "caller was told" or "caller agreed".
- optionally, a follow-up task

The call completes at once: `call.completed` is emitted and a `call.logged` timeline entry is added.

**Notes.** The team can add notes to any call. For a call they logged, they can also change the outcome label. The provider's facts (times, status, summary, ended reason) are never edited.

**Follow-up task.** One per call, from the call's detail sheet (requires `tasks.manage`).

**Filters:** outcome (completed / missed / failed / in progress), direction, source (Vapi / Retell / logged), linked or not, and period.

## Permissions

| What | Who |
|---|---|
| See Reviews (links, requests, feedback, numbers) | `contacts.view` (every client role; agency read sessions) |
| Manage review links, send and cancel requests | `reviews.manage` (owners and managers, delegable), client members only |
| Mark feedback acknowledged or resolved | `reviews.manage` (agency write sessions included) |
| See calls and connection status | `calls.view` (everyone who works with customers; not read-only viewers, because calls can carry recording links) |
| Log calls, add notes, link a call to a contact | `calls.view` + `contacts.edit` |
| Create a follow-up task from a call | `calls.view` + `tasks.manage` |
| Set up or disconnect a voice connection | Agency super admin in a write support session (the vault also checks `agency_super_admin`) |

## Events (`crm_events`)

| Type | Entity | Dedupe key | Payload |
|---|---|---|---|
| `review.requested` | `review_request` | `review.requested:<request id>` | `requestId`, `channel`, `templateId`, `templateVersion`, `via` (`manual`, `workflow` or `api`), `appointmentId`, `opportunityId` |
| `feedback.received` | `customer_feedback` (actor kind `contact`) | `feedback.received:<feedback id>` | `feedbackId`, `reviewRequestId`, `rating`, `hasComment`, `source`. The comment text is never included. |
| `call.completed` | `call` | `call.completed:<call record id>` | `callId`, `provider`, `direction`, `status`, `durationSeconds`, `disposition`, `contactMatched` |

These are in the outbox, so the dispatcher hands them to subscribers, and both catalogs list them:
- the workflow **trigger** catalog (`EVENT_TRIGGER_TYPES` in `src/lib/crm/workflow/spec.ts`, the "Growth" group of the trigger picker).
  "Call ended" can be narrowed to how the call ended and its direction (for example missed incoming calls → a follow-up task).
  "Private feedback received" deliberately has no rating filter: every customer who answers is treated alike, so a workflow can't single
  out happy customers for public reviews.
- the outbound webhook event catalog (`WEBHOOK_EVENTS` in `src/server/crm/webhooks.ts`, documented in `docs/crm-api.md`). Review and
  feedback events need "See contacts"; call events need "See call records" and "See contacts". Deliveries never carry the customer's link,
  the feedback comment, phone numbers or recording references.

## Workflow step: Request a review (`request_review`)

**Config:** `{ templateId, contentHash, channel, businessHoursOnly }`.
- The template must be approved, a service template, and contain `{{review.link}}`.
- The approved wording is bound by `contentHash`. If the template's approved wording changes, the step stops until the workflow is republished.

**Approval:** effects `send_sms`, `send_email` or `send_whatsapp`, so the owner approves the exact version before it runs. The approval preview shows the message.

**Running:** it runs the same `queueReviewRequestInTx` as a manual request, with:
- `via: workflow`
- the step's effect key as the message's dedupe key, so a retry never sends twice
- the run's deal and appointment linked

**Refusals:** no consent, recently asked and so on. These skip the step as "blocked", with the reason.

**Test runs** describe what would happen. Nothing is created.

## Not done, and limits

- **Google Business Profile:** Blocked (see above).
- **Automatic follow-ups for provider calls:** there is no built-in follow-up per connection. A workflow does it: "Call ended", narrowed to
  incoming calls that ended as No answer, Busy or Voicemail, with a "Create task" step.
- **The link is stored in the message:** the review link is rendered into the queued message, so `conversation_messages.body` holds it. It is masked everywhere the team reads message text.
  - Filling it in only at dispatch, as appointment manage links are, would need a change to `src/server/messaging/send.ts`.
- **Template previews:** the template editor previews `{{review.link}}` as the labelled sample link (sample values) or as `[review link]`
  (a real contact). Only a real review request has a value for it: any other send of such a template is refused as missing a value.
- **Asking from a contact:** the contact profile's "Request a review" (owners and managers of the client's own workspace) opens
  `/crm/reviews?contact=<id>` with the request dialog and that contact chosen.
- **"Opened" counts** include link scanners.
- **Retell's `transcript_updated`** and Vapi's live transcript and tool messages are ignored on purpose.
- **Not tested against real accounts:** neither provider has been called with a real Vapi or Retell account from this codebase. The adapters follow the documentation and SDK sources listed above, and the tests use vectors computed by their documented algorithms, including Retell's own SDK vector.
