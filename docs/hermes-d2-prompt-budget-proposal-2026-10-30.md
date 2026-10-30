# D2 proposal: the prompt budget (Option B prepared on the review branch; not pushed, not deployed)

**Status (2026-10-30):** Option B is committed and pushed as `02875cf3` on `integration/hermes-bridge-final` with CI green (section 8), and the **worker side is rolled out**: image `0.22.5-v3` runs on the six VPS workers (section 8.1). The **app is not released** (the production app still enforces its own 6,144-byte pre-check, so nothing can send a larger prompt yet), the audit and canary flags are off, and no real-model call has been made. The data-handling question in section 6 and the app release in section 7 are still undecided.

Date: 2026-10-30. Decision owner: the founder. Context: the A2 re-run (section 8 of `hermes-a1-results-and-request-2026-10-29.md`) measured all six employees over the worker's 6,144-byte prompt budget. No real-model call (A3) can run until this is decided.

## 1. Recommendation in one paragraph

**Raise the budget deliberately (Option B): 24,576 bytes (24 KiB) for all six roles, instruction text up to 20,000 characters, and keep the existing 8,192-input-token and 128-output-token ceilings.** Do not shorten the employees' instructions (Option C) and do not paper over the problem with a short canary instruction (Option A): the Chat canary is designed to push the real role instructions through the real Chat path, so a short instruction cannot prove what A3 is for, and the real employee path stays blocked either way. The price of the raise is a larger worst-case cost per call (about 3.5 times, to roughly 1.1 cents on the most expensive model at peak rates), still small, and a decision from you that the full role text may be sent to DeepSeek during A3.

## 2. The facts

**Live measurements (A2 re-run, pinned Hermes 0.22.5, 2026-10-30).** "Chat message" is what the worker's runner checks: app instructions plus the SOUL plus Hermes framing.

| Role | App instruction | SOUL | Chat message | Over 6,144 by |
|---|---:|---:|---:|---:|
| Operations Manager | 11,037 | 2,291 | 14,822 | 8,678 |
| Lead Hunter | 14,091 | 2,404 | 17,910 | 11,766 |
| Sales Assistant | 8,638 | 2,346 | 12,399 | 6,255 |
| CRM Manager | 8,349 | 2,323 | 12,166 | 6,022 |
| Appointment Setter | 8,518 | 2,361 | 12,294 | 6,150 |
| Performance Analyst | 8,281 | 2,349 | 12,045 | 5,901 |

- Fixed part of every call: the SOUL (2.3 to 2.4 KB) plus about 1.4 KB of Hermes framing (the chat call adds 37 bytes). About 2.4 KB of the 6,144 is left for the business instructions.
- **The live instructions are larger than the earlier "default configuration" measurement** (section 2 of the A1 results): Operations Manager 5,699 then, 11,037 now; Lead Hunter 10,874 then, 14,091 now; the other four are about 2.7 KB larger. I did not investigate why (saved configuration, business context, or code changes since). The practical point: instruction text moves by kilobytes when someone edits an employee, so any budget needs headroom.
- **What the canary sends.** The provider canary and the Chat canary both send the role's full run instructions (`buildRunInstructions`) plus a fixed greeting request. The Chat canary text is "Use your approved internal role instructions to give a concise greeting and one way you support iAcquireOS. Do not research or take an action." Its purpose is to prove that the real instructions reach the real model and are followed.
- **Where the limit lives (all must agree):**
  - `src/server/integrations/hermes/inference-only.ts` (app): `MAX_PROMPT_BYTES = 6_144` on instructions plus input plus history, the literal type `promptLimitBytes: 6_144`, and `MAX_INPUT_TOKENS = 8_192` after the call.
  - `services/hermes-inference-worker/worker.py`: `MAX_PROMPT_BYTES = 6_144` (same sum), `MAX_INSTRUCTIONS_CHARS = 16_000`, `MAX_INPUT_TOKENS = 8_192` after the call.
  - `services/hermes-inference-worker/inference_runner.py`: `MAX_PROMPT_BYTES = 6_144` on the effective messages (this is the authoritative check, it includes the SOUL and framing), and a usage check that compares the provider-reported prompt **tokens** against that same bytes constant.
