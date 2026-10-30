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
- CI on `02875cf3` (all code) was green on both jobs; the three later commits are documentation only. A push to the review branch would rerun CI on the final tip before anything touches master.
- Public-repository check: the repository is public. I scanned all 1,271 added lines for IPv4 addresses, 32-hex account ids, tunnel and session ids, provider hostnames and email addresses: **none**. The only credential-looking string is `synthetic-key` in a unit test, the same placeholder the existing tests use. The new docs name the production hostname already used publicly, container names and VPS paths.
- Section 6.2 of the D2 proposal first listed production knowledge by section name and size. Because the repository is public, **it was trimmed to its conclusions (done, at your request, before anything goes to master)**: no section names, titles or sizes of production records remain in the documents.

**Options.** (A, recommended) fast-forward `master` to the branch tip: master then matches what runs on the VPS and keeps the CI workflow and tests. (B) a minimal commit with only the two source files and their tests: smaller, but master would still lack the worker service, the CI and the tests the VPS runs from.

**Steps if approved (Option A).**

1. (Done) Section 6.2 trimmed.
2. Push the branch tip to `integration/hermes-bridge-final` first so CI runs on the final commit; wait for green (about 30 minutes).
3. Push that same SHA to `refs/heads/master` (explicit SHA, explicit ref; it needs your GitHub sign-in and your explicit authorization, because you authorized exactly one master push earlier and it was used).
4. Vercel builds production (about 5 to 7 minutes). Verify `/api/health`, the audit and canary routes still answer 503, and that the deployment's source is the pushed SHA.

**Rollback.** Redeploy the previous production deployment (`m613jymv7`, source `bd843d27`) with `vercel redeploy ... --target production`; or push a revert commit. The release changes no data, so there is nothing to restore. The VPS side does not need rolling back for this.

## 4. What I need from you (each separate)

1. **App release:** approve Option A or B (section 6.2 is already trimmed).
2. **A3:** approve the scope in section 2 once the release is live; I will restate the price, the model and the 12-call cap at that moment.
3. **DeepSeek account:** confirm it has a balance before A3.

After A3 the next gates are D3, C6 and A4 (business-tool acceptance), then the open items W2, O1, O2, O3 and moving the egress proxy onto the v3 image.
