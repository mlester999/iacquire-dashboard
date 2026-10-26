# Staff Messages (the agency team's internal chat)

Written 2026-10-24, stage G1 of Wave 2 (the foundation: database, permissions, notices, rules, services, job). The screens are the next stage and are **not built**; this document says what exists, what it does not do, and what only a person can decide. Nothing here has run against a hosted database, a real browser or a real colleague. Everything below was run on embedded Postgres with made-up people.

Staff Messages is for the agency's own people (Agency Staff, Managers and Super Admins) to talk to each other: direct messages, private groups and channels, with threads, mentions, reactions, files and search. It is **not** the customer inbox (conversations with a client's customers), **not** Support and Requests (a client's tickets, with the team's internal notes) and **not** the AI employees' chat. It has its own tables, its own notification audience and its own permissions, and nothing in it is visible to a client, a client's customer, the AI employees, Automation Studio or AQi.

## At a glance

| Part | Built and tested here | Simulated, or never run against a real service | Needs an account or an approval |
| --- | --- | --- | --- |
| Conversations: direct messages (one per pair), private groups, channels open to the team or by invitation, with owners, join and leave, adding and removing people, archive, rename, mute | Rules in `src/lib/staff-messages/conversations.ts`, services in `src/server/staff-messages/conversations.ts`, the database checks in `0096`, all on embedded Postgres (`tests/staff-messages-conversations.test.ts`, `tests/staff-messages-migration.test.ts`) | Never used by a real team; never on a hosted database; concurrency tests run on one embedded connection, which takes transactions in turn, so they prove the logic but not behaviour under a pooled hosted Postgres | A Super Admin switches the module on (`org_features`, `staff_messages`); applying `0096` to the hosted database needs the founder's approval (backup, dry run) |
| Messages: send with a retry key, numbers per conversation, threads one level deep, mentions, edit, delete (a tombstone), reactions from a fixed list, a read cursor that only moves forward | `src/server/staff-messages/messages.ts` and `read.ts`, `tests/staff-messages-service.test.ts` | Same as above | The retention period, if any, is a Super Admin's choice and the first run after it is set deletes older messages for good |
| Files on messages: five per message, 10 MB, seven types, checked by their first bytes, kept in the private bucket `staff-messages` that no browser can read | `src/server/staff-messages/attachments.ts`, `tests/staff-messages-attachments.test.ts` (stored in a temporary folder) | The hosted Storage bucket and its policy were only emulated; there is **no virus scanning** | Whether the agency's own storage should have a limit: staff files are stored under the agency workspace and go through the same storage check as any workspace's (`assertStorageAllowed`), which refuses new files only when a limit has been set and chosen to block; none is set by default |
| Who can read what: agency roles only, the Super Admin cannot read other people's direct messages or private groups, a demoted, disabled or denied person loses everything at once | Row-level security on all eight tables, the services re-read standing on every request, `tests/staff-messages-isolation.test.ts` | Emulated Supabase roles (`authenticated`, `anon`) on embedded Postgres, not a hosted project | The founder confirms the "no break-glass reading" default, and counsel the monitoring notice (below) |
| Notices: a new audience `staff`, five kinds, one notice per unread burst, a link into the conversation, never the text of a message | `src/server/notifications.ts` (`notifyStaff`, `notifyStaffBatch`, the agency feed), `tests/staff-messages-notifications.test.ts` | No email was sent: the email job skips these kinds (and would send a title and a link only) | Nothing |
| Search: the person's own conversations only, as plain text, with a snippet | `src/server/staff-messages/search.ts`, in `tests/staff-messages-service.test.ts` | Without the `pg_trgm` extension (hosted Supabase has it; the embedded database has it) a search is slower, not wrong | Nothing |
| Delivery to the open page | A revision number per person that every change raises (`src/server/staff-messages/inbox.ts`), so a poll or a stream reads one row | The stream, the poll endpoint and the page are the next stage. Supabase Realtime is only a SQL file (`supabase/optional/staff-messages-realtime.sql`) that is **not** part of the migration and is not applied | The founder approves a live-project Realtime test before that file is applied anywhere |
| The scheduled clean-up `staffMessagesMaintenance` | Registered hourly in `src/server/ops/tick.ts`, off until a staged start names it; `tests/staff-messages-maintenance.test.ts` | Never run by a real scheduler | The founder names it in a staged start (it contacts nobody and calls no provider) |
| Screens, actions, routes | **Not built** (stage G2) | - | - |

## Who can do what