- **The token ceiling already exists and is separate:** 8,192 input tokens and 128 output tokens per call. Today the 6,144-byte pre-call cap is 3 to 4 times tighter than that, because bytes are the only thing that can be checked before the provider is called.
- **Any option needs an app release as well as a worker image**, because the app has its own 6,144 pre-check and the canary routes live in the app. Production runs master `bd843d27`; the review branch changes so far touch services, CI and tests only.

## 3. Options

| | A. Short canary instruction, keep 6,144 | **B. Raise the budget (recommended)** | C. Shorten the instructions |
|---|---|---|---|
| What changes | Canary and Chat-canary paths get a fixed role-neutral instruction of about 1 KB | Three numbers and the tests that pin them (section 4) | Each role's instructions cut by about 71% to 84% |
| Proves provider, model, token usage | Yes | Yes | Yes |
| Proves the real role instructions reach the model and are followed | **No** | **Yes** | Only a cut-down version |
| Real employee chat afterwards | Still blocked (needs B later) | Within the new cap (still no tools; A4 is separate) | Behaviour changes for every employee |
| Business knowledge sent to DeepSeek in A3 | None | The full role text (8 to 14 KB per role) | Reduced text |
| Respects "no silent truncation of security rules or business knowledge" | Yes (nothing real changes) | Yes | **No** |
| Cost per A3 call at peak rates (estimate, section 5) | flash about $0.0006, v4-pro about $0.0026 | flash $0.0014 to $0.0026, v4-pro $0.0058 to $0.0113 | lowest |
| Releases needed | App + worker, then again for B | App + worker, once | App + worker + a review of six employees |
| Verdict | Cheap, but only postpones B and cannot cover the Chat canary | **Recommended** | Rejected: conflicts with your rule and changes behaviour without a review |

A second route inside C (move static business knowledge out of the prompt into on-demand lookups) is a real design, but it belongs to A4 (business-tool acceptance), not to this decision.

## 4. Option B in detail (nothing below is done)

