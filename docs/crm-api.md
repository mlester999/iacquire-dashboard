# CRM API, webhooks and the n8n workflow action

Status: **implemented locally, not live.** API keys, the public API under `/api/v1/crm`, signed outbound webhooks and the n8n workflow
action are built and covered by `tests/crm-api.test.ts` and `tests/crm-webhooks.test.ts` against an embedded PostgreSQL database, with every
outbound request going to a mocked `fetch` and every DNS answer to a mocked resolver. Nothing has been deployed, migration
`0032_crm_automation.sql` has not been applied to the hosted project, no request has been sent to a real endpoint, and no n8n workflow has
been called or activated.

Code:

| Part | Where |
| --- | --- |
| API keys, scopes, authentication | `src/server/crm/api-keys.ts` |
| Public API routes | `src/app/api/v1/crm/**` (shared plumbing in `_lib/http.ts`, record shapes in `_lib/resources.ts`, bodies in `_lib/schemas.ts`) |
| Webhook subscriptions, queueing, delivery, signatures | `src/server/crm/webhooks.ts` |
| n8n workflow action | `src/server/integrations/n8n-actions.ts` |
| Settings screen (CRM Settings, API & Webhooks, `/crm/settings/api`) | `src/app/(portal)/crm/settings/api/page.tsx`, `src/components/crm/views/developer-view.tsx`, `src/components/crm/developer/*`, actions in `src/app/actions/crm-developer.ts` |
| Schema | `crm_api_keys`, `crm_webhook_subscriptions`, `crm_webhook_deliveries` in `supabase/migrations/0032_crm_automation.sql` |
| Rate limits | `crmApiByKey`, `crmApiAuthFailureByIp`, `crmWebhookManualByOrg` in `src/server/security/rate-limit.ts` |

Who can manage keys and webhooks: people in the client's own workspace with `crm.api.manage` (owners and managers by default). Agency
support sessions never hold that permission, so iAcquire staff can't create, read or revoke a client's keys or webhooks.

