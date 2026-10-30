# A3 request and app release package (DRAFT: nothing here is approved or started)

Date: 2026-10-30. Decision owner: the founder. Background: D2 is decided in principle (Option B, 24 KiB budget) and the v3 worker image runs on the VPS (`hermes-d2-prompt-budget-proposal-2026-10-30.md`). The founder has confirmed that the text described in its section 6.2 (iAcquire's business description, services and approved prices, each employee's behavioural settings and the fixed policy) may go to DeepSeek for the A3 canaries. **That is the only thing decided. The app release and A3 below each still need their own approval.**

## 1. What is being asked, in order

1. **App release** (section 3): fast-forward `master` from `bd843d27` to the review branch, so production has the 24 KiB pre-check. Needed because the production app still refuses any prompt over 6,144 bytes and all six roles are over it.
2. **A3 real-model canaries** (section 2): 12 calls at most, with the inference flag on for about 20 minutes, then off again.

Neither starts until you say so, and the second one needs the first.

## 2. A3: the real-model canaries

**Scope.** For each of the six employees, in this order (Operations Manager first): one provider-only canary, then one fixed no-tool Chat canary through the restricted Chat path. Six plus six, **12 calls at most, one request at a time**, 128 output tokens each. The provider canary asks for a short greeting; the Chat canary is the fixed sentence "Use your approved internal role instructions to give a concise greeting and one way you support iAcquireOS. Do not research or take an action." Nothing else can be sent: both routes accept only their fixed text, Super Admin only, no history, no tools.

**What goes to DeepSeek.** Per call: the employee's composed instructions (8.3 to 14.1 KB), the profile's `SOUL.md` (about 2.3 KB), Hermes framing (about 1.4 KB) and the one fixed sentence. Nothing else (section 6.1 and 6.2 of the D2 proposal): no lead, contact, booking or message data, no uploaded documents, no employee notes, no tool schemas.

**Model and price.** The six profiles all resolve to `deepseek-flash` (release package, section "Profiles"; identifiers only were read then). DeepSeek's page, read on 2026-10-30, lists deepseek-flash at $0.30 per 1M input and $1.20 per 1M output tokens at peak and half of that off-peak (peak is 01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays). With 3 bytes per token assumed:

| Prompt | Input tokens (estimate) | Cost per call at peak rates |
|---|---:|---:|
| Smallest live (Performance Analyst, 12,045 B) | about 4,000 | about $0.0014 |
| Largest live (Lead Hunter, 17,910 B) | about 6,000 | about $0.0019 |
| At the 8,192-token ceiling | 8,192 | about $0.0026 |

**Twelve calls cost about $0.02, and under $0.04 even if every call hit the token ceiling.** The price will be re-read from DeepSeek's page at approval time, as the release package requires. I cannot see the DeepSeek account: please confirm it has a balance (a call on an empty account would fail, and the worker reports it only as a failure).

**Prerequisites.** (a) The app release in section 3. (b) Each profile's DeepSeek key must be present in its `.env` (the release package recorded that provider credentials are configured; the first call proves it). (c) The v3 workers are already running; **no worker change is needed**, because the worker allows inference for any correctly signed request within its budget and the audit flag stays off.

**Procedure (after the release is live).**

