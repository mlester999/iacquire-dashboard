# AI employee role acceptance (2026-11-01)

**What each of the six employees really does today, what was observed on production, and the checks that decide whether it passes.** It separates five kinds of "done" that a green badge hides, and it records what was verified on 2026-11-01 (read-only reading of the live dashboard, plus six chat requests the owner asked for that change no business record). Nothing here switched on a flag, contacted a customer, created a booking or wrote a business record. The repository is public: no address, account, key or person's name is in this file.

## 1. The five kinds of "done"

| Kind | Meaning | How to recognise it |
| --- | --- | --- |
| **Real** | iAcquire ran the work on live records and saved the result with its evidence (a work job, its events and a report). Deterministic code under the signed-in person's permissions; no model decides what is true. | The chat shows a result card ending "Saved with execution evidence"; the AI Work Board holds a notification for it; the numbers can be checked against the screen they came from. |
| **Suggestion** | Words or a recommendation: a review's "Next:" line, or anything a model writes in free chat. Nothing was changed. | A person has to act on it (a button, an approval, a decision). |
| **Simulated** | Proven only against synthetic data or a mock gateway in the test suite. | A test name, not a production record. |
| **Missing integration** | The code or the credential for it does not exist yet. | The employee's page says so ("No customer channel is enabled"), or the feature is not on the list in section 3. |
| **Blocked** | Built and tested, switched off until a gate is met and a person approves. | A flag that is absent on production, a setting that says "approval required" or "off". |

## 2. What the chat can start today, and what it cannot

The employee does not "do" anything in iAcquireOS by itself. The pinned Hermes runtime gives it no write path. What exists is the **chat router**: when the person's own message matches one of the requests below, iAcquire (not the model) starts the work under that person's permissions and shows the result in the chat. Everything else a person types goes to the model, which receives a read-only, tenant-scoped snapshot (the "evidence") and can only describe it. `src/lib/employee-chat-requests.ts` is the list, and `tests/employee-chat-quality.test.ts` proves each wording reaches the flow it names.

The **business tools** (the model reading live records itself through the business MCP, A4a) are a third path. They are **Blocked**: the flags and the signing secret are absent on production, and they stay so until the A4a gates are met.

## 3. Role by role

"Production 2026-11-01" is what was read on the live site that day. "Acceptance" is the check that decides a pass; the independent figure is always taken from a screen or a query that shares no code with the employee.

### Zeng, Operations Manager

| | |
| --- | --- |
| **Real today** | "Review our current operations and tell me what needs my attention" starts the reviewed capability *On-demand operations review* (tasks, approvals, CRM, integrations, AI workforce). **Production 2026-11-01:** 1 signal across 10 affected items, "10 researched leads are waiting for review", saved with a five-event timeline. Independent check: the Leads review queue holds exactly 10 pending leads, and the three examples quoted are in it. |
| **Suggestion** | The "Next:" line of each finding, and any free-chat answer (11 completed model chats on record, none today). "Create follow-up task" is a button a person presses; the employee creates nothing. |
| **Simulated** | The other signal families (overdue tasks, missing approvals, failed runs, integration problems): proved on seeded data (`tests/workforce-chat-e2e.test.ts`, `tests/internal-workforce-capabilities.test.ts`); production has no such records, so they did not fire. |
| **Missing** | Nothing the role needs. Monitoring on its own is not built to run (see Blocked). |
| **Blocked** | Working on its own (scheduler off, "Allowed to work on its own: No"); creating tasks or approvals; the business tools (open tasks, overdue tasks, pending approvals read live). |
| **Acceptance** | A4a (read-only): ask the fixed question in `docs/hermes-a4a-acceptance-plan-2026-10-31.md`; its open, overdue and pending counts must equal the independent counts of `scripts/hermes-a4a-evidence.ts`. |

### Lead Hunter

