# D3 and C6 release readiness (2026-10-31)

**A recommendation with evidence. The review branch is pushed (`master` is not touched); nothing is deployed, applied or switched on.** No production setting, secret, flag, profile, database or customer record was changed; no model was called. The repository is public: this file names no address, account or identifier. The security findings behind some of the gates, and the exact change packages for the remaining stages, are in private reports that are not in this repository.

Labels used: **Complete**, **Verified Locally**, **Verified Against Pinned Runtime**, **Production-Verified**, **Blocked**, **Requires Approval**.

## 1. Implementation versus deployment

| Item | Built | Evidence | On production now | Label |
| --- | --- | --- | --- | --- |
| Six inference workers (A1, A2) on `0.22.5-v4` | yes | CI green on the commit that built it; isolation checked on the host | six workers healthy, proxy on the older `v1` image (harmless drift) | **Production-Verified** |
| Real-model canaries (A3): 11 calls across the six employees | yes | 11 audit rows, all success, DeepSeek `deepseek-flash`, zero tool calls | the inference flag is off again | **Production-Verified** (dormant) |
| D3: signed, profile-bound business MCP credential; profile key refused | yes | 68 tests on a seeded database (credential 29, authentication 39), mutation checks | **no**: production runs the code from before D3 (flag off, so the endpoint answers 404) | **Verified Locally** |
| C6: real Hermes 0.21.5 gateway and MCP client against the real handler | yes | **39 of 39 checks** on Windows (a fresh runtime rebuilt from nothing); passed on Linux CI at `a276c967` (38 checks) and again at `0b0b3bb8` (the file now holds 39, including the credential scan) | the production gateway's version, `mcp` package and all eight overlay files were read-only-matched to the tested ones on 2026-10-30; it was not asked to discover or call a tool | **Verified Against Pinned Runtime** |
| Business tools in production (A4a) | prepared | see `hermes-a4a-acceptance-plan-2026-10-31.md` | off | **Requires Approval**; **Blocked** by the gates below |
| O2: workers mount a worker-only profile view | yes | 34 behavioural and 12 static tests, 7 mutation checks, and the real worker path against the pinned 0.22.5 source (identical results; an `mcp_servers` entry is inert) | not applied (the VPS still mounts whole profiles) | **Verified Locally**, **Verified Against Pinned Runtime** (0.22.5, Windows) and **green on Linux CI at `0b0b3bb8`** (the O2 unit tests inside the full suite and the three O2 worker steps, section 3.1) |
| A4a evidence tool (read-only before/after comparison) | yes | 18 tests; checked against what the real handler writes | n/a (run only inside the approved window) | **Verified Locally** |
| O1: gateway port reachable from the internet | analysis and runbook (private) | externally re-verified today | **present** | **Blocked**; **Requires Approval** |
| Client provisioning | service and states built | sandbox pass (2026-10-24), not re-run on this commit | **nothing client-side exists on production** | **Verified Locally** / sandbox only; see `client-provisioning-dependencies-2026-10-31.md` |

## 2. What the release contains

Review branch against `master` at `0b0b3bb8`: 41 files, +5,865 / −160 (`git diff --shortstat`). `master` (`d89e5031`) is an ancestor of the branch tip, so the release is a fast-forward: no merge commit and no conflict to resolve. **No database migration** (none is needed or proposed), **no dependency change** (the lockfile is untouched; `package.json` gains one script line, `hermes:business-mcp-token`).

