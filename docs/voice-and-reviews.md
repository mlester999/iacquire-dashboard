# Reviews and call activity (Native CRM, phase 5)

This covers two features of the native CRM:

- **Reviews**: public review links, review requests to customers, the customer's private feedback page, and private feedback.
- **Calls**: call records reported by the voice-AI providers (Vapi, Retell), calls logged by the team, and the workspace's voice connections.

Both work only on the workspace's own data. Neither uses GoHighLevel.

| Area | Code |
|---|---|
| Reviews service | `src/server/crm/reviews.ts` |
| Low-feedback follow-up, settings, reminders, erasure | `src/server/reputation/` (`feedback.ts`, `settings.ts`, `jobs.ts`, `erasure.ts`, `task-link.ts`) and the pure rules in `src/lib/reputation/` |
| Surveys: scores, the Satisfaction view, program links, survey forms | `src/lib/reputation/` (`scores.ts`, `satisfaction.ts`, `incentives.ts`), `src/server/reputation/` (`analytics.ts`, `program-link.ts`, `survey-feedback.ts`), `src/lib/retention.ts`, `src/server/retention/engine.ts`, `src/lib/crm/forms/` (`spec.ts`, `mapping.ts`), `src/server/crm/forms/process.ts` |
| Calls service | `src/server/crm/calls.ts` |
| Voice adapters | `src/server/integrations/voice/` (`vapi.ts`, `retell.ts`, `types.ts`, `handler.ts`) |
| Webhook routes | `/api/webhooks/vapi`, `/api/webhooks/retell` |
| Customer page | `/r/<token>`, which posts to `/api/public/reviews/feedback` and `/api/public/reviews/click` |
| Screens | CRM → Growth → **Reviews** (`/crm/reviews`) and **Calls** (`/crm/calls`); the **Calls** tab on a contact; agency mirror `/admin/clients/<id>/crm/reviews` and `/calls` |
| Workflow step and triggers | **Request a review** (`request_review`, optionally a survey); triggers `feedback.escalated` and `review.external_received` |
| Tests | `tests/crm-reviews.test.ts`, `tests/crm-calls.test.ts`, `tests/reputation-*.test.ts` |

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
5. **Nothing is offered in return, and no rating is asked for.**
   - Wording that carries the customer's review link may not offer anything for feedback or a review (a discount, a coupon, a free item, a gift, a reward, "in exchange", "off your next") or ask for a particular rating ("a 5-star review", "a positive review"). `reviewIncentiveFindings` (`src/lib/reputation/incentives.ts`) **blocks**, it does not warn.
   - It is applied where wording is made and where it is sent: a template with the link can't be saved or approved with such words (`validateTemplate`), a retention program step with the feedback link can't be saved or switched on, and a request is refused (`incentive_wording`) if wording that got in some other way reaches `prepareRequest` or the program step.
   - The word list is deliberately blunt and is a proposal for counsel to confirm. It does not mistake "feel free to reply" or "hassle-free" for an offer.

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
- The template's wording offers something in return for feedback or a review, or asks for a particular rating (rule 5).
- No review link is switched on. (A **survey** may be sent to a business with no review link yet: its page then shows only the questions.)
- The contact is archived.
- The contact has no address on the template's channel.
- The address is suppressed.
- Consent is not granted.
- The contact was asked in the last **30 days**, on any channel, by anything: a person, a workflow, a retention program, a review request or a survey. Requests that never reached them don't count: cancelled ones, and ones whose message failed or was blocked.
- The ask is **automatic** (a workflow, a program or the API) and a person on the team excluded the contact from automatic messages (`contacts.retention_paused`, set on the Retention page, for example during a dispute). This is that person's explicit choice: nothing sets it from a rating, a comment or a complaint. A person pressing Send is not stopped by it. Each stopped ask is audited (`crm.review_request_held`).

**Preview.** The request dialog runs the same checks first (`previewReviewRequest`). It shows:
- the exact message, with `[review link]` where the customer's link goes
- each check, with whether it passed

