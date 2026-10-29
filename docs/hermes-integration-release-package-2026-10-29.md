# Hermes integration: consolidated release package (2026-10-29)

One integration branch, `integration/hermes-bridge-final`, built on production master. **Nothing in it is deployed.** No push to `master`, no production deployment, no Cloudflare or VPS change, no live profile change, no DeepSeek call and no business-tool activation has been made. Every step after this document needs its own explicit approval (section 9).

## 1. What is actually current (read 2026-10-29)

The brief's starting point was out of date, so this was re-read rather than assumed.

| Item | State |
| --- | --- |
| Production `iacquire.online` | `master` **`7d411f25`**, Vercel `dpl_CKmCcLjUNARx8aSaRQTPDqG1nmBF` (`iacquire-dashboard-d2n7hvc05`), Ready, target production |
| `/api/health` | `{"status":"ok","database":"ok","scheduler":"never_ran"}` |
| Why not `50da121a` | `50da121a` was the previous production deployment (`dpl_6CByKwLmcn9pqavvfG2ZQhhjT2v7`, `iacquire-dashboard-hgt3cwaas`). The two wording fixes were then deployed at the founder's approval, so `master` moved to `7d411f25`. `fix/chat-quality-polish` is at `c3c8d079` (documentation on top of `50da121a`) |
| Key Chat regressions, re-run in the real signed-in Chat today | Zeng: "Company knowledge is only partly supplied: 3 of 9 sections", offers only a real request and says it cannot start it. Appointment Setter: "That's not the same as an empty week; nothing could be checked", no "Nothing is booked", no unavailable promise. Earlier today, after the wording deployment: Performance Analyst explanation (plain words, no card) and the explicit KPI card; Lead Hunter, Sales Assistant, CRM Manager correct; no record, approval or message created |
| Origin branches | `codex/internal-iacquire-activation` `fe40f7e4` (not touched); `integration/hermes-business-bridge` `77038458` (my earlier branch, now superseded); other `codex/*` branches not touched. `codex/prompt-audit-final-ci` `fd610fa9` exists **only locally** in another worktree and is merged into the final branch |

**Production rollback anchor for this release:** the current deployment `dpl_CKmCcLjUNARx8aSaRQTPDqG1nmBF`. If the candidate is deployed and has to be undone: `vercel rollback iacquire-dashboard-d2n7hvc05-mlester999s-projects.vercel.app --project iacquire-dashboard`. Behind it, in order: `iacquire-dashboard-hgt3cwaas` (`50da121a`), `iacquire-dashboard-j0v7x7co9` (`eac5070f`).

## 2. The single integration branch

Two integrations were in flight: mine (`integration/hermes-business-bridge`, with the C1, C8, C9 fixes) and the other session's local `codex/prompt-audit-final-ci` (the bridge plus a no-call prompt-size audit and CI changes, built on the same master). They were reconciled, not duplicated: `integration/hermes-bridge-final` starts from mine and merges theirs without a conflict.

| Contents on top of production master | Source |
| --- | --- |
| The isolated v0.22.5 inference worker, the restricted canary and Chat routes, the MCP business endpoint, per-role tool policy, tool tokens and approval changes, inventory verification | `codex/internal-iacquire-activation` `fe40f7e4` |
| The no-call prompt-size audit (route, client, worker mode, pinned-runtime smoke, tests) and its CI | `codex/prompt-audit-final-ci` (`89ea940a`, `b9422e47`, `fd610fa9`) |
| C1, C2, C5, C8, C9 fixes and tests; the generalized CI workflow and known-failures guard; the policy change taken back out (C10) | this session |

**Nothing from production master was lost.** Master is an ancestor of the branch, no file is deleted, and the only lines removed from existing code are: the rate-limit line in the chat service (now conditional for the restricted path), and a handful of lines in the tool-token, tool-service, inventory and provisioning code that the bridge gates behind `HERMES_BUSINESS_MCP_ENABLED`. The approved Chat quality, hardened snapshot, booking-intent and wording changes are unchanged and covered by the suite.

## 3. Findings and their state on the final branch