| Permission | Agency Staff | Manager | Super Admin | What it allows |
| --- | --- | --- | --- | --- |
| `agency.messages.use` | yes | yes | yes | Direct messages, private groups, joining open channels, writing, reading what one is in. Can be denied to one person. |
| `agency.messages.channels` | no | yes | yes | Creating channels (open or private), and running the **open** channels (adding and removing people, renaming, archiving) without being their owner. Can be given to one person. |
| `agency.messages.moderate` | no | no | yes | Archiving any channel and deleting a message in a channel one belongs to. Cannot be given to anyone else. |

No client role is in any of these rows (a test reads the database and the code and compares). A person's standing is read from the database on every request: still an active account, still the agency role the session names, holding `agency.messages.use`, the module switched on, and (for a conversation) an active member. A person denied, demoted or disabled is out on their next request; nothing is deleted, and the history is back if they are restored.

**What a role does not give.** No role reads a conversation it is not in. A manager with the channels permission can archive a private channel by its id without being a member, and that gives no way to read it. The Super Admin's moderation reaches a message only in a channel the Super Admin has joined. The people who run the system, or anyone with a database backup or the service key, can read everything: **these messages are protected by access rules, not by encryption**, and the draft notice below says so.

## How it is stored (migration `0096_staff_messages`)