1. Set the Vercel Production variable `HERMES_INFERENCE_WORKER_ENABLED=true` and redeploy (about 6 minutes). `HERMES_INFERENCE_WORKER_URL` and `HERMES_INFERENCE_WORKER_SECRET` are already set.
2. From your signed-in Super Admin session, call `POST /api/internal/hermes-inference/canary` with `{role}` six times, one role at a time, paced inside the limits (6 per minute per user, 2 per minute per profile, one active call per profile). Read each response: provider, model, content, token usage.
3. Run the six Chat canaries through `POST /api/internal/hermes-inference/chat` (or the Chat view's restricted mode, which appears when the flag is on), each in a new empty conversation. Each leaves one conversation, one run and its audit row in production's chat tables.
4. Record per employee: provider, model, input, output and total tokens, response text length, and the audit rows (`hermes.inference_only_canary`, `hermes.inference_only_chat`). Compute the cost from the recorded tokens. You can compare with DeepSeek's usage page.
5. Remove `HERMES_INFERENCE_WORKER_ENABLED`, redeploy, and verify the canary and chat routes answer 503 again and `/api/health` is ok. Confirm the audit flag is still off on the six workers. The flag is on for about 20 minutes, Super Admin only.

**Acceptance (per employee).** Provider-only canary: HTTP 200, provider `deepseek`, a model name that matches the allowed set, input tokens at most 8,192 and output at most 128, no tool schemas and no tool calls, a short greeting. Chat canary: a concise greeting in the employee's role and one honest way it supports iAcquireOS, with no action taken and no invented facts (no numbers, customers or capabilities that are not in the instructions), run finished, usage recorded.

**Stop conditions (I stop and report, I do not retry blindly).** Any non-200 or worker error code; any tool call or schema; usage over the ceilings; an unexpected model name; a reply that invents data or claims an action; a second failure of the same employee; anything that looks like a prompt or secret in a response.

**What A3 proves and does not prove.** It proves the whole chain (app, Access, tunnel, worker, proxy, DeepSeek), the first verified provider identity and model, real token usage against the budget, and that each employee's real instructions (up to 17.9 KB) reach the model and shape its reply under a 128-token cap. It does **not** prove accuracy on business data (A4), tool use, multi-turn behaviour or long answers, and it uses none of the live workspace data.

**Known unknowns.** The Chat canary first checks the employee's health and tool-inventory attestation against the Hermes gateway (`requireFreshInventory`); if an attestation is stale it can refuse with "agent unavailable", which would be a readiness finding, not a budget problem. The provider-only canary skips that check. A 128-token cap can end a reply mid-sentence.

## 3. The app release

**Facts (checked 2026-10-30 after `git fetch`).**

- `origin/master` is still `bd843d27`, the source production runs (`m613jymv7` is a rebuild of it). The review branch `integration/hermes-bridge-final` is 13 commits ahead and **0 behind**, so master can be advanced by a **fast-forward** (no merge commit, no conflicts).
- 19 files, +1,473 / -185. **Runtime change: two files, 3 lines added and 3 removed:** `src/server/integrations/hermes/inference-only.ts` (the prompt budget constant and its type, 6,144 to 24,576) and `src/lib/employee-evidence.ts` (a comment). Everything else is the worker service files, the CI workflow, tests and docs. No migrations, no dependency or config change.
- **With the flags off, production behaves identically**: the new constant is read only by the restricted-inference and audit code paths, which both answer 503 today.
- CI on `02875cf3` (all code) was green on both jobs (run 40996733401). The review branch tip `1f5cddd5` differs from it only in two documentation files, and the verification workflow runs only for pushes that touch the worker files, the workflow, its scripts or the lockfile, so a docs-only push correctly starts no run. The green run therefore covers exactly the code that would go to master.
- The workflow file already exists on master (an earlier version); the release updates it. Its jobs run only on the two review branches, so merging it changes nothing on master.
- Public-repository check: the repository is public. I scanned all 1,271 added lines for IPv4 addresses, 32-hex account ids, tunnel and session ids, provider hostnames and email addresses: **none**. The only credential-looking string is `synthetic-key` in a unit test, the same placeholder the existing tests use. The new docs name the production hostname already used publicly, container names and VPS paths.
- Section 6.2 of the D2 proposal first listed production knowledge by section name and size. Because the repository is public, **it was trimmed to its conclusions (done, at your request, before anything goes to master)**: no section names, titles or sizes of production records remain in the documents.

**Options.** (A, recommended) fast-forward `master` to the branch tip: master then matches what runs on the VPS and keeps the CI workflow and tests. (B) a minimal commit with only the two source files and their tests: smaller, but master would still lack the worker service, the CI and the tests the VPS runs from.

**Steps if approved (Option A).**

1. (Done) Section 6.2 trimmed.
2. (Done) The branch tip is pushed to `integration/hermes-bridge-final` (`1f5cddd5`); no further CI wait is needed (see above).
3. Push the branch tip SHA to `refs/heads/master` (explicit SHA, explicit ref; it needs your GitHub sign-in and your explicit authorization, because you authorized exactly one master push earlier and it was used).
4. Vercel builds production (about 5 to 7 minutes). Verify `/api/health`, the audit and canary routes still answer 503, and that the deployment's source is the pushed SHA.

**Rollback.** Redeploy the previous production deployment (`m613jymv7`, source `bd843d27`) with `vercel redeploy ... --target production`; or push a revert commit. The release changes no data, so there is nothing to restore. The VPS side does not need rolling back for this.

## 4. What I need from you (each separate)

1. **App release:** approve Option A or B (section 6.2 is already trimmed).
2. **A3:** approve the scope in section 2 once the release is live; I will restate the price, the model and the 12-call cap at that moment.
3. **DeepSeek account:** confirm it has a balance before A3.

After A3 the next gates are D3, C6 and A4 (business-tool acceptance), then the open items W2, O1, O2, O3 and moving the egress proxy onto the v3 image.

## 5. Status after the release and the first A3 attempt (2026-10-30, later)

- **App release: done.** Production runs master `2e877d24` (the 24 KiB budget). Both authorized master pushes are used.
- **A3 attempt 1 stopped at the first call, as designed.** Operations Manager's provider-only canary returned HTTP 502 ("could not complete the request") after 4.5 seconds. The app discards the worker's error body, so the cause was invisible from the app side. The worker's own log line for that request read `inference_failed` with no model and no tokens, which meant the request reached the worker's runtime and the runner exited with an error.
- **One diagnostic DeepSeek call (founder-approved, from inside the worker, 8 output tokens, no business text):** HTTP 200, a stream, the returned model name was exactly `deepseek-flash`, and usage was present (11 prompt, 1 completion tokens). So the key, the request settings, the model name and streaming usage are all fine. The profile `.env` holds a `DEEPSEEK_API_KEY` entry, the profile config names `deepseek-flash`, and the egress proxy reaches `api.deepseek.com:443`.
- **Root cause.** A no-network container running the real runner against the real profile failed at `_configured_provider` with an `ImportError`: the runner imported `get_env_value_prefer_dotenv` from `hermes_cli.auth`, where Hermes 0.22.5 does not define it (it lives in `hermes_cli.config`). The runner therefore failed before any provider call. The audit path never reaches that import and the pinned smoke drives `AIAgent` directly, so no earlier check exercised it. This is the same class of defect as the missing `Path` import found in the first A2 attempt.
- **Fix, validated against the real pinned runtime with no network:** one import line. With only that line corrected, the runner under Hermes 0.22.5 passes provider configuration, agent creation, the tool and fallback checks and makes exactly one upstream request, stopping only at the post-network check because the container had no network.
- **Prevention:** `RunnerHermesContractTests` (source-level pairs always run; resolving every Hermes import and running `_configured_provider()` run against Hermes 0.22.5), and the CI in-image test step now sets `IACQUIRE_REQUIRE_PINNED_HERMES=1`, so a missing or different Hermes fails instead of skipping. `tests/hermes-runner-contract.test.ts` guards the import and the switch.
- **Calls so far against the 12-call cap:** the failed canary (which never reached DeepSeek, because the runner failed first) and the one diagnostic call.
- **Next, each needing approval:** push for CI (the change touches `services/**`, so CI runs), build image `0.22.5-v4` and recreate the six workers on the VPS, then re-enable the inference flag and resume A3.

### 5.1 Worker roll-out of the fix (image `0.22.5-v4`, approved "Roll out v4"; 2026-10-30)

- **CI first:** run 41013072265 on `6bdbc2ca` was green on both jobs, including the new in-image contract tests (with the require-pinned switch on).
- **Files and image:** the nine service files were fetched from `6bdbc2ca` and checked against hashes computed from the commit; only the Dockerfile label, the compose tags, `inference_runner.py` and `test_worker.py` differed from the installed v3 files. The v3 files are backed up on the VPS. Image `iacquire/hermes-inference-worker:0.22.5-v4` = `1ae81e2a8465` (v3 `72dfd7284a2f`, v2 and v1 kept for rollback).
- **Tests inside the new image, no network, `IACQUIRE_REQUIRE_PINNED_HERMES=1`:** 32 OK, none skipped, including the three Hermes contract tests against the real pinned runtime.
- **The real v4 runner against the real Operations Manager profile, no network, synthetic 11 KB instruction:** it now passes provider configuration, agent creation, the tool and fallback checks and makes exactly one upstream request, stopping only at the post-network usage check because the container has no network (v3 stopped at the bad import).
- **Scope:** a `--dry-run` showed only the six workers recreating; then `up -d --no-build --no-deps` on the six services with the audit flag at its default (off). The egress proxy is untouched and still runs the v1 image.
- **Verified after:** six workers healthy on v4, audit flag false; read-only root, no published ports, user 10000, all capabilities dropped, profile and secret mounts read-only, `/tmp` a 32 MB `nosuid,nodev,noexec` tmpfs; the proxy answers `403 Forbidden` to `CONNECT example.com:443`; the tunnel is attached to all six ingress networks; the running workers hold the budget numbers (24,576 bytes, 20,000 characters, 8,192 input tokens); unauthenticated calls to the public worker routes return 403; `/api/health` is ok.
- **Not touched:** Vercel, Cloudflare, the profiles, master, any DeepSeek call during the roll-out. The `/opt/data` volume is still writable (O3).
- **Calls against the cap so far:** the failed canary (which never reached DeepSeek) and the one diagnostic call.

## 6. A3 results (2026-10-30, 07:27 to 07:33 UTC): all 11 calls passed

**Setup.** Worker image `0.22.5-v4` on the six workers (audit flag off), the production app on `2e877d24` (the 24 KiB budget), and the Vercel flag `HERMES_INFERENCE_WORKER_ENABLED` on only for about 13 minutes (07:20:51 to 07:34:05), then removed and the site redeployed. One call at a time, 15 seconds apart, stopping at the first problem (none occurred). Eleven calls, the approved cap: six provider-only canaries and five Chat canaries. Performance Analyst's Chat canary was call 12 and was not run.

**Recorded by the app's audit rows (provider `deepseek`, model `deepseek-flash`, 0 tool schemas, 0 tool calls, result `success` for every row; exactly 11 rows in the three-hour window):**

| Employee | Provider-only canary, tokens in / out | Chat canary, tokens in / out |
|---|---:|---:|
| Operations Manager | 2,836 / 36 | 2,848 / 48 |
| Lead Hunter | 3,454 / 68 | 3,464 / 106 |
| Sales Assistant | 2,448 / 32 | 2,458 / 58 |
| CRM Manager | 2,372 / 46 | 2,382 / 53 |
| Appointment Setter | 2,403 / 45 | 2,409 / 56 |
| Performance Analyst | 2,393 / 45 | not run |

- **Cost.** 29,467 input and 593 output tokens in total, about **$0.01** at DeepSeek's peak deepseek-flash rates ($0.30 per 1M input, $1.20 per 1M output; the window fell in the 06:00 to 10:00 UTC weekday peak). The estimate in section 2 assumed 3 bytes per token; the measured figure is about 5.2 bytes per token, so real prompts are cheaper than estimated.
- **What the replies showed.** Each provider reply was a short greeting in the employee's own voice that said it had taken no action. Each Chat reply gave one honest way the employee supports iAcquireOS, in line with its role (for example: summaries of authorised tasks for Operations Manager; drafting follow-ups for review for Sales Assistant; proposing record updates for approval, not applying them, for CRM Manager). Nothing invented was found. Performance Analyst said it had no workspace records in front of it. Lead Hunter used an illustrative example assignment, labelled as an example. The no-tool, no-action restrictions held.
- **First verified provider identity:** `deepseek` / `deepseek-flash` for all six employees, with real token usage recorded against the 24 KiB budget (largest prompt used 3,464 tokens, far under the 8,192 ceiling).
- **Findings.** (1) Each call took 17 to 23 seconds, against a 32-second worker limit, a 36-second app limit and a 45-second route limit: the margin is thin for longer prompts or history, so latency should be watched before real chat is routed through this worker. (2) The Chat canary's readiness check against the Hermes gateway did not block any run. (3) The restricted worker accepts the full live instructions (8 to 14 KB) with room to spare.
- **What A3 does not prove.** Accuracy on business data (A4), tool use, multi-turn behaviour and long answers; the 128-token output cap kept every reply short. No live workspace data was sent.
- **Next gates.** D3, C6 and A4 (business-tool acceptance), each needing its own approval; the open items W2, O1, O2, O3 and moving the egress proxy to the current image; and the unrun Performance Analyst Chat canary if wanted.
