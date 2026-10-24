# Proposals (Phase 5A)

Status as of 2026-10-24: **built and tested locally** (embedded Postgres, an in-process stand-in for email, a stub for the AI model). The customer's page was also used in a real browser on a local server at phone and desktop widths; sending the customer their link by email, text message or WhatsApp (added after that browser pass) has **not** been seen in a browser. **Nothing has run against a real email, text message or WhatsApp provider for proposals, a real language model or any hosted database.** Migration `0091_proposals.sql` (rollback beside it in `supabase/rollbacks/`) is not applied anywhere, and no workspace has the module switched on. Electronic signing is a separate module that builds on this one: see [esignature.md](esignature.md).

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Writing and pricing (editor, price book, tax rates, templates) | The editor, versions, the price book, tax rates and templates, and the approval rules. Money is whole minor units. The list, detail, approvals, templates, price book and settings screens were used in a real browser at 375 and 1024 pixels | The editor's add-a-line, save and conflict flows and a 1280-pixel pass were not yet checked in a browser | A Super Admin switches the module on for a workspace; the owner fills the price book and tax rates (nothing is seeded); where proposals sit relative to the implementation fee and the monthly plan is the founder's decision |
| Approval and sending | Approval reasons, the two-person rule, frozen versions, the customer's link and PDF made when a version is marked sent. Marking it sent contacts no one | The PDF writer is deterministic and local; no service renders anything | Nothing external |
| Sending the customer their link | A person with the send permission picks email, text message or WhatsApp, reads the exact fixed-wording message and what the send chain says about it, and confirms. It goes through the consent-gated send chain (consent, opt-outs, quiet hours, a person's hold, a paused or suspended workspace, credits); the link is added only at the moment of sending and is kept nowhere; a double click sends once; anything that ends the link stops a message that has not gone out; the tab says queued, sent (the provider accepted it) or not sent with the reason, never delivered or read | Every provider is a recording stand-in; no message was sent through a real email, text message or WhatsApp provider. Not yet seen in a browser | The customer's recorded consent on the channel; the provider's write switch (`RESEND_WRITES_ENABLED`, `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED`); service credits for text and WhatsApp; counsel's approval of the message wording (it is a draft) |
| The customer's page and the recorded answer | The private link, the emailed one-time code, the three honest levels of "seen", and an answer bound to the exact frozen version. Used in a real browser on a local server in every state at 375 and 1024 pixels | The code email: `EMAIL_PROVIDER=capture` (the default) stores it and sends nothing. No code has been sent through a real email provider | `RESEND_WRITES_ENABLED=true` with `EMAIL_PROVIDER=resend` to send real codes; counsel-approved acknowledgement and terms wording before any real client; the founder confirms the proposed numbers (link life, code limits, session length) |
| AI drafting | Drafts from the price book only; every sentence checked; always needs a person's approval; credits checked, 20 drafts an hour per person and 50 a day per workspace, every call metered | A stub model only: the real model has never been evaluated against this prompt | Off until the owner turns it on; the AI service must be configured; usage is charged to the workspace's credits |
| Effects on the CRM | Timeline lines, events, tasks and notices; optional tag, stage and won-stage effects the owner turns on; each in its own savepoint | Never exercised against a hosted CRM | The owner chooses which optional effects to turn on |
| Privacy requests | Withdraws unfinished proposals, deletes codes and sessions, removes the address and name; keeps frozen versions, answers and signing history and says how many | Never run on real data | Counsel and the founder decide whether an accepted proposal may be erased |
| Access by the agency | Files (frozen copies, signed copies, certificates) are read inside an active support session only | No screen shows an agency person the proposal records | Founder decision still open: whether the proposal tables should need a support session too |
| Scheduler | `proposalExpiry` and `proposalHousekeeping`, shown through the real tick endpoint | Never run on a real host | Named in a staged start by the founder; both are internal |
| Hosted database | Migration `0091_proposals.sql` and its rollback, rehearsed on embedded Postgres | Not applied anywhere | A backup, the rehearsal and the founder's approval to apply it |

## What it is, and what it is not

A client (a business) writes a priced proposal for one of its own customers, a person with approval rights looks at the exact version that goes out, and the customer's answer is recorded. The customer gets a private link; to answer they enter a one-time code emailed to their address.

It is not an electronic signature product. A customer who accepts on the page has made a **recorded answer**: the decision, the time, the email address they verified and the fingerprint of the exact document. The page and the PDF say so in those words (`src/lib/proposals/ack.ts`). Only the electronic signing module, through the client's own signing account and only when that service says so, produces a signature, and then the answer is labelled "Signed through a signing service". Nothing in the product calls a ticked box, a typed name or an emailed code a signature.

Nothing is invented for the client. The price book is empty until the owner fills it, the tax rates are the owner's, the wording is the owner's, and the AI drafts only from the price book and the approved business information, never a price (see "AI drafting").

## Where things are

| Area | Files |
| --- | --- |
| Tables, permissions, notification kinds, rollback | `supabase/migrations/0091_proposals.sql`, `supabase/rollbacks/0091_proposals.down.sql` |
| Private PDF bucket and its access rule | `supabase/migrations/0090_document_buckets.sql` (bucket `proposal-documents`) |
| Pure rules (states, approval reasons, money, the frozen snapshot, the PDF, the customer's wording, AI checks) | `src/lib/proposals/*` |
| Services (writing, approving, sending, the customer's side, the price book, templates, CRM effects, jobs, erasure) | `src/server/proposals/*` |
| Sending the customer their link (the message, the preview, the send, the check right before it leaves, stopping what has not gone out) | `src/server/proposals/delivery.ts`; the shared part of the send chain (conversation, probe, queue, stop) in `src/server/messaging/delivery.ts`; the `delivery` message scope and the dispatcher's substitution in `src/server/messaging/send.ts`; the link placeholder and its masking in `src/server/messaging/redact.ts`; the wording, the fingerprint, the words for each state and what the tab offers in `src/lib/proposals/delivery-text.ts`, `delivery-hash.ts`, `delivery-state.ts` and `delivery-ui.ts`; the table `proposal_deliveries` in migration 0091 |
| Staff screens | `/proposals`, `/proposals/new`, `/proposals/[id]`, `/proposals/approvals`, `/proposals/catalog`, `/proposals/templates`, `/proposals/settings`; `src/components/proposals/*` |
| Customer screens and routes | `/proposal/<token>` and its PDF, `/api/public/proposals/<token>/<action>` (view, code, verify, decide); `src/components/proposals/public/*` |
| Switch on / off per workspace | Super Admin page `/admin/module-rollout` (`src/server/admin/module-rollout.ts`), which calls `setOrgFeature` in `src/server/proposals/features.ts` |
| Scheduler | `proposalExpiry`, `proposalHousekeeping` (see [production-scheduler.md](production-scheduler.md)) |
| Tests | `tests/proposals-*.test.ts(x)` and the shared fixtures in `tests/support/proposals.ts` |
| Browser QA data | `scripts/proposals-qa-world.ts` (eighteen proposals in every state). `PROPOSALS_QA_DELIVERY=1` with the QA seed also gives the workspace a made-up email channel and the consent of some of its customers, so the Delivery tab's send section can be tried; nothing can leave (the provider's write switch stays off) |

## The life of a proposal

`draft` -> `pending_approval` -> `approved` -> `sent` -> `accepted`, `declined` or `expired`. A reviewer can also send it back (`changes_requested`) or `rejected` it, and anything not yet answered can be `withdrawn`. A sent, declined, expired or withdrawn proposal can be revised, which makes the next version a draft; an accepted proposal is final (a change is a new proposal).

- **A version is frozen** when it is submitted for approval or sent, once, and never changes. What the reviewer approves, what the customer's page and PDF show, and what an answer is bound to (a hash) are that frozen version. Any change to what the customer will see makes a new version and voids the approval.
- **When approval is required** (`approvalReasons` in `src/lib/proposals/state.ts`): an AI draft always; a proposal written by someone who can write but not send; every proposal if the workspace chose "approve all"; a discount or a price below the price book (unless the owner turned that rule off); a total above the amount the workspace set. Otherwise a person who can send may send without a second look. The owner can require two people (the author cannot approve their own).
- **Who can do what** (`src/lib/permissions.ts`): view, owner, manager, team members, sales reps and viewers; create, owner, manager, team member, sales rep; discount and approve, owner and manager; send, owner, manager, sales rep; record an answer made outside the product, owner and manager; price book, templates and tax rates, owner and manager (and the agency as a setup service, inside an audited support session); settings, owner. The agency never sends, approves or accepts for a client.
- **Marking a proposal as sent contacts no one.** It freezes the version and makes the customer's link and the PDF. The team then either copies the link and gives it to the customer itself, or sends it from the Delivery tab (next section). The link can be shown again later: it is derived from a server key and only its hash is stored.

## Sending the customer their link

On the Delivery tab of a sent proposal, someone who holds the send permission (owner, manager, sales rep) can have iAcquire carry the link to the customer by email, text message or WhatsApp. It is one confirmed action, not an automation: no workflow, AI employee or API key can do it.

1. **They pick a channel and read the message.** The server shows the exact words, where it would go (the address masked, `m***@example.com` or `***4567`) and what the send chain would do with it right now: *ready*, *waiting for sending hours* (with when they open), or *can't be sent* with the reason. Nothing is written by looking, and nothing is sent until they confirm.
2. **They confirm, and the server checks it is the message they read.** The words are fixed in code (`src/lib/proposals/delivery-text.ts`): no AI writes them and nothing a customer typed is in them except a first name that is a plain name. They carry the business's name, the proposal's number and the last day it can be answered, and they say nothing about price, how to answer or anyone's rights. Their fingerprint (channel, subject, text, wording version) goes back with the confirmation and the server renders the message again and refuses to send anything else. **Why a per-send preview and not a standing authorization like the invoice reminders:** reminders go out on a schedule with nobody present, so the owner authorizes the exact wording once; a proposal message is one message sent by the person at the screen, who reads it. The wording is a draft that nobody has approved, and the screen says so.
3. **The send chain decides.** The message is a `delivery` scope service message sent by the system on that person's behalf (so a refusal is recorded instead of thrown and a message that has to wait for sending hours can be sent later). It needs the customer's consent on that channel; an opt-out or bounce stops it; quiet hours make it wait; a person's hold on the customer stops it (when it is queued and again right before it leaves); a paused or suspended workspace stops it; a text or WhatsApp message needs service credits, and WhatsApp the customer's last message within a day, as every free-form message does. An address a website visitor typed and nobody has confirmed is refused (`identity_unverified`), as for every automatic message. A refusal leaves nothing behind but an audit line (`proposals.delivery_refused`), and the reason comes back in words. For email, the address on the customer's record must be the one on the proposal (the emailed code goes to the proposal's address, so the link must not go to a different mailbox).
4. **The link is never stored.** The message holds `{{proposal.link}}`. The dispatcher asks `proposalLinkForMessage` for the link at the moment it calls the provider; the link is derived again from the proposal's own link and exists only in that request. The history, the audit line, the conversation preview, the Inbox, the AI's context, the client's data export and every log carry it as words (`[customer proposal link]`) or not at all; a test searches every table that could hold it. Any other message that carries the placeholder (a person or an AI typed it) is blocked, not sent.
5. **It is checked once more just before it leaves.** The proposal must still be sent, on that same version, with that same link working, inside its last day, and the module still on; otherwise the message is blocked as `proposal_link_unavailable` and its credit hold is given back.
6. **A double click sends once.** The proposal row is locked, a message for the same version, link and channel that is queued, being sent or accepted by the provider is returned instead of sending another, and the chain's own key (`proposal-delivery:<proposal>:<version>:<channel>`) makes the database refuse a second. To send again on the same channel, make a new link first. A new version has its own link and needs a new send. At most six messages per version, whatever became of them.
7. **Anything that ends the link stops a message that has not gone out**, and says why on the tab: withdrawing, revising, an answer (the customer's, a person's record of it, or a signature), expiry, a new link, a privacy request, and a person's hold on the customer. A message already on its way or accepted by the provider is left as it is.

**What the tab says.** Each message is listed with its channel, version, who asked and when, and one of: *Queued* (not sent yet), *Waiting for sending hours*, *Being sent*, *Sent by email / text message / WhatsApp* (the provider accepted it; the line adds that iAcquire cannot tell whether it arrived or was seen), *Not sent* (with the reason), *Not confirmed* (the provider did not answer, so it may or may not have gone: check with the customer), *Failed after it was sent* (the provider took it and later reported a failure) or *Stopped before it was sent* (with the reason). It never says delivered, received or read, whatever a provider reports later. How far the customer has gone is the three levels of "seen" above, from the link itself.

**What it does not do.** No second AI-written message, no reminder to a customer who has not answered, no send from a workflow or the Sales Assistant, and nothing for a proposal that is a draft, answered, expired or withdrawn.

## Price book, tax rates and templates

The workspace's own, typed by a person: nothing is seeded. A line takes its price and tax from the price book row looked up on the server; what a browser claims about a price is not read. Money is integers in the currency's minor unit with one rounding per line, and one-time, monthly and yearly amounts are totalled apart ("USD 1,500 once plus USD 99 a month" is never "USD 1,599").

A template is reusable wording plus a starting set of price book items (never prices). Editing makes a new version, and the owner approves a version before anyone sends from it.

## The customer's page: three honest levels of "seen"

| Level | What it means | What it does not mean |
| --- | --- | --- |
| Link opened | The page was requested | That the customer read it: an email security scanner or link preview does the same |
| Viewed in a browser | The page stayed open and was used | Who, or that it was read |
| Opened by someone with the code | Someone entered the code emailed to the customer's address | Who they are, only that they control that mailbox |

The history says exactly that and no more ("the link was requested", never "the customer read it"). The code is six digits, valid for ten minutes, five tries, one a minute and five an hour per link; a session slides for 30 minutes and ends after eight hours. A link with no valid-until date lasts 90 days, and 30 days past a valid-until date so a late customer is told "expired" and not "invalid link". All of those numbers are **proposed defaults** in `src/lib/proposals/share.ts`, listed for the founder to confirm.

The page is served with `Referrer-Policy: no-referrer`, no-store and noindex, because the address is the credential. Its forms are checked with `src/server/security/same-site.ts` (a form posted from a no-referrer page arrives with `Origin: null`). `PROPOSALS_PUBLIC_DISABLED=true` makes the page, its PDF and its API answer "temporarily unavailable" for every workspace before any database read.

The customer's email address is masked on the page and not printed in the PDF (anyone holding the link can download the PDF).

## What a recorded answer is

An answer is recorded only from a verified session, for the exact frozen version whose hash was shown, once. It stores the decision, the time, the verified address, the exact acknowledgement text the customer saw and its version, and the document's hash. The decision table is append-only (the database refuses an edit or a delete). A person at the business can also record an answer given outside the product (owner and manager); it reads "Recorded by <name>; not verified by the client" wherever it is shown.

**The acknowledgement wording is draft wording for counsel.** It has not been reviewed by a lawyer, and the module must not be switched on for a real client until the owner of the terms has approved the final text.

## AI drafting

Off until the owner turns it on, and it needs the AI service to be configured. Every request first checks that the workspace has credits and is inside the limits (20 drafts an hour for a person, 50 a day for a workspace), and every call is metered and charged to the workspace's credits. The model can name price book items by id and write a few paragraphs; it has no field for an amount, a total, a discount, a tax, a date or terms. Every sentence it writes is checked first, and a sentence that states a number the workspace did not give it, an amount in words, a claim the approved business information does not back, a web address or a placeholder is dropped, not trimmed, and the drop is recorded. What is left is an ordinary draft marked "AI-written", and it always needs a person's approval. **The real model has never been evaluated against this prompt**: the tests use a stub that returns what a model could return, including hostile output.

## What it does to the rest of the CRM

A line on the contact's and the deal's timeline, an event automations can start from (for example `proposal.expired`), a notice to the people concerned, a task when somebody has to act, and, only if the owner turned them on, a tag on send, a deal stage on send and a won stage on accept. Each runs in its own savepoint: one that fails is written on the proposal's history and nothing else is lost.

## Privacy

A privacy request withdraws the person's unfinished proposals, stops any message about them that has not gone out, deletes their emailed codes and sessions, removes the address and name kept on each link and from each working copy, and removes the masked address each delivery kept. The messages themselves (their text, which holds a first name, and their subject) are made unreadable with the customer's conversations. It **keeps** the frozen versions, the recorded answers and the signing history, which are the record of what was sent and agreed, and returns a count of what it kept. Whether an accepted proposal must be kept, for how long, or erased regardless is a legal question for counsel and the founder.

## Access by the agency

The files (frozen PDFs, signed copies, and a certificate where a signing service's adapter fetches one; PandaDoc's does not) are read by an agency person only inside an active support session on that client (`app.file_permission`, migration 0090). The proposal tables' read policy uses `proposals.view`, which does not itself require a support session; no screen shows an agency person these records today. **Whether the tables should be gated the same way is a founder decision still open** (recorded in the header of `0091_proposals.sql`).

## Switching it on, and what stays off

1. A Super Admin switches **Proposals** on for the workspace on `/admin/module-rollout`. That shows the module in the client's menu and nothing else: it connects nothing and sends nothing.
2. The owner fills the price book and tax rates and chooses the approval rules in Proposals > Settings.
3. The customer's emailed code leaves only through the email provider: `EMAIL_PROVIDER=capture` (the default) stores it without sending, and `resend` needs `RESEND_WRITES_ENABLED=true`.
4. A message that carries the link (the Delivery tab) leaves only through the workspace's own messaging channel for that kind of message, set up and verified in Settings > Messaging, and only while that provider's write switch is on (`RESEND_WRITES_ENABLED`, `TWILIO_WRITES_ENABLED`, `META_WHATSAPP_WRITES_ENABLED`, all off by default). The customer must have agreed to messages on that channel, and text and WhatsApp use the workspace's prepaid service credits. With a switch off the dispatcher blocks the message and the tab says so ("Sending through this channel's provider is not switched on"); nothing is sent.
5. The scheduler's two jobs close expired proposals and clear spent codes; they run only when the scheduler does. Sending a message needs no job of its own: the existing message dispatcher sends what was queued.

## What is simulated and what has never run

- Email: tests and local runs use the capture provider. No proposal code email has been sent through a real provider.
- Messages that carry the link: tests run the real consent-gated send chain on embedded Postgres and replace only the provider (a recording stand-in); no email, text message or WhatsApp has been sent for a proposal through a real provider, and the Delivery tab's send section has not been seen in a browser. The wording has never been read by counsel.
- The PDF writer is deterministic and local. Nothing is rendered by a service.
- The AI model: a stub only (see above).
- Hosted database, the scheduler, and a real customer: none. Migration 0091 has not been applied anywhere.
- Browsers: the customer's page in every state (open, accepted, signed through a service, expired, withdrawn, long document) and the full "email me a code, confirm, accept" flow were run on a local server at 375 and 1024 pixels. The editor's add-a-line, save and conflict flows, the AI draft button and a 1280-pixel pass were not yet checked in a browser.

## Founder decisions this needs

Counsel-approved acknowledgement and terms wording, and what may be said about enforceability; where proposals sit relative to the implementation fee and the monthly plan; the proposed numbers above (link lifetime, code limits, session length, expiry warning of two days); whether an accepted proposal may be erased on a privacy request; and the open agency-read decision above.

For sending the link (all **proposals**, none decided): counsel's approval of the message wording (`DELIVERY_WORDING_VERSION` is a draft); whether a per-send preview is enough or the owner should authorize the wording once as for invoice reminders; the limit of six messages per version; whether an address a website visitor typed should be reachable once a person confirms it in the Inbox (today it is refused until then) or a person's deliberate send should be allowed to it; whether the email on the proposal must equal the customer's record (today it must); and whether text and WhatsApp stay available beside email (each uses prepaid credits).
