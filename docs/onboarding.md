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

## Tests

`tests/onboarding-v2.test.ts` (adaptivity, validation, hidden answers, persistence and resume, tenant isolation, confirmation gate,
submission, re-submission, review, website and assistant), `tests/onboarding-pipeline.test.ts` (autosave semantics),
`tests/assets-and-reader.test.ts` (address filtering, robots, extraction, background removal, asset isolation and limits),
`tests/tenant-isolation-generic.test.ts` (schema-wide RLS guard).

## Not verified

The interface was checked in a real browser against the sample-data preview (resume after refresh, simulated outage, mobile
overflow, axe-core in light and dark, zero violations beyond the preview banner). The authenticated page against hosted Supabase,
the live AI model, and real website reads were **not** exercised.