Neither a key nor a webhook ever does more than the person who set it up may do in the CRM. Creating one needs every permission it
exposes (see [Scopes](#scopes) and [Events](#events)), the same rule as granting a permission to a teammate; and because the creator's
access is checked again on every request and every queued event, withdrawing a permission from them (or removing them from the
workspace) also limits what their keys and webhooks do from then on.

---

## 1. The public CRM API

### Base URL and versioning

```
https://<portal host>/api/v1/crm
```

The settings screen shows the exact base URL (it is built from `APP_URL`).

The API version is **`2026-10-01`**. Every response carries `iAcquire-Api-Version: 2026-10-01`. A client may send
`iAcquire-Version: 2026-10-01` to pin it; any other value is refused with `400 unsupported_version` rather than guessed.

Within a version, changes are additive only: new endpoints, new optional request fields, new response fields and new error `details`
keys. Clients must ignore response fields they don't know. Removing or renaming a field, changing a type or tightening validation means a
new dated version, served alongside the old one.

### Authentication

Every request sends an API key as a bearer token:

```
Authorization: Bearer iaq_k3x9wq_9yJ0...43 characters...
```

- **Format.** `iaq_` + six lower-case letters or digits (the key's public prefix, shown in the key list) + `_` + 43 base64url
  characters (256 random bits). Pattern: `^iaq_[a-z0-9]{6}_[A-Za-z0-9_-]{43}$`.
- **Shown once.** The key is displayed once when it is created. iAcquire stores only its sha256 (`crm_api_keys.key_hash`); the application
  database role can't read even that column. A lost key can't be recovered, only revoked and replaced.
- **The workspace comes from the key.** Nothing in a request (path, query, body or header) can choose another workspace. A record id from
  another workspace is simply "not found".
- **Expiry and revocation.** A key lasts 30, 90 or 365 days, or until revoked. Revoking takes effect on the next request. Expired and
  revoked keys are refused with `401`. A workspace that is suspended or archived answers `403 workspace_inactive`.
- **Last used** is recorded at most once a minute and shown on the settings screen.
- A workspace can have up to **25** active keys.

Under the hood a request acts as an `api` CRM actor (`apiActor()` in `api-keys.ts`) whose permissions are exactly the key's scopes,
translated to CRM permissions. Every CRM service check (`assertCan`), duplicate rule and validation applies to it exactly as to a person,
and every change it makes is recorded with the key as the actor (`crm_events.actor_kind = 'api'`, `actor_id` = the key id) and in the
audit log with the key's prefix and name.

### Scopes

| Scope | Allows | CRM permissions it carries |
| --- | --- | --- |
| `contacts.read` | List and read contacts | `crm.view`, `contacts.view` |
| `contacts.write` | Create and update contacts (includes reading them) | `crm.view`, `contacts.view`, `contacts.edit` |
| `opportunities.read` | List and read deals; list pipelines and stages | `crm.view`, `sales.view` |
| `opportunities.write` | Create deals and move them between stages (includes reading them) | `crm.view`, `sales.view`, `opportunities.edit` |
| `appointments.read` | List appointments booked in iAcquire calendars | `crm.view`, `appointments.view` |
| `tags.read` | List the workspace's tags | `crm.view` |
| `tags.write` | Add tags to and remove tags from contacts; new tag names are created | `crm.view` |

No scope grants deletion, merging, exports, bulk changes, reopening a closed deal, sending messages, or managing keys and webhooks. A
request without the scope an endpoint needs is refused with `403 insufficient_scope` and `details: { required, granted }`.

**Bounded by the creator.** Creating a key needs every CRM permission its scopes carry (`tags.write` also needs `contacts.edit`, since it
changes contacts), so someone whose "See contacts" was withdrawn can't make a `contacts.read` key. On every request the scopes are checked
against what the creator may do **now** (`created_by`, their role and per-person overrides): a scope whose permissions they no longer hold
is suspended, and a creator who left the workspace leaves the key with no scopes. A suspended scope answers `403 insufficient_scope` with
`details.suspended` and says so in the message; it works again as soon as the creator's access is restored. To keep an integration
independent of one person's access, have the owner create its key.

### Rate limits

- **120 requests per minute per key** (a fixed one-minute window). Every authenticated response carries `X-RateLimit-Limit`,
  `X-RateLimit-Remaining` and `X-RateLimit-Reset` (seconds until the window resets). Over the limit: `429 rate_limited` with `Retry-After`.
  Each key has its own budget, so one busy integration doesn't slow another.
- **Failed authentication: 30 per 10 minutes per client address** (hashed). Missing, malformed, unknown, revoked or expired keys count;
  past the limit the answer is `429` with `Retry-After`, which slows down key guessing without locking anyone out of a valid key.

### Errors

Every error has the same shape and a request id you can quote to support:

```json
{
  "error": {
    "code": "duplicate_contact",
    "message": "A contact with this email address already exists.",
    "requestId": "req_5d0c1f4a9b2e4c7d8a6f3e21",
    "details": { "existingContactId": "4f1c2a9e-0b7d-4a51-9f0e-6c2d1b8a7e33" }
  }
}
```

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | A parameter or value is wrong (bad email, bad cursor, `limit` out of range, a lost stage without a reason, …) |
| 400 | `validation_failed` | The body doesn't match the schema (unknown field, wrong type); `details.issues` lists `{ path, message }` |
| 400 | `invalid_json` | The body isn't JSON |
| 400 | `unsupported_version` | `iAcquire-Version` names another version |
| 401 | `unauthorized` | Missing, malformed, unknown, revoked or expired key (with `WWW-Authenticate: Bearer`) |
| 403 | `insufficient_scope` | The key lacks the scope, or the scope is suspended because its creator lost that access (`details.suspended`) |
| 403 | `forbidden` | The action needs a permission no API key has (for example reopening a closed deal) |
| 403 | `workspace_inactive` | The workspace is suspended or archived |
| 404 | `not_found` | No such record in this workspace (including ids from other workspaces and malformed ids) |
| 409 | `duplicate_contact` | The email or phone already belongs to a contact; `details.existingContactId` |
| 409 | `conflict` | `version` is stale: someone changed the record since you read it |
| 413 | `payload_too_large` | Body over 64 KB |
| 415 | `unsupported_media_type` | Body isn't `Content-Type: application/json` |
| 422 | `idempotency_key_reused` | The `Idempotency-Key` was used with a different body |
| 429 | `rate_limited` | See rate limits; `Retry-After` says when to try again |
| 502, 503 | `unavailable` | A dependency is unavailable; safe to retry later |
| 500 | `internal_error` | Unexpected; nothing internal is exposed. Quote the `requestId` |

Request bodies are **strict**: an unknown field is an error, so a typo never silently does nothing. Values are then normalized and
validated again by the CRM services (emails lower-cased, phone numbers to E.164 with the workspace's calling code, names trimmed).

Every response also carries `Cache-Control: no-store` and `X-Request-Id`.

### Pagination

List endpoints take `limit` (1 to 100, default 25) and `cursor`, and answer:

```json
{ "data": [ ... ], "pagination": { "hasMore": true, "nextCursor": "WyIyMDI2LTEwLTE2IDA5OjEyOjMzLjEyMzQ1NiswMCIsIjRmMWMy..." } }
```

Pass `nextCursor` back unchanged as `cursor` for the next page; `nextCursor` is `null` on the last page. Cursors are opaque keyset
positions (the last row's timestamp to the microsecond, and its id), so records created while you page are never skipped or repeated.

### Idempotent creates

`POST /contacts` and `POST /opportunities` accept an `Idempotency-Key` header (1 to 255 visible ASCII characters; a UUID is ideal).

- A repeat with the same key and the same body (within 24 hours, for the same API key) creates nothing and returns the record the first
  request created, with `201` and `Idempotent-Replayed: true`. The record is returned as it is now.
- The same key with a different body is refused with `422 idempotency_key_reused`.
- Requests with one key are serialized, so concurrent retries can't both create.
- A request that failed (for example `409 duplicate_contact`) stored nothing; repeating it fails the same way.

Without the header, a retried create is an ordinary second request (for contacts, usually `409 duplicate_contact`). Updates, stage moves and
tag changes are naturally repeatable: applying the same change twice changes nothing the second time.

### Endpoints

All paths are relative to the base URL. Ids are UUIDs.

#### `GET /me`

Any valid key. Which workspace and scopes the key has; use it to test a new key.

```json
{ "data": { "workspace": { "id": "…", "name": "Acme Dental", "timezone": "Asia/Manila" },
            "key": { "name": "Zapier bridge", "prefix": "iaq_k3x9wq", "scopes": ["contacts.read", "tags.write"] } } }
```

#### `GET /contacts`

`contacts.read` or `contacts.write`. Newest first.

| Query | Meaning |
| --- | --- |
| `search` | Name, email or phone digits, as the Contacts screen searches |
| `updated_since` | ISO 8601 date-time; only contacts changed at or after it |
| `include_archived` | `true` to include archived contacts |
| `limit`, `cursor` | Pagination |

A contact:

```json
{
  "id": "4f1c2a9e-0b7d-4a51-9f0e-6c2d1b8a7e33",
  "displayName": "Ana Reyes", "firstName": "Ana", "lastName": "Reyes",
  "email": "ana@example.com", "phone": "+639171234567",
  "emails": ["ana@example.com", "ana.work@example.com"], "phones": ["+639171234567"],
  "leadStatus": "qualified", "leadScore": 70, "source": "api", "ownerId": null,
  "timezone": "Asia/Manila", "preferredLanguage": null, "preferredChannel": "email",
  "address": { "line1": null, "line2": null, "city": "Cebu", "region": null, "postalCode": null, "country": "PH" },
  "tags": [{ "id": "…", "name": "Newsletter" }],
  "archived": false, "version": 1,
  "createdAt": "2026-10-16T09:12:33.123Z", "updatedAt": "2026-10-16T09:12:33.123Z"
}
```

#### `GET /contacts/{id}`

`contacts.read` or `contacts.write`. One contact, `{ "data": contact }`.

#### `POST /contacts`

`contacts.write` (and `tags.write` when `tags` is sent). Supports `Idempotency-Key`. Answers `201 { "data": contact }`.

| Field | Type |
| --- | --- |
| `firstName`, `lastName` | string ≤ 100 |
| `displayName` | string ≤ 200 (defaults to first + last name) |
| `email`, `phone` | the primary address and number |
| `emails`, `phones` | up to 10 more of each |
| `address` | `{ line1, line2, city, region, postalCode, country }` (`country` is a two-letter code) |
| `timezone`, `preferredLanguage` | IANA zone; language tag |
| `preferredChannel` | `email`, `sms`, `whatsapp` or `phone` |
| `source` | string ≤ 60 |
| `leadStatus` | `new`, `open`, `contacted`, `qualified`, `unqualified`, `customer` or `inactive` |
| `leadScore` | whole number 0 to 100 |
| `tags` | up to 20 tag names (created when new) |

A contact needs a name, an email or a phone number. An email or phone that already belongs to a contact is refused with
`409 duplicate_contact` and that contact's id. `curl` example:

```bash
curl -X POST "$BASE/contacts" \
  -H "Authorization: Bearer $IACQUIRE_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 8d2f7c1e-5b0a-4e6f-9a31-2c7b4d9e0f12" \
  -d '{"firstName":"Ana","lastName":"Reyes","email":"ana@example.com","tags":["Newsletter"]}'
```

#### `PATCH /contacts/{id}`

`contacts.write`. Changes only the fields sent; `null` clears a field. Same fields as create except `emails`, `phones` and `tags`, plus an
optional `version`: when sent, the change is refused with `409 conflict` if the contact changed since you read that version, so neither
edit is lost. Answers `{ "data": contact, "changed": ["firstName", "leadScore"] }`. An email or phone that belongs to another contact is
refused with `409 duplicate_contact`.

#### `POST /contacts/{id}/tags`

`tags.write`. Body `{ "add": [...], "remove": [...] }` (up to 20 each). Each item is a tag id or a tag name (names are matched
case-insensitively). Names that don't exist yet are created when adding and ignored when removing. Adding a tag the contact already has,
or removing one it doesn't have, changes nothing. Answers `{ "data": contact, "added": 1, "removed": 0 }` when the key also has
`contacts.read` or `contacts.write`; a key without either gets only `{ "data": { "id", "tags": [{ "id", "name" }] }, "added", "removed" }`,
so tagging never becomes a way to read contact details. Each real change appears on the contact's timeline and emits
`contact.tag_added` / `contact.tag_removed` (which can start workflows and webhooks).

#### `GET /tags`

`tags.read` or `tags.write`. Every tag, alphabetically; `?search=` narrows by name.
Items: `{ id, name, color, description, contactCount, createdAt }`.

#### `GET /pipelines`

`opportunities.read` or `opportunities.write`. Every active pipeline with its stages in order:
`{ id, name, isDefault, stages: [{ id, name, kind: "open" | "won" | "lost", position, probability }] }`.

#### `GET /opportunities`

`opportunities.read` or `opportunities.write`. Deals, newest first. Query: `pipeline_id`, `stage_id`, `status` (`open`, `won`, `lost`),
`contact_id`, `updated_since`, `limit`, `cursor`. A deal:

```json
{
  "id": "…", "name": "Kitchen remodel", "status": "open",
  "pipelineId": "…", "stageId": "…", "stageName": "Qualified",
  "value": 12500.5, "currency": "PHP", "contactId": "…", "companyId": null, "ownerId": null,
  "expectedCloseDate": "2026-11-30", "probability": 40, "source": "api", "lostReason": null,
  "tags": [], "version": 1, "createdAt": "…", "updatedAt": "…", "closedAt": null
}
```

#### `GET /opportunities/{id}`

`opportunities.read` or `opportunities.write`. One deal.

#### `POST /opportunities`

`opportunities.write`. Supports `Idempotency-Key`. Body: `name` (required, ≤ 200), `pipelineId`, `stageId` (an open stage; defaults to the
pipeline's first stage, and the pipeline to the default one), `contactId`, `companyId`, `value` (≥ 0), `currency` (three letters; defaults
to the workspace's), `expectedCloseDate` (`YYYY-MM-DD`), `probability` (0 to 100), `source`, `description`. Validated like a deal created in
the CRM. Answers `201 { "data": deal }`.

#### `POST /opportunities/{id}/stage`

`opportunities.write`. Body `{ "stageId", "lostReason"?, "version"? }`. A won or lost stage closes the deal (a lost stage needs
`lostReason`). Moving to the stage the deal is already in changes nothing (`"changed": false`), so a retried request is harmless. Moving a
closed deal back to an open stage (reopening) needs a permission API keys don't have: `403 forbidden`. Answers
`{ "data": deal, "changed": true }`.

#### `GET /appointments`

`appointments.read`. Appointments booked in iAcquire calendars that end after `from` (default now), soonest first. Query: `from`, `to`,
`status` (`new`, `confirmed`, `showed`, `no_show`, `cancelled`), `contact_id`, `calendar_id`, `limit`, `cursor`. An appointment:
`{ id, title, status, startAt, endAt, calendarId, appointmentTypeId, contactId, hostIds, location, meetingLink, bookedVia, version }`.

### Routing note

`src/proxy.ts` never redirects `/api/*` to the sign-in page (it only does that for page routes), so API clients get the JSON errors above
instead of an HTML redirect. This is asserted in `tests/crm-api.test.ts`; `proxy.ts` needed no change.

---

## 2. Outbound webhooks

A webhook subscription is a name, a public `https://` address and a set of event types. When one of those events happens in the
workspace, iAcquire sends a signed `POST` to the address. Manage them in CRM Settings, API & Webhooks: add, edit, pause and resume, roll
the signing secret, send a test, read the delivery log, and redeliver. A workspace can have up to 20 subscriptions.

### Address rules (SSRF guard)

Checked when the address is saved **and again before every delivery** (`checkWebhookUrl`, which uses `assertPublicHttps` from
`src/server/calendars/adapters/http.ts`):

- `https://` only, on the standard port 443; no user name or password in the address; no `#fragment`; at most 500 characters.
- The host name is resolved and **every** address it resolves to must be public: loopback, private (10/8, 172.16/12, 192.168/16),
  link-local and cloud metadata (169.254/16), carrier-grade NAT, IPv6 unique-local and link-local, and IPv4-mapped forms of all of these
  are refused, as are single-label and internal names.
- **The connection is pinned to the checked answer** (`src/server/security/pinned-https.ts`). The delivery doesn't go through `fetch()`,
  which would resolve the name a second time: the socket's own DNS lookup is the check (one lookup, every address must be public, and
  the connection uses only those addresses), with TLS still verified against the host name. So a host that starts resolving to a
  private address, including a hostile DNS server answering public and then private seconds apart (DNS rebinding), is never connected
  to; the attempt fails as not sent ("That address now points to a private, local or internal network"). Each delivery opens its own
  connection (no pooled sockets). The agency n8n trigger call uses the same transport.
- Redirects are **not followed**: a `3xx` answer counts as a failed attempt ("use the final address").

### Events

Only event types the CRM emits today. Each delivery carries the record as it is **when the delivery is sent**, not a copy from the moment
of the event, so a receiver always gets current data.

| Type | When |
| --- | --- |
| `contact.created` | A contact was created (`context.via`: how, for example `manual`, `import`, `api`; `context.source`) |
| `contact.updated` | A contact's details changed (`context.changed` lists the fields) |
| `contact.assigned` | A contact got a new owner (`context.from`, `context.to`: user ids) |
| `contact.tag_added`, `contact.tag_removed` | A tag was added to or removed from a contact (`context.tagId`, `context.tagName`) |
| `contact.consent_changed` | Consent changed (`context.channel`, `purpose`, `status`) |
| `contact.merged` | Two contacts were merged (`context.mergedContactId`; `data.object` is the kept contact) |
| `contact.erased` | A contact was erased; `data.object` is `{ type: "contact", id, erased: true }` and nothing else |
| `company.created`, `company.updated` | A company was created or changed |
| `opportunity.created`, `opportunity.updated`, `opportunity.archived` | A deal was created, changed or archived |
| `opportunity.stage_changed` | A deal moved to another stage (`context.fromStageId`, `toStageId`, `toStageName`, `fromStatus`, `toStatus`) |
| `opportunity.won`, `opportunity.lost`, `opportunity.reopened` | A deal was closed or reopened (`context.value`, `currency`, `lostReason`) |
| `appointment.booked`, `appointment.rescheduled`, `appointment.cancelled` | An appointment was booked, moved or cancelled |
| `appointment.confirmed`, `appointment.showed`, `appointment.no_show` | Its outcome was recorded |
| `task.created`, `task.completed` | A task was created or completed |
| `note.added` | A note was added to a contact, company or deal (`data.object` is that record; `context.noteId`) |
| `form.submitted` | A submission to a native form or survey was processed (`data.object` is the form). `context`: `submissionId`, `formId`, `formKey`, `formName`, `kind` (`form` or `survey`), `purpose`, `version`, `source` (`website` for a Website Studio site, `hosted` for the form's own page), `contactId` (null when the form asked for no email or phone), `contactCreated`, `opportunityId` (when the form creates a deal), `marketingOptIn`, `attribution` (UTM parameters, referrer and landing page, only those the visit actually carried) and `answers` by question key (left out, with `answersOmitted: true`, when they are larger than about 6 KB) |
| `campaign.sent` | A campaign finished: everyone on it was sent the message or left out by the send rules. `context`: `campaignId`, `name`, `channel`, `recipients`, `sent` (handed to the provider), `failed` (failed or bounced), `excluded` (left out by consent, opt-outs, suppression, limits or missing details), `completedAt`. No recipient is named |
| `review.requested` | A review request was queued for a contact (`data.object` is the request). `context`: `requestId`, `channel`, `templateId`, `templateVersion`, `via` (`manual`, `workflow` or `api`), `appointmentId`, `opportunityId`. The customer's private link is never included |
| `feedback.received` | A customer sent private feedback from their review request page (`data.object` is the feedback). `context`: `feedbackId`, `reviewRequestId`, `rating` (1 to 5, or null), `hasComment`, `source`. The comment text is never included |
| `call.completed` | A call ended: a voice assistant (Vapi or Retell) reported it with a signed event, or someone in the team logged it (`data.object` is the call). `context`: `callId`, `provider` (`vapi`, `retell` or `manual`), `direction`, `status` (`completed`, `no_answer`, `busy`, `failed`, `voicemail` or `cancelled`), `durationSeconds`, `disposition`, `contactMatched` |

Two more types exist but can't be subscribed to: `webhook.ping` (the test button) and `workflow.webhook` (a workflow's webhook step, see
below).

A subscription can only carry what its creator can see in the CRM: contact events need "See contacts", company events "See companies",
deal events "See pipelines and deals", appointment events "See appointments", task events access to the CRM, and `note.added` (which
carries the contact or deal) both "See contacts" and "See pipelines and deals". `form.submitted`, `review.requested` and
`feedback.received` need "See contacts", `campaign.sent` "Prepare campaigns", and `call.completed` both "See call records" and "See
contacts". Saving a subscription with an event its creator can't
see is refused. The same check runs when each event is queued: if the creator has since lost that access (or left the workspace), the
event isn't queued for that subscription, and owners and managers get one notification about it.

### The envelope (version `2026-10-01`)

```json
{
  "id": "evt_48213",
  "type": "opportunity.stage_changed",
  "apiVersion": "2026-10-01",
  "occurredAt": "2026-10-16T09:12:33.123Z",
  "orgId": "0b9a7c2e-…",
  "data": {
    "object": { "type": "opportunity", "id": "…", "name": "Kitchen remodel", "status": "won", "...": "…" },
    "context": { "fromStageId": "…", "toStageId": "…", "toStageName": "Won", "pipelineId": "…", "fromStatus": "open", "toStatus": "won" }
  }
}
```

- `id` is stable for the event: every attempt and every redelivery of it carries the same `id` (and the same `iAcquire-Event-Id` header).
  **Use it to ignore repeats.**
- `data.object` is a minimal snapshot of the record, read when the delivery is sent, never with secrets:
  - contact: `type, id, displayName, firstName, lastName, email, phone, leadStatus, leadScore, source, ownerId, timezone, city, region,
    country, preferredChannel, tags (names), archived, createdAt, updatedAt`
  - company: `type, id, name, domain, website, industry, phone, email, city, country, ownerId, archived, createdAt, updatedAt`
  - opportunity: `type, id, name, status, pipelineId, stageId, stageName, value, currency, contactId, companyId, ownerId,
    expectedCloseDate, lostReason, archived, createdAt, updatedAt, closedAt`
  - appointment: `type, id, title, status, startAt, endAt, calendarId, appointmentTypeId, contactId, hostIds, bookedVia, location,
    meetingLink`
  - task: `type, id, title, status, priority, dueAt, contactId, companyId, opportunityId, assigneeId, completedAt, createdAt`
  - form: `type, id, key, name, kind, purpose, status`
  - campaign: `type, id, name, channel, status, startedAt, completedAt`
  - review_request: `type, id, contactId, channel, status, via, appointmentId, opportunityId, createdAt, sentAt, openedAt,
    reviewLinkClickedAt, expiresAt` (never the customer's link or its hash)
  - customer_feedback: `type, id, contactId, reviewRequestId, rating, source, followUpStatus, receivedAt` (never the comment)
  - call: `type, id, provider, direction, status, contactId, startedAt, endedAt, durationSeconds, disposition, createdAt` (never phone
    numbers, summaries, notes, or recording and transcript references)
  - a record deleted since the event: `{ type, id, deleted: true }`
- `data.context` is what the event itself recorded (changed field names, stage ids, the tag, how it was created), with any key that
  looks like a secret removed and strings capped at 500 characters.
- Order isn't guaranteed: a retry can arrive after a later event. Compare `occurredAt` or re-read the record through the API when order
  matters.

Within `2026-10-01`, fields may be added to the envelope and to `data.object`; nothing is removed or renamed.

### Request headers

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `iAcquire-Webhooks/1.0` |
| `iAcquire-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` (below) |
| `iAcquire-Event-Id` | The envelope's `id`, for de-duplication |
| `iAcquire-Event-Type` | The envelope's `type` |
| `iAcquire-Delivery-Id` | This delivery's id (one per subscription and event) |
| `iAcquire-Delivery-Attempt` | 1, 2, … |

### Verifying the signature

Each subscription has a signing secret (`whsec_` + 43 characters) generated by iAcquire. It is **shown once**, when the webhook is added
or the secret is rolled; it is stored encrypted (AES-GCM, `encryptSecret`) in a column the application database role can't read, and only
its last four characters are shown afterwards. Rolling replaces it immediately.

The signature is `HMAC-SHA256(secret, "<t>.<raw body>")` in lower-case hex, where `<t>` is the `t=` value and `<raw body>` is the exact
request body. To verify:

1. Read the raw body **before** parsing JSON (re-serializing changes the bytes).
2. Split the header on `,` into `t=` and `v1=` parts.
3. Refuse a `t` more than 5 minutes from your clock (replay protection).
4. Compute the HMAC and compare with each `v1` in constant time.
5. Answer any `2xx` within 10 seconds, then do slow work asynchronously. Ignore an `iAcquire-Event-Id` you already processed.

Node.js (Express):

```js
import crypto from "node:crypto";
import express from "express";

// rawBody: the request body exactly as received (a string, before JSON.parse).
function verify(rawBody, header, secret, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const got = Buffer.from(parts.v1 ?? "");
  return got.length === expected.length && crypto.timingSafeEqual(got, Buffer.from(expected));
}

const app = express();
app.post("/webhooks/iacquire", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  if (!verify(raw, req.get("iAcquire-Signature") ?? "", process.env.IACQUIRE_WEBHOOK_SECRET)) return res.sendStatus(400);
  const event = JSON.parse(raw);
  // if (alreadyProcessed(event.id)) return res.sendStatus(200);
  res.sendStatus(204);
  // handle event.type / event.data asynchronously
});
```

Python:

```python
import hashlib
import hmac
import time


def verify(raw_body: bytes, header: str, secret: str, tolerance: int = 300) -> bool:
    timestamp, signatures = None, []
    for item in header.split(","):
        key, _, value = item.strip().partition("=")
        if key == "t":
            timestamp = value
        elif key == "v1":
            signatures.append(value)
    try:
        t = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in signatures)
```

Both samples were checked against signatures produced by `signWebhookPayload` (the Node one in `tests/crm-webhooks.test.ts`; the Python
one by hand, including non-ASCII bodies). The server's own verifier, `verifyWebhookSignature`, accepts several `v1` values, so a receiver
built on it can accept the old and the new secret while it is being updated after a roll.

### Delivery, retries and dead letters

Deliveries are sent by the scheduler (`deliverDueWebhooks`, see Operations), never inside a database transaction:

1. **Queue.** The event dispatcher calls `enqueueWebhookDeliveries(db, event)` in the event's transaction: one delivery per **active**
   subscription that chose that event type, unique per (subscription, event), so a redispatched event never queues twice. Events that
   happen while a subscription is paused or switched off are not queued for it.
2. **Claim.** Due deliveries are claimed in small batches (`for update skip locked`, attempt counted, lease on `claimed_at`) and the
   envelope is built from the records as they are now.
3. **Send.** `POST` with a 10-second timeout, outside any transaction, after re-checking the address.
4. **Record.** In a second transaction, only by the claim that sent it.

Outcomes:

| What happened | Status | Retried? |
| --- | --- | --- |
| `2xx` | `delivered` | No |
| The endpoint answered `3xx`, `4xx` or `5xx` | `failed`, then `dead` after the last attempt | Yes, with backoff |
| Never reached the endpoint (address refused, DNS failure, connection refused, TLS error) | `failed`, then `dead` | Yes, with backoff |
| **Unknown outcome**: no answer within 10 seconds, the connection dropped mid-request, or the worker stopped mid-send (lease older than 5 minutes) | `dead` | **No.** The endpoint may have it. Use Redeliver if it didn't arrive |
| Held back (subscription paused or off, workspace suspended, agency pause) for more than 3 days | `dead` | No. Use Redeliver to send it now |

Backoff after failed attempt *n*: 1 minute, 4 minutes, 16 minutes, about 1 hour, about 4 hours, about 17 hours, then 24 hours; **8 attempts**
in all (about two days), then the delivery is `dead`. Delivery history is kept for 30 days.

**Auto-disable.** Every failed attempt (except test pings) adds one to the subscription's consecutive-failure count; any `2xx` resets it.
After **25 failed attempts in a row** the subscription is switched off, its reason is shown on the screen, and the workspace's owners and
managers get a `crm_webhook_failing` notification linking to `/crm/settings/api`. Resuming clears the count; deliveries already
scheduled continue (unless they expired), events from while it was off are not sent.

**Paused workspaces.** Deliveries wait while the agency has paused automation or the workspace is suspended or archived.

**Test ping.** "Send test" sends a `webhook.ping` event right now (even while the subscription is paused) and shows what the endpoint
answered. A failed ping is not retried and doesn't count towards auto-disable. `data` is
`{ "message": "This is a test delivery from iAcquire. …", "subscriptionId": "…" }`.

**Redeliver.** Any logged delivery that isn't being sent can be sent again from the delivery log, with the same event id, starting a fresh
retry cycle if it fails. Test sends and redeliveries are limited to 30 per hour per workspace.

### Workflow webhook step

A workflow's "Send to webhook" step calls `enqueueWorkflowWebhook(db, { orgId, subscriptionId, payload, idempotencyKey })`. It queues the
step's payload (at most 12 KB of JSON) as a `workflow.webhook` event for that one subscription, delivered, signed and retried exactly like
any event (`data` is the payload). The idempotency key (the workflow engine's per-step effect key) makes a retried step queue nothing new:
the second call answers `duplicate` with the first delivery's id. A paused or deleted subscription answers `blocked` with the reason. The
payload rides on an outbox row that is already marked dispatched, so nothing else ever picks it up.

---

## 3. The n8n workflow action

A workflow's "Start n8n automation" step calls `callN8nWorkflow({ orgId, mappingId, payload, idempotencyKey })`, which starts an
agency-approved n8n workflow for this client through the workflow's **Webhook trigger**. iAcquire never activates, edits, lists or executes
n8n workflows any other way.

### How n8n is triggered (verified against n8n's source, October 2026)

Checked in `n8n-io/n8n`: `packages/nodes-base/nodes/Webhook/{description,utils}.ts`,
`packages/cli/src/errors/response-errors/webhook-not-found.error.ts` and `packages/@n8n/config/src/configs/endpoints.config.ts`.

- A Webhook node listens on `<n8n base URL>/webhook/<path>`, its **Production URL** (the segment is `N8N_ENDPOINT_WEBHOOK`, default
  `webhook`). It answers only while the workflow is **active**; otherwise, or when the node doesn't accept the method, n8n answers `404`
  ("The requested webhook "POST …" is not registered."). The test URL (`/webhook-test/…`) only works while someone listens in the editor
  and is refused by iAcquire.
- **Header Auth** (`authentication: headerAuth`) reads an `httpHeaderAuth` credential (Name, Value), looks the header up by that name
  (case-insensitively) and compares its value exactly: `403` when it differs, `500` when the credential is missing.
- **Respond: Immediately** (`responseMode: onReceived`, the default) answers `200 {"message":"Workflow was started"}` as soon as the request
  is accepted.
- n8n doesn't de-duplicate requests; the `Idempotency-Key` header is there for the workflow to use.

### What the agency configures

1. In n8n: the workflow starts with a **Webhook** node: HTTP Method `POST`, a path, Authentication **Header Auth** with an
   `httpHeaderAuth` credential whose Name is `X-iAcquire-Token` (or another header name) and whose Value is a random token of 32 to 512
   characters, and Respond **Immediately**. The agency activates the workflow in n8n itself.
2. In iAcquire (existing integrations flow): the workflow id is on the agency n8n connection's approved list, mapped to this client, and the
   client's mapping has been verified (`automation_template_mappings.status = 'verified'`).
3. The trigger is stored with `configureN8nTrigger(superAdminUserId, { orgId, mappingId, url, headerName?, token })` (agency super admins
   only). The URL must be a Production URL on the agency connection's own host (and pass `INTEGRATION_ALLOWED_HOSTS`); the URL, header name
   and token go to the credential vault (`integration_credentials`, encrypted, scope `n8n_webhook_trigger:<mappingId>`), never to plain
   configuration. `removeN8nTrigger` revokes it; `getN8nTriggerStatus` reports whether one is set, never the token.
   **No screen calls `configureN8nTrigger` yet**: until an agency screen does, n8n steps answer "The agency hasn't set up this workflow's
   webhook trigger yet."
4. The deployment sets **`N8N_ACTIONS_ENABLED=true`**. It is off by default; while off, every call answers `blocked` without contacting n8n.

### The request

```
POST <Production URL>
Content-Type: application/json
User-Agent: iAcquire-Workflows/1.0
X-iAcquire-Token: <token>                    (the configured header name)
iAcquire-Signature: t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>" keyed with the token>
Idempotency-Key: <the workflow step's effect key>
iAcquire-Event-Id: n8n_<24 hex characters>

{ "id": "n8n_…", "type": "workflow.n8n", "apiVersion": "2026-10-01", "occurredAt": "…", "orgId": "…",
  "idempotencyKey": "…", "data": { …the step's payload (at most 64 KB)… } }
```

In n8n the payload is `{{$json.body.data}}` and the key `{{$json.headers["idempotency-key"]}}`.

### Gates and outcomes

Checked at the moment of the call, in one transaction that also serializes calls with the same key: the workspace is an active client;
no agency pause and no `workflows`, `outbound` or `messaging` pause; the mapping exists for this workspace, is `verified`, and its workflow
is still on the approved list; the agency connection is `connected` (or `permission_limited`); a trigger is stored and its URL is still on
the approved host; the address resolves only to public IPs (checked again just before sending, and the connection is pinned to the
addresses that check returned, as for webhook deliveries). The call runs outside any transaction with
a 15-second timeout, and its start and finish are written to the audit log (`automation.external_call_started` / `_finished`), which is also
the ledger for the idempotency key (30 days).

| Result | Meaning | Same key again |
| --- | --- | --- |
| `sent` | n8n answered `2xx`: the workflow started | Returns `sent` (`duplicate: true`), no request |
| `blocked` | Nothing was sent: switched off, paused, not verified, not approved, no trigger | Checked again |
| `not_sent` | Never reached n8n (connection refused, DNS); `retryable: true` | May send |
| `rejected` | n8n answered `3xx`/`4xx` (`403` token, `404` inactive or wrong path); the workflow didn't run. `retryable` only for `429` | May send once fixed |
| `unknown` | Timeout, dropped connection, or `5xx`: the workflow may have started | Returns `unknown` (`duplicate: true`), **never resent** |

---

## 4. Operations

- **Scheduler.** `deliverDueWebhooks({ limit, budgetMs })` is the tick job body. It must be registered in `src/server/ops/tick.ts` (owned
  by the workflow engine package), after the event dispatcher, for example
  `{ name: "crmWebhookDeliveries", run: () => deliverDueWebhooks({ limit: 100, budgetMs: 20_000 }) }`. It reconciles interrupted sends and
  expired held deliveries first, prunes 30-day-old history now and then, sends in batches of 10 concurrent requests, and stops at the
  limit or the time budget (all jobs share the tick's 120 seconds).
- **Event dispatcher.** `crmEventDispatch` (`src/server/crm/dispatch.ts`) calls `enqueueWebhookDeliveries(db, event)` for each event.
- **Environment.** `N8N_ACTIONS_ENABLED` (default off). `INTEGRATION_ALLOWED_HOSTS` must include the agency n8n host. `APP_URL` gives the
  API base URL shown on the settings screen.
- **Audit.** `crm.api_key_created`, `crm.api_key_revoked`, `crm.webhook_created`, `_updated`, `_paused`, `_resumed`, `_deleted`,
  `_secret_rotated`, `_test_sent`, `_redelivered`, `_auto_disabled`; API creates and tag changes are audited with the key's prefix and the
  request id; n8n calls as described above. Webhook URLs are audited by host only.

## Not verified

- No request has been sent to a real webhook receiver or a real n8n instance; DNS, TLS and timeouts were exercised with doubles. The
  pinned transport's lookup was exercised through an `https.request` double (rebinding refused, connection made to exactly the checked
  address), not against a real TLS server.
- The settings screen has not been checked in a browser in this pass.
- The tick registration and the CRM settings navigation entry (Settings, API & Webhooks, `/settings/api`, permission `crm.api.manage`)
  belong to other packages and may not be in place yet.