| File | Change |
|---|---|
| `services/hermes-inference-worker/worker.py` | `MAX_PROMPT_BYTES` 6_144 to 24_576; `MAX_INSTRUCTIONS_CHARS` 16_000 to 20_000 (Lead Hunter is at 14,091 today, so 12% under the old cap: raising only the byte cap would leave that role one edit away from `instructions_too_large`) |
| `services/hermes-inference-worker/inference_runner.py` | `MAX_PROMPT_BYTES` to 24_576 for the effective-message check; **the usage check must stop comparing tokens to the bytes constant** and use a separate `MAX_INPUT_TOKENS = 8_192`, otherwise raising the bytes constant would silently loosen that layer's tripwire from 6,144 to 24,576 tokens (the worker's own 8,192 check would still catch it, but one layer would be wrong) |
| `src/server/integrations/hermes/inference-only.ts` | `MAX_PROMPT_BYTES` and the `promptLimitBytes` literal type to 24_576 |
| Tests | `tests/hermes-prompt-audit.test.ts` (expects 6_144); `test_worker.py` (add: 24,576 accepted and 24,577 refused with `prompt_too_large`; an 18 KB instruction accepted in inference mode; the runner's token tripwire uses the token constant; an input at 8,193 reported tokens is rejected); a test that all three layers hold the same byte constant |
| Docs | `DEPLOYMENT.md` lines 40 to 44 and 175 to 176; section 8.3 of the A1 results; this proposal's outcome |

Unchanged on purpose: 128 output tokens, 2,000-character input, 8 history messages and 5,000 history characters, the rate limits (2 per profile, 6 per actor, 30 global per minute), the over-budget refusal before any provider call, no tools, no tool schemas, the no-key audit child, the egress proxy rules. The runner's effective check stays the authoritative one: requests that pass the app and worker sums but exceed 24,576 once the SOUL and framing are added are still refused before the provider is called.

Headroom at 24,576 against today's live sizes: Lead Hunter 6,666 bytes (37%), Operations Manager 9,754 (66%), the other four 12.2 to 12.5 KB (about 100%).

## 5. Cost (DeepSeek prices read from `api-docs.deepseek.com/quick_start/pricing` on 2026-10-30)

| Model | Input, cache miss, peak / off-peak per 1M | Output, peak / off-peak per 1M | Input, cache hit, peak per 1M |
|---|---:|---:|---:|
| deepseek-flash | $0.30 / $0.15 | $1.20 / $0.60 | $0.006 |
| deepseek-v4-pro | $1.32 / $0.66 | $3.96 / $1.98 | $0.044 |

Peak is 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays; everything else is half price. I have not seen which model each role uses.

Per-call estimate at peak rates with 128 output tokens, assuming 3 bytes per token (conservative for English; **an estimate, A3 measures the real usage**):

| Prompt | Approx. input tokens | deepseek-flash | deepseek-v4-pro |
|---|---:|---:|---:|
| Today's cap, 6,144 B | 2,048 | $0.0008 | $0.0032 |
| Largest live prompt, 17,910 B (Lead Hunter) | 5,970 | $0.0019 | $0.0084 |
| Smallest live prompt, 12,045 B (Performance Analyst) | 4,015 | $0.0014 | $0.0058 |
| Proposed cap, 24,576 B (the 8,192-token ceiling) | 8,192 | $0.0026 | $0.0113 |

- **A3 as designed (at most 12 calls):** under $0.15 even if every call hit the ceiling on v4-pro at peak rates; realistically about $0.07 to $0.10.
- **Worst case after the raise:** the cap roughly quadruples the largest possible input. Under the existing rate limits, one Super Admin calling non-stop (6 per minute) could spend at most about $98 a day on v4-pro at peak rates, against about $28 a day under today's cap. That is a theoretical ceiling for a Super-Admin-only endpoint, not an expected figure. Identical instruction text repeated across calls should hit DeepSeek's prefix cache (about 30 times cheaper per input token on v4-pro), which I have not counted.
- To confirm at approval time: whether the DeepSeek account is prepaid (then the loaded balance is a hard ceiling) and what its spending limit is.

## 6. Risks and what I have not verified

- **Data handling (your decision).** With Option B the first real calls send each role's full instruction text, assembled from the active configuration and business knowledge, to `api.deepseek.com`. Option A would send none. **I never read or printed the instruction text.** Sections 6.1 and 6.2 list what it is made of and what production holds, in summary, and a pattern scan found no email addresses, phone-like numbers or key-like strings in any of it. What the text does contain is iAcquire's own business description, services and **approved prices**, plus each employee's behavioural settings.
- Token estimates are not measurements; the 8,192-token ceiling is checked after the call, so one over-ceiling call could still be billed before it is rejected. The byte cap is the pre-call bound.
- Growth: edits to an employee can add kilobytes (the live text is already 2.7 to 5.3 KB above the earlier default measurement). A role that grows past the cap fails safe (refused before any provider call), and the audit shows it.
- Behaviour with 14 KB of instructions and a 128-token reply cap is untested on a real model; that is what the Chat canary is for.
- Nothing in this proposal changes the A3 approval gate: A3 still needs its own approval, DeepSeek pricing re-read at that time, and the inference flag off afterwards.

### 6.1 What the instruction text is built from (read from the code on 2026-10-30)

Method: I read `buildRunInstructions` and what feeds it, and measured the code-defined pieces with a temporary script (byte sizes only, deleted afterwards). **No instruction text and no database content was read or printed.** The sizes below are for the iAcquire internal workspace with default settings.

| # | Part | Source | Who controls it | Size |
|---|---|---|---|---|
| 1 | Header, role text, role operating standard, how to communicate | Code (`compiler.ts`, `policy.ts`) plus the employee's saved style settings | Code; Super Admin for the style fields | Role text 131 to 242 B; operating standard 296 to 400 B, **Lead Hunter 3,873 B**; style fields up to 500 to 1,000 characters each |
| 2 | Capability section (what the employee can do, in plain words) | Code, from the role's default tool list | Code | about 1.0 KB |
| 3 | Business context | The workspace company profile (`company_profiles`: description, industry, website, services, ideal customers, operating area, goals) and the employee's saved fields (responsibilities, goals, target customers, company rules, never promise, escalation, custom instruction, role answers). Where the agency profile is empty the iAcquire defaults in code fill in | Super Admin | Each field is capped (80 to 1,500 characters). Code defaults: description 283 B, services 315 B, ideal customers 369 B, operating area 83 B |
| 4 | Role additions for the agency workspace | Code | Code | Lead Hunter "approved internal prospecting profile" 1,554 B; Sales Assistant "approved internal commercial context" 182 B |
| 5 | Company knowledge block | `company_knowledge` (approved sections: business description, products and services, FAQ, approved pricing, hours, policies, customer service, brand voice, escalation), then up to 20 approved employee notes (`employee_knowledge_entries`), then up to 8 uploaded reference documents (first 3,000 characters of extracted text each, only documents that are ready and applied) | Managers and Super Admins; notes the risk check flags are held for agency review and not included | **Capped at 6,000 characters of content plus a short header, shared across all three kinds**; anything past the cap is dropped and flagged "truncated" |
| 6 | Agency policy | Code: 9 fixed rules | Code | 1,679 B |

- **Where today's live size comes from.** The code-defined total with default settings (without the tool list or knowledge) is 5.3 to 5.6 KB for five roles and 10.6 KB for Lead Hunter. Live minus the earlier default measurement is about 2.7 KB for CRM Manager, Appointment Setter, Sales Assistant and Performance Analyst, 3.2 KB for Lead Hunter and 5.3 KB for Operations Manager. My first reading (before the production query) guessed this was mostly the knowledge block; **section 6.2 shows it is the knowledge block (about 2 KB) plus the employees' saved settings**, and that the pieces add up to the audit numbers.
- **What the A3 canaries send:** parts 1 to 6 plus the one fixed canary sentence. **What they do not send:** the workspace evidence snapshot (recent leads, opportunities, bookings, research requests), the Operations Manager's task and approval context, chat history, any customer message, any tool schema. Basis: the canary route and the restricted Chat run (`createInferenceOnlyChatRun`) call only `buildRunInstructions`, and a code comment there says the verification turn "deliberately omits dynamic Operations Manager task context and chat history". The normal chat path is different: it adds the evidence snapshot (real lead, opportunity and booking rows) on top.
- **What the code cannot tell:** the content of parts 3 and 5, that is, whatever people typed, saved or uploaded. If anyone pasted personal data into an employee note, a reference document or a free-text setting, it would be in the canary prompt. Only a read of those records can rule that out.
- **For later, not for A3:** a real employee chat through the restricted worker would add the evidence snapshot, history (up to 5,000 characters) and the user's message (up to 2,000) on top of 8 to 14 KB of instructions, the SOUL and the framing. For the largest role that can exceed 24 KiB, so real-chat sizing and its data rules are a separate decision (A4 and after).

### 6.2 What production holds (read-only query, 2026-10-30, approved by the founder)

Method: one read-only transaction (`begin read only`, rolled back) against production as the database owner role, listing titles, sizes, statuses and review flags, replaying the app's own selection and 6,000-character budget, and counting pattern hits per record (email addresses, phone-like numbers of 9 to 15 digits, key-like strings). **No content was printed, stored or committed**; the script and its output stay in the session scratch folder, outside the repository. Nothing was written.

- **Workspace:** one agency workspace (not a demo). Its company profile matches the code defaults in size, and no profile field has a pattern hit.
- **Company knowledge:** three approved sections with no review flags, about 1.8 KB in total (the descriptive text, the services text and the approved price list). No pattern hits.
- **Employee notes: none. Uploaded reference documents: none.** So no uploaded file or free-form note reaches any prompt today.
- **The knowledge block is the same for all six employees**, about 2 KB, all in full, far below the 6,000-character cap, not truncated.
- **Saved settings** (one configuration per employee): short free-text fields of a few hundred characters each. Operations Manager's are the longest, including its company rules and approval rules. **No pattern hits in any field.**
- **The pieces add up.** Stored configuration plus the knowledge block plus the policy comes within about 0.9 KB of the audit measurement for every role (the same gap everywhere: the capability section that replaces the stored tool list). So the prompt contains nothing I have not accounted for.
- **Limits of this check.** A pattern scan finds email addresses, phone-like numbers and key-like strings; it cannot recognise a person's name or a free-form personal fact. The three knowledge sections (about 1.8 KB in total) and the saved settings are short enough to read yourself in the Knowledge Center and the employee settings screens.

**Reading for the data decision:** what would go to DeepSeek in A3 is iAcquire's own business description, services and approved price list, plus each employee's behavioural settings and the fixed policy. I found no customer, lead or contact data and no uploaded documents in it. The one commercially sensitive item is the approved price list, which exists so employees can quote it.

## 7. Path if you choose B (each step separately approved)

1. Code change on the review branch, tests, CI green (no production effect).
2. Worker image v3 built and the six workers recreated on the VPS (one approval, as with v2). Optionally re-run the no-call audit: it then reports `underLimit: true` for every role.
3. App release (master push, which needs your explicit authorization) so the app's own pre-check and canary routes match.
4. A3 canaries (12 calls at most), with the budget, model and cost line stated again at approval.

## 8. What was prepared (local commit, nothing pushed or deployed)

- **Worker:** `MAX_PROMPT_BYTES` 24,576 and `MAX_INSTRUCTIONS_CHARS` 20,000 in `worker.py`; `MAX_PROMPT_BYTES` 24,576 and a new `MAX_INPUT_TOKENS` 8,192 in `inference_runner.py`, whose usage check now compares provider-reported prompt tokens to the token ceiling instead of the byte budget.
- **App:** `MAX_PROMPT_BYTES` and the `promptLimitBytes` type in `src/server/integrations/hermes/inference-only.ts` are 24,576. Two code comments that quoted 6,144 were updated.
- **Image tag:** `0.22.5-v3` in `compose.internal.yaml` (both services), the Dockerfile label and `DEPLOYMENT.md`, so it cannot be confused with the running v2. `DEPLOYMENT.md` now states the new numbers and why.
- **Tests added or changed:** `PromptBudgetTests` in `test_worker.py` (six tests: the two layers agree; instructions accepted at exactly 20,000 characters and refused at 20,001; the byte budget cut at exactly 24,576 including history and multibyte text; the provider gate accepts a prompt of exactly 24,576 bytes; the usage check uses the token ceiling); two existing tests that pinned the old numbers now use the constants; `tests/hermes-prompt-budget.test.ts` (new: the three layers hold the same numbers, the runner's token check, the body limits, the documentation); `tests/hermes-prompt-audit.test.ts` (reports 24,576 and a live-sized measurement); `tests/hermes-worker-readonly-profile.test.ts` (v3 tag).
- **Checked locally:** worker tests 29 OK (2 skipped on Windows); the 23 Hermes-related TypeScript test files, 185 tests, pass; reverting the runner's token check, or the worker's byte budget, makes the new tests fail.
- **Not done:** CI has not run (it needs a push); the image is not built; the full test suite and lint have not run locally.

### 8.1 Worker roll-out on the VPS (approved "Roll out v3"; 2026-10-30)

- **Files:** the nine service files were fetched from commit `02875cf3` into `/root/v3-stage`; every sha256 matched the hashes computed from the commit. A diff against the installed v2 files showed only the expected changes (two image tags, the Dockerfile label, `worker.py`, `inference_runner.py`, `test_worker.py`; the proxy and the three smokes were identical). The v2 files are backed up in `/root/v2-backup-files`.
- **Image:** `iacquire/hermes-inference-worker:0.22.5-v3` = `72dfd7284a2f` (v2 `d22cf79d90c9` and v1 `4ee41de3b352` are kept for rollback). In-image unit tests with `--network none`: 29 OK, none skipped on Linux.
- **Scope:** a `--dry-run` showed only the six workers recreating (no proxy, network or volume change), then `up -d --no-build --no-deps` on the six services with the audit flag at its default (false). **The egress proxy is untouched and still runs the v1 image** (same code), as agreed for v2.
- **Verified after:** six workers healthy on v3, audit flag false; read-only root, no published ports, user 10000, all capabilities dropped, profile and secret mounts read-only, `/tmp` a 32 MB `nosuid,nodev,noexec` tmpfs; the proxy answers `403 Forbidden` to `CONNECT example.com:443`; the tunnel is still attached to all six ingress networks; the running workers hold the new numbers (24,576 bytes, 20,000 characters, 8,192 input tokens in both the worker and the runner); unauthenticated calls to the public worker routes return 403; `/api/health` is ok.
- **Not touched:** Vercel, Cloudflare, the profiles, master, any DeepSeek call. The roll-out is inert for now: with the production app still on the 6,144-byte pre-check, no request can exceed the old budget, and both Vercel flags are off.
- **Open:** the `/opt/data` volume on each worker is still writable (O3); the proxy is still on the v1 image; the app release (master push, needs your explicit authorization) is what makes the new budget reachable.

## 9. What I need from you

1. Option A, B (recommended) or C.
2. If B: confirm 24,576 bytes and 20,000 instruction characters, or give other numbers.
3. If B: confirm that the full role instruction text may be sent to DeepSeek for the canaries (or ask me to list what it is made of first).
4. Whether I may prepare the code change and tests on the review branch now (no production effect, pushing still needs your GitHub sign-in).