Eight tables, all in the one agency workspace (a trigger refuses any other), all with row-level security and **select-only** for the application role; nothing is granted to `anon`, `authenticated` or the published-site role: `staff_conversations`, `staff_conversation_members` (each person's read cursor, mute and notification choice), `staff_messages`, `staff_message_reactions`, `staff_message_attachments`, `staff_conversation_events` (append-only history of who joined, left, renamed or archived: ids and kinds only), `staff_inbox_state` (one revision per person) and `staff_message_settings` (the one optional retention period).

* A message takes the next number from its conversation's counter inside the sending transaction (the update also makes writers to one conversation take turns), so the order is the database's and unread is a subtraction. A message carries an id its sender's browser made, so a retry posts nothing twice.
* The read cursor can only move forward and never past the newest message; a trigger enforces it as well as the statement (`greatest()`).
* A deleted message keeps its place and loses its text, its mentions, its reactions and its files.
* A conversation holds at most 200 people; a message at most 8,000 characters, 20 mentions and five files; a thread is one level deep. The database repeats each limit.
* The audience `staff` for notifications and five kinds (`staff_message_direct`, `staff_message_mention`, `staff_message_added`, and two the workload module will use, `staff_workload_alert` and `staff_work_overdue`) were added by reading the live constraints, not by copying a list. `app.notification_visible` gains one branch: a `staff` notice is visible to an active agency account and to nobody else. (The older audience `direct` is unchanged; it would show an agency account's mail to the same person if they were later invited into a client workspace, which is why staff messages do not use it.)
* The two per-person override lists gain `agency.messages.use` and `agency.messages.channels`; the moderation permission is not delegable.
* The rollback (`supabase/rollbacks/0096_staff_messages.down.sql`) **refuses** while a conversation, a message, an attachment, a stored staff file or a staff notice exists, and removes the module's switch with its tables. The combined rehearsal (`scripts/rehearse-combined-migrations.mjs`) seeds and cleans it.

## Notices

One notice per unread burst: while a person has not read past the point they had reached when the first new message arrived, more messages in that conversation add nothing (the key is `staffmsg:<conversation>:<how far they had read>`). A mention is its own notice, one per message, and reaches a person who muted the conversation (not one who chose to hear nothing). A conversation is `all` for direct messages and groups and `mentions` for channels by default. The title is generic ("New direct message", "You were mentioned"); the body names the sender and where, never what was written. Reading a conversation marks its notices read. **Email:** the five kinds are in `CUSTOMER_CONTENT_KINDS` (title and link only) and in `IN_APP_BY_DEFAULT`, and a staff notice has no workspace, so no per-workspace email preference reaches it: none is emailed.

## Files

Staged in the composer (owned by the uploader, removed after 24 hours if never sent, at most 20 waiting), bound to the message when it is sent. Allowed: PDF, PNG, JPG, WebP, plain text, CSV and Word (.docx), each checked against its first bytes. They sit in `staff-messages`; the file rule of migration `0090` says **no browser can read the bucket**, so a file comes out only through `downloadAttachment`, which checks that the person is an active member of the conversation the file was sent in. When a message is deleted, access to its files is withdrawn in the same transaction and the stored bytes are removed straight after (the hourly job finishes any that could not be).

## The job `staffMessagesMaintenance`

Hourly, with a 20-second budget, off until a staged start names it (see `docs/production-scheduler.md`); it does nothing at all while the module is switched off. It removes staged files whose day is up, finishes removing files of deleted messages, takes people who are no longer on the agency team (disabled, or no longer an agency account) out of their conversations (their messages stay and show as "Former team member"; a returning person is let back into their direct messages, and into groups only when someone adds them), and, **only if a Super Admin chose a retention period**, deletes messages older than it (30 to 3,650 days; none by default). A message that starts a thread waits until its newest reply is old enough too. There is one agency workspace, so there is no fairness to keep between workspaces.

## Founder and counsel decisions (every default below is a proposal)

| Decision | The default built | Where to change it |
| --- | --- | --- |
| Who can use it | Agency roles only; client organisations get no internal chat from this work | A client-side chat would be a separate build |
| Can the Super Admin read other people's DMs or private groups | **No.** Moderation is for channels only. A break-glass read, if wanted, needs an audited, reasoned action and a notice to staff, and is not built | Decision, then a build |
| Retention and departure | Keep everything until a Super Admin sets a period; a departed person's messages stay under "Former team member"; there is no per-person export | `setRetentionDays`; counsel for the period |
| Monitoring notice | The draft in `src/lib/staff-messages/notice.ts` (version `draft-2026-10-24`), shown by the screens as a draft | Counsel approves or rewrites it |
| Email | In-app only; a title and a link at most | `src/lib/ops.ts` |
| Files | 10 MB, 5 per message, the seven types, no virus scanning; stored under the agency workspace, so a storage limit, if the founder ever sets one for it, applies | `src/lib/staff-messages/limits.ts`; the founder decides whether the agency's own storage should have a limit |
| Who starts what | Anyone who may use Messages starts direct messages and private groups; channels need the channels permission | `src/lib/staff-messages/conversations.ts` |
| People added to a conversation can read its earlier messages | Yes (and start with nothing unread) | A different rule would be a build |
| Realtime | A visible-tab poll and a server-sent stream (next stage); Supabase Realtime only as `supabase/optional/staff-messages-realtime.sql`, unused until a live-project test is approved | The founder approves the test |
| Typing indicators | Not built, and not claimed | - |
| Rate limits | 90 sends a minute, 120 reactions a minute, 240 reads a minute, 60 searches a minute, 40 conversation changes an hour, 30 uploads an hour, per person | `src/server/security/rate-limit.ts` |
| Hosted rollout | Not done. `0096` is unreleased and may be edited in place until it is applied anywhere | The founder approves a backup, a dry run, one migration at a time |

## What is not built or not checked

* The screens, the server actions, the download and upload routes, the poll and stream endpoints (stage G2), and the browser-side behaviour they will need (focus, 375 px layout, labelled fields).
* Supabase Realtime on a live project; typing indicators; a context link from a message to a client record (it would need the viewer's client scope on every render); a per-person export; mentions of the whole channel (`@channel`, `@here`).
* Anything on a hosted database, hosted Storage or a real scheduler.
* The concurrency of sends from many processes on a pooled Postgres. The code takes the conversation's row first and keeps the unique key as a backstop; the tests run on one connection.
* A person denied Messages keeps seeing the generic titles of their old staff notices in the bell (the audience is the active agency account, as the audit recommended); no message text is in them.

## Draft notice (for counsel; not approved)

The text is `STAFF_MESSAGES_NOTICE_LINES` in `src/lib/staff-messages/notice.ts`. It says that messages live in iAcquire's database behind access rules (not encryption), that only the people in a conversation can read it inside the product, that a Super Admin cannot open a direct message or private group they are not in, that nothing is deleted unless a retention period is chosen, how a departed colleague's messages look, and that notices stay in the app.

## Where the code is

* Rules (pure): `src/lib/staff-messages/` (`direct.ts`, `body.ts`, `mentions.ts`, `reactions.ts`, `unread.ts`, `threads.ts`, `conversations.ts`, `attachments.ts`, `search.ts`, `notices.ts`, `notice.ts`, `limits.ts`).
* Services: `src/server/staff-messages/` (`access.ts`, `conversations.ts`, `messages.ts`, `read.ts`, `search.ts`, `attachments.ts`, `directory.ts`, `inbox.ts`, `settings.ts`, `maintenance.ts`).
* Database: `supabase/migrations/0096_staff_messages.sql`, `supabase/rollbacks/0096_staff_messages.down.sql`, `supabase/optional/staff-messages-realtime.sql` and its down script.
* Tests: `tests/staff-messages-rules.test.ts`, `tests/staff-messages-migration.test.ts`, `tests/staff-messages-conversations.test.ts`, `tests/staff-messages-service.test.ts`, `tests/staff-messages-attachments.test.ts`, `tests/staff-messages-notifications.test.ts`, `tests/staff-messages-maintenance.test.ts`, `tests/staff-messages-isolation.test.ts`, with fixtures in `tests/support/staff-messages.ts`.