**Token.**
- 43 characters, base64url. It is derived from the request's id with a server key (HMAC-SHA256 over a key made from `APP_ENCRYPTION_KEY`), so it is never stored and the same request always yields the same link. Links made with a retired key (`APP_ENCRYPTION_KEY_PREVIOUS`) still match.
- Only its **sha256** is stored (`crm_review_requests.token_hash`). The application role can't read that column.
- The queued message does **not** contain the link. It keeps the placeholder `{{review.link}}`. The dispatcher derives the token again, checks it against the stored hash, and puts `<APP_URL>/r/<token>` into the text for the provider call only (`reviewLinkForMessage`, called from `src/server/messaging/send.ts`).
- So `conversation_messages.body` never holds a working link. Everywhere the team reads message text the placeholder (and any `/r/<token>` link) is shown as `[customer review link]` (`maskCustomerLinks` in `src/server/messaging/redact.ts`): the inbox, the timeline, AI tools and exports. A queued message whose request is gone or cancelled is blocked (`review_link_unavailable`) instead of being sent with a raw placeholder.

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
   - an optional score and an optional comment (at most 2,000 characters, control characters removed). The score is **1–5** ("How was your experience?") or, on a request made with the zero-to-ten scale, **0–10** ("How likely are you to recommend X to a friend or colleague?", with only the two ends named). Both are plain radio buttons with the same field name; **the request decides which scale applies**, never the form, so a posted 7 on a one-to-five request is refused
   - at least one of the two is required (a 0 is an answer, not "nothing chosen")
   - posted to `/api/public/reviews/feedback`

The public-links panel is left out in exactly one case: a **survey** (below) for a business that has no active review link at all. Nothing else removes or reorders it, whatever the answer.

**Other behaviour:**
- Works without JavaScript.
- Never indexed.
- No referrer is sent.
- Rate-limited per token: 60 page views, 10 feedback posts and 60 clicks an hour.
- The proxy allows `/r/` without sign-in.

**Low feedback and the follow-up.** Feedback is **low** when its rating is at or below the workspace's level (2 of 5 by default; owners and managers can choose 1 to 3 under CRM → Reviews → Settings), when its recommend score is at or below the workspace's detractor level (6 of 10 by default; owners and managers can choose 4 to 7 in the same place), or when it is a comment with no rating that plainly raises a complaint (the same blunt words the inbox acts on; "no complaints at all" does not count). Whether it was low is decided when it arrives and stored (`customer_feedback.low_score`), so changing the level later never rewrites history. A comment next to a rating is judged by the rating alone. Low feedback **adds** a private follow-up, in one transaction with the feedback itself:
- a high-priority task for the contact's owner (or unassigned), due when the acknowledgement time ends (24 hours by default), with the comment in the task (tasks are read inside the portal)
- `customer_feedback.follow_up_status = 'escalated'`, `escalated_task_id` and `escalation_id`
- a notice to the owner and managers with the customer's name and score, never their words (notices can be emailed)
- an inbox escalation (`human_escalations`, category complaint, urgent) in the conversation the review request lives in, reopened if it was resolved or archived. The summary holds the score, never the customer's words. The escalation's emails are sent only after the transaction commits. If raising it fails, the task and notice still exist and the failure is audited (`crm.feedback_escalation_failed`)
- the customer's remaining **automatic retention program messages stop** (reason `negative_feedback`), so an unhappy customer is not sent a cheerful check-in the next day. This stops program messages only
- a `feedback.escalated` event (no rating, no comment in its payload) and a timeline entry

It changes nothing the customer sees, except that the thank-you says a person will follow up privately. The public review links, their order and the wording around them are identical for every rating (tests/reputation-feedback.test.ts compares the page for a 1 and a 5). Who is asked for a review never depends on a rating, a comment, an escalation or a feedback status (tests/reputation-gating-guard.test.ts).

**Acknowledging and resolving.** Owners and managers, and the person the follow-up task is assigned to, mark feedback acknowledged or resolved; who and when are recorded. Finishing the follow-up task resolves the feedback by itself. If nobody has acknowledged low feedback within the workspace's time, the scheduler's `feedbackSla` job reminds the owner, the managers and the task's assignee **once** (not when someone acknowledged or resolved it, finished its task, or took its inbox escalation; items older than 14 days are left alone).