| | |
| --- | --- |
| **Real today** | *Lead generation review* ("Review our researched leads and tell me which need review"): **production 2026-11-01** 10 leads waiting more than 48 hours, matching the queue. *Lead research* ("Find 10 dental clinics in Austin, Texas") is a real job over approved public sources that saves candidates for a person to review: the supervised run of 2026-10-21 prepared 10 leads; one opened on 2026-11-01 carries a five-part fit score (service fit, problem evidence, buying signal, market fit, source quality), notes that separate what was observed from what is inferred, signals, and a source address with a quoted page title. |
| **Suggestion** | The fit score and notes (a research priority, not interest or consent, as the panel says); the review's "approve, reject or ask for better evidence". |
| **Simulated** | Research stop reasons, duplicate flags and the no-targeting-rules path (`tests/lead-research*.test.ts`). |
| **Missing** | Importing a lead into the CRM and any outreach: nothing leaves, by design ("Nothing has been imported or contacted"). Enrichment beyond public pages. |
| **Blocked** | Starting new research from this acceptance (it writes pending-review rows, so it needs the owner's go-ahead); CRM import (needs approval); the business tools (`find_contacts`, `get_contact` read CRM contacts, a different record from researched leads). |
| **Acceptance** | Review count equals the independent count of leads by review state. For research: every candidate has a source address that opens, a score whose parts add up, and no contact made. |

### Appointment Setter

| | |
| --- | --- |
| **Real today** | *Calendar availability check*: reads the calendar's real bookable start times for the next seven days, holds nothing. **Production 2026-11-01** (host works Monday to Friday 09:00-17:00 in Manila, 30-minute type, 15-minute buffer, 24 hours' notice, "you confirm", booking page off): it reported 50 slots in UTC, which was wrong in three ways (see "Found and fixed" below). Independent arithmetic gives 73 start times that week. **After the fixes were released (the same day, 14:19 local):** 69 slots on 5 days in Asia/Manila (Monday 5, from 2:30 PM; Tuesday to Friday 16 each, 9:00 AM to 4:30 PM), which is what the arithmetic gives for that moment (the 24-hour notice had moved Monday's first start). Free chat then answered "which day next week has the most room" with the same counts, and, asked for the open times on Tuesday, gave the three it holds (9:00, 9:30, 10:00), said there are 16 in all, declined to list the rest and pointed to the availability check: no invented times. *Appointment review* (requests and their confirmation state) exists; not run today. |
| **Suggestion** | Free chat describes the calendar, appointments and open times from the evidence (now counted for the whole week, three per day listed) and says what it would confirm before booking. It cannot book. |
| **Simulated** | The whole booking chain on the production configuration, through the real chat flow and approval (`tests/appointment-setter-acceptance.test.ts`): preview holds nothing; "confirm booking" files an approval request; approval creates exactly one CRM appointment for that contact, pending the host's own confirmation because the type says "you confirm"; the booked time and its 15-minute buffer leave the offer; a time waiting for approval is offered to no one else; weekend, before and after hours, between starts, inside the notice period and past times are each refused; no model run, no customer message, no email. Not exercised on production (it would create a booking request for a real contact). |
| **Missing** | A customer channel (nothing this employee prepares can reach a customer: the page says so), connected Google or Microsoft calendars (so no meeting links), a workspace time zone set to the host's (it is UTC; previews and the evidence read in the contact's zone, else the workspace's). |
| **Blocked** | The public booking page (off); booking on its own (approval required); the business tool `check_availability` (A4a). |
| **Acceptance** | Counts per day equal the independent arithmetic; every refused time is refused with nothing held; an approved request yields one CRM appointment and no outbound message. All of it is the test file above; the production check is the availability request, compared with arithmetic. |

**Found and fixed on 2026-11-01 (commit `f556376f`, on `master` since 06:15 UTC that day):** the availability result was capped at 50 and shown as the total; it read the week in UTC although the host works in Manila; every work card ended with the lead-research footer and a "Review N leads" link (a calendar result said "Review 50 leads", an operations review "Review 1 lead"); and a time waiting for approval was still offered and previewed to the next person, who was refused only at "confirm booking". Now: exact counts with a per-day summary in the hosts' zone, a footer that fits the work, a week-wide list in the model's evidence, and waiting requests removed from the offer (the rule `requestNativeBooking` already applied). **A limit to know:** a held time is released at once when a person declines or cancels the request, but an approval that simply expires (48 hours) is released by the scheduler (`src/server/appointments/holds.ts`), which is off on production; until it runs, an abandoned request keeps its time held (and, as before, keeps that time from being requested again) until someone declines or cancels it in Approvals. **One more, found after the release by asking a natural question:** "List every open time on Tuesday, November 3." was read as a recurring schedule request ("every" plus a weekday) and answered "What local time should I use?" instead of reaching the employee. The word now starts a schedule only when a period follows it ("every Friday", "each morning"); in "list every open time" it means all of them (`src/lib/workforce-chat-schedule-intent.ts`, on the review branch).

### Sales Assistant

| | |
| --- | --- |
| **Real today** | *Pipeline review*. **Production 2026-11-01:** "no actionable signals". With 0 open deals this is true and **vacuous**: the code ran and had nothing to find. |
| **Suggestion** | Follow-up risks and next steps in a review; free-chat advice. |
| **Simulated** | Stale deals, past close dates and missing values (`tests/workforce-review-capabilities.test.ts`), and unsent follow-up drafts for conversations the employee handles (`tests/workforce-chat-e2e.test.ts`). |
| **Missing** | Opportunities and conversations to work on (none exist); a customer channel (a draft cannot be sent). |
| **Blocked** | *Follow-up drafts* write unsent drafts into the Inbox, so they need the owner's go-ahead and an open conversation; sending (never available to an employee); the business tools. |
| **Acceptance** | Needs data. Either real deals or a synthetic client workspace holding stale deals; then the review's findings equal the independent counts by stage and age, and the drafts stay unsent. |

### CRM Manager

| | |
| --- | --- |
| **Real today** | *CRM quality review*. **Production 2026-11-01:** "no actionable signals", with 0 contacts created in 30 days: **vacuous**, as above. |
| **Suggestion** | Proposed fixes for missing details and possible duplicates. The employee edits, merges and deletes nothing. |
| **Simulated** | Incomplete records, duplicate names and companies, unverified identities (`tests/workforce-review-capabilities.test.ts`). |
| **Missing** | Contacts and companies to review. |
| **Blocked** | Any change to a record (no write path in chat); the business tools (`crm_summary_report`, `find_contacts`, `get_contact`). |
| **Acceptance** | Needs data, as for the Sales Assistant: a workspace with planted duplicates and gaps; findings equal the independent query. |

### Performance Analyst

| | |
| --- | --- |
| **Real today** | *Performance snapshot* ("Show our performance metrics for the last 30 days"): **production 2026-11-01** 12 measured figures, each with its period and source, nothing estimated: leads created 10, approved 0, awaiting review 10, rejected 0, contacts 0, appointments confirmed 0, upcoming 0, open deals 0, won 0, lost 0, AI runs completed 49, AI runs failed 5. The lead figures match the Leads page. The run counts need a database read to check independently (the A4a evidence tool does it). |
| **Suggestion** | The "up" and "down" against the previous 30 days is arithmetic; any commentary in free chat is a suggestion. |
| **Simulated** | The comparison periods and the stated anomaly thresholds. Three more reviews exist (social media, receivables, reputation) and were not run today. |
| **Missing** | Conversion rates, revenue and attribution are not recorded anywhere yet, so the honest answer is "not recorded". |
| **Blocked** | The business tools (`crm_summary_report`). |
| **Acceptance** | Each figure equals the independent count over the same window (`readRoleFacts` in the evidence tool). The 5 failed AI runs deserve a look by a person; nobody has said why they failed. |

## 4. What is true across all six on 2026-11-01

- Each employee is "Ready for authorized work" (7 of 7 requirements), is not allowed to work on its own, and needs approval for any change. "Safe tools confirmed" reads "Not confirmed" between chats **by design**: the verified inventory is re-attested for about two minutes around each chat and refreshed before the next message is saved.
- Six chat requests ran on production and saved their evidence. None called a model, a business tool or a provider; none changed a business record; none sent anything.
- **Vacuous passes:** the Sales Assistant and the CRM Manager passed on empty data. They are not accepted until they have been run on data.
- **Not accepted for real work yet:** anything on the business-tool path (A4a), lead research as a new run, bookings and approvals on production, follow-up drafts, and every customer-facing action.

## 5. Where the acceptance checks live

| Check | Where |
| --- | --- |
| Deterministic reviews for all six, persisted evidence, no model call | `tests/workforce-chat-e2e.test.ts`, `tests/workforce-review-capabilities.test.ts`, `tests/six-employees-conformance.test.ts` |
| Appointment Setter on the production configuration | `tests/appointment-setter-acceptance.test.ts`, `tests/crm-calendars.test.ts` |
| The model's evidence per role | `tests/employee-evidence.test.ts`, `tests/employee-evidence-hardening.test.ts` |
| Business tools (A4a, per role) and their independent counts | `docs/hermes-a4a-acceptance-plan-2026-10-31.md` section 7, `scripts/hermes-a4a-evidence.ts`, `tests/hermes-a4a-evidence.test.ts` |
| What each chat request is wired to | `src/lib/employee-chat-requests.ts`, `tests/employee-chat-quality.test.ts` |