| # | Finding | State |
| --- | --- | --- |
| C1 | Role-context tool re-implemented every role's reads as the system role | **Resolved.** It returns the same verified snapshot chat gives the employee (`prepareEmployeeEvidence`), read as the person asking: honours switched-off abilities, per-area time limits, the empty / not set up / could not be read / no permission / switched off states; refuses anyone who is not an internal Super Admin; takes no arguments; audit holds area names and states only. End-to-end test through the real MCP handler (8 cases); 5 of the first 7 fail on the original tool |
| C2 | MCP SDK adds about 65 install-time packages | **Resolved as a measured decision.** None is traced into the endpoint's function bundle (the SDK is inlined in one chunk of about 402 KB), `npm audit` shows zero vulnerabilities in production dependencies, and a test keeps the imports to the server class and the web-standard transport and the version pinned exactly |
| C3 | One key (the profile API key) authenticates both directions | **Open, design recommended, not implemented** (section 7). Confirmed by the provisioning preview, which sets the MCP entry's bearer to `${API_SERVER_KEY}`, the profile's own API key |
| C4 | The "oldest agency organisation" subquery is repeated in several places | **Open, low.** Planned: one helper with a test that a second agency workspace never inherits access |
| C5 | Tool results as prompt-injection boundary | **Resolved for the bridge.** Every tool description and every structured result carries the records-are-data rule first (so a result cut at the size limit keeps it), and free text comes through the snapshot's bounding. SDK-level argument-validation errors are the SDK's own text and carry no record data |
| C6 | Hermes v0.21.5 loading an MCP server entry and the inventory's expected `mcp__iacquire_business__<tool>` naming | **Unverified, blocking for tool acceptance only** (the branch's own provisioning preview carries the same caveat: "verifying the installed Hermes runtime supports Streamable HTTP MCP"). An attempt to read Hermes's own MCP client source was rate-limited by GitHub (HTTP 429) and the pinned tag path returned 404, so naming and provenance compatibility are not established (section 7) |
| C7 | The worker's 6,144-byte effective prompt budget | **Measured; the no-call audit is now the measurement path** (section 6). On instruction bytes alone five roles fit with 104 to 391 bytes to spare and Lead Hunter is 4,872 over (default configuration); the worker also adds the SOUL and message wrapping, so the audit decides. A decision is needed before any real-model canary (section 9, D2) |
| C8 | Private copy of the "runtime online" SQL | **Resolved.** The active-run query uses `runtimeReadySql` (the single definition; stricter: it also checks the recorded inventory and an unrevoked credential) |
| C9 | Unbounded request bodies in new authenticated routes | **Resolved for all three restricted routes** (`canary`, `chat`, `prompt-audit`): `readBoundedJson` with a 1 KB ceiling, enforced while the body arrives. The repository guard is unchanged and passes; a test pins the three routes to the bounded reader. No exception was added |
| C11 | **New, low.** `buildInternalAgencyConfigYaml` changes the provisioning bundle's config preview for internal agency employees even with the flag off (it lists the safe toolsets plus a `no_mcp` line instead of the default preview). It is a preview only: nothing applies it, and the live profiles are not read or changed | Reviewed. The exact diff against each live profile file is part of A4's pre-change review, not of A0 |
| C10 | **New.** The bridge branch edited the live immutable agency policy and bumped both policy versions | **Taken out of the candidate.** `composeRunInstructions` applies the current policy to every run for every workspace, so it would change the live prompt of all six internal employees and every client employee the moment the candidate is deployed, with no flag, outside the approved Chat quality set, and about 290 bytes more per run (worse for C7). `policy.ts` and two version assertions in `workforce-config.test.ts` are back to master's. Its intent is already carried by the approved snapshot rules. If the founder wants it, it is a separate decision (D1) |

## 4. Checks on the exact final candidate

Code candidate `8122d3e8` (everything but this document). The branch tip that is pushed is this document on top, which changes no code.

