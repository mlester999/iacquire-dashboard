# Proposals (Phase 5A)

Status as of 2026-10-24: **built and tested locally** (embedded Postgres, an in-process stand-in for email, a stub for the AI model). The customer's page was also used in a real browser on a local server at phone and desktop widths. **Nothing has run against a real email provider for proposals, a real language model or any hosted database.** Migration `0091_proposals.sql` (rollback beside it in `supabase/rollbacks/`) is not applied anywhere, and no workspace has the module switched on. Electronic signing is a separate module that builds on this one: see [esignature.md](esignature.md).

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Writing and pricing (editor, price book, tax rates, templates) | The editor, versions, the price book, tax rates and templates, and the approval rules. Money is whole minor units. The list, detail, approvals, templates, price book and settings screens were used in a real browser at 375 and 1024 pixels | The editor's add-a-line, save and conflict flows and a 1280-pixel pass were not yet checked in a browser | A Super Admin switches the module on for a workspace; the owner fills the price book and tax rates (nothing is seeded); where proposals sit relative to the implementation fee and the monthly plan is the founder's decision |
| Approval and sending | Approval reasons, the two-person rule, frozen versions, the customer's link and PDF made on send. Sending does not email the customer: the team copies the link | The PDF writer is deterministic and local; no service renders anything | Nothing external |
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
| Staff screens | `/proposals`, `/proposals/new`, `/proposals/[id]`, `/proposals/approvals`, `/proposals/catalog`, `/proposals/templates`, `/proposals/settings`; `src/components/proposals/*` |
| Customer screens and routes | `/proposal/<token>` and its PDF, `/api/public/proposals/<token>/<action>` (view, code, verify, decide); `src/components/proposals/public/*` |
| Switch on / off per workspace | Super Admin page `/admin/module-rollout` (`src/server/admin/module-rollout.ts`), which calls `setOrgFeature` in `src/server/proposals/features.ts` |
| Scheduler | `proposalExpiry`, `proposalHousekeeping` (see [production-scheduler.md](production-scheduler.md)) |
| Tests | `tests/proposals-*.test.ts(x)` and the shared fixtures in `tests/support/proposals.ts` |

## The life of a proposal

`draft` -> `pending_approval` -> `approved` -> `sent` -> `accepted`, `declined` or `expired`. A reviewer can also send it back (`changes_requested`) or `rejected` it, and anything not yet answered can be `withdrawn`. A sent, declined, expired or withdrawn proposal can be revised, which makes the next version a draft; an accepted proposal is final (a change is a new proposal).

- **A version is frozen** when it is submitted for approval or sent, once, and never changes. What the reviewer approves, what the customer's page and PDF show, and what an answer is bound to (a hash) are that frozen version. Any change to what the customer will see makes a new version and voids the approval.
- **When approval is required** (`approvalReasons` in `src/lib/proposals/state.ts`): an AI draft always; a proposal written by someone who can write but not send; every proposal if the workspace chose "approve all"; a discount or a price below the price book (unless the owner turned that rule off); a total above the amount the workspace set. Otherwise a person who can send may send without a second look. The owner can require two people (the author cannot approve their own).
- **Who can do what** (`src/lib/permissions.ts`): view, owner, manager, team members, sales reps and viewers; create, owner, manager, team member, sales rep; discount and approve, owner and manager; send, owner, manager, sales rep; record an answer made outside the product, owner and manager; price book, templates and tax rates, owner and manager (and the agency as a setup service, inside an audited support session); settings, owner. The agency never sends, approves or accepts for a client.
- **Sending does not email the customer.** Sending freezes the version, makes the customer's link and the PDF. The team copies the link into its own email or message. The link can be shown again later: it is derived from a server key and only its hash is stored.

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

A privacy request withdraws the person's unfinished proposals, deletes their emailed codes and sessions, removes the address and name kept on each link and from each working copy. It **keeps** the frozen versions, the recorded answers and the signing history, which are the record of what was sent and agreed, and returns a count of what it kept. Whether an accepted proposal must be kept, for how long, or erased regardless is a legal question for counsel and the founder.

## Access by the agency

The files (frozen PDFs, signed copies, and a certificate where a signing service's adapter fetches one; PandaDoc's does not) are read by an agency person only inside an active support session on that client (`app.file_permission`, migration 0090). The proposal tables' read policy uses `proposals.view`, which does not itself require a support session; no screen shows an agency person these records today. **Whether the tables should be gated the same way is a founder decision still open** (recorded in the header of `0091_proposals.sql`).

## Switching it on, and what stays off

1. A Super Admin switches **Proposals** on for the workspace on `/admin/module-rollout`. That shows the module in the client's menu and nothing else: it connects nothing and sends nothing.
2. The owner fills the price book and tax rates and chooses the approval rules in Proposals > Settings.
3. The customer's emailed code leaves only through the email provider: `EMAIL_PROVIDER=capture` (the default) stores it without sending, and `resend` needs `RESEND_WRITES_ENABLED=true`.
4. The scheduler's two jobs close expired proposals and clear spent codes; they run only when the scheduler does.

## What is simulated and what has never run

- Email: tests and local runs use the capture provider. No proposal code email has been sent through a real provider.
- The PDF writer is deterministic and local. Nothing is rendered by a service.
- The AI model: a stub only (see above).
- Hosted database, the scheduler, and a real customer: none. Migration 0091 has not been applied anywhere.
- Browsers: the customer's page in every state (open, accepted, signed through a service, expired, withdrawn, long document) and the full "email me a code, confirm, accept" flow were run on a local server at 375 and 1024 pixels. The editor's add-a-line, save and conflict flows, the AI draft button and a 1280-pixel pass were not yet checked in a browser.

## Founder decisions this needs

Counsel-approved acknowledgement and terms wording, and what may be said about enforceability; where proposals sit relative to the implementation fee and the monthly plan; the proposed numbers above (link lifetime, code limits, session length, expiry warning of two days); whether an accepted proposal may be erased on a privacy request; and the open agency-read decision above.
