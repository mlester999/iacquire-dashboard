# The prospect demo funnel

Status: **data, rules and services built and tested locally (stage D1)**. The public pages (`/demo`, `/demo/verify`, `/demo/room`), the public API, the AI chat generator with its checks and metering, and the agency screens (`/admin/prospects`) are the next stages and do not exist yet. Nothing here has run against a real email provider, a real language model, a hosted database or a real visitor, and the demo is **off**: the deployment switch `DEMO_ENABLED` and the Super Admin's own switch in the demo settings both default to off. Every number below is a **proposal** for the founder to confirm.

> The public pages, API, chat and Super Admin screens exist in this checkout; the paragraph above is kept as the original stage note. The signed registration door from the separate marketing website is documented in [demo-external-registration.md](demo-external-registration.md) (route, HMAC contract, environment, migration `0113`).

## What it is for

A person who is thinking about buying asks for a demo with a name, a work email address, their business name and an industry. They confirm the address from an emailed link, get a time-limited window (proposal: 24 hours from confirming) and a number of AI chat messages (proposal: 10), see what the six AI Employees do on sample data, and are offered a consultation or the price. A Super Admin sees them, can extend a demo, and can turn a confirmed prospect into a client workspace by hand.

## The rules that cannot be bent

1. **A prospect is never a user.** Nothing in `src/server/demo` writes a user, a workspace, a membership, an invitation or a sign-in row. The prospect holds an emailed link (works once) and then a cookie of their own (`iaq_demo`), both stored only as hashes in the demo tables. `tests/demo-register.test.ts` counts the rows of seven identity tables before and after a whole prospect journey; `tests/demo-isolation.test.ts` reads the source and fails if a file a stranger can reach imports workspace, messaging, AI-employee, CRM or sign-in code, or if SQL in the module touches those tables.
2. **The only way to a client is a Super Admin pressing a button.** `convertProspect` (`src/server/demo/admin.ts`) needs `agency.prospects.manage` and the permission to create clients, claims the prospect first (two people pressing at once make one workspace), calls `createClientTenant` exactly like creating a client by hand (workspace in "invited" status, six AI Employees that need setting up, an invitation to the owner), and marks the prospect. The workspace gets a name, an owner address, an industry label and a time zone; the conversation is not copied anywhere (a test searches every table of the new workspace for a phrase from the transcript).
3. **One prospect per mailbox.** The key is the address lower-cased, without a plus tag, and with Gmail's dots and `googlemail.com` folded. Registering again returns the same row and never resets the window or the message count; an address still waiting for its link gets a new link and its details replaced; one inside its window is sent a way back (to the address it started with); one whose window ended, or that was blocked, gets nothing. The answer to the form is the same in every case, so it cannot be used to find out who has asked.
4. **Opening the link's page changes nothing.** A GET shows a button; pressing it (a POST) uses the link up and opens the demo. A mail scanner that follows every link in a message cannot burn it.
5. **Access is decided from the clock, never from a stored status alone.** A window is open strictly before its end; at the very moment it ends it is over. The expiry job only records what the clock already says.
6. **A message is counted before it is answered, atomically.** The prospect's row is locked, the rules are read from it, and a guarded update raises the count, so twenty simultaneous posts of a prospect with ten messages left reserve exactly ten. The same `clientMessageId` again returns what was stored and counts nothing, even after the window ended. A message whose answer never comes is given back (and the platform's daily budget with it, unless the model was already asked).
7. **The platform's daily AI budget is taken in the same transaction** (`demo_usage_days`). When it is used up the message is refused with a plain sentence, counted as refused, and the team is told once a day.
8. **No tenant data, no tools, no Hermes in the chat.** The chat code contains no model call at all yet (stage D2 adds it); what it will have is a persona label (one of the six roles) and nothing else.
9. **Public pages have an emergency stop** (`DEMO_PUBLIC_DISABLED`, checked before any database read) and rate limits: per address on every request, per address and per mailbox on asking for a demo or a new link, per address on link pages, per session on messages, per session on calls to action.
10. **Notifications carry no personal details.** A title, a fixed sentence and a link to the prospect by id.

## States