Source that can reach the production runtime: `src/server/env.ts` (optional new variables, checked at boot only when the endpoint is switched on), `src/server/workforce/hermes-business-mcp.ts` and the new `hermes-business-mcp-credential.ts` (the endpoint's authentication), `src/server/integrations/hermes/inventory.ts` (the tool-inventory verifier: a server-name alias tolerated only while the bridge is on for the role, and anything that presents itself as MCP must carry MCP provenance), `src/server/workforce/provisioning.ts` (the preview names the dedicated credential variable). The issuing module and the A4a evidence module are imported only by scripts and tests, never by a route or page. Everything else is tests, scripts, services (worker view, smokes), the workflow and documents.

**What changes on production when this is deployed with every flag off:** nothing observable. The business endpoint stays a plain 404, the inference and audit routes stay 503, no employee, profile, schedule or setting changes. The one behavioural difference is the inventory verifier: it is stricter about tools that claim MCP provenance, and the six employees have no MCP tools today.

## 3. Verification

Run on 2026-10-31 on the Windows development machine, on the review branch's working tree, against synthetic data only, with the commands CI uses. The commit under test is `bbbe9ceb` plus two later edits (a fake-`docker` location fix in the O2 test so it runs under CI's `noexec` temp directory, and one trailing blank line removed from `tests/support/c6-runtime.ts` because CI's `git diff --check` flagged it); the rest of what changed afterwards is documents. Dependencies were reinstalled from the lockfile first (`npm ci`), because this worktree's `node_modules` pre-dated the MCP SDK dependency.

| Check | Result |
| --- | --- |
| Full test suite (`--pool=forks --maxWorkers=2`) | **726 files: 716 passed, 9 failed, 1 skipped. 11,399 tests passed, 10 failed, 42 skipped.** 39 minutes |
| Judged against the recorded baseline (`.github/scripts/known-failures.mjs`) | **`KNOWN_FAILURES_ONLY`: the 9 failing files are exactly the 9 that already fail on production `master`** (`appointments`, `automation-studio-hardening`, `chat-rail`, `demo-showroom-controls`, `email-render`, `messaging-core`, `staff-workload-views`, `type-scale-floor`, `workforce-navigation`); every one still fails as recorded; **no new failure, and none was hidden or removed** |
| Against the D3/C6 run of 2026-10-30 (723 files, 11,334 passed, 10 failed, 40 skipped) | +3 files, **+65 passing tests = the new ones** (A4a evidence 18, profile-view 34, profile-mounts 12, one new write-surface test in the capability matrix); the 2 extra skips are a POSIX-only permission test and the new C6 check, which needs a runtime |
| D3 and MCP tests in that run | credential 29, authentication 39, capability matrix 21 (with the new write-surface check), inventory, context, provisioning and policy tests: all pass |
| C6 pinned-runtime compatibility (real Hermes 0.21.5 plus overlay, rebuilt from nothing today) | **39 of 39 pass** in 313 seconds, including the new check that scans 2,721 files (28.8 MB) written by the real gateways and clients for any credential, signing secret or gateway key (none outside the profile `.env` files). The same proof passed on Linux CI at `a276c967` (38 checks) and at `0b0b3bb8` (section 3.1). The file is skipped in the full suite, as designed, because it needs the runtime |
| O2 against the pinned Hermes 0.22.5 source (real worker path, offline, loopback only) | the audit is identical with and without an `mcp_servers` entry in the copied config (about 9 s each), with no connection to the entry's address and no start of its command (both detectors shown to fire); a view built by the real script from planted secrets completes an audit through the real runner; run locally from scratch scripts; the two CI smokes ran on Linux at `0b0b3bb8` and passed (section 3.1) |
| TypeScript (app and scripts) | **0 errors**, run on the final test files |
| ESLint, whole repository | **0 errors, 3 warnings** (the same three as before this work: two in `src/server/aqi/service.ts`, one in `src/server/chat/service.ts`) |
| Production build (`next build`) | **succeeded** (exit 0, compiled in 29.7 s); the business MCP, inference canary, inference chat and prompt-audit routes are all in the output |
| Workflow file | YAML parses, every `run:` block passes `bash -n`, the embedded Python compiles |
| `git diff --check` against the base the workflow uses | clean after the one fix above |
| Mutation checks (each protection removed in turn) | the 7 O2 protections: all caught; the D3 protections: caught in the earlier phase |
| Migrations | none required, none proposed |

### 3.1 Linux CI on the release commit (GitHub Actions, 2026-10-31, commit `0b0b3bb8`)

| Run and job | Result |
| --- | --- |
| *Pinned Hermes 0.21.5 business MCP proof*, run 41186800540 | **success**, 4 min 52 s, on Linux: Hermes 0.21.5, `mcp` 2.0.0, Python 3.13.14; the evidence step lists the six role inventories with `platform: linux` |
| *Synthetic worker isolation and app checks*, run 41186800262, job *Build pinned Hermes worker and run synthetic checks* | **success**, 14 of 14 steps, 1 min 54 s, including the three O2 steps (an `mcp_servers` entry is inert for the worker; a worker-only view built by the real script runs through the real worker path; Compose refuses the old variable) |
| Same run, job *Full tests, TypeScript, lint (offline) and production build* | **success**, 38 min 39 s; every step succeeded: the guard, the install, **the full test suite, TypeScript and lint with the network disabled**, and **the production build** |
| Vercel build of the same commit | success (a Preview, not production) |

*What the full-suite step proves.* One step runs the whole suite offline, judges it with the baseline comparator (`.github/scripts/known-failures.mjs`), runs `npm run typecheck` and `npm run lint`, and exits non-zero if any of these fails: a failing test file outside the nine recorded failures of production `master`, a TypeScript error, or a lint error. It succeeded, so on Linux there is **no regression** (no failing file outside the nine baseline files), **TypeScript is clean**, **lint has no errors** (the run's annotations show the same three old unused-variable warnings), and **the production build succeeds**. Whether each of the nine baseline files still fails on Linux is only informational for the comparator and appears only in the job log. The exact counts in the table above (726 files, 11,399 tests passed, 10 failed, 42 skipped) are from the Windows run: GitHub shows job logs only to signed-in users, so this record states the Linux conclusions, not Linux counts.

*First attempt.* The first push of this tree (`84899d5f`) passed the C6 proof and the worker job, but the full-suite job stopped at its first check (`git diff --check` with git's default whitespace rules) because 127 lines added by the D3 commit carried Windows line endings, and the earlier push of that commit had not started this job. `0b0b3bb8` converted exactly those lines (whitespace only) and documented the check; none of the later commits had introduced a flagged line.

## 4. Other agents and changed files

No uncommitted change in any worktree present on this machine (58 checked on 2026-10-31 against the 41 release files) touches a file of this release, and no other branch has a commit newer than this one (re-checked after the second push); `master` has not moved. The main checkout's own local `master` is hundreds of commits behind `origin/master`: nothing should be built or deployed from it. Two stale branches (the other assistant's older activation branches) contain an earlier version of `hermes-business-mcp.ts` that predates D3 and the bridge integration: if one of them were merged it would undo D3's authentication change in that file. The rule to put in front of any assistant working on this repository: do not merge or push those branches, and re-read this file's history first. The other Claude session in this repository is idle.

## 5. Public-diff hygiene

The added lines of the whole review-branch range (6,032 lines and 165 commit-message lines at `0b0b3bb8`) and every tracked text file at that commit were scanned for hostnames, addresses (IPv4 and IPv6), account, tunnel and project identifiers, e-mail addresses, private keys, API-key, token and webhook-secret patterns and 64-hex strings, and for an exact list of private values that is kept outside the repository: **nothing the range adds or touches matches the private list.** The few lines in the range that match a generic token pattern are synthetic by design (planted test secrets in the O2 test and workflow). The matches in older tracked files are test fixtures and detection patterns, reviewed one by one; findings about older files are in the private report, not here. Two earlier documents were trimmed for the public history: the account-event narrative and the exact port details in `hermes-a4-blockers-proposal-2026-10-30.md` are now generic, with the detail kept in the private report. Before any push to `master`, re-run this scan on the exact commit.

## 6. Rollback

- **Application code:** redeploy the current production deployment (the build of master `d89e503` that has been live since 2026-10-31 03:16 UTC) from the deployment list: `vercel redeploy <that deployment> --target production`. Verify afterwards that the live alias points at a deployment created after the redeploy, and that `/api/health` is ok.
- **Runtime configuration:** this release changes none (no variable, no flag, no VPS or Cloudflare setting), so there is nothing to roll back there. Later steps carry their own rollbacks: `services/hermes-inference-worker/DEPLOYMENT.md` (the worker view) and section 9 of the A4a plan (the kill-switch ladder).

## 7. Settings the later stages need (names only)

| Where | Name | When |
| --- | --- | --- |
| Deployment environment | `HERMES_BUSINESS_MCP_SECRET` (sensitive; 32 to 512 characters, no whitespace, different from every other secret) | A4a, flags off, after a quiet day on the account |
| Deployment environment | `HERMES_BUSINESS_MCP_ENABLED` | only inside the supervised window |
| Deployment environment | `HERMES_BUSINESS_MCP_WRITES_ENABLED` | never in this plan (stays off) |
| Deployment environment | `HERMES_BUSINESS_MCP_SECRET_PREVIOUS`, `HERMES_BUSINESS_MCP_REVOKED_TOKEN_IDS` | rotation and single-credential revocation only |
| Gateway host, one profile | `IACQUIRE_BUSINESS_MCP_TOKEN` in the profile's `.env`, and the `mcp_servers.iacquire_business` entry in its `config.yaml` | A4a, Zeng only, installed by the owner at the console |
| Gateway host, compose | `IACQUIRE_WORKER_PROFILE_BASE` (required; the worker view, never the live profiles) | the O2 stage |

## 8. Feature flags: all must be off, and how that is checked

`HERMES_BUSINESS_MCP_ENABLED`, `HERMES_BUSINESS_MCP_WRITES_ENABLED`, `HERMES_INFERENCE_WORKER_ENABLED`, `HERMES_PROMPT_AUDIT_ENABLED` and the scheduler are off or absent on production as of 2026-10-31 04:53 UTC (read by name through the deployment provider's read-only API; values are never read). They are checked by name before and after every stage, and a variable created by anyone else is a stop condition.

## 9. Production smoke tests after a release, and the emergency checks

1. `GET /api/health` answers 200 with the database ok and the scheduler `never_ran`.
2. An unauthenticated `POST` and `GET` to `/api/internal/hermes-business/mcp` answer 404 (the endpoint is off); a request with a Hermes profile key also 404, never 401, because the switch is checked first.
3. Signed in as a Super Admin: the prompt-audit and canary routes answer 503 "disabled"; one ordinary Chat message to one employee completes.
4. The account's recent events show only the release and its aliases; no variable changed.
5. **Emergency stop checks** (each is one step, section 9 of the A4a plan): disable an employee in the portal and confirm the next business call is refused; remove `HERMES_BUSINESS_MCP_ENABLED` and confirm a 404 after the redeploy.

## 10. Recommendation

**Release of the D3/C6 code in dormant state: technically GO** (Linux CI is complete, section 3.1; `master` is an ancestor of the branch tip), subject to your authorization of one `master` fast-forward. It carries no migration, no dependency, no flag and no production setting, the verification below holds, and it makes a mistaken enabling of the endpoint safer (the profile key stops working there). It also has **no benefit until the A4a gates are met**, so it can wait, and the safer order is accounts, then O1, then the release: a deployment by another assistant of an older build can silently undo it, as happened on 2026-10-30.

**A4a: NO-GO** today (`hermes-a4a-acceptance-plan-2026-10-31.md`, section 2): the account trust gate, O1 and the release are open, O2 is built but not applied, and the signing secret does not exist.

## 11. Residual risks

1. The credential lives in each profile's `.env`: whatever can read a profile directory can read it. O2 removes the workers; O1 removes the internet; root on the host remains, by design.
2. The environment-level switches take one deployment (about 5 to 7 minutes). The immediate stops are the database-level ones (disable the employee, pause the agency, end the turn).
3. There is no source-address pinning (recommended once the gateway's outbound address is confirmed from the host) and no per-credential issue registry or one-click revocation screen (a small table would add both; not proposed now).
4. Credentials last 90 days; reissue at 60. An expired or wrong credential makes the profile retry hard, tripping the per-address failure limit (30 per 10 minutes) for failures only.
5. Whether a running 0.21.5 gateway picks up a new `mcp_servers` entry without a restart is unknown; a restart interrupts all six employees' Chat briefly.
6. The agency CRM row is created lazily, so reads are "empty" rather than "not set up" until a Super Admin opens CRM once.
7. Upstream's later security fixes are assessed in `hermes-upstream-security-assessment-2026-10-31.md`: not an A4a blocker by themselves; the gateway upgrade is a separate project.
8. Exact Linux test counts are visible only in GitHub's sign-in-protected job logs, so this record states conclusions, not Linux numbers. A small workflow change could also publish the comparator's summary as a public annotation; it is not made (it would need another push and a full 39-minute run).

## 12. Statements elsewhere that are now stale (the dated records are kept as written; this is the stronger evidence)

| Where | It says | Stronger evidence |
| --- | --- | --- |
| `hermes-d3-c6-results-2026-10-30.md`, section 7 | the production build was not run, and the full suite ran once on the earlier commit | section 3 above: the suite, ESLint, TypeScript and the production build on the release commit, with this session's numbers |
| `hermes-d3-c6-results-2026-10-30.md`, section 9 | the next request is to decide O1, O2 and the hosting-account question | O2 is now built and tested; the account review and O1 are in the private report; the A4a plan lists every gate |
| `hermes-a4-blockers-proposal-2026-10-30.md`, sections 3.1, 4.1, 5.3, 5.4 | the account narrative and port numbers; the `HERMES_PROFILE_BASE` rollout; the `mcp_servers` question as unverified | trimmed (detail moved to the private report); the variable is now `IACQUIRE_WORKER_PROFILE_BASE`; the `mcp_servers` question was answered against the pinned 0.22.5 source |
| `hermes-a3-request-and-app-release-2026-10-30.md` | the application release "is not done" | the release reached `master` on 2026-10-30 and has been live since (the later commits are documents and worker files only) |
| `client-ai-onboarding-release.md`, `hermes-restricted-provisioner.md` (2026-10-24) | migration 0084 is missing from the production ledger | a read-only production dry run on 2026-10-30 reported nothing pending, which implies 0084 was applied; a direct ledger read is still owed before any provisioning approval |
| The hand-over brief for this work | five console sessions were "unmatched" | the Codex-log timestamp scan matched all five to the other assistant's own browser activity (likely explained, not confirmed); the classification is in the private report |
| `hermes-a4a-acceptance-plan-2026-10-31.md`, sections 3 and 5 | the evidence tool is named `hermes-a4a-evidence baseline` / `verify` | it is not an `npm` script: it is run as `node --env-file-if-exists=.env --conditions=react-server --import tsx scripts/hermes-a4a-evidence.ts <baseline or verify> ...`, and it reads the database named by its environment (select only), so which connection it uses is a decision before the window (corrected in the plan) |

## 13. The operating sequence from here to A4a (generic; the exact change packages are private)

Each stage is its own approval and none is implied by another. The order is the safer one; stages 1 and 2 are the account owner's own settings and fit one sitting.

| Stage | The change | Who | Approval | Rollback | Status |
| --- | --- | --- | --- | --- | --- |
| 1. Accounts trusted (G1) | two-factor sign-in on the hosting, deployment, source, edge and database accounts; the one-operator rule for assistants; review of unattributed access and non-expiring credentials; then a quiet day | account owner | none needed by the assistant; the owner confirms in chat | none needed (hardening) | **Open** |
| 2. Gateway host not reachable from the internet (G2, O1) | a provider firewall with an inbound allow-list in front of the host, the HTTPS route decided with it, later the host port unpublished at a gateway restart that is happening anyway | owner applies it (a security setting); the assistant verifies from outside | owner applies; the restart is approved separately | detach the firewall group (seconds) | **Open** |
| 3. Workers on the worker-only view (G3, O2) | the six inference workers move to the profile view (`services/hermes-inference-worker/DEPLOYMENT.md`) | operator at the host console | its own approval | previous Compose file and variable | **Built; green on Linux CI; not applied** |
| 4. D3/C6 on production, every flag off (G4) | fast-forward `master` to a named commit; Vercel builds; no migration, dependency, variable or flag changes | assistant pushes; owner signs in | one explicit authorization of the named commit | redeploy the recorded previous production deployment | **Technically GO; sequence after 1 and 2** |
| 5. A4a for Zeng (G5 to G7) | signing secret as a sensitive variable, one credential for Zeng, installed by the owner, one supervised read-only turn, then dormant again | owner and assistant | each step separately (plan, section 10) | kill-switch ladder (plan, section 9) | **NO-GO until 1 to 4** |

## 14. The next major product milestone (kept on the roadmap)

**Automatic provisioning of six working, tenant-isolated AI Employees for every new paying client.** After onboarding and payment clearance, each new client workspace receives its own six employees (identity, role instructions, restricted tools, an isolated key and profile, and honest Pending Setup and Ready states) with no manual step and no access across tenants. It follows the internal A4 acceptance and nothing in this file starts it. What exists, what is missing and the ordered list of what is left (ledger reconciliation, the sandbox acceptance re-run on the release commit, capacity and placement, the client-only runtime and restricted provisioner, the client runtime's security review, client role texts and knowledge approval, a supervised pilot client, client business tools as a separate design, and operations) are in `client-provisioning-dependencies-2026-10-31.md`. The work in this release (D3/C6, O2, the evidence tool, the account and gateway-port hardening) is the internal foundation that milestone reuses; none of it changes a client's data path.
