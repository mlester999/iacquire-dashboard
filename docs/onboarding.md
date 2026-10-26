# Adaptive onboarding (questionnaire v2)

One question per card, six sections (A–F), adaptive to industry, channels, appointments and website needs. Progress is
held **on the server, per answer**, so a refresh, closed tab, logout or different device resumes at the exact question.

## Where things live

| Concern | File |
| --- | --- |
| Question definitions, sections, adaptive rules, option sets | `src/lib/onboarding/definitions.ts` |
| Visibility, validation per kind, progress, resume, review model, mapping to the platform | `src/lib/onboarding/engine.ts` (pure, shared by browser and server) |
| Client save pipeline (debounce, serial writes, retries, honest status) | `src/lib/onboarding/save-pipeline.ts` |
| Persistence, review facts, AI suggestions, website reading, applying answers | `src/server/onboarding/service.ts` |
| What the workspace is really connected to, for the review (website address, website chat, social media, CRM, calendar, channels) | `src/server/onboarding/connection-facts.ts` |
| The business profile written by Settings and by onboarding, and the rules that keep them from undoing each other | `writeBusinessProfile` in `src/server/settings/service.ts`, `src/lib/onboarding/business-profile.ts` (pure), `src/server/onboarding/profile-sync.ts` |
| Booking answers to a draft calendar and appointment types | `src/lib/onboarding/scheduling-drafts.ts` (pure), `src/server/onboarding/scheduling-drafts.ts` |
| The Setup payment line, the employee card wording, the optional media storage step | `src/lib/onboarding/setup-payment-line.ts`, `src/lib/onboarding/employee-status.ts`, `src/lib/onboarding/media-storage-step.ts`, `src/server/setup/storage-step.ts` |
| SSRF-safe public website reader | `src/server/onboarding/website.ts` |
| Logos, photos, reference images (re-encode, background removal) | `src/server/assets/*`, `/api/assets/*` |
| Interface | `src/components/onboarding/*`, page `src/app/(setup)/onboarding` |
| Sample-data preview (dev only, 404 in production) | `/dev/onboarding-preview` |

## Data model (migration `0020_onboarding_v2.sql`)

- `onboarding_responses` gains `questionnaire_version`, `current_question_id`, `status` (`draft`/`submitted`), `submitted_at`, `revision`.
  The legacy nested `data` column is kept and used only to prefill.
- `onboarding_answers (org_id, question_id)`: one row per answered or skipped question with `value` (jsonb), `skipped`,
  `source` (`user`, `ai_suggestion`, `website_analysis`, `prefill`) and `needs_confirmation`. RLS: members read, owners and
  managers write. The website analysis reference is stored as the internal row `x.website_analysis` (never an answer).
- `org_assets` + private bucket `brand-assets` for logos and images; `company_knowledge.seeded_hash` records which text was
  written by onboarding so a later submission never overwrites text edited in the Knowledge Center.

## Behaviour that matters

**Honest saving.** Answers are validated in the browser (instant feedback) and again on the server (the authority). Only valid
answers are sent. "Saved" is shown only after the server commits. Requests run one at a time so an older save can never overwrite
a newer one; failures keep the unsent answer and retry with backoff (1.5 s, 4 s, 10 s). **Next** waits for the save and does not
advance if it fails. The browser warns before closing with unsaved changes.

**Resume.** `current_question_id` is saved with the answers. If a later answer hides the saved question, the user continues at the
next visible one. With every required answer in and no saved position (a prefilled workspace), they continue at the review.

**Adaptive.** Real-estate, healthcare, home-services, agency and professional-services questions appear only for those industries;
appointment questions only if booking is wanted; sender questions only for chosen channels; website design questions only if a
website is wanted. Answers to questions that later become hidden are kept but excluded from progress, review and every
configuration (`effectiveStored`).

**AI help is optional and never authoritative.** "Suggest with AI" uses the connected model, only from the owner's own answers and
the read website text. Prices and FAQs are suggested **only from the owner's website** (never composed from general knowledge).
Writing assistance now uses field-specific allowlists, current wording, optional user clarifications and relevant approved company knowledge. Recent website context is excluded if its origin no longer matches the saved website. Output is checked for shape, length, source quotes and unsupported wording. A separate editable preview requires explicit acceptance; missing details are optional and never silently persisted as company facts. See `docs/onboarding-ux-and-ai.md` for limits and verification evidence.

Output is validated against the question's shape. Suggestions are labelled, editable, and for policy-like questions (prices,
FAQs, hand-off rules) remain `needs_confirmation` until the owner presses "I've checked this"; unconfirmed answers block
submission and never feed approved knowledge. Website text is treated as untrusted data in the prompt. Nothing the assistant
produces changes permissions.