`unverified` -> (link button) `active` -> `expired` (the clock; the job records it) -> `active` again (Super Admin extension). `active` and `expired` can become `consultation_requested` or `purchase_started` (the prospect's own call-to-action buttons; the latest wins and is kept when the window ends), `declined` or `blocked` (Super Admin; they stay so until reopened), and `converted` (only by the explicit conversion; final). The table is in `src/lib/demo/rules.ts` and is walked pair by pair in `tests/demo-rules.test.ts`.

## Tables (migration `0100_demo_funnel`)

`demo_settings` (one row, absent until a Super Admin saves), `demo_prospects`, `demo_verifications` (links, hash only, 48 hours), `demo_sessions` (cookie, hash only, 7 days), `demo_messages` (the transcript with idempotency key and state), `demo_events` (the timeline, append-only by a trigger; an erasure may redact the words in a line, never the line), `demo_usage_days` (the platform's daily counters). All seven have row-level security and **no grant to any role**: the application role, the Data API roles and the published-site role get "permission denied" (`tests/demo-migration.test.ts` checks every privilege on every table for every role, and the rehearsal reports them as "server only"). Agency people read them only through guarded server functions that re-read their standing from the database on every call. The foreign keys are listed in a test: agency users and the access request of the same address (set null), the prospect's own children (cascade), and `converted_org_id` (set null), nothing else.

Rollback `supabase/rollbacks/0100_demo_funnel.down.sql` refuses while any prospect exists (even an erased one: its row is the record that a demo was asked for), or any demo notification exists. The settings row and the daily counters go with their tables.

## Settings (proposals, all editable by a Super Admin, stale screens refused by a version)

| Setting | Default | Meaning |
| --- | --- | --- |
| enabled | off | The Super Admin's switch. Also needs `DEMO_ENABLED` in the environment. |
| aiEnabled | off | The AI chat. Off: the guided tour is what ships working, and the room says the chat is not available. |
| windowHours | 24 | From confirming the address. Copied to the prospect, so a later change moves nobody. |
| messageLimit | 10 | AI messages per demo. Copied to the prospect. |
| maxExtensionHours / maxExtraMessages | 72 / 20 | Totals for one prospect's whole life. A reason is mandatory. |
| dailyStartCap / dailyMessageCap | 50 / 300 | Demos started and AI messages answered per UTC day, platform-wide. 0 stops it. |
| consultationUrl | none | https only. Empty: the button is not shown. |
| retentionDays | 90 | Days after the window ended (or the last visit) that details and conversation are kept. Someone who never confirmed is removed after 7. |
| blockedEmailDomains | none | Free-mail domains, if the demo is for work addresses only (a domain and its subdomains). |

## Who may do what

`agency.prospects.view`: agency managers and Super Admins (list, details, timeline, summary, reading a conversation: each read is a timeline line and an audit row with the number of lines, never the words). `agency.prospects.manage`: Super Admins only (settings, extend, end now, block, decline, reopen, assign, note, consultation done, export, erase, convert). Neither can be handed to one person. Agency staff hold neither. A session that still says Super Admin after the role was taken away is refused.

## Jobs (dormant until the scheduler runs and, in a staged start, until named)

`demoExpiry` (every 15 minutes) and `demoRetention` (daily), described in [production-scheduler.md](production-scheduler.md). Both are budgeted, idempotent (`skip locked`, and an erased row is skipped), and read no demo switch.

## Privacy, retention, erasure

Kept per prospect: name, work email address, business name, industry, a keyed hash of the address the request came from (abuse analysis only), campaign tags, the notice version they agreed to and when, the conversation, a timeline. **Erasure** (`eraseProspect` on request, `runDemoRetention` on the clock) removes the details, the conversation, sessions, links, the copies of the link emails still in the outbox, and the words team members typed in the timeline; the row stays as the record that a demo happened (dates, counts, status). On a request (not on the retention clock) the same address's requests on `/get-started` are redacted too, because the pipeline joins them. `exportProspect` hands a person their own data. After an erasure the same address can start again as a new prospect. `tests/demo-retention.test.ts` searches every table of the database for the erased person's address, name, business, phone number and words after an erasure and finds none.

The notice text (`src/lib/demo/notice.ts`) is **draft wording for counsel**; its version is recorded with each request.

## Founder inputs this needs (each a proposal)

* Whether the numbers above are right (24 hours, 10 messages, 72 hours and 20 messages at most, 50 demos and 300 AI messages a day, 90 days).
* Whether free-mail addresses are refused (the list is empty), and whether one demo per mailbox is right or should be per company domain.
* Counsel: the notice, the marketing tick, how long a blocked person's details may be kept (they are kept until a Super Admin erases them, because the block is the record that keeps them out), and whether erasing on request should also redact the person's `/get-started` requests (it does).
* An approved consultation link (or none), and whether Buy now is offered before purchase intents exist (it only records the press for now).
* When the AI chat may be switched on: no real model has been evaluated for this prompt.
* The email deliverability of the link (Resend's SPF and DKIM for the sending address) is unproven.

## What was and was not checked

Checked locally on embedded Postgres, with the capturing email outbox and a clock the tests pass in: `tests/demo-rules.test.ts` (pure rules, every boundary, ten thousand random moves of the state machine, twenty thousand characters of hostile text), `demo-register.test.ts`, `demo-chat.test.ts`, `demo-admin.test.ts`, `demo-retention.test.ts`, `demo-jobs.test.ts` (through the real tick endpoint), `demo-migration.test.ts`, `demo-isolation.test.ts`, the combined migration rehearsal, and nineteen deliberate breakages of the code (each makes at least one test fail).

Checked in Chromium against the isolated QA app (1280 and 375 px): the public request form, the captured verification email, the one-use verify button, the room, a simulated AI reply, and the ten-message limit (0 left, Send gone); 0 console/page errors, 0 horizontal overflow, axe 0. That run found a real crash: the room's local-time line passed `dateStyle`/`timeStyle` together with `timeZoneName`, which Chrome rejects, so the first hydration dropped the whole room into the error boundary. Fixed in `src/components/demo/local-time.tsx` and guarded by `tests/demo-local-time.test.ts`.

Not checked: a real email provider; a multi-connection Postgres (the embedded database runs one transaction at a time, so the concurrency tests prove the count and the guarded update, not row locking under real parallel connections); the message budget under real load; the hosted database; the booking/consultation destination (the configured link was empty in QA).
