# D3 and C6 release readiness (2026-10-31)

**A recommendation with evidence. Nothing in it has been pushed, deployed, applied or switched on.** No production setting, secret, flag, profile, database or customer record was changed; no model was called. The repository is public: this file names no address, account or identifier. The security findings behind some of the gates are in a private report that is not in this repository.

Labels used: **Complete**, **Verified Locally**, **Verified Against Pinned Runtime**, **Production-Verified**, **Blocked**, **Requires Approval**.

## 1. Implementation versus deployment

| Item | Built | Evidence | On production now | Label |
| --- | --- | --- | --- | --- |
| Six inference workers (A1, A2) on `0.22.5-v4` | yes | CI green on the commit that built it; isolation checked on the host | six workers healthy, proxy on the older `v1` image (harmless drift) | **Production-Verified** |
| Real-model canaries (A3): 11 calls across the six employees | yes | 11 audit rows, all success, DeepSeek `deepseek-flash`, zero tool calls | the inference flag is off again | **Production-Verified** (dormant) |
| D3: signed, profile-bound business MCP credential; profile key refused | yes | 68 tests on a seeded database (credential 29, authentication 39), mutation checks | **no**: production runs the code from before D3 (flag off, so the endpoint answers 404) | **Verified Locally** |
| C6: real Hermes 0.21.5 gateway and MCP client against the real handler | yes | **39 of 39 checks** on Windows today (a fresh runtime rebuilt from nothing); 38 of 38 on Linux CI at `a276c967` | the production gateway's version, `mcp` package and all eight overlay files were read-only-matched to the tested ones on 2026-10-30; it was not asked to discover or call a tool | **Verified Against Pinned Runtime** |
| Business tools in production (A4a) | prepared | see `hermes-a4a-acceptance-plan-2026-10-31.md` | off | **Requires Approval**; **Blocked** by the gates below |
| O2: workers mount a worker-only profile view | yes | 34 behavioural and 12 static tests, 7 mutation checks, and the real worker path against the pinned 0.22.5 source (identical results; an `mcp_servers` entry is inert) | not applied (the VPS still mounts whole profiles) | **Verified Locally** and **Verified Against Pinned Runtime** (0.22.5, Windows); CI steps added, **not yet run on Linux** |
| A4a evidence tool (read-only before/after comparison) | yes | 18 tests; checked against what the real handler writes | n/a (run only inside the approved window) | **Verified Locally** |
| O1: gateway port reachable from the internet | analysis and runbook (private) | externally re-verified today | **present** | **Blocked**; **Requires Approval** |
| Client provisioning | service and states built | sandbox pass (2026-10-24), not re-run on this commit | **nothing client-side exists on production** | **Verified Locally** / sandbox only; see `client-provisioning-dependencies-2026-10-31.md` |

## 2. What the release contains

Review branch against `master`: 40 files, +5,731 / −160 at `bbbe9ceb` (the commits after it add this and other documents and two small test edits). **No database migration** (none is needed or proposed), **no dependency change** (the lockfile is untouched; `package.json` gains one script line, `hermes:business-mcp-token`).

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
| C6 pinned-runtime compatibility (real Hermes 0.21.5 plus overlay, rebuilt from nothing today) | **39 of 39 pass** in 313 seconds, including the new check that scans 2,721 files (28.8 MB) written by the real gateways and clients for any credential, signing secret or gateway key (none outside the profile `.env` files). The same proof passed 38 of 38 on Linux CI at `a276c967`. The file is skipped in the full suite, as designed, because it needs the runtime |
| O2 against the pinned Hermes 0.22.5 source (real worker path, offline, loopback only) | the audit is identical with and without an `mcp_servers` entry in the copied config (about 9 s each), with no connection to the entry's address and no start of its command (both detectors shown to fire); a view built by the real script from planted secrets completes an audit through the real runner; run locally from scratch scripts and the two new CI smokes, which have **not** run on Linux yet |
| TypeScript (app and scripts) | **0 errors**, run on the final test files |
| ESLint, whole repository | **0 errors, 3 warnings** (the same three as before this work: two in `src/server/aqi/service.ts`, one in `src/server/chat/service.ts`) |
| Production build (`next build`) | **succeeded** (exit 0, compiled in 29.7 s); the business MCP, inference canary, inference chat and prompt-audit routes are all in the output |
| Workflow file | YAML parses, every `run:` block passes `bash -n`, the embedded Python compiles |
| `git diff --check` against the base the workflow uses | clean after the one fix above |
| Mutation checks (each protection removed in turn) | the 7 O2 protections: all caught; the D3 protections: caught in the earlier phase |
| Migrations | none required, none proposed |

