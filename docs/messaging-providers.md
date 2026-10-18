# Messaging providers

What each native messaging transport relies on, checked against the provider's official, machine-readable or official-doc sources before
the code was written. Nothing here has been exercised against a live provider account: every test mocks `fetch`.

## The provider-neutral core

Code: `src/server/messaging/transports/{types,index,ghl}.ts`, `src/server/messaging/{send,ingest,channels,redact}.ts`. Tests:
`tests/messaging-transports.test.ts` (plus the existing `tests/messaging-{core,handoff,responder}.test.ts`, which run unchanged).

### Which transport carries a message

- Each workspace channel has one provider, `messaging_channels.provider`: `ghl` (the column default, so every existing workspace keeps
  GoHighLevel), `resend` (email), `twilio` (SMS) or `meta_whatsapp` (WhatsApp). The database allows only those pairings
  (`messaging_channels_provider_channel`). A channel with no row at all is GoHighLevel's and switched off.
- `transportFor(name)` returns the `ChannelTransport`; `loadChannelTransport(db, orgId, channel)` returns the transport with the channel's
  sender (`identity`, `senderId`, `accountId`, `credentialId`). Native transport modules are imported on first use, so a GoHighLevel
  workspace never loads them; a module that fails to load turns the send into "not attempted" (nothing leaves, the credit hold is released).
- Every transport has its own environment kill switch, off unless set to `true`: `GHL_WRITES_ENABLED`, `RESEND_WRITES_ENABLED`,
  `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED` (`transportWritesEnabled(name)`). While it is off the transport answers
  `{ ok: false, blocked: true }` before any request, and the message is held as `provider_not_enabled`.

### The rule chain (`evaluateSend`)

Unchanged in order and meaning for every provider: contact removed, AI owner and escalation, automation gate and approval, address,
suppression, consent, channel enabled, WhatsApp template or 24-hour window, follow-up and program allowances, rate and credit, time rules.
What now depends on the channel's provider:

- **CRM contact id.** Only a transport with `requiresContactRef` (GoHighLevel) needs `contacts.ghl_contact_id`; a native transport sends to
  the address, so a contact who only ever wrote in through Twilio or Resend can be answered.
- **Rates.** The unit rate is the latest one an iAcquire admin published for *that provider* (`usage_unit_rates.provider`). With none
  published the message is refused as `rate_not_published`, exactly as before; no price is ever assumed.
- **WhatsApp templates.** A template counts as approved only for the provider that approved it (`whatsapp_templates.provider`): a template
  approved in GoHighLevel can't be sent through Meta, and the other way round. Everywhere a template is offered or linked (the inbox
  composer, the template editor, approval) only templates of the provider that carries WhatsApp now are usable; rows left over from the
  other provider are listed as "Not usable now".
- **Meta template wording (`template_mismatch`).** Meta delivers the template's own approved text, filled with the values passed. So a
  message sent with a Meta template must be exactly that text: word for word for a template without values, and with every `{{n}}`
  replaced by a value otherwise (`templateFit`). Anything else is refused when it is queued and again before it is sent, so the inbox never
  records one text while the customer receives another. Picking a template in the inbox puts its wording in the composer.
- **Marketing templates.** A WhatsApp template whose category is `marketing` makes the message marketing, whatever the sender asked for:
  it needs a `granted` marketing consent (a `revoked` one refuses it permanently) and the message is recorded with purpose `marketing`.
- **A provider switch in progress.** While `crm_workspaces.switching` is on, every message waits (`provider_switching`, re-checked after 10
  minutes) and keeps its credit hold; a person's own send is refused with that explanation instead of being dropped.

`SendDecision` now carries `provider`, the channel's `sender` and the approved `template` (name, language, body).

### What the dispatcher hands a transport (`dispatchMessage`)

The claim and the final rule check run in one transaction, the provider call runs outside any transaction, and the result is recorded in a
second one (as before). The request (`TransportSendRequest`):

- `to`: the normalized address the rule chain checked (E.164 or a lower-case email address); `contactRef`: the GoHighLevel contact id or
  null; `messageId`: our `conversation_messages.id`, used by each native transport as its correlation id and, where the provider has one,
  its idempotency key; `sender`: the channel's identity, sender id, account id and credential id (transports resolve the secret themselves).
- **Email threading.** `inReplyTo` is the Message-ID of the customer's latest email in the conversation; `references` lists the thread's
  known Message-IDs up to it, oldest first (RFC 5322 §3.6.4, at most 20). Inbound emails store their own Message-ID in
  `provider_thread_ref`; an outbound email stores the Message-ID its provider reports, when it reports one. Without an inbound
  Message-ID the email starts a new thread.
- **Unsubscribe.** Marketing email gets `unsubscribeUrl` from `buildUnsubscribeUrl` (one-click, RFC 8058), issued at the message's creation
  time so every attempt carries the same link. Service email gets none.
- **WhatsApp templates.** `template = { name, language, params }`. The parameters are read back from the message text: the stored template
  body (`Hi {{1}}, your visit is on {{2}}.`) is matched against the message, and each placeholder's text becomes its parameter. A template
  without placeholders has none. A message that doesn't follow the template's text never gets this far: it is refused as
  `template_mismatch` (see the rule chain). The schema gained no parameter column.
  GoHighLevel still receives our `templateId` (its own addressing).
- **A reminder's manage link.** See "Customer booking links" below.

Recording the outcome:

- **Accepted.** `status` becomes `sent` unless a delivery callback that raced ahead already recorded `delivered`, `read` or `failed` (then it
  is kept). `provider`, `provider_message_id`, `provider_thread_ref` and `segments_actual` (SMS segments the provider reported) are stored.
  Usage is settled under the provider's name (`metered_usage_events.provider`, `provider_reference = <provider>:<id>`) for the quantity
  actually sent: SMS segments are counted on the text that went out, so a filled-in link that adds a segment is billed. The billing model
  is unchanged: the estimate at send time is what is charged; `segments_actual` is kept for reconciliation only.
- **Credit holds that outlive a wait.** A message's hold lasts six hours past the time it is due (it is sized for `send_after` when queued,
  and extended whenever the message waits again: quiet hours, a provider switch, a retry). At the claim, a hold the scheduler released
  anyway is replaced by a fresh one after the balance and budget are checked again; without credit the message is held as `credits` /
  `budget`. If a hold lapses during the provider call, the accepted send is charged directly (`chargeUsage`) instead of failing: a message
  the provider took is always recorded as sent and billed once. One message whose result can't be recorded never stops the rest of a
  `dispatchDue` batch.
- **A callback that raced ahead of an unclear result.** When the send call doesn't confirm (a timeout) but the provider's status callback
  already recorded its id or moved the message past `sending`, the provider took it: it is recorded as sent and billed, never failed,
  re-queued or reported as undeliverable. Every failure and retry update applies only to a row still `sending`. `dispatchDue` also settles
  the hold of a message a callback confirmed after its worker stopped.
- **Refused because of the address** (`suppress`: carrier opt-out such as Twilio 21610, invalid, bouncing): the address is suppressed
  (source `<provider>_send`) and the message held as `suppressed`.
- **WhatsApp window closed** (`windowClosed`): held as `whatsapp_window_closed`.
- **Not attempted** (`blocked`): held as `provider_not_enabled`; with `reconnectRequired` the owners are told to reconnect *that* provider
  ("Reconnect Twilio to send messages", deduplicated per provider and day). For a native provider, whose credential only iAcquire can
  replace, the agency is told as well.
- **Retryable**: queued again after 2, 4 minutes (three attempts in all); **anything else** fails the message, releases the hold and tells
  the owners. A transport that throws is treated as "not confirmed sent", never as safe to repeat.

### Delivery events

- `applyDeliveryEvent(db, { provider, providerEventId, providerMessageId, status, rawStatus?, occurredAt?, detail?, suppress?, segments? })`
  finds the message by the provider's id (as before).
- `applyDeliveryEventForMessage(db, { provider, messageId, providerEventId, providerMessageId?, status, rawStatus?, … , orgId? })` finds it
  by **our** id, which each native provider echoes back (Twilio's per-message status callback URL, Resend's `mid` tag, Meta's
  `biz_opaque_callback_data`). A callback that arrives before the send call returned is therefore applied, and the provider's id is
  recorded if it was not stored yet. The workspace comes from the message row; the event is refused as `unknown_message` when the message
  went through a different provider (or, before the send returned, its channel belongs to another provider), when it names a provider id
  other than the one stored, or when the caller's `orgId` (the tenant the webhook resolved) is not the message's.
- Both: the event is recorded once per `(provider, provider_event_id)` (a repeat is `duplicate`), with the provider's own status word in
  `raw_status`; status only moves forward (`advancesDelivery`); "delivered" exists only because a provider said so; `suppress`
  (`bounce`, `complaint`, `invalid`, `opt_out`) suppresses the contact's address.

### Inbound (`ingestInbound`)