| Check | Result |
| --- | --- |
| Full test suite (Windows, 16 threads) | 713 files, 11,202 tests: **11,191 passed, 9 failed, 2 skipped.** All nine failing files are the recorded known set below; the guard script confirms no other failure |
| TypeScript, app and scripts | Pass (`tsc --noEmit` for the app configuration and for the scripts configuration, no errors) |
| ESLint, whole repository | 0 errors, 3 warnings (two already on production in `src/server/aqi/service.ts`; one unused `err` in the restricted inference path of `src/server/chat/service.ts`, from the bridge branch) |
| Production build (`next build`, Next 16.4.2) | Pass: compiled successfully (25 s) and all four bridge routes are in the build (`hermes-business/mcp`, `hermes-inference/canary`, `chat`, `prompt-audit`). The nested integration worktree cannot build on its own (it cannot find `next`), so the build was run from the parent worktree checked out detached on the same commit |
| Worker smoke, no-call prompt audit smoke, worker unit tests, Compose isolation | **Not runnable here** (no Docker in this workspace). Run by the Linux CI workflow on the pushed branch (`ubuntu-24.04`, pinned Hermes v0.22.5 image, network disabled): see section 8 |
| Synthetic prompt audit | The parsing and policy tests (`tests/hermes-prompt-audit.test.ts`) pass locally; the pinned-runtime prompt audit smoke runs in CI |
| Full suite on Linux | In the same CI run (job `app-checks`: whole suite offline, judged against the known failures, then TypeScript, lint and the build) |

### Remaining failing tests and their classification

Nine files fail. All nine fail identically on production master before this work; none is touched by, or related to, the employees, Chat, Hermes or the bridge. The CI guard (`.github/scripts/known-failures.mjs`) allows exactly these nine and fails on anything else.

| File | What fails | Since |
| --- | --- | --- |
| `tests/appointments.test.ts` | Appointment reminders keep being planned after the owner switches them off | clean production `d4adb4fd` |
| `tests/automation-studio-hardening.test.ts` | Usage metering counts every failed attempt of a given-up run | `d4adb4fd` |
| `tests/chat-rail.test.tsx` | The chat rail wordmark text is not found | `d4adb4fd` |
| `tests/demo-showroom-controls.test.tsx` | The showroom rail folds to 76 px, not the asserted 68 px | `d4adb4fd` |
| `tests/messaging-core.test.ts` | The 30-day per-contact allowance at planning and send time | `d4adb4fd` |
| `tests/staff-workload-views.test.ts` | A dated item does not appear on the team calendar on its day | `d4adb4fd` |
| `tests/type-scale-floor.test.ts` | 14 existing arbitrary text sizes below 12 px | `d4adb4fd` |
| `tests/workforce-navigation.test.tsx` | The sidebar wordmark through the shared Logo | `d4adb4fd` |
| `tests/email-render.test.ts` | The invitation email expects the old logo URL | the email-branding commit `a8708414` |

The two guard-test failures the first integrated run showed (`employee-runtime-single-definition`, `upload-bodies-bounded`) were this branch's own and are fixed (C8, C9).

## 5. Normal Chat and the six profiles are preserved

- No stored configuration, SOUL file, acknowledgement or knowledge entry is read or changed by the candidate, and no migration is included.
- The live agency policy text and versions are unchanged (C10), so no employee's run instructions change at deploy time beyond what is already in production.
- The restricted Chat path is a separate, fixed-message route reachable only by an internal Super Admin with `HERMES_INFERENCE_WORKER_ENABLED` on; the normal Chat path is the same code as in production apart from that branch.
- With the three flags off (their default), the MCP endpoint answers 404, the inference and audit routes refuse, and the inventory and tool-token changes behave as before.

## 6. Six-role offline prompt audit plan

Purpose: know, per employee, whether the exact prompt the pinned worker would send fits the 6,144-byte budget, before any provider is called.

**Stage 0, done here (a floor, not a forecast).** Run instructions per role on default configuration with the three approved agency knowledge sections, on the final code:

| Role | Run instruction bytes | With the chat canary (142 bytes) | Headroom against 6,144 |
| --- | --- | --- | --- |
| Zeng (operations manager) | 5,699 | 5,841 | 303 |
| Lead Hunter | **10,874** | 11,016 | **-4,872** |
| Appointment Setter | 5,785 | 5,927 | 217 |
| Sales Assistant | 5,898 | 6,040 | 104 |
| CRM Manager | 5,666 | 5,808 | 336 |
| Performance Analyst | 5,611 | 5,753 | 391 |

The provider-only canary message is 105 bytes. An earlier measurement on the bridge branch as it stood (with the extra policy rule, C10) was about 290 bytes higher per role; with that rule left out, five roles fit on instruction bytes alone and only Lead Hunter is over. These are the app's instructions only: the worker adds the SOUL and Hermes's own message wrapping, so the effective prompt is larger, and only the audit can say by how much.