**Website reading.** Only the address the owner typed, http/https on ports 80/443, public IPs only (re-checked at connect time,
which defeats DNS rebinding), robots.txt honoured, at most four same-site pages, 400 KB and a few redirects, rate-limited.

**Brand assets.** Uploads are decoded and re-encoded (metadata stripped, orientation applied, 8000 px cap, 10 MB). Logos keep the
original and may get a transparent version by removing a **single plain colour connected to the border** (white letters inside a
logo are kept). If the background is busy, already transparent, or removal would leave too little, the original is kept and the
reason is shown. The owner chooses which version to use.

**Review and approval (section F).** Editable summary, how the six employees will be configured (with gaps called out), how
messaging will work, permissions requested, connections that are **really** missing (read from the workspace's actual state), and
who must do what. Approval is explicit, and **any later edit withdraws it**. Submitting creates versioned configurations for the
six employees (existing per-employee customisation is preserved, unchanged configs are not re-versioned), saves profile, contact
details and brand colours, writes messaging *preferences* (business hours, reply hours, follow-up style; automatic replies and
channels stay off), seeds knowledge, requests provisioning and notifies the agency. It never activates anything customer-facing.
Team members entered in section D are not invited automatically; the review lists them as a task for the owner.

After approval the owner lands on the Setup Center. Editing answers later saves them as a draft; they reach live employees only
after another explicit approval (versioned, with rollback in each employee's history).

## Onboarding completion (Phase 7, milestone M3)

Migration `0102_onboarding_snapshot.sql` (unreleased, additive, with a rollback that refuses while any of the three things below has been used): the column
`onboarding_responses.submitted_snapshot`, the calendar origin `onboarding`, and one optional step, `media_storage`, on the default checklist.
Nothing here contacts a provider, charges anyone, sends a message or switches anything on.

**Booking rules become a draft, never a live calendar.** When a questionnaire is submitted and the owner said the team books appointments, the appointment
types (name, length, format), the bookable hours, the minimum notice and the time zone become a **draft** calendar called "Appointments" with those types
(`origin = 'onboarding'`). The database refuses a draft that is public or the default (0054), it has no host, and every booking path refuses it, so it takes no
bookings until someone assigns a host and activates it after the existing checks (`src/server/calendars/activation.ts`). The CRM setup guide lists the draft's hosts
and activation checks like those of a Blueprint calendar, and the calendar settings page says where it came from. It is made only when the workspace has no
calendar of its own (a calendar made by hand, one from a Blueprint, or one the owner activated all count as the client's own); on a later submission only appointment
types that are newly listed are added (a type the owner tuned or removed is never touched), and the suggested hours of a calendar still in draft are refreshed. It is
skipped, with the reason on the result, when the owner says no appointments, lists no usable type, uses GoHighLevel for calendars or is switching CRM provider. A
problem while drafting is caught in a savepoint: the submission still succeeds and says the draft was skipped. The screen says what was drafted and that it is not live.

**One writer for the business profile.** Settings > Business profile and the questionnaire both write the workspace name, industry, website, area, time zone, brand
colour, description, services and ideal customers through `writeBusinessProfile`, which cleans the text, refuses instruction-like text before writing anything, and
writes only the facts that differ from what the workspace has. A Settings edit also changes the answer it came from (as the person's own answer, source `user`), so
the questionnaire shows what the workspace says and nobody is asked twice. A Settings text that cannot be that answer exactly (an industry that is none of the listed
ones, a text longer than the question allows) leaves the answer alone. Both paths take the questionnaire's row first, then write the profile, so a Settings edit and a
submission at the same moment cannot wait on each other.

**A re-submission writes only what changed.** Each submission stores `submitted_snapshot`: the nine facts as the answers said them, and the moment up to which answer
edits are known to be live. A later submission writes a fact only when its answer differs from the snapshot, so a Settings edit made in between survives an unrelated
change of answers, and a fact the owner changes in the questionnaire is written. A Settings edit moves its facts into the snapshot (and the moment forward only when
no other edit is waiting). A workspace submitted before this existed has no snapshot: a fact then counts as unchanged unless one of its answers was edited after the
submission. The first submission writes everything, as it always did. The snapshot is bookkeeping (business facts the profile already holds, no contact detail, no
secret); it is not part of the data export.

**The review reports real connections.** `connectionFacts` now reads whether a website address is verified or active in Website Studio, where website chat stands
(from install evidence only: off, no website, waiting for a first visit, seen on a website) and whether a real social account is connected (a stand-in account or one
that needs signing in again does not count). They appear as "Optional connections" lines and never block approval. A line appears only when the server said something
about it, and the website address line only when the owner asked for a website or already has a verified one.

**The Setup payment line** on `/setup` says "Setup payment confirmed" or "Setup payment not confirmed yet" from the one yes or no the database gives a member of the
workspace (`app.setup_payment_cleared`, migration 0099). The status behind it, any waiver reason and the payment itself stay with `billing.view`; the line says nothing
finer, never says a payment was detected, shows nothing when the question could not be answered or in a sample workspace, and does not depend on the address
(`?onboarded=1` only decides whether the welcome banner shows). A link to billing appears only for someone who may see billing. There is no pay button: the setup-fee
checkout waits for a payment provider account, and until then iAcquire records the payment (`docs/billing-and-entitlements.md`).

**Employee cards say why.** While an employee that is switched on has the status "Setup required", its card says which of two things it is waiting for:
"Setup required: waiting for setup payment" when the payment is known to be unconfirmed, and "Setup required: Hermes profile not connected" otherwise
(`src/lib/onboarding/employee-status.ts`). An employee that is working keeps working and keeps its own wording after a refund, a paused employee and a change waiting
for review keep theirs. The words "Setup required" are one constant, `SETUP_REQUIRED_LABEL` in `src/lib/agents.ts`; labels, captions, the readiness text and the help
article all read it, and a test fails for a copy of the words anywhere else in the source. Changing to "Pending setup" is that one line.

**Optional media storage step.** Every new checklist has "Where your post pictures and videos are kept", optional, owned by iAcquire, not an activation step, not counted
in the percentage and not a dependency of anything. Its text is read from the existing storage policy each time the client opens the checklist
(`src/lib/social/media-policy.ts`, with the plan decided by `workspaceEntitlements`): with the managed maintenance plan it says media can be added from iAcquire
storage; without it, that no media storage is available yet and why; Google Drive and OneDrive are always "not available yet" because that connection is not built. The
step connects nothing and completes nothing. Checklists that were already activated do not get it.

### Proposals the founder or counsel must confirm

- Employee status wording: **"Setup required"** (kept) or "Pending setup". One line, `SETUP_REQUIRED_LABEL`.
- The default for existing clients, the payment gate itself and every number around it are in `docs/billing-and-entitlements.md`.
- That an owner may change the profile in Settings after submitting and expect it to survive a re-submission (built that way; the alternative is that the questionnaire wins).
- Whether the drafted calendar should also be offered a first host automatically (not done: nobody is assigned to a calendar without a person choosing them).
- Whether media storage should be a required step for clients on the managed plan (built optional).

## Tests

`tests/onboarding-v2.test.ts` (adaptivity, validation, hidden answers, persistence and resume, tenant isolation, confirmation gate,
submission, re-submission, review, website and assistant), `tests/onboarding-pipeline.test.ts` (autosave semantics),
`tests/assets-and-reader.test.ts` (address filtering, robots, extraction, background removal, asset isolation and limits),
`tests/tenant-isolation-generic.test.ts` (schema-wide RLS guard).

Milestone M3: `tests/onboarding-business-profile.test.ts` (the writer, Settings and the answers, the snapshot rule including workspaces without a snapshot, tenant isolation,
two saves at once, lock order), `tests/onboarding-profile-rules.test.ts` (the pure rules), `tests/onboarding-scheduling-rules.test.ts` and
`tests/onboarding-scheduling-drafts.test.ts` (the plan, the draft on the real migrations, the setup guide), `tests/onboarding-connection-facts.test.ts` (the optional
lines), `tests/setup-media-storage-step.test.ts`, `tests/setup-payment-line.test.ts`, `tests/onboarding-status-wording.test.ts` and `tests/client-onboarding-ui.test.tsx`
(the payment line, the optional lines of the review and the employee cards, rendered in jsdom).

## Not verified

The interface was checked in a real browser against the sample-data preview (resume after refresh, simulated outage, mobile
overflow, axe-core in light and dark, zero violations beyond the preview banner). The authenticated page against hosted Supabase,
the live AI model, and real website reads were **not** exercised.

Milestone M3 was verified only on embedded Postgres and in jsdom: no screen of it (the Setup payment line on `/setup`, the Optional connections block of the review, the
employee cards, the draft-calendar toast and the calendar settings sentence, the media storage step in the checklist) has been opened in a real browser, so 375 px
layout, focus and contrast are unchecked. A deadlock between a Settings edit and a submission cannot happen on embedded Postgres, which runs one transaction at a time; the
protection is the lock order, checked by reading the code. Migration 0102 was applied only by the combined rehearsal on embedded Postgres.