One code path for every provider: idempotent on `inbound:<provider>:<provider message id>`, exact-identifier contact match, inquiry
consent, STOP and START, follow-ups cancelled on a reply, escalation on unmistakable requests. The input is provider-neutral: `provider`,
`channel`, `address` (the customer's), `body`, `providerMessageId`, optional `subject`, `receivedAt`, `attachments` (described in the
message, never stored), email `threadRef` / `inReplyTo` / `references`; the GoHighLevel ids are optional.

- **Which workspace.** The GoHighLevel webhook passes `orgId` from its location mapping. A native webhook may pass `orgId` once it has
  located its tenant, or let ingest find it: by `(provider, provider_sender_id)` (`resolveChannelByProviderSender`, unique per provider)
  or, for email, by the receiving address (`resolveChannelByInboundAddress`, unique, case-insensitive). The channel must be that provider's
  and that channel's. Nothing matching: `{ status: "ignored" }`, nothing recorded. GoHighLevel tenants are never found this way.
- **Email threads.** A reply joins the conversation holding a Message-ID it names (In-Reply-To or References), whatever its thread, but
  only a conversation with the same customer: a forwarded or forged header can't put a message into someone else's conversation.
  Otherwise the customer's main email conversation is used, as before.
- **Unproven senders (`senderVerified`).** SMS and WhatsApp senders are proven by the carrier or Meta, and GoHighLevel's inbound is trusted
  as before, so the input defaults to proven. An inbound email is proven only when the receiving server authenticated its From domain (the
  Resend handler sets `senderVerified: false` otherwise). An unproven message is recorded and shown, but it never changes consent or
  suppressions through a keyword (STOP, START), never counts as the customer asking to be contacted (`inbound_inquiry`), and never gets an
  automatic reply.
- **Keywords never lift every suppression.** START (and the other opt-in words) lifts only an `opt_out` or `invalid` suppression
  (`KEYWORD_LIFTABLE_SUPPRESSIONS`). A bounce, a spam complaint or a person's do-not-contact entry (`manual`) stays.

### Channel setup (`src/server/messaging/channels.ts`)

- **Who.** Storing a provider credential, testing it and switching a native channel on is an agency super admin's job
  (`assertCredentialAdmin`, the rule for every stored credential). A client's owners and managers see each channel's provider and status
  (`getMessagingSettings`, `listChannelStatus`) and can switch any channel off; they can't switch a native channel on again
  (`setChannelEnabled` refuses with an explanation). Agency sender attestation (`attestChannelSender`) remains for GoHighLevel senders only.
- **Order.** `configureNativeChannel` (credential into the vault, sender details) → `runChannelCapabilityTest` (the provider package's
  read-only, authenticated test with the stored secret, called outside any transaction; the result is always recorded in
  `capability_test`; only a pass sets `capability_tested_at`, `sender_verified_at` and the registration status) → `enableChannel`. The
  database enforces the end of it: a native channel can't be enabled without a credential, a sender id and a passed **latest** test
  (`messaging_channels_native_ready` requires `capability_tested_at` and `capability_test.ok = true`), and an SMS or WhatsApp channel needs
  an approved (or not required) registration. A refusal says what is missing.
- **Saving a setup.** A change to anything the test checked (provider, credential, sender id, account, receiving address, or the address or
  number customers see) leaves the channel off and untested. Saving the same setup again (for example only a new display name on the
  from-address) keeps it as it was, on or off, with its test result. A save that would switch off a channel that is on, through GoHighLevel
  or a native provider, must be confirmed (`replaceLiveChannel`); the setup dialog shows that confirmation and says what happens.