The real applied configurations and the SOUL files were not readable from here, so these figures are a floor for the instruction text, not a forecast of the effective prompt.

**Stage 1, the no-call audit on the worker (needs approvals A0, A1, A2).** For each of the six roles, as the internal Super Admin, `POST /api/internal/hermes-inference/prompt-audit` with the role. The app reads the role's real applied instructions, the worker loads only that role's read-only SOUL, and the pinned Hermes `AIAgent` builds the real provider messages twice against a synthetic loopback listener. The audit child gets a synthetic key, no DeepSeek credential and no proxy setting, and the worker refuses to run if it finds either. It returns only byte counts and identity: `appInstructionBytes`, `soulBytes`, `providerOnlyMessageBytes`, `chatMessageBytes`, `syntheticProviderRequests` (must be 2), `promptLimitBytes` (6,144), `hermesVersion`, with `toolSchemas`, `toolCalls` and `deepseekCalls` all 0.

**Record and decide.** One row per role. Pass for a role when both message sizes are at or under 6,144. If any role is over, no canary runs until D2 is decided. The audit is switched off (both flags) after the six measurements.

## 7. Credential separation and MCP compatibility (reviews)

**C3, credential separation.** The MCP endpoint accepts the employee's own profile API key. That key also authenticates the portal to Hermes, so one secret carries both trust directions. The exposure is bounded (a call also needs that employee's own live, authenticated Chat turn), but it is avoidable. Recommended design, not yet built: a server-only secret `HERMES_BUSINESS_MCP_SECRET`; the MCP bearer for a profile is `<profile id>.<HMAC-SHA256(secret, "iacquire-mcp:" + profile id)>`; the portal verifies by recomputation in constant time; the Hermes profile holds that derived token, never the API key; rotating the secret revokes every token. The profile key then no longer opens the endpoint and a leaked MCP token cannot call Hermes. It touches the authentication path, so it should be built with its own tests and must be in place before the MCP entry is added to any profile (A4), not before the flags-off deployment (A0).

**C6, MCP compatibility.** Unverified. The proof must not touch the six live profiles: a throwaway profile on the existing v0.21.5 gateway with the MCP entry, pointed at a staging copy of the endpoint, checking that (1) the gateway loads the entry, (2) the tool inventory reports the tools with the provenance the verification expects (`source: mcp`, server `iacquire_business`, toolset `mcp-iacquire_business`) and the names it expects, and (3) one authenticated read works. A throwaway profile cannot authenticate against the production endpoint (the endpoint accepts only the six registered internal employees), so this needs a staging endpoint or a Docker harness with the Hermes v0.21.5 client in CI. Until it is proven, the business-tool stage (A4) does not start.

## 8. Worker infrastructure preflight

None of this was checked by me; it is the other session's read-only snapshot (recorded in `services/hermes-inference-worker/DEPLOYMENT.md`, 2026-10-29) plus what the plan still requires.

| Item | Recorded state | Still to do before installation |
| --- | --- | --- |
| Gateway and tunnel | Hermes Agent v0.21.5, cloudflared 2026.10.1; the tunnel is token-managed with no local configuration | Inspect, in the authenticated Cloudflare account, the current route order and that the Access service-token policy covers the six new paths. This was **not** verifiable by the other session either |
| Profiles | Six profile directories map to the six roles; all resolve to DeepSeek with `deepseek-flash`, provider credentials configured (identifiers and booleans only were read) | Confirm each is readable by UID/GID 10000:10000 through its own read-only mount; do not broaden permissions |
| Capacity | 6.1 GiB memory available, 88 GiB disk free; the plan caps six workers at 3 GiB total plus 64 MiB for the proxy | Re-check immediately before installation |
| Running state | No worker or proxy containers; no signing secret yet | Create the secret at install, mode 0400, readable by 10000:10000, never printed |
| Vercel | Hobby with Fluid Compute; the routes declare `maxDuration = 45`; no worker variables set in production | Re-check; set the URL, secret and flags only at A2 |
| CI evidence | The other session reports its worker CI run passing on an earlier commit (synthetic provider only) | Read the run for this candidate's tip (below) |