## 4. Other agents and changed files

No uncommitted change in any other worktree touches a file of this release, and no other branch has a commit newer than this one. Two stale branches (the other assistant's older activation branches) contain an earlier version of `hermes-business-mcp.ts` that predates D3 and the bridge integration: if one of them were merged it would undo D3's authentication change in that file. The rule to put in front of any assistant working on this repository: do not merge or push those branches, and re-read this file's history first. The other Claude session in this repository is idle.

## 5. Public-diff hygiene

The added lines of the whole review-branch diff were scanned (5,729 lines at `bbbe9ceb`, and again on the final tree) for hostnames, addresses (IPv4 and IPv6), account, tunnel and project identifiers, e-mail addresses, private keys, API-key, token and webhook-secret patterns and 64-hex strings: **none**. The four lines that match a generic token pattern are synthetic values by design (planted test secrets and a known-answer vector built from obviously fake UUIDs). Two earlier documents were trimmed for the public history: the account-event narrative and the exact port details in `hermes-a4-blockers-proposal-2026-10-30.md` are now generic, with the detail kept in the private report. Before any push, re-run this scan on the exact commit.

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

**Release of the D3/C6 code in dormant state: technically GO**, subject to your authorization of one `master` fast-forward. It carries no migration, no dependency, no flag and no production setting, the verification below holds, and it makes a mistaken enabling of the endpoint safer (the profile key stops working there). It also has **no benefit until the A4a gates are met**, so it can wait, and the safer order is accounts, then O1, then the release: a deployment by another assistant of an older build can silently undo it, as happened on 2026-10-30.

**A4a: NO-GO** today (`hermes-a4a-acceptance-plan-2026-10-31.md`, section 2): the account trust gate, O1 and the release are open, O2 is built but not applied, and the signing secret does not exist.

## 11. Residual risks

1. The credential lives in each profile's `.env`: whatever can read a profile directory can read it. O2 removes the workers; O1 removes the internet; root on the host remains, by design.
2. The environment-level switches take one deployment (about 5 to 7 minutes). The immediate stops are the database-level ones (disable the employee, pause the agency, end the turn).
3. There is no source-address pinning (recommended once the gateway's outbound address is confirmed from the host) and no per-credential issue registry or one-click revocation screen (a small table would add both; not proposed now).
4. Credentials last 90 days; reissue at 60. An expired or wrong credential makes the profile retry hard, tripping the per-address failure limit (30 per 10 minutes) for failures only.
5. Whether a running 0.21.5 gateway picks up a new `mcp_servers` entry without a restart is unknown; a restart interrupts all six employees' Chat briefly.
6. The agency CRM row is created lazily, so reads are "empty" rather than "not set up" until a Super Admin opens CRM once.
7. Upstream's later security fixes are assessed in `hermes-upstream-security-assessment-2026-10-31.md`: not an A4a blocker by themselves; the gateway upgrade is a separate project.
8. The Linux CI steps added for O2 have not run; they need a push of the review branch.

## 12. Statements elsewhere that are now stale (the dated records are kept as written; this is the stronger evidence)

| Where | It says | Stronger evidence |
| --- | --- | --- |
| `hermes-d3-c6-results-2026-10-30.md`, section 7 | the production build was not run, and the full suite ran once on the earlier commit | section 3 above: the suite, ESLint, TypeScript and the production build on the release commit, with this session's numbers |
| `hermes-d3-c6-results-2026-10-30.md`, section 9 | the next request is to decide O1, O2 and the hosting-account question | O2 is now built and tested; the account review and O1 are in the private report; the A4a plan lists every gate |
| `hermes-a4-blockers-proposal-2026-10-30.md`, sections 3.1, 4.1, 5.3, 5.4 | the account narrative and port numbers; the `HERMES_PROFILE_BASE` rollout; the `mcp_servers` question as unverified | trimmed (detail moved to the private report); the variable is now `IACQUIRE_WORKER_PROFILE_BASE`; the `mcp_servers` question was answered against the pinned 0.22.5 source |
| `hermes-a3-request-and-app-release-2026-10-30.md` | the application release "is not done" | the release reached `master` on 2026-10-30 and has been live since (the later commits are documents and worker files only) |
| `client-ai-onboarding-release.md`, `hermes-restricted-provisioner.md` (2026-10-24) | migration 0084 is missing from the production ledger | a read-only production dry run on 2026-10-30 reported nothing pending, which implies 0084 was applied; a direct ledger read is still owed before any provisioning approval |
| The hand-over brief for this work | five console sessions were "unmatched" | the Codex-log timestamp scan matched all five to the other assistant's own browser activity (likely explained, not confirmed); the classification is in the private report |