### Surveys: CSAT and NPS

**Dormant until switched on.** Everything in this section that is new (a request of kind survey, the Satisfaction view, a program's feedback link, a survey form's answers saved as private feedback, the survey mode of the workflow step, the check-in template) is off in every workspace until a Super Admin switches it on: `org_features`, feature `reputation_surveys`; no row means off (`src/server/reputation/entitlement.ts`, one seam, no price: where surveys sit relative to the implementation fee and the monthly plan is the founder's decision). Off, a survey is refused with the reason in the preview and when sending, a program can't be saved or approved with the link (and a step that was approved earlier is held back with `surveys_not_enabled`), a survey form can't be published with a feedback question (and answers to one published earlier are kept with the submission, not saved as feedback, with a note), the workflow step can't be published in survey mode (and a published one is skipped with the same reason), and the Reviews screen shows no Satisfaction tab and no survey choice. Review requests, the page for a request that already exists, private feedback and its follow-up do not depend on the switch, and turning it off never withdraws or hides an answer a customer already gave.

A request has a **kind**: a *review request* (the default) or a *satisfaction survey*, and a **scale**: one to five (`csat5`) or zero to ten (`nps10`). Both are columns of `crm_review_requests` (migration 0094), chosen in the request dialog or on the workflow step, and both use exactly the same page, template mechanism (`{{review.link}}`), send path, consent rules, 30-day cool-down and low-feedback follow-up. A survey is a review request whose question is the point.

**Answers** are stored in `customer_feedback`: a one-to-five answer in `rating`, a zero-to-ten answer in `nps_score` (never both), with `scale`. A low answer is decided on arrival from the workspace's settings and stored (`low_score`).

**Scores** (`src/lib/reputation/scores.ts`, shown under CRM → Reviews → **Satisfaction**):
- **CSAT** is the share of answers that are 4 or 5, and the average.
- **NPS** is the share of promoters (9–10) minus the share of detractors (0–6). These are the standard groups, whatever follow-up level the workspace chose.
- **A score is shown only for enough answers**: 10 on the one-to-five scale, 30 on the zero-to-ten scale (proposals; the owner of the product confirms them). Below that the screen says how many answers there are and how many are needed, never a number. The same gate applies to the whole period, to each week, and to each appointment type and calendar.
- Answers a customer gave through their own link, or in a survey form that knew who they were, are one group. Answers to an **anonymous** survey form are reported on their own and are not mixed in. Feedback recorded by hand (the Retention page) or imported is counted and **never scored**, because it is not the customer's own answer on a scale.
- The view also shows the share of sent requests that got an answer (review requests and surveys apart; a percentage only for enough requests), a weekly trend (weeks start on the workspace's own Monday), and how the team is doing with low feedback (open, past the acknowledgement time, and a typical time to acknowledge once there are 5 examples).

### Retention programs that carry the link

The "Ask for feedback" and "Follow up after an appointment" programs (both service messages) can put the customer's own private link in a message with `{feedback_link}`. The standard wording of every program has no link; nothing changes until an owner or manager edits the wording and the **owner approves the new words** (the approval is bound to a hash of the exact wording, so changing the text around the link withdraws it, as for any program). `{feedback_link}` is refused in every other program, in promotional messages, more than once in a message, and next to an offer (rule 5).

When such a step comes due (`src/server/reputation/program-link.ts`, called from `prepareDueSteps`):
- **Channel.** It goes only by a channel the customer agreed to service messages on (consent exactly *granted*, not merely allowed by the send rules), to an address that has not opted out, preferring the channel they wrote on lately. With no such channel the step is held back with a reason (`link_needs_consent`, `no_contact_channel`); if an address opted out and no other channel was agreed to, the customer's program ends (`suppressed`).
- **Cool-down.** Nobody who was asked for a review or a survey in the last 30 days (by anyone) gets a second link: the step is held back (`recently_requested`) and the rest of the program carries on.
- **The request exists with the message.** The request (kind survey, scale one to five, `requested_via = 'program'`, the attended appointment attached) is created in the same transaction as the queued message, so the message can never be dispatched without its link. A message the send path refuses leaves nothing behind. The stored message keeps `{{review.link}}`; the link is put in for the provider call only, as for every request.
- **Withdrawing.** When a queued message is withdrawn (the customer replied, a person excluded them, low feedback came in, the program was switched off), its request is cancelled with it and the link stops taking answers.
- **A person's hold.** Customers excluded by a person (`retention_paused`) are not enrolled, and their planned messages are cancelled; the exclusion is audited with the reason given.
- The shared frequency limit applies as to every program message: a second program message for the same customer waits out the minimum spacing, and a step stopped by the limit is shown as held back by the limit, not as not sent.

### Surveys built as forms

A native form of kind *survey* can save its answers as private feedback. The question editor offers, under "Private feedback (surveys only)": **rating from 1 to 5**, **how likely to recommend, 0 to 10**, and **comment**. A number question must accept exactly the scale's whole numbers (smallest and largest set, whole numbers only), and a choice question's choices must have stored values that are those numbers; only one score per survey. A form that is not a survey can't be published with one.

When the scheduler processes a submission (`processSubmissionInTx`), the feedback is saved once per submission (`customer_feedback.form_submission_id`, unique):
- **A survey that asked for an email or phone** and matched or made a contact attributes the answer to that contact and, if it is low, opens the same follow-up as a link (task, notice, `feedback.escalated`, the customer's program messages stop). A form identifies people only by what they typed, so the task says to check it is really them. There is no conversation to escalate in, so there is no inbox escalation.
- **A survey that asked for nothing identifying** stores the answer attached to no one. It is counted and flagged as low, appears in the private feedback list as "No name attached", and is reported apart in the Satisfaction view. Nobody is told to follow up with no one.

### Batches: asking many customers at once

**Dormant until switched on.** `org_features`, feature `reputation_batches` (one seam in `src/server/reputation/entitlement.ts`, no price). Off, a batch can't be made, prepared, approved or resumed and the scheduler does not touch one; a workspace that already has batches keeps seeing them (and can pause or cancel them). Nothing in this section has run against a real provider; the scheduler has never run in production, and the job `reviewRequestBatches` does nothing until a staged start names it.

**Who is in a batch (rule 2).** Only customers a service was **completed** for, in a window of up to 366 days that has already happened (a day in the workspace's own time zone): *appointments marked attended* (optionally only some calendars or appointment types), *deals marked won* (optionally one pipeline) or *customers since* a date. Each customer appears once, with the most recent such service attached to their request. The criteria are a strict object of six keys (`source`, `from`, `to`, `calendarIds`, `appointmentTypeIds`, `pipelineId`); any other key is refused by name, and the column's check constraint repeats the list, so no rating, score, comment, status, escalation or tag can be stored as a way to choose people. `tests/reputation-gating-guard.test.ts` reads every batch file whole to keep it so.

**Who is then left out**, by the first rule that applies, in the order the send path checks them: no address on the channel, opted out or bounced, consent withdrawn, no consent exactly *granted* for service messages on that channel, asked in the last 30 days (by anyone), or a person's own hold on automatic messages (`contacts.retention_paused`). The preview counts them by reason and names some; each is checked again, by `queueReviewRequestInTx` itself, when it is their turn (`tests/reputation-batches.test.ts` keeps the preview and the single request in step). Each customer a hold keeps out is audited (`crm.review_request_held`, which the Reviews numbers count) and shown as *held back by a person*; a person pressing Send is not stopped by it.

**Approval.** Owners and managers prepare a batch (draft). The preview shows who would be asked, who would not and why, and the message as the first customer would get it. A manager asks the owner; **only the owner approves** (`campaigns.send`, in the client's own workspace; iAcquire support can look, never prepare or approve). The approval is a hash (`approved_hash`) of the template's approved wording and version, the criteria, the channel, the kind and scale, the pace and the business details the wording uses, plus the stored binding that explains a change. It is recorded as a standing authorization that lapses after 14 days. Approving sends nothing.

**Pace and sending.** The scheduler starts an approved batch: it re-checks the approval (still standing, approver still the owner, nothing in the hash changed), reads the people once and records each as waiting or left out, then asks at most `rate_per_minute` (1 to 60, default 10) in any minute, each in its own transaction through the ordinary review request (consent, opt-outs, cool-down, hold, quiet hours, frequency limit, credits), with the message dedupe key `batch:<batch>:<customer>`. The pace is spent inside the batch's row lock, so two turns at once share it. A customer's own address, consent or hold leaves just that customer out; credits, the budget, the channel, a missing public review link or surveys switched off **pause** the batch for a person; an approved wording that can no longer be sent, or any change to what the owner approved, **stops** it for good (queued messages not yet sent are stopped, their requests cancelled, the approval withdrawn; copy the batch to start again). A paused workspace holds the batch and what it queued. A batch finishes when nobody is waiting.

**Pause, resume, cancel.** A person's pause holds what was queued and not sent; resuming lets it go and re-checks the approval. Cancelling (or closing the workspace) stops what was not sent and asks nobody else; messages already sent stay sent.

**What it does not do.** No scheduling for later (approval starts it), no customer-facing text beyond the template, no result counted against how people answered (the batch reports sent, opened and not sent from the requests and messages), no AI.

### Automation Studio

- **Request a review** step: *a request for a review* (default; nothing new is stored, so versions published earlier keep their exact content) or *a short satisfaction survey* (`mode: "survey"`, with `scale: "csat5"` or `"nps10"`).
- **Trigger `feedback.escalated`** ("Low private feedback needs a follow-up"): fires once per piece of low feedback, with the customer and no rating or comment. A workflow it starts may notify people and create tasks. It **may not contain a request-a-review step (either mode) or a message whose approved wording carries `{{review.link}}`**: who is asked never depends on how they felt (checked when a workflow is saved and published). It has no filters.
- **Trigger `review.external_received`** ("New public review"): defined, with no contact and no filters, for the day a review site is connected. Nothing starts it today.
- **Template "Check in after a visit, then ask how it went"**: a day after someone is marked as having attended, an approved check-in message; three days later, an approved survey message with the survey link.

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
- **Private feedback:** count, average rating (one to five answers only), the number of recommend scores, ratings by score, low answers, and how many still need a follow-up.
- **Satisfaction** (own tab): CSAT and NPS with sample gates, response rates, weekly trend, by appointment type and calendar, anonymous survey answers apart, and the team's follow-up (see "Surveys: CSAT and NPS").
- **Review sites opened, by site:** counted from `review.link_clicked` timeline entries.

**Caveats shown on screen:**
- "Opened" counts link opens. Email security scanners also open links.
- "Opened a review site" doesn't mean a review was posted.

Owners and managers (and the assignee of the follow-up task) mark feedback **new**, **acknowledged** or **resolved**. **Escalated** is set by the escalation itself.

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
| Mark feedback acknowledged or resolved | `reviews.manage` (agency write sessions included), or being the person the feedback's follow-up task is assigned to |
| Change the reputation settings (low-feedback level, acknowledgement time, optional assists) | `reviews.manage`, client members only |
| `reviews.view`, `reviews.respond`, `reviews.reply_publish` | Defined for the public-review features that come next (reading, drafting and approving replies); nothing uses them for private feedback yet. `reviews.reply_publish` is the client's owner and manager only: the agency never approves or posts a reply |
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
- **The link is not stored in the message:** the queued message holds `{{review.link}}` and the link is filled in at dispatch, for the provider call only (see "Token" above). The provider and the customer's own phone or inbox hold the working link; nothing the team can read does.
- **Template previews:** the template editor previews `{{review.link}}` as the labelled sample link (sample values) or as `[review link]`
  (a real contact). Only a real review request has a value for it: any other send of such a template is refused as missing a value.
- **Asking from a contact:** the contact profile's "Request a review" (owners and managers of the client's own workspace) opens
  `/crm/reviews?contact=<id>` with the request dialog and that contact chosen.
- **"Opened" counts** include link scanners.
- **Retell's `transcript_updated`** and Vapi's live transcript and tool messages are ignored on purpose.
- **Not tested against real accounts:** neither provider has been called with a real Vapi or Retell account from this codebase. The adapters follow the documentation and SDK sources listed above, and the tests use vectors computed by their documented algorithms, including Retell's own SDK vector.