**CI for this candidate.** The workflow was generalized (not duplicated) so it can run for this branch: it checks the candidate contains production master, the worker candidate and the no-call audit commit, then runs two jobs in parallel on `ubuntu-24.04`: `app-checks` (whole suite offline, judged against the nine known failures, TypeScript, lint, production build) and `worker-build-and-smoke` (pinned image build, pinned runtime smoke, no-call prompt audit smoke, worker unit tests with the network disabled, Compose isolation: six one-profile workers, no published ports, only the proxy has external egress). It triggers on a push to the review branch only and never targets production.

## 9. Staged approval requests

Each stage is separate, has its own rollback, and stops on any failure. Nothing proceeds on a later stage because an earlier one was approved.

**Decisions first**

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Keep the extra agency policy rule (C10) out of this release? | Yes, keep it out; decide it separately if wanted |
| D2 | How to handle the 6,144-byte budget (C7) | Decide after the audit numbers. If any role is over: send the canary a purpose-built short instruction and keep the cap and its cost bound; the alternative is to raise the cap deliberately with a priced limit |
| D3 | Build the derived MCP credential (C3) | Yes, before A4 |
| D4 | Host and workspace time zone | See section 10 |

**A0. Deploy the candidate with every flag off.** Fast-forward `master` from `7d411f25` to the branch tip, no force; Vercel builds production. No migration, no environment change, no VPS or Cloudflare change. Intended effect on production: none. Check after: `/api/health`, the six-employee Chat regression questions, and that the three bridge routes refuse. Rollback: the anchor in section 1. Adds one pinned build dependency (the MCP SDK, audited).

**A1. Controlled infrastructure installation, inference disabled.** Build the pinned image on the VPS, create the signing secret, start the six workers and the proxy with the exact read-only profile mounts, confirm no published ports and one profile mount each, confirm unrelated `CONNECT` destinations are denied, attach the tunnel connector to the six ingress networks, add only the six anchored routes under the existing Access policy. No gateway restart, no firewall change. Rollback: the sequence in `DEPLOYMENT.md` (flags off, remove the six routes, disconnect the connector, stop only the worker services and proxy, remove the secret). Preconditions: the Cloudflare inspection above.

**A2. No-call prompt audit.** Set in Vercel `HERMES_INFERENCE_WORKER_URL`, `HERMES_INFERENCE_WORKER_SECRET` and `HERMES_PROMPT_AUDIT_ENABLED=true` (keep `HERMES_INFERENCE_WORKER_ENABLED=false`), and `IACQUIRE_HERMES_PROMPT_AUDIT_ENABLED=true` on the workers; run the six audits (section 6); record the table; switch both audit flags off. No provider call is possible: the audit child has no credential and no proxy.

**A3. Real-model canaries (separate approval, after D2).** One fixed provider-only request per employee, then one fixed no-tool Chat canary per employee through the normal authenticated Chat view, sequentially, at most 12 calls, 128 output tokens each, input inside the budget. Records provider, model and actual token usage per employee: this is the first verified provider identity. DeepSeek pricing must be re-read at approval (not checked here). Inference flag off afterwards.

**A4. Role-specific business-tool acceptance (separate approval, after D3, C6 and A3).** Record each profile file's hash and prepare a reviewed diff and restore copy before adding the MCP entry; one authorized read per employee against the internal workspace, writes off. Autonomous work, outreach, live bookings, schedules and writes stay off.

## 10. Next milestones (after the worker and tools)

**Internal consultation calendar.** Prepared, not applied (`src/lib/internal-consultation-calendar.ts` and its test). The time zone must be resolved first: read-only checks show Mark's host availability time zone is **UTC** and no hours are set, and the employees report in **UTC** ("this week, Oct 26 to Nov 1, UTC"), so the workspace time zone is UTC as well. The desired zone is Asia/Manila. Two production settings change (the workspace time zone and the host's availability time zone), which also moves the employees' "this week" boundaries, so they need approval before the calendar is created. Still needed from the founder: the buffer after (not before) each call, the calendar and appointment names, whether each booking needs a person's confirmation, and registering the Google app (a platform credential) before any Meet link.

**Client automatic provisioning.** The automated controlled-client test passes (six isolated Pending Setup employees, client-owned and honestly partial knowledge, unmet requirements reported, no cross-tenant data). A real controlled client and the VPS profile provisioning for it need their own approval.