- **A failed re-test.** It withdraws the earlier pass: `capability_tested_at` and `sender_verified_at` are cleared, so the channel can't be
  switched on. A channel that was **on** is switched off, and the client's owners and the agency are notified: sending with a credential or
  sender the provider just refused would fail, or half work (a WhatsApp number whose webhook subscription is gone keeps sending while
  customers' STOP replies never arrive), which is worse than holding messages until iAcquire fixes it. `disableChannel` switches off; `switchChannelToGhl` clears the native setup, revokes its credential and
  leaves the channel off until its GoHighLevel sender is verified again. Every step is audited without secrets.
- **Credentials.** `saveCredential` accepts `resend`, `twilio` and `meta_whatsapp`. A credential of several parts is one vault secret, a
  single-line JSON object (`encodeCredentialSecret` / `parseCredentialSecret`). Nothing the setup functions return, and nothing they audit,
  contains a secret: a status says only whether a credential is stored and when.

### Customer booking links

A customer's manage link (`/book/manage/<token>`) is a bearer secret. A reminder now stores the placeholder `{{appointment.manage_link}}`
(laid out with a link of real length, so filling it in never pushes the text past its limit) and no link is issued when it is queued.
Right before the provider call, the dispatcher issues a fresh link (`issueManageLink`, issued for `reminder`, valid until a week after the
appointment) for a reminder whose booking can still be changed online, and puts it only in the provider payload; the stored row is never
rewritten. When no link can be issued (the type no longer allows online changes, the cut-off passed, the appointment is no longer upcoming)
the sentence with the placeholder is left out; any other message never sends the raw placeholder either. A link issued for an attempt the
provider did not take at all is revoked; after any other failure the outcome may be unknown, so it stays valid until it expires.
Older rows may still hold a live link, so the inbox (messages and the conversation list preview), the contact timeline and the data export
show `[customer booking link]` instead (`maskCustomerLinks`). Each claimed reminder is also re-checked under a row lock before it is queued:
one rescheduled, cancelled or moved since the claim is never queued for the old time.

### Environment (agency level)

`RESEND_WRITES_ENABLED`, `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED` (kill switches, default off), `RESEND_WEBHOOK_SECRET`
(Svix signing secret, `whsec_…`), `TWILIO_WEBHOOK_BASE_URL` (optional public origin Twilio signs; else `APP_URL`), `META_APP_SECRET`
(signs WhatsApp webhooks), `META_WEBHOOK_VERIFY_TOKEN` (Meta's subscription handshake). Per-workspace keys live in the credential vault.

### Not verified, and known limits

- Nothing has been sent through any provider: every test uses an in-memory recorder or a mocked `fetch`.
- A reminder retried after an unconfirmed attempt (a timeout) carries a different manage link. Resend refuses a reused idempotency key with
  a different payload (`409 invalid_idempotent_request`), so if the first attempt had in fact been accepted, the retry is reported as failed
  although the customer received the first email, whose link still works.
- WhatsApp template parameters come from matching the message against the template body. A value that itself repeats the template's
  surrounding words could be read back ambiguously; the lazy match takes the shortest reading.
- Moving a live GoHighLevel channel to a native provider stops sending on it until the new provider passes its test and is switched on.
  Turning on `crm_workspaces.switching` first makes queued messages wait instead of being held as `channel_not_ready`; nothing in the
  product sets that flag yet.
- `segments_actual` is recorded but not yet reconciled against what was billed.

## GoHighLevel

The original transport, unchanged for existing workspaces: `ghlProvider` in `src/server/messaging/provider.ts`, wrapped as a
`ChannelTransport` by `src/server/messaging/transports/ghl.ts` (`requiresContactRef: true`, every channel). Webhooks:
`src/app/api/webhooks/ghl/route.ts` (`verifyGhlWebhook`, `parseGhlMessageEvent`, `handleGhlWebhook`), unchanged.

### Sources

| Source | What it settled |
|---|---|
| `GoHighLevel/api-v2-docs` `specs/conversations.json` (latest commit 2026-06-19, read 2026-10-16) | `POST /conversations/messages` on `https://services.leadconnectorhq.com` with the `Version` header; body `SendMessageBodyDto`: `type` (`SMS`, `Email`, `WhatsApp`, …), `contactId`, `message`, `subject`, `html`, `emailFrom`, `fromNumber`, `templateId` (the fields `ghlProvider` sends); response `SendMessageResponseDto`: `messageId`, `conversationId`, `emailMessageId`. |
| GoHighLevel webhook authentication guide (read 2026-10-14, unchanged) | `x-wh-signature`, RSA-SHA256 over the raw body with GoHighLevel's published public key; the code adds a 300-second freshness window. |

### What GoHighLevel workspaces keep

The `'ghl'` column default (no existing row changes), the contact-id requirement, GoHighLevel's published rates, the
`/api/webhooks/ghl` route and its receipts, `GHL_WRITES_ENABLED`, the template id addressing, and "a timeout or 5xx is not confirmed sent".
The only visible change: a reconnect notification now names the provider it is about, and GoHighLevel's still reads "Reconnect GoHighLevel
to send messages".

### Not verified

- Nothing has been exercised against a live GoHighLevel location.
- The current spec lists `subType` and `status` as required in `SendMessageBodyDto`; `ghlProvider` has never sent them and still doesn't.
  Whether GoHighLevel enforces them for `SMS`, `Email` and `WhatsApp` sends can only be settled against a live location.

## Twilio

SMS through Twilio Programmable Messaging. Code: `src/server/messaging/transports/twilio.ts` (transport, capability test, webhook
handler) and `src/app/api/webhooks/twilio/[kind]/route.ts` (the two public webhook routes). Tests: `tests/messaging-twilio.test.ts`.

### Sources (read 2026-10-16)

| Source | What it settled |
|---|---|
| `twilio/twilio-oai` `spec/json/twilio_api_v2010.json` | Message create, Account fetch, IncomingPhoneNumbers list: paths, form fields, response fields, enums. Server `https://api.twilio.com`. |
| `twilio/twilio-oai` `spec/json/twilio_messaging_v1.json` | Messaging Service fetch and its PhoneNumbers / ShortCodes lists. Server `https://messaging.twilio.com`. |
| twilio.com/docs/usage/webhooks/webhooks-security, and `twilio-node` `src/webhooks/webhooks.ts` with `spec/validation.spec.js` | `X-Twilio-Signature` algorithm, port handling, repeated parameters, published test vectors. |
| twilio.com/docs/messaging/guides/webhook-request | Incoming-message parameters. |
| twilio.com/docs/messaging/guides/track-outbound-message-status | Status callback parameters and status values. |
| twilio.com/docs/messaging/api/message-resource | Status meanings (`partially_delivered` is deprecated, `canceled` applies to scheduled Messaging Service messages only), `num_segments` is `"0"` for a Messaging Service send until a sender is picked, the 1,600-character Body limit. |
| twilio.com/docs/usage/webhooks/webhooks-connection-overrides | Retries happen only when a connection override asks for them; retries carry `I-Twilio-Idempotency-Token`. |
| twilio.com/docs/messaging/tutorials/advanced-opt-out | `OptOutType` (`STOP`, `START`, `HELP`) means Twilio already matched an opt-out keyword and replied. |
| twilio.com/docs/iam/api-keys | Standard API keys can't read `/Accounts`; Main keys and the account's own SID and token can. |
| Twilio error dictionary (`twilio-error-codes.json` from twilio.com/docs/api/errors) | The meaning of every error code mapped below. |

### Sending

- `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, `application/x-www-form-urlencoded`, HTTP Basic auth: an API
  key SID and secret when one is stored, otherwise the account SID and auth token.
- Form fields sent: `To` (E.164), `MessagingServiceSid` (when the sender is `MG…`) or `From` (when it is an E.164 number), `Body`, and
  `StatusCallback`. `To` is the only field the spec marks required; one of `From` / `MessagingServiceSid` is needed to send.
- `StatusCallback` is `<TWILIO_WEBHOOK_BASE_URL or APP_URL>/api/webhooks/twilio/status?mid=<our conversation_messages id>`. Twilio signs
  that URL with the query string included, and the `mid` lets a callback that arrives before the send call returned still find its message.
- Response `201`: `sid` (`^(SM|MM)[0-9a-fA-F]{32}$`), `status` (`message_enum_status`), `num_segments` (a string), `error_code` (integer or
  null). The send reports `quantity = num_segments` only when it is a real count (1 to 50). `"0"` (Messaging Service, sender not yet
  picked) reports nothing, and billing keeps the estimate made at queue time. A `201` whose `status` is already `failed`, `undelivered` or
  `canceled` is a failure, not a send.
- **At most once.** Message creation has no idempotency key. A timeout, a network error or a 5xx comes back as a non-retryable "not confirmed
  sent". The dispatcher marks it failed and never repeats it. Only a 429 / 20429 (refused before anything was accepted) is retryable.
- **Kill switch.** `TWILIO_WRITES_ENABLED` is off unless set to `true`. While it is off, `send` returns `{ ok: false, blocked: true }`
  before anything else happens.
- Refused before calling Twilio:
  - a channel other than SMS
  - no sender or credential
  - a credential that is missing, revoked, unreadable, or belongs to another workspace
  - a credential for a different account SID than the sender's
  - a destination that isn't E.164
  - an empty body
  - a body over 1,600 characters (Twilio would refuse it with 21617; nothing is truncated)
- Delivery is never assumed from the send response. It advances only from status callbacks, and only forward (`advancesDelivery`).

Error mapping. Twilio's own error text is never passed on, because it can contain the phone number.

| Code | Meaning (Twilio dictionary) | What iAcquire does |
|---|---|---|
| 21610 | Attempt to send to unsubscribed recipient | Fails the message and suppresses the number with reason `opt_out`. |
| 21211, 21614 | Invalid 'To' number / not a valid mobile number | Fails the message and suppresses the number with reason `invalid`. |
| 20003 (or HTTP 401/403) | Permission denied | Fails the message and asks the owner to reconnect Twilio. |
| 20404, 21606, 21660, 21704, 30002, 30037 | Sender or account not usable (not found; not an SMS-capable number on the account; number and account don't match; empty Messaging Service; account suspended; outbound messaging disabled) | Fails the message and asks the owner to reconnect Twilio. |
| 20429 (or HTTP 429) | Too many requests | Retryable. |
| 30003–30008, 30410, 30450 | Carrier and handset outcomes, including 30007 (carrier filtered) | Fails the message without suppressing. These codes are ambiguous about whether the number itself is bad. |
| 21408, 21608, 21609, 21612, 21617, 30001, 30032, 30034–30036, 30041, 30044 | Geo permissions, trial limits, a bad StatusCallback, sender and destination pairing, length, queue overflow, toll-free and A2P 10DLC registration, validity period, country registration | Fails the message with a plain description and the code, for example "(Twilio 30034)". |

### Credentials

The secret is stored in the credential vault (`saveCredential`, provider `twilio`) as one JSON string. Use `twilioSecretJson()` to build it:

- `accountSid` (`AC…`) and `authToken`: always required. Twilio signs every webhook with the account's auth token, so without it incoming
  replies and STOP messages could not be authenticated.
- `apiKeySid` (`SK…`) and `apiKeySecret`: optional, and given together. When present, REST calls use the key, so the auth token stays out of
  request traffic. An API key alone is not accepted, because it cannot verify webhooks.

### Capability test

`testTwilioCapability({ secret, senderId })` takes the sender either as `senderId` or as `sender.senderId` (the registry's
`CapabilityTestInput`). It only reads and never sends a message. Its result contains no secret. Checks, in order:

1. **Twilio account.** `GET /2010-04-01/Accounts/{Sid}.json`, always authenticated with the auth token, which proves the token that signs
   webhooks is valid. The account must have `status` `active` and `type` `Full`. A trial account fails the check, because it can only text
   verified numbers and adds a trial notice. The response's `auth_token` field is never read.
2. **API key**, when one is stored: `GET IncomingPhoneNumbers.json?PageSize=1` with the key.
3. **Sender**, by type:
   - **Messaging Service:** `GET https://messaging.twilio.com/v1/Services/{MG…}`. Its `account_sid` must be this account. Then
     `GET /v1/Services/{MG…}/PhoneNumbers`, falling back to `/ShortCodes`, must list at least one sender with the `SMS` capability.
   - **Phone number:** `GET IncomingPhoneNumbers.json?PhoneNumber=<E.164>` must return it on this account with `capabilities.sms = true`.
4. **Incoming messages.** The service's `inbound_request_url` (with `use_inbound_webhook_on_number` false) or the number's `sms_url`
   must be `<base>/api/webhooks/twilio/inbound`, with method POST.
5. **Webhook address.** The base URL must be public `https`. Localhost, private addresses and `.local` / `.test` / `.internal` names fail.
6. **US carrier registration.**
   - A Messaging Service with `us_app_to_person_registered = true` is `approved`.
   - US (+1) senders without it are `pending`, and the check fails.
   - A bare US number is always `pending`, because the number API does not report A2P 10DLC or toll-free verification. Connect it through
     a registered Messaging Service instead.
   - Non-US senders are `not_required`.

### Webhooks

Configure `<base>/api/webhooks/twilio/inbound` in Twilio as "A message comes in" (HTTP POST) on the Messaging Service, or on the number.
Status callbacks are set per message and need no configuration. `<base>` is `TWILIO_WEBHOOK_BASE_URL`, or `APP_URL` when that is not set.

- **Signature.** `X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + name1 + value1 + name2 + value2 …))`:
  - Names are sorted.
  - Repeated names have their values de-duplicated and sorted, as in `twilio-node`'s `getExpectedTwilioSignature`.
  - The fragment (`#…` connection overrides) is never sent and never signed.
  - Like the SDK, the check accepts the URL with or without the default port.
  - The comparison uses `timingSafeEqual`.
  - The code is tested against Twilio's own published vectors, for example token `12345`,
    `https://mycompany.com/myapp.php?foo=1&bar=2` with the five `CallSid…To` parameters gives `RSOYDt4T1cUTdK1PDd93/VVr8B8=`.
- **The signed URL** is rebuilt from the configured public base plus the query string as received. It is never built from `req.url`, `Host`
  or forwarded headers, which a caller controls.
- **Tenant.** The tenant comes only from our own records:
  - for an incoming message: `MessagingServiceSid` and `To`
  - for a status callback: the outbound message named by the `mid` in its URL, plus `MessagingServiceSid` and `From`

  Sender ids are looked up with `resolveChannelByProviderSender`. Every id that matches must point at the same workspace and credential.

  Anything that resolves to no workspace, or to two, is refused. The token comes from that tenant's credential. The payload's `AccountSid`
  must match the credential's account SID and the channel's recorded account. The resolved credential is kept in memory for at most 60
  seconds, because one message produces several callbacks. Revoking or replacing a credential takes effect for webhooks within a minute.
- **Unknown tenants: 403.** An unknown sender and a bad or missing signature get the same bare `403 Forbidden`, so a caller cannot probe
  which numbers are connected. Nothing is written for a request that was not authenticated. This choice keeps processing honest: an empty
  TwiML 200 would tell Twilio the message was handled. Twilio shows the 403 in its debugger, so a misconfigured number is visible to whoever
  configured it. A form body is required: anything else gets 400. The route caps the body at 256 KB and accepts only POST (GET gets 405).
- **Replays.** A replayed request is dropped by a `webhook_receipts` row (`provider 'twilio'`), keyed on signed fields: `inbound:<MessageSid>`
  and `status:<MessageSid>:<MessageStatus>`. `I-Twilio-Idempotency-Token` is deliberately not the key. It is a header, so the signature does
  not cover it, and a captured request replayed with a fresh token would otherwise be processed again. Twilio's genuine retries carry the
  same signed parameters, so they are caught either way. The receipt is written in the same transaction as the processing, so a request
  that fails with a 500 leaves no receipt and a retry is processed.
- **Incoming message.** It goes through the provider-neutral `ingestInbound` (provider `twilio`, channel `sms`). That handles:
  - contact match and consent
  - STOP and START with the shared keyword list: suppression, consent revoked, follow-ups and pending AI messages cancelled
  - follow-up cancellation on a reply
  - escalation

  Some extra rules apply to the incoming message:
  - Twilio may block the person for a word the shared keyword list doesn't know. The same opt-out is then applied, with the source
    `twilio_opt_out`, in two cases:
    - Advanced Opt-Out sends `OptOutType = STOP` (a custom or translated keyword).
    - Without Advanced Opt-Out, the whole message is one of Twilio's default long-code opt-out words: STOP, UNSUBSCRIBE, END, QUIT,
      STOPALL, REVOKE, OPTOUT, CANCEL. REVOKE is the one missing from the shared list.

    `OptOutType = START` lifts the suppression.
  - After any `OptOutType` (including `HELP`), or a default opt-out word, no AI reply is prepared, because Twilio has already answered.
  - Media is described to the shared ingest by content type only (`MediaContentType{N}`, at most 10). The ingest records a note that
    attachments aren't shown yet.
  - A `From` with a channel prefix (`whatsapp:`, `messenger:` …) is ignored on this SMS connection.
  - The response is always the empty TwiML `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`, which receives the message
    without replying.
- **Status callback.** `MessageStatus` maps as follows:
  - `sent`, `delivered`, `read`, `failed` and `undelivered` map to themselves.
  - `canceled` maps to `failed`.
  - Everything else (`queued`, `sending`, `accepted`, `scheduled`, the deprecated `partially_delivered`) is acknowledged and ignored.

  The callback is applied with `applyDeliveryEventForMessage`, matched by our `mid`. It carries the raw status (`raw_status`), the
  `NumSegments` value when Twilio includes it (`segments_actual`), the error description and the suppression from the table above. Without
  a `mid`, it falls back to `applyDeliveryEvent` by Twilio's `MessageSid`. Delivery only moves forward: a late `delivered` after `read`
  changes nothing.
- After the response, an AI-owned conversation gets its reply prepared (`respondToConversation`, then `dispatchDue`) through `after()`, as
  the GoHighLevel route does.

### Not verified

- No call has been made to a real Twilio account. The request shapes, the response parsing and the capability checks follow the OpenAPI spec
  and the docs above, and are exercised only against mocked responses.
- How long Twilio takes to send the first status callback, and whether a Messaging Service's status callback includes
  `MessagingServiceSid`, were not observed. The `mid` correlation doesn't depend on either.
- MMS media is not downloaded or shown. Media URLs need the account's credentials, and storing them is a separate decision.

## Resend

Email through Resend. Code: `src/server/messaging/transports/resend.ts` (transport, capability test, webhook handler),
`src/app/api/webhooks/resend/route.ts` (the public webhook route), `src/server/messaging/unsubscribe.ts` (signed unsubscribe links),
`src/app/api/public/unsubscribe/route.ts` (the List-Unsubscribe URL) and `src/app/unsubscribe/[token]/page.tsx` (the confirmation page).
Tests: `tests/messaging-resend.test.ts`.

### Sources (read 2026-10-16)

| Source | What it settled |
|---|---|
| `resend/resend-openapi` `resend.json` v1.5.1 | `POST /emails`: `SendEmailRequest` (`from`, `to` as a string or an array of at most 50, `subject`, `text`, `html`, `reply_to`, `headers` as an object, `tags` as `[{name, value}]`), the `Idempotency-Key` header (at most 256 characters), `SendEmailResponse { id }`. `GET /domains` (`limit` / `after` / `before` paging; list items carry no DNS records) and `GET /domains/{domain_id}` (`status`: `pending`, `verified`, `failed`, `not_started`, `partially_verified`, `partially_failed`; `capabilities.sending` / `.receiving`: `enabled` or `disabled`; `records[].record`: `SPF`, `DKIM`, `Receiving`, `Tracking`, `TrackingCAA`, each with a `status`). `GET /emails/receiving/{email_id}` (`GetReceivedEmailResponse`: `from`, `to`, `subject`, `message_id`, `text`, `html`, `headers`, `attachments`). Webhook schemas: `OutboundEmailEventData.tags` is an object of name to value; `WebhookEventBounce.type` is `Undetermined`, `Transient` or `Permanent`; `WebhookEventSuppressed.reason` is `previous_bounce` or `previous_complaint`; `EmailReceivedEventData` has `email_id`, `from`, `to`, `cc`, `bcc`, `received_for`, `subject`, `message_id` and attachment metadata. |
| resend.com/docs/api-reference/errors | Every error name and status in the table below. |
| resend.com/docs/dashboard/emails/idempotency-keys | Keys are kept 24 hours. A repeated key returns the original response without sending again. `409 invalid_idempotent_request`: same key, different body. `409 concurrent_idempotent_requests`: the first request is still running, safe to try again. |
| resend.com/docs/dashboard/emails/tags | Tag names and values: ASCII letters, digits, `_` and `-`, at most 256 characters. A UUID fits. |
| resend.com/docs/dashboard/emails/custom-headers and …/add-unsubscribe-to-transactional-emails | Custom headers are passed through. `List-Unsubscribe` plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; answer the POST with an empty 200 or 202; stop sending within 48 hours. |
| resend.com/docs/dashboard/receiving/* | Receiving works at a verified domain (its MX record) or at the account's `<id>.resend.app` address. The `email.received` webhook carries metadata only; the body and headers are read with the Receiving API. Replying in a thread: `In-Reply-To` set to the received `message_id`, subject starting with `Re:`. |
| resend.com/docs/webhooks/* (introduction, event types, verify requests, retries and replays) | Event types `email.sent`, `.delivered`, `.delivery_delayed`, `.bounced`, `.complained`, `.opened`, `.clicked`, `.failed`, `.scheduled`, `.suppressed`, `.received`. Signed through Svix. Retries: immediately, then 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h; an endpoint that keeps failing is disabled. |
| docs.svix.com "Verifying Webhooks Manually", and the `svix` / `standard-webhooks` verifier source | `svix-id`, `svix-timestamp`, `svix-signature`. HMAC-SHA256 over `id.timestamp.body`, keyed with the base64-decoded part after `whsec_`. A space-separated list of `v1,<base64>` entries. Constant-time comparison. The unbranded `webhook-*` header names. A 5-minute tolerance either way. The published example vector, which the tests use. |
| RFC 8058, RFC 2369, RFC 5322 | The one-click POST body, HTTPS for the one-click signal, angle brackets in `List-Unsubscribe`, and the `Message-ID` / `References` formats. |
| `resend.json` v1.5.1, webhooks (read 2026-10-16) | `GET /webhooks` (`ListWebhooksResponse`: `data[].id`, `endpoint`, `events`, `status`; `limit` at most 100, `after` paging), `GET /webhooks/{webhook_id}` (`GetWebhookResponse.signing_secret`), and `CreateWebhookRequest` with only `endpoint` and `events`: Resend generates every webhook's secret. resend.com/docs/api-reference/webhooks/list-webhooks shows `status` `enabled` / `disabled`. |
| resend.com/docs/api-reference/emails/retrieve-received-email (read 2026-10-16; not yet in the OpenAPI document) | `authentication: { spf, dkim, dmarc }`, each `pass`, `fail`, `gray`, `processing_failed` or `unknown`, computed by Resend's receiving server when the email arrived (not read from the message's headers, so a sender can't forge them); `null` for older emails. DKIM `gray` covers a signature by a domain other than From; DMARC `gray` means SPF or DKIM passed without a DMARC policy. |

### Sending

- `POST https://api.resend.com/emails`, JSON, `Authorization: Bearer <key>`, a `User-Agent`, and `Idempotency-Key: msg:<our conversation_messages id>`.
- Body fields:
  - `from`: the channel's sender identity (`Name <hello@domain>`; the name is quoted when needed).
  - `to`: the one normalized address.
  - `subject`: control characters and line breaks removed, at most 200 characters. A reply gets `Re:` in front.
  - `text`: the message.
  - `html`: derived from the text. It is escaped, keeps paragraphs and line breaks, and links only `http` and `https` URLs. It contains no
    images, remote styles, fonts or scripts, so opening it loads nothing.
  - `reply_to`: the workspace's inbound address, when one is set, so replies come back into the Inbox.
  - `headers`: `In-Reply-To` and `References` for a reply (Message-IDs are validated; anything that could break a header line is dropped).
    For a marketing email, `List-Unsubscribe: <url>`, plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click` when the URL is HTTPS. The
    link is also added to the text and as a footer to the HTML.
  - `tags: [{ name: "mid", value: <our message id> }]`, so a webhook is matched even if it arrives before the send call returns.
- The same message always produces the same body, because Resend refuses a reused key with a different body. The dispatcher builds the
  unsubscribe URL from the message's creation time for that reason.
- **Kill switch.** `RESEND_WRITES_ENABLED` is off unless set to `true`. While it is off, `send` returns `{ ok: false, blocked: true }` before
  anything is read.
- Refused before calling Resend: a channel other than email, a message id that isn't a UUID, an invalid address, no sender identity, no
  credential, and a credential that is missing, revoked, unreadable or belongs to another workspace.
- The send response has no Message-ID, so an outbound message's `provider_thread_ref` stays empty. Replies thread on the customer's
  Message-ID, which inbound messages record.
- **At most once, with confirmation.** An unclear answer (a timeout, a 5xx other than 503, a 2xx without an id, `409
  concurrent_idempotent_requests`) is followed, after 1 s and then 3 s, by the identical request with the same key. Resend then returns the
  original answer without sending again, or processes it if it never took it. If the answer stays unclear after three tries, the message is
  "not confirmed sent", not retryable, and is never repeated later, because the 24-hour idempotency window could pass before a later retry.
  Only answers that confirm nothing was taken are retryable by the dispatcher.
- Delivery is never assumed from the send response. It advances only from webhooks, and only forward (`advancesDelivery`).

| Resend answer (status, `name`) | What iAcquire does |
|---|---|
| 429 `rate_limit_exceeded`; 503 `service_unavailable`; connection refused or DNS failure before reaching Resend | Retryable (nothing was taken). |
| 500 `application_error`, other 5xx, a timeout, 409 `concurrent_idempotent_requests` or `resource_locked` | Confirmed with the same key, as above. |
| 400 `validation_error` "API key is invalid"; 401 (`missing_api_key`, `validation_error`); 403 `restricted_api_key`, `suspended_api_key`, `invalid_permission` | Fails, and asks the owner to reconnect Resend. |
| 403 `validation_error` (domain not verified, or the testing-only sender) | Fails, and asks the owner to run the channel test again. |
| 409 `invalid_idempotent_request` | Fails; not sent again. |
| 429 `daily_quota_exceeded`, `monthly_quota_exceeded` | Fails, naming the quota. |
| Any other 4xx (400 `validation_error`, 422 `invalid_parameter`, `missing_required_field`, …) | Fails as invalid, with the error name. |

Resend's own error `message` is never shown or stored. It is only used to tell the two kinds of 400 `validation_error` apart.

### Credentials

Stored in the credential vault as provider `resend`: the API key (`re_…`) or the JSON `{"apiKey": "re_…"}`. It must be a **Full access**
key. A sending-only key can't read a domain's status (401 `restricted_api_key`) or a received email.

### Capability test

`testResendCapability({ secret, senderIdentity, senderId?, inboundAddress? })` also accepts the registry's `CapabilityTestInput` (`sender:
{ identity, senderId }`). It only reads, never sends, and its result contains no secret. Checks, in order:

1. **API key.** `GET /domains/{senderId}`, or `GET /domains?limit=100` page by page (at most 1,000 domains) to find the from-address's
   domain by name. A 401, a 403 or a 400 "API key is invalid" fails the check, naming a sending-only or suspended key when Resend says so.
2. **Domain.** It must exist in that Resend account and match the from-address's domain exactly. The domain's id becomes the channel's
   `provider_sender_id`.
3. **Sending.** `status = verified`, or `partially_verified` / `partially_failed` with every SPF record and a DKIM record verified, and
   `capabilities.sending` not `disabled`. A pending, not-started or failed domain fails the check, with Resend's status in plain words.
4. **Replies.** With an inbound address:
   - at the sender's domain: `capabilities.receiving = enabled` and a verified `Receiving` (MX) record are required, or the check fails;
   - at another domain in the account: the same check on that domain;
   - at a Resend-managed `*.resend.app` address: it passes with a note, because the API can't say which account owns one.

   Without one, it passes with a note that replies won't reach the Inbox.
5. **Webhooks.** `GET /webhooks` (page by page) must list an `enabled` webhook to `<APP_URL>/api/webhooks/resend` subscribed to
   `email.delivered`, `email.bounced` and `email.complained` (and `email.received` with a reply address), and `GET /webhooks/{id}` must
   return a `signing_secret` equal to `RESEND_WEBHOOK_SECRET` (compared in constant time, never shown). Resend generates every webhook's
   secret, so a key from a client's own Resend account fails here instead of every bounce, complaint and reply being refused later.
6. **Tracking** (information only): when open or click tracking is on, Resend rewrites links or adds a tracking image to the HTML part.

`registrationStatus` is always `not_required` for email.

### Webhooks

Create one webhook endpoint in Resend at `<APP_URL>/api/webhooks/resend`, subscribed to `email.sent`, `email.delivered`,
`email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed` and `email.received`. Its signing secret
is `RESEND_WEBHOOK_SECRET`.

- **One signing secret.** The secret is agency-level, so every workspace's domains must live in the Resend account whose endpoint it signs,
  normally the agency's own. A workspace with its own, separate Resend account would need its own endpoint secret. That isn't supported,
  and it is enforced: the capability test's Webhooks check fails for such a key, and the setup screen says so where the key is entered.
- **Signature and freshness.** As in the sources: the HMAC is compared in constant time with every `v1` entry, and the timestamp must be
  within 5 minutes either way. A bad signature gets 401, missing or stale headers 400, and no configured secret 503. Nothing is recorded for
  a request that fails. The route accepts only POST, caps the body at 256 KB, and answers with only `{ received, outcome }`.
- **Replays.** The `svix-id` is the `webhook_receipts` key (provider `resend`). Svix sends the same id on its retries and on manual
  replays, so either changes nothing. The receipt is written in the same transaction as the processing.
- **Delivery events.** Matched by the `mid` tag through `applyDeliveryEventForMessage`, which also records Resend's email id when the send
  hasn't returned yet. Without a tag, or with a tag that matches nothing (for example a message that went through another provider),
  `applyDeliveryEvent` matches by Resend's email id. Mail that isn't ours (platform mail sent from the same account) is acknowledged and
  ignored. The event id is `<email_id>:<type>`, and the raw type is kept in `raw_status`.

  | Event | Status | Also |
  |---|---|---|
  | `email.sent` | `sent` | |
  | `email.delivered` | `delivered` | |
  | `email.delivery_delayed` | `sent`, which never moves a message back | Raw status `delivery_delayed`. |
  | `email.bounced`, `bounce.type = Permanent` | `failed` | Suppresses the address (`bounce`). |
  | `email.bounced`, `Transient` or `Undetermined` | `failed` | No suppression: a full mailbox can work another time. |
  | `email.complained` | `delivered` (it reached the inbox) | Suppresses the address (`complaint`). |
  | `email.suppressed` | `failed` | Mirrors Resend's suppression: `previous_complaint` as `complaint`, otherwise `bounce`. |
  | `email.failed` | `failed` | The `failed.reason` word goes in the detail. |
  | `email.opened`, `email.clicked`, `email.scheduled`, anything else | ignored | Opens are unreliable, and iAcquire adds no tracking. |

- **Received email.** The workspace is found only by our own records: the recipients (`to`, `cc`, `bcc`, `received_for`) are matched against
  `messaging_channels.inbound_address`. One email reaches one workspace, the one whose address comes first, because a Resend email id belongs
  to one message. The receipt notes any other workspace it was also addressed to. Then:
  - The email is read with **that workspace's own key** (`GET /emails/receiving/{email_id}`), outside any transaction.
  - Transient failures (429, 5xx, network) answer 503, so Resend retries and nothing is recorded.
  - Permanent failures (401/403 key refused, `email_above_quota`, a 404 meaning the key belongs to another account, a missing credential)
    record the receipt as `rejected` and notify the agency once a day per workspace.
  - Ignored: no usable sender, mail from the workspace's own sender or inbound address, and automatic or bulk mail (`Auto-Submitted` other
    than `no`, `Precedence: bulk/junk/list/auto_reply`, `X-Autoreply`, `X-Autorespond`, `X-Auto-Response-Suppress: All`, `List-Id`,
    `List-Unsubscribe`, `mailer-daemon@` / `postmaster@`).
  - Otherwise the message goes through the provider-neutral `ingestInbound` (provider `resend`, channel `email`). The body is the text part
    (or text derived from the HTML part, tags dropped, never interpreted), with the quoted thread removed ("On … wrote:", `>` lines,
    "Original Message", Outlook `From:`/`Sent:` blocks), at most 5,000 characters. The customer's `Message-ID` is stored as the message's
    `provider_thread_ref`, so the reply carries `In-Reply-To` and `References`. Attachments are counted, not downloaded.
  - **Sender authentication.** The received email's `authentication` verdicts decide whether its From address is proven: DMARC `pass`, or
    DKIM `pass` (signed by the From domain). SPF alone proves only the envelope sender, and an `Authentication-Results` header inside the
    message could be forged, so neither is used. An unproven email (or one without verdicts) is recorded with `senderVerified: false`: no
    STOP/START consent or suppression change, no inquiry consent, no automatic reply; the receipt's detail says so.
  - After the response, an AI-owned conversation from a proven sender gets its reply prepared through `after()` (`respondToConversation`,
    then `dispatchDue`).

### Unsubscribe links

- `buildUnsubscribeUrl(orgId, contactId, channel, { issuedAt })` returns `<APP_URL>/api/public/unsubscribe?t=<token>`.
- **Token.** 55 bytes, base64url (74 characters): version, workspace id, contact id, channel, purpose (`marketing`), issue time in seconds,
  and a 16-byte HMAC-SHA256 tag. The key is derived with HKDF-SHA256 from `APP_ENCRYPTION_KEY`, with its own label, so it can't be confused
  with any other use of that key. Keys listed in `APP_ENCRYPTION_KEY_PREVIOUS` still verify, so links in emails already sent survive a key
  rotation.
- **Verification** needs no database: a forged or tampered token costs one HMAC. A link works for 365 days (CAN-SPAM asks for at least 30)
  and is refused when it is dated more than 10 minutes in the future. `verifyUnsubscribeToken(token, { orgId })` also refuses another
  workspace's token.
- **GET** only redirects (303, relative) to `/unsubscribe/<token>`, and never changes anything, because link scanners open links too. The
  page shows the business, the channel and the address, partly hidden ("ma•••@example.com"), with an Unsubscribe button. That button is a
  plain HTML form, so it works without JavaScript.
- **POST** unsubscribes:
  - A mail app's one-click POST (`List-Unsubscribe=One-Click`, url-encoded or multipart) gets an empty 200, also for a link whose contact
    no longer exists. A bad token gets 400, an expired one 410, and a rate-limited one 429.
  - The page's own form gets a 303 back to the page.
- **What it records.** A `revoked` marketing consent event for that contact and channel (source `list_unsubscribe` or
  `unsubscribe_link`), and an audit entry `consent.unsubscribed`. It is idempotent: the contact row is locked, and a second request records
  nothing. It is deliberately not a suppression. Service messages the person asked for (an appointment confirmation) still go, while
  `evaluateSend` refuses marketing on that channel from then on.
- Rate limits are per link (20 unsubscribes and 60 page views an hour), not per IP address, because mail providers send one-click requests
  for many people from shared addresses.
- `/unsubscribe/` is listed in the proxy's public paths. The page sets `noindex` and `no-referrer`, and the route answers `no-store`.

### Not verified

- No call has been made to a real Resend account. The request shapes, the response parsing and the capability checks follow the OpenAPI
  document and the docs above, and are exercised only against mocked responses. The Svix verification is checked against Svix's published
  example vector.
- RFC 8058 requires the `List-Unsubscribe` headers to be covered by a valid DKIM signature. Resend signs with DKIM, but its docs don't say
  whether custom headers are in the signed header list. Check the `h=` list of a real message's `DKIM-Signature`.
- Whether Resend replays an original 5xx for a repeated idempotency key isn't documented. The confirmation step relies on the documented
  behaviour: a repeated key returns the original response, or the request is processed.
- The exact header-name casing in `GetReceivedEmailResponse.headers` wasn't observed. Names are lower-cased before the automatic-mail checks.
- A forged `From` still lands in that contact's conversation, as in any shared inbox, but changes nothing and gets no automatic reply.
  A genuine customer whose domain neither signs with DKIM nor passes DMARC is treated the same way: a person answers, and STOP by email
  from such a sender needs a person (or the unsubscribe link) to take effect.
- The Webhooks check was written against the OpenAPI document and the list-webhooks page; the exact `status` word of a disabled webhook
  (`disabled`) comes from the docs' example only.
- Inbound attachments are not downloaded or shown.

## WhatsApp (Meta Cloud API)

WhatsApp through Meta's WhatsApp Business Cloud API (Graph API). Code: `src/server/messaging/transports/meta-whatsapp.ts` (transport,
capability test, webhook handlers), `src/server/messaging/whatsapp-templates.ts` (template sync and template status events),
`src/app/api/webhooks/meta-whatsapp/route.ts` (the public webhook route, GET and POST) and the `whatsappTemplateSync` job in
`src/server/ops/tick.ts`. Tests: `tests/messaging-whatsapp.test.ts`.

### Sources (read 2026-10-16)

Meta's developer docs now live under `developers.facebook.com/documentation/business-messaging/whatsapp/…`. Each page was read in its
"View as Markdown" form. The machine-readable spec is `facebook/openapi` on GitHub (v23.0 at the time of reading).

| Source | What it settled |
|---|---|
| Graph API changelog (`/docs/graph-api/changelog`) | The latest version is **v26.0** (July 29, 2026, available until "TBD"). v25.0 runs until July 29, 2028. The v26.0 changes don't touch the WhatsApp endpoints used here. Every call uses `v26.0` (`META_GRAPH_VERSION`). |
| Messages API reference, "Service messages", "Text messages" | `POST https://graph.facebook.com/{Version}/{Phone-Number-ID}/messages`, `Authorization: Bearer`, JSON body with `messaging_product: "whatsapp"`, `recipient_type: "individual"`, `to`, `type`, `text.body` (max 4,096 characters). The response (`messages[0].id`, the wamid) only means "accepted". Delivery is reported by status webhooks. Meta recommends `+` and the country code in `to`. |
| "Template fundamentals" (parameter formats) | `type: "template"`, `template: { name, language: { code }, components: [{ type: "header" or "body", parameters: [{ type: "text", text }] }] }`. Named templates add `parameter_name`. Positional values follow the placeholder order. Only `APPROVED` templates can be sent. |
| WhatsApp changelog | `biz_opaque_callback_data` is accepted on free-form messages (it already was on template messages), maximum 512 characters, and comes back on the status webhooks. `played` was added as a status for voice messages. |
| "Create a webhook endpoint" and Graph API "Webhooks" | GET `hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`: answer 200 with the challenge only if the token matches. POST carries `X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the payload, keyed with the app secret>`. Up to 1,000 updates per request. Failed deliveries are retried for up to 7 days, so the receiver deduplicates. |
| Webhook references: text, image, button, interactive, location, reaction, system, unsupported, errors, status | `entry[].changes[]` with `field: "messages"` and `value.metadata.phone_number_id`, `value.contacts[].profile.name` / `wa_id`, `value.messages[]` (`id`, `from` as digits without `+`, `timestamp` in seconds, `type`, a per-type object, `context`), `value.statuses[]` (`id`, `status` sent/delivered/read/failed/played, `timestamp`, `recipient_id`, `errors[]`, `pricing { billable, pricing_model, type, category }`, `biz_opaque_callback_data`). A read can arrive without a delivered first. |
| "Business-scoped user IDs" | A user who adopted a WhatsApp username may arrive with `from_user_id` (BSUID) and **no `from` phone number**. |
| Template status webhook reference (`message_template_status_update`) | `entry.id` is the WABA, `value.event` (APPROVED, ARCHIVED, UNARCHIVED, DELETED, DISABLED, FLAGGED, IN_APPEAL, LIMIT_EXCEEDED, LOCKED, PAUSED, PENDING, REINSTATED, PENDING_DELETION, REJECTED), `message_template_id`, `reason`. |
| Message Templates API reference | `GET /{Version}/{WABA-ID}/message_templates` with `fields`, `limit`, `after`. Template status enum: APPROVED, ARCHIVED, DELETED, DISABLED, IN_APPEAL, LIMIT_EXCEEDED, PAUSED, PENDING, PENDING_DELETION, REJECTED. Also `rejected_reason`, `parameter_format` (NAMED / POSITIONAL), `category` (AUTHENTICATION, MARKETING, UTILITY), `paging.cursors.after` plus `paging.next`. |
| Phone number API reference, "Phone numbers", `facebook/openapi` | `GET /{Phone-Number-ID}?fields=…` (`display_phone_number`, `verified_name`, `quality_rating`, `name_status`, `status`). The status must be `CONNECTED` to send and receive. Also `GET /{WABA-ID}/phone_numbers` and `GET /{WABA-ID}/subscribed_apps` (`data[].whatsapp_business_api_data { id, name, link }`). |
| Error codes reference | Error body `{ error: { message, type, code, error_data: { details }, fbtrace_id } }`. Meta says to build error handling around `code`. The meaning of every code mapped below. |
| "Access tokens" | System User tokens are long-lived. A token without access to the asset gets error 200. |

### Sending

- `POST https://graph.facebook.com/v26.0/{phone_number_id}/messages` with the tenant's System User token as a Bearer token. The body is
  `{ messaging_product: "whatsapp", recipient_type: "individual", to: "<E.164>", …content, biz_opaque_callback_data: "<our message id>" }`.
- **Text or template.** The core (`evaluateSend`) decides whether a free-form message may go: only within
  `messaging_policy.whatsapp_window_hours` (default 24) of the customer's last message (`conversations.last_inbound_at`). Outside it, a
  message needs an approved template. The transport only follows that decision:
  - no `template` in the request: `type: "text"`, `text: { body }`
  - a `template`: `type: "template"` with the template's name and language code, and its values placed by the variables the last sync
    recorded (header values in a `header` component, body values in a `body` component, `parameter_name` for named templates). A wrong
    number of values, an empty value, or a template that isn't approved for this workspace is refused before calling Meta.
- `biz_opaque_callback_data` is our `conversation_messages.id`, so a status webhook that arrives before the send call returned is still
  matched (see Webhooks).
- **At most once.** The Cloud API has no idempotency key. A timeout, a network error or a 5xx is "not confirmed sent" and is never repeated.
  Only rate-limit refusals (HTTP 429, codes 4, 80007, 130429, 131056) are retryable, because nothing was accepted.
- **Kill switch.** `META_WHATSAPP_WRITES_ENABLED` is off unless set to `true`. While it is off, `send` returns `{ ok: false, blocked: true }`
  before anything else happens.
- Refused before calling Meta:
  - another channel
  - no phone number ID or credential
  - a credential that is missing, revoked, unreadable or belongs to another workspace
  - a destination that isn't E.164
  - an empty body, or a body over 4,096 characters (nothing is truncated)
  - a template problem as above
- Delivery is never assumed from the send response. It advances only from status webhooks, and only forward (`advancesDelivery`).

Error mapping. Meta's `message` and `details` text is never passed on, because it can contain the phone number.

| Code | Meaning (Meta's error reference) | What iAcquire does |
|---|---|---|
| 131047 | More than 24 hours since the customer's last message | Fails the message with `windowClosed`. Not retryable. |
| 0, 190 (or HTTP 401) | Token could not be authenticated / expired | Fails and asks to reconnect (`reconnectRequired`). |
| 3, 10, 200–299, 131005 | Permission missing or removed | Fails and asks to reconnect. |
| 33, 131045, 133010, 131037 | Number deleted or not registered, or (555 numbers) no approved display name | Fails and asks to reconnect. |
| 368, 131031, 131042 | Account restricted or locked; payment method problem | Fails and asks to reconnect (a person must fix the account). |
| 4, 80007, 130429, 131056 (or HTTP 429) | App, account, throughput and pair rate limits | Retryable. |
| 131026 | Undeliverable (not a WhatsApp number, old app version, terms not accepted) | Fails without suppressing. The reasons are ambiguous about the number itself. |
| 131050 | The user stopped marketing messages from this business | Fails. From a status webhook, the contact's WhatsApp **marketing** consent is withdrawn (`source: provider_opt_out`). Service messages and the address are not suppressed. |
| 131049, 131048, 131064, 130472, 130497, 130403, 131021 | Per-user marketing limit, spam limit, classification limit, experiment, country restriction, business blocked the user, sender = recipient | Fails with a plain description and the code, for example "(WhatsApp 131049)". |
| 132000, 132001, 132005, 132007, 132012, 132015, 132016, 132018 | Template value count, not approved or no such language, too long, policy, value format, paused, disabled, parameter validation | Fails with a plain description. The next template sync updates the template's status. |
| 1, 2, 131000, 131016, 133004 with a 5xx | Unknown or temporary server problems | "Not confirmed sent", never repeated. |

### Credentials

The secret is stored in the credential vault (`saveCredential`, provider `meta_whatsapp`) as one JSON string `{ "accessToken": "…" }`. Use
`metaWhatsappSecretJson()` to build it. The token is a System User token with `whatsapp_business_messaging` and
`whatsapp_business_management` on the workspace's WhatsApp Business Account.

The app secret that signs webhooks is **agency-level** (`META_APP_SECRET`), because every workspace's account is subscribed to the same
iAcquire Meta app. So is the verify token (`META_WEBHOOK_VERIFY_TOKEN`). The channel records:

- `provider_sender_id`: the phone number ID
- `provider_account_id`: the WABA ID
- `sender_identity`: the number in E.164

### Capability test

`testMetaWhatsappCapability({ secret, senderId, accountId })` also accepts the registry's `CapabilityTestInput`, with the ids inside `sender`.
It is read-only: GET requests only, nothing is sent. The result contains no secret. Checks, in order (the test stops at the first one that
makes the rest meaningless):

1. **Access token.** `GET /{phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating,name_status,status`. A 401 or an
   auth/permission code fails it.
2. **Phone number.** The id must come back, with `status` `CONNECTED` (Meta: a number must be connected to send and receive).
   - The display number becomes `senderIdentity` (E.164).
   - Verified name, display-name status and quality rating are shown in the detail.
   - `registrationStatus` is `approved` when connected, otherwise `pending`.
3. **WhatsApp Business Account.** `GET /{waba_id}/phone_numbers` (up to five pages of 100) must list the phone number ID, so a number can't be
   paired with someone else's account.
4. **Message templates.** `GET /{waba_id}/message_templates?limit=1` must succeed. The template sync needs it.
5. **Webhook subscription.** `GET /{waba_id}/subscribed_apps` must list at least one app. Meta reports app names, not callback URLs. The
   detail names the apps and says the iAcquire app must be one of them. Without an app id, the test can't prove which app it is.
6. **Webhook address.** `META_APP_SECRET` and `META_WEBHOOK_VERIFY_TOKEN` must be set, and `<APP_URL>/api/webhooks/meta-whatsapp` must be a
   public https address.

### Webhooks

Configure `<APP_URL>/api/webhooks/meta-whatsapp` once as the iAcquire Meta app's callback URL, with `META_WEBHOOK_VERIFY_TOKEN` as the verify
token. Subscribe the app to the `messages` field and, recommended, to `message_template_status_update`. Each workspace's WABA must have the
app subscribed (`subscribed_apps`).

- **Handshake (GET).** `hub.mode` must be `subscribe` and `hub.verify_token` must equal `META_WEBHOOK_VERIFY_TOKEN`, compared in constant
  time over SHA-256 digests. The answer is the `hub.challenge` as `text/plain` (`nosniff`). Anything else, or no configured token: 403.
- **Signature (POST).** `X-Hub-Signature-256` must be `sha256=` plus the hex HMAC-SHA256 of the exact raw body, keyed with
  `META_APP_SECRET`. It is compared with `timingSafeEqual` before anything is parsed or written.
  - Missing or wrong: 401.
  - No app secret configured: 503, so Meta keeps retrying until it is.
  - The code is tested against the RFC 4231 HMAC-SHA256 vector (key `Jefe`, data `what do ya want for nothing?` gives `5bdcc146…3843`) and
    against signatures computed independently in the test.
- **Batches.** Every status and message in every entry is handled on its own, in its own transaction, behind its own `webhook_receipts` row
  (`provider 'meta_whatsapp'`): `status:<wamid>:<status>`, `inbound:<wamid>`, and `template:<id>:<event>:<entry.time>`.
  - A retried batch only processes what is new.
  - If any event fails unexpectedly, that event's receipt rolls back with it and the answer is 500, so Meta retries. The events already
    recorded are skipped as duplicates.
  - The route caps the body at 1 MB, because Meta batches up to 1,000 updates. Past 2,000 events in one request the answer is also 500.
- **Tenant.** The workspace comes only from our own records: `metadata.phone_number_id` is looked up with
  `resolveChannelByProviderSender('meta_whatsapp', …)`. When the channel records a WABA, `entry.id` must match it. An unknown number is
  acknowledged (200) and ignored, with nothing written.
- **Incoming messages** go through the provider-neutral `ingestInbound` (provider `meta_whatsapp`, channel `whatsapp`). That handles the
  contact match by E.164 number (`from` gets its `+`), the WhatsApp profile name for a new contact, consent, STOP/START (a quick-reply
  button "Unsubscribe" is a STOP), follow-up cancellation and escalation. `last_inbound_at` becomes the message's own timestamp, which opens
  the 24-hour window. By message type:
  - Text, button and interactive replies become their text. Location and contact cards become a short description.
  - Image, video, audio, document and sticker become a note with the caption, for example
    `[Photo received. Media isn't downloaded or shown in the inbox yet.]`. Media is **not downloaded**: that needs the tenant's token and
    storage, which is a separate decision.
  - Reactions, system notices (number changes), `request_welcome` and similar events are acknowledged and not recorded.
  - A username-only sender (no `from`, only a BSUID) is acknowledged and ignored, because the inbox addresses people by phone number.
  - An AI-owned conversation gets its reply prepared after the response (`respondToConversation`, then `dispatchDue`) through `after()`.
- **Statuses.** `sent`, `delivered`, `read` and `failed` map to themselves. `played` and anything else is acknowledged and ignored. Matching:
  - With `applyDeliveryEventForMessage`, by `biz_opaque_callback_data` (our id), when it names an outbound WhatsApp message of the same
    workspace that has no other wamid.
  - Otherwise with `applyDeliveryEvent` by the wamid. That is refused if the wamid belongs to another workspace.

  The event keeps the raw status (`raw_status`). A failure keeps the mapped error description. A success with `pricing` keeps
  `Meta pricing category: <category> (<type>).` in the event's `detail`. Billing is unchanged (the estimate made at queue time).
- **Template status events** (`message_template_status_update`):
  - An event after which the template can't be sent (PAUSED, PENDING, REJECTED, DISABLED, ARCHIVED, IN_APPEAL, LIMIT_EXCEEDED,
    PENDING_DELETION, DELETED) marks that template not sendable at once, in every workspace whose channel uses that WABA.
  - Approvals, reinstatements, FLAGGED and LOCKED (both still sendable) change nothing directly.
  - Every template event schedules a full sync of those workspaces after the response, because the event carries no components and an
    edited template may have changed.

### Templates

`syncWhatsappTemplates(orgId)` reads
`GET /{waba_id}/message_templates?fields=id,name,language,status,category,components,rejected_reason,parameter_format&limit=100` page by
page (`after` cursor, at most 30 pages). It mirrors the account into `whatsapp_templates` with `provider 'meta_whatsapp'`. It never creates,
edits, submits or deletes anything in Meta. It runs:

- every three hours from the scheduled tick (`whatsappTemplateSync`), for every workspace whose WhatsApp channel is Meta with a credential and
  a WABA
- after template status webhooks
- after channel setup, when that calls it

**Status mapping.** Only `APPROVED` is sendable (Meta: any other status can't be sent).

| Meta status | `whatsapp_templates.status` | `rejection_reason` |
|---|---|---|
| APPROVED | `approved`, unless iAcquire can't send it (then `rejected`) | null, or "Approved by Meta, but iAcquire can't send it yet: …" |
| PENDING | `pending` | null |
| IN_APPEAL | `pending` | "Rejected by Meta; an appeal is under review." |
| PAUSED | `pending` (not sendable; Meta may unpause it) | "Paused by Meta because of low quality…" |
| REJECTED | `rejected` | "Rejected by Meta: <reason>." from `rejected_reason` |
| DISABLED, ARCHIVED, LIMIT_EXCEEDED, PENDING_DELETION, DELETED, unknown | `rejected` | Why it can't be sent. |

**Not sendable from iAcquire (yet).** The dispatcher fills a template from the message text by its numbered body placeholders. So a template
is stored as `rejected`, with the reason, when it has any of these:

- a media or location header, or a value in the header
- named values (`{{first_name}}`)
- a button that needs a value (OTP, copy code, flow, catalog, a URL with a variable part)
- another component type (carousel, limited-time offer)

Static quick-reply, phone, voice-call and URL buttons are fine.

**Columns.**

- `template_id`: Meta's template id.
- `body`: the BODY text (at most 1,024 characters).
- `category`: lower-case.
- `variables`: `[{ position, label, component: "header" | "body", name? }]` in the order values are passed, with Meta's example in the label
  ("{{1}} (e.g. Pablo)").
- `components`: structure and text only. Examples and media handles are dropped, to stay within the column's size limit.
- Templates whose name is over 120 characters (the column limit) are skipped and counted.

**Idempotent.** The sync upserts on `(org_id, template_id)`. A GoHighLevel row with the same id is never overwritten. A Meta template that is
no longer listed is marked `rejected` ("No longer in the WhatsApp Business Account…"), never deleted, because messages and native template
definitions refer to it. All pages are read before anything is written. If any page fails, or there were more than 30 pages, nothing is
marked as gone.

### Not verified

- No call has been made to a real Meta account or app. Request shapes, response parsing and the capability checks follow the docs and the
  `facebook/openapi` spec above, and are exercised only against mocked responses.
- Two response details were not observed live: whether Meta returns a phone number's `status` field for every account type, and the exact
  `subscribed_apps` shape for apps subscribed with an override callback URL.
- The capability test can't confirm which app receives the webhooks (no app id is configured), only that some app does.
- Template parameter rules that Meta enforces at send time beyond the documented ones (for example characters a value may not contain) are
  not checked locally. Meta's refusal is reported with its code.
- Media is not downloaded, username-only (BSUID) senders can't be answered, and sending to a BSUID is not implemented.

## Templates, tokens and canned replies

Native message templates and canned replies are provider-neutral: they are rendered by iAcquire and then sent through whichever transport
carries the channel, under the same rules as any other message. Code: `src/lib/messaging/tokens.ts` (token catalog, validator, renderer),
`src/server/crm/message-templates.ts` (versions, approval, preview, test sends, Communication Settings read model). Tests:
`tests/crm-templates.test.ts`.

### Sources (read 2026-10-16)

| Source | What it settled |
|---|---|
| `twilio/twilio-oai` `spec/json/twilio_api_v2010.json` (info version 1.0.0), Message create `Body` | "can be up to 1,600 characters in length", and SMS bodies over 160 GSM-7 characters are segmented. The validator refuses an SMS template longer than 1,600 characters (measured with sample values). |
| developers.facebook.com, WhatsApp Business Platform, "Text messages" page, `text.body` | "Maximum 4096 characters." The validator refuses a WhatsApp template longer than that. |
| developers.facebook.com, WhatsApp Business Platform, "Template components" page, BODY component | "Maximum of 1024 characters", positional (`{{1}}`) and named parameters. Recorded as `TEMPLATE_LIMITS.whatsappTemplateBody`; iAcquire doesn't create Meta templates, it only links to synced ones. |
| `resend/resend-openapi` `resend.yaml` (info version 1.5.1), `SendEmailRequest` | `from`, `to` and `subject` are required, so an email template without a subject is refused when it is saved. |

### Rules

- Tokens are `{{group.name}}` from a fixed catalog (contact, business, sender and appointment details). Saving a template or canned reply
  with an unknown token, an unfinished `{{`, or a WhatsApp Manager placeholder such as `{{1}}` is refused; the editor suggests the token
  that was probably meant.
- `renderTemplate` fills values in one pass (a value is never expanded again) and never returns a `{{` or `}}`: a token without a value is
  reported in `missing`, and a send that would need it is refused with the reason ("This message needs the contact's first name, which
  isn't available."). The inbox composer fills canned replies the same way and marks gaps ("[First name]") that must be replaced before
  the reply can be sent; `sendReplyAction` also refuses a reply that still contains a catalog token.
- SMS segment counts in the editor come from `smsSegments` (the function billing uses), with 160/70 characters for one segment and 153/67
  per segment once a message is split. They are estimates with sample values: real names and dates change them.
- Every change to a template's channel, subject or body is a new frozen `crm_message_template_versions` row with a sha256 content hash.
  Approval binds the exact version and hash a person reviewed; editing an approved template (or changing its purpose or linked WhatsApp
  template) moves it back to draft. Automated senders read the approved version through `loadApprovedTemplate`, never the draft.
- A test send goes only to an address in `approved_test_destinations` (confirmed by the person adding it as their own), through
  `queueOutbound` as that person, and only when the channel is enabled and its transport's kill switch (`*_WRITES_ENABLED`) is on.
  Otherwise it reports exactly which of those failed and queues nothing. The message goes to the contact's main address for the channel,
  so a destination that is only a second address on a customer's record (whose main address differs) is refused
  (`destination_not_approved`) before anything is recorded on that record.
- A WhatsApp template linked to a Meta template can be approved only when its wording fits the Meta template (each token where Meta has a
  value, everything else the same words): Meta would deliver its own text, so approving other words would approve text no customer
  receives. Only templates of the provider that carries WhatsApp now can be linked or approved.

### Not verified

- No template has been sent through a live provider account; every test stubs `fetch`, and test sends in tests are only queued.
- GSM-7 versus UCS-2 classification follows the existing `smsSegments` implementation; carrier-specific encodings (for example national
  language shift tables) are not modelled.
- WhatsApp template parameters for a linked Meta template are filled by the WhatsApp transport, not by the template editor. The editor
  doesn't check the wording while typing; approval and every send do.
