# D3 and C6: business tool security and Hermes compatibility (2026-10-30)

Work on `integration/hermes-bridge-final`; the code was pushed to that review branch for CI only (not `master`), and **nothing was deployed or applied.** No production setting, secret, flag, profile, database or customer record was changed; no model
was called; the business MCP endpoint and inference stay off. The only thing done on the production gateway is the two read-only version checks in section 3.5 (nothing restarted or changed). This is the evidence for the D3 and C6 gates and the preparation for A4, not an approval to start A4.

## 1. Outcome labels

| Item | Label |
| --- | --- |
| D3: dedicated signed, profile-bound MCP credential; the Hermes profile API key no longer opens the endpoint | **Implemented. Verified locally** |
| D3: authorization against the application's records, run-level binding, people boundary, rotation, revocation, expiry | **Implemented. Verified locally** (denial matrix, with a no-side-effects check on every refusal) |
| D3: operator issuing script (`npm run hermes:business-mcp-token`) | **Implemented. Verified locally** on synthetic inputs. Never run against hosted data |
| C6: real Hermes 0.21.5 gateway and MCP client against the real handler, six profiles, 38 checks | **Verified against pinned Hermes** (Windows host, hash-locked dependencies). The same test **also passed on Linux CI** (Ubuntu 24.04, GitHub Actions run 41041177963, commit `a276c967`, 2026-10-30, about five minutes; the evidence it recorded shows `platform: linux`, Hermes 0.21.5, `mcp` 2.0.0, Python 3.13.14) |
| C6: the production gateway's own versions | **Verified by read-only checks on 2026-10-30:** Hermes Agent v0.21.5 (2026.9.24), upstream `f97608f1`, `mcp` 2.0.0, as tested; Python 3.13.5 (tested 3.13.14). Section 3.5 |
| C6: tool discovery and calls on the production gateway itself | **Not done. Requires production approval** (that is A4); the proof ran on the pinned source runtime, not on the production container |
| A4 preparation: read-only capability contracts for the six employees | **Verified locally** on synthetic records |
| Production business-tool readiness | **Not claimed.** Local and synthetic tests do not establish it |

Success criteria: D3 is complete (section 2). C6 "a disposable Hermes 0.21.5 runtime demonstrably discovers and invokes the approved business MCP contract with correct authentication and inventory
provenance" is met on the pinned source runtime (Windows, and Linux CI), and the production gateway's own versions now match what was tested (section 3.5); discovery and calls have not been run on the production container itself, which is A4. A4 is **ready to be requested for separate authorization**
only when the blockers in section 8 are resolved.

## 2. D3: credential separation

Full design and operator procedure: `docs/hermes-business-mcp-credentials.md`. In short:

- **Before:** the endpoint accepted the employee's Hermes profile API key, which is also the portal's credential for the Hermes gateway: one leaked string, two trust directions.
- **Now:** only `iamcp1.<role>.<employee id>.<workspace id>.<issued>.<expires>.<credential id>.<signature>`, HMAC-SHA256 under a key derived with HKDF from `HERMES_BUSINESS_MCP_SECRET` (a new,
  server-only secret that must differ from every other secret in the deployment; checked at boot, never echoed). The profile API key is refused; the credential opens nothing but this endpoint.
  Constant-time comparison, strict shapes, fields read only after the signature verifies, expiry (90 days default, 400 maximum), single-credential revocation by id, overlap rotation with a
  verify-only previous secret, one audit entry for a signed-but-refused credential (id only), failure limiting that never blocks a valid credential.
- **A signed credential is not authority.** The employee row it names must still match every claim (workspace, role, profile, enabled, workspace active, saved Hermes credential unrevoked), and nothing
  is read without that employee's own live, authenticated Chat turn, run by a Super Admin who still belongs to the workspace. The turn, and so the person, is chosen by the server.
- **Found and fixed while doing it:** the Super Admin boundary applied to the context tool but not to the CRM tools. It now applies to both, before any tool token exists (`requireWorkspaceUser`).
- **Tests:** `hermes-business-mcp-credential.test.ts` (29: known-answer vector, tamper/malformed matrices, domain separation, expiry, clock, revocation, rotation, environment contract, secret-handling
  guards) and `hermes-business-mcp-auth.test.ts` (39: against a seeded database and the real handler: valid and invalid credentials, the old profile key refused, wrong role/employee/workspace,
  altered/expired/revoked/rotated, disabled and suspended employees and workspaces, revoked Hermes credential, re-mapped profile, no turn, another employee's turn, wrong kind of turn, stale, doubled and
  out-of-date turns, expired inventory proof, non-Super-Admin and removed member, replay after the turn ends, tool lists, unauthorized and write tools, operating mode and agency pause, the failure limit,
  the credential not opening the tool API or the gateway, nothing credential-shaped in any table or log, and the issuing script's core). Mutation checks confirmed the tests fail when each protection is removed.
- **No migration.** If per-credential issue records or admin-screen revocation are wanted later, a small table would add them; it is not proposed now.

## 3. C6: compatibility with the real Hermes

### 3.1 What was run

`services/hermes-business-mcp-acceptance/prepare-runtime.mjs` builds, in a new directory, **Hermes 0.21.5** at upstream commit `f97608f178d1ffeca59860195ab7da295f7c8e5f` (v2026.9.24), its
dependencies installed exactly as upstream's own container build does (`uv sync --frozen`, lockfile sha256 `ab53c5f5…8027f7`; Python 3.13.14; MCP SDK `mcp` 2.0.0, aiohttp 3.14.3, httpx 0.28.1), plus this
repository's catalog overlay, checked against its `SHA256SUMS` (eight files) and applied to a copy. The pristine checkout is the control. Reproduced from nothing in 47 seconds.

`tests/hermes-business-mcp-pinned-runtime.test.ts` then serves the **real** `handleHermesBusinessMcp` over loopback on a seeded in-memory database, creates a disposable Hermes home with the six
internal profiles (each with its own API key and its own credential in its own `.env`), starts the **real** gateway, and checks the following. The runtime's environment holds no provider key and
nothing from the developer's shell; no model is called; the only network use is loopback (and, in the build, the fetch of the pinned source and packages).

### 3.2 Results (all 38 checks pass)

| Required check | Result | Evidence |
| --- | --- | --- |
| 1. Hermes accepts the MCP server configuration | Yes, all six profiles | `mcp_servers.iacquire_business` with `Authorization: "Bearer ${IACQUIRE_BUSINESS_MCP_TOKEN}"` expanded from the profile `.env`, `tool_timeout: 12` |
| 2. The gateway discovers the required tools | Yes, exactly each role's approved tools (2 to 5 per role) | the real MCP client authenticates with the signed credential; the endpoint answered 200 |
| 3. Inventory reports correct source, server, toolset, names | Yes | every business row: `source: mcp`, `source_server: iacquire_business`, `toolset: mcp-iacquire_business`, names `mcp__iacquire_business__<tool>`; catalog `complete: true`, contract `hermes.api_server.tool_catalog.v1` |
| 4. Tools recognized under the existing `iacquire_business` contract | Yes, after one fix (3.3) | the application's own `runHealthCheck` records all six employees online with a verified inventory |
| 5. One authenticated, authorized read on synthetic records | Yes | Hermes' MCP client and tool registry call `get_role_workspace_context`: own record found, other workspace's record absent; a CRM summary read; without the employee's live Chat turn the application refuses |
| 6. Invalid credentials rejected | Yes, 8 cases | garbled, the profile's own API key, signed under another secret, expired, client employee, right employee under another workspace, wrong role, none: no tool registered, the endpoint answered 401 (429 once the address's failure limit tripped), no side effect |
| 7. Unauthorized tools unavailable or refused | Yes | `crm_summary_report`, `update_contact`, `create_task`, `request_appointment`, `prepare_message`, `request_send_approval` are not registered for the Lead Hunter: "Unknown tool" |
| 8. Cross-tenant access denied | Yes | cross-workspace credentials refused (check 6); the context read returns only the employee's own workspace |
| 9. No unexpected administrative or system tools | Yes | the only built-in tools are `memory`, `session_search`, `todo_list`, `web_extract`, `web_search`; no terminal, file, browser, code, cron, delegation or other MCP tool, in any of the six inventories |
| 10. Failed, partial, incompatible, missing fail closed | Yes | service down: gateway reports "never completed tool discovery", employee not online. One tool missing: "missing required reviewed tool". An extra `shell_exec` offered: "unapproved MCP tool". A malformed schema: Hermes fails the whole server's discovery, employee not online |
| Control: gateway without the overlay | Fails closed as documented | `GET /v1/tools` is 404; the employee stays `setup_required` |

### 3.3 What the real runtime found that mocks could not

1. **The gateway lists a configured MCP server twice in `enabled_toolsets`:** as `mcp-iacquire_business` and under the server's own name `iacquire_business`. The application's verifier refused the real
   inventory ("not allowed: iacquire_business"). The mocked gateway had never produced that shape, and no existing test exercised the MCP-enabled inventory path at all. Fixed in `assertCatalogPolicy`: the
   server name is tolerated as an alias **only while the business bridge is on for the role**, and no tool may hide behind it (a row whose toolset is the alias is refused).
2. **A gap the negative tests exposed:** a tool carrying a business tool's reserved name (`mcp__iacquire_business__…`) or sitting in an `mcp-` toolset, but reporting a non-MCP source, was accepted.
   The verifier now treats anything that presents itself as MCP as MCP and requires provenance to agree exactly. Ten mocked tests (`hermes-business-mcp-inventory.test.ts`, labelled as mocked) pin both decisions.

### 3.4 What this does not prove

- **Not run on the production container.** The proof used the same Hermes source, the same locked dependencies as upstream's official image and the repository's overlay, on Windows and on Linux CI; the production gateway is an
  iAcquire-tagged Hermes 0.21.5 image on the hosting provider's Hermes base image, carrying the same backport (by its labels). Two read-only checks on it were approved and run on 2026-10-30 (section 3.5): the versions match what was tested. Nothing was discovered or called through the real gateway. The historical official 0.21.5 image digest used in this repository is recorded in git history (commit `f2eed8a3`) if a container build is wanted.
- **Linux:** the same test passed on Ubuntu in CI after the push (run 41041177963), rebuilding the runtime from nothing on the runner. The full evidence is in that run's job summary; the annotation copy is cut at 6,000 characters.
- **Not a model-driven run.** The "read" is Hermes' MCP client and registry called in-process, the path an agent's tool call takes, with no model in the loop.
- **Not a gateway restart or profile reload,** and not multi-day behaviour (credential expiry is proven by unit test, not by waiting).
- **The six inference workers (Hermes 0.22.5)** are separate and have no MCP; nothing here concerns them.

### 3.5 The production gateway's versions (two read-only checks, 2026-10-30)

Approved by the founder in chat (the 'Approve checks' reply) and run once, from the founder's signed-in browser, in the VPS web console. Nothing was restarted, installed or changed; no profile, setting, secret, port or firewall was touched; no model was called and nothing was sent to the portal; no environment value was printed.

| Check | Tested (pinned runtime) | Production gateway | Result |
| --- | --- | --- | --- |
| `hermes --version` | Hermes Agent 0.21.5, upstream commit `f97608f1` (v2026.9.24) | `Hermes Agent v0.21.5 (2026.9.24)`, upstream `f97608f1`, install method docker | **Match** |
| Installed `mcp` package | 2.0.0 | 2.0.0 | **Match** |
| Python (printed by `hermes --version`) | 3.13.14 | 3.13.5 | Differs at patch level; nothing further compared |
| OpenAI SDK (printed by `hermes --version`) | not recorded | 2.24.0 | Not compared |

Supporting facts, read from the container's and its image's metadata with field selectors that leave out the environment: the gateway container runs an image tagged `iacquire/hermes-agent:0.21.5-toolcatalog-f6a6230` (built 2026-10-18 on the hosting provider's Hermes base image, per its labels). Its labels declare upstream source commit `f97608f178d1ffeca59860195ab7da295f7c8e5f`, the contract `hermes.api_server.tool_catalog.v1` and revision `f6a6230`: the same upstream commit and reviewed backport revision that the overlay README in this repository names. The container was created on 2026-10-19 at 07:01 UTC; its start time was the same each time it was read, and its restart count was 0.

What was run, exactly: a listing of container names, images and status; the metadata reads above; `hermes --version` and a package-metadata lookup inside the gateway container as user 10000 with a throwaway `HERMES_HOME` in the container's temporary directory (made and removed by the command, so nothing was written to the gateway's data volume); and a final status read.

What this still does not show: the labels are what the image says about itself, and the eight overlay files inside the running image were **not** hashed against `SHA256SUMS` (a third read-only check, outside the approval). Only the `mcp` package was compared, not aiohttp, httpx or the rest of the dependency set. The real gateway has not been asked to discover or call a business tool; that is A4. Separately, the overlay README records that upstream v0.21.6 later listed security fixes that have not been assessed or ported. It is written about the client image, but the internal gateway is the same 0.21.5 base, so the question applies to it too; it has not been assessed here.

## 4. The six-employee capability matrix (A4 preparation, read-only)

`tests/hermes-business-mcp-capability-matrix.test.ts` pins this table to the code and exercises every tool each employee holds through the real handler on **synthetic** records (labelled "Matrix
Synthetic …", created by the test). Nothing is a real customer record or real activity. Every tool is a read; no write, proposal, approval, send or booking tool is offered to any employee, and the test
asserts that running all of them creates no message, booking, approval, task or lead.

Common to every row: the endpoint is `/api/internal/hermes-business/mcp`; the people check is `assertWorkforceWorkspaceAccess` (Super Admin) plus `agents.use` for the run's user; the service is
`buildRoleWorkspaceContext` → `prepareEmployeeEvidence` (`src/server/workforce/employee-evidence.ts`) for the context tool and `callAgentTool` (`src/server/crm/agent-tools/service.ts`) for CRM tools,
which add the role allowlist, the person's permissions and the automation gate. "Area" means a section of the context snapshot. The internal agency CRM row is created lazily by a Super Admin opening
CRM; until then CRM reads are empty and the snapshot says "native, ready, no contacts" (existing design), which an employee cannot tell from a CRM that is genuinely empty.

| Employee | Capability | Existing service / tool | Permission check | Employee scope | Expected result (synthetic) | Remaining blocker |
| --- | --- | --- | --- | --- | --- | --- |
| **Zeng** (Operations Manager) | Task status | areas `work_board`, `schedules`; `internalOperations` (`openTaskCount`, `overdueTaskCount`, `openTasks`) | `agents.use` or `activity.view` | `tasks:write` (no read tool), `contacts:read`, `opportunities:read`, `calendar:read`, `reports:read` | counts and up to 6 attention records; here `work_board:empty` | none for reads |
| | Approvals | `internalOperations.pendingApprovals`, `pendingApprovalCount`, `blockedApprovals`, `changesRequestedCount` | `approvals.view`, `activity.view`, `agency.workforce.view` | | summary and counts | details beyond the summary are not exposed; deciding or submitting approvals is out of scope |
| | Workload | areas `handoffs`, `work_board` | same | | `handoffs:ready` | none |
| | Employee health | `internalOperations.workforce`: per employee, enabled, connection status, currently executing, runs in 24 hours, failed runs in 7 days, last run | `agency.workforce.view` | | present for the six roles | none for reads |
| | Business operations | `crm_summary_report`, `check_availability`, `find_contacts`, `get_contact` | `analytics.view`, `appointments.view`, `contacts.view` | `reports:read`, `calendar:read`, `contacts:read` | counts (contacts, deals, tasks, appointments, conversations); 3 open slots; contact found | agency CRM row lazy (see above) |
| **Lead Hunter** | Authorized leads | area `leads`; `find_contacts`, `get_contact` | `leads.view`; `contacts.view` | `contacts:read` | `leads:ready`, the synthetic lead listed with review state, duplicate check, CRM sync | CRM contacts and researched leads are different records |
| | Research requests | area `leads` (`researchRequestsByStatus`, `recentResearchRequests`) | `leads.view` | | present | starting research is a chat request (`chat_requests`), not an MCP tool |
| | Lead status, qualification | area `leads` records (`score`, `review`, `buyingSignalsFound`); `get_contact` lead status | `leads.view`; `contacts.view` | | listed | `targeting:not_configured` until rules are saved (reported honestly) |
| **Appointment Setter** | Availability | `check_availability`; area `open_times` | `appointments.view` | `calendar:read` | 3 open slots on the synthetic calendar | native calendars only; a GoHighLevel-owned calendar reports "managed elsewhere" |
| | Calendars | area `calendar` | `appointments.view` | | `calendar:ready` | none |
| | Appointment requests | area `booking_requests` (counts and up to 5) | `appointments.view` | `appointments:request` (**not offered**: `request_appointment` is a proposal tool) | `booking_requests:empty` | requesting a booking stays on the approval path (out of scope) |
| | Booking status | area `appointments`; `get_conversation_history` (own conversations only) | `appointments.view`; `inbox.view` | `conversations:read` | `appointments:empty`; another employee's conversation is "not found" | none |
| **Sales Assistant** | Opportunities | area `pipeline` | `crm.view`, `sales.view` | `opportunities:read` (**no read tool exists for it**) | `pipeline:ready` with the synthetic deal | no per-opportunity tool; reachable only through the area |
| | Approved service information | none | | | `knowledge:not_configured` | **Gap.** No approved knowledge saved and no tool; service text reaches the employee in its instructions, not through MCP |
| | Sales follow-up context | `get_conversation_history`, `get_contact` (open deals, tasks, appointments), `check_availability` | `inbox.view`, `contacts.view`, `appointments.view` | `conversations:read`, `calendar:read` | own conversation returned (internal notes never included) | none |
| **CRM Manager** | Contacts | `find_contacts`, `get_contact` | `contacts.view` | `contacts:read` | synthetic contact found | none |
| | Opportunities, pipeline records | area `pipeline` | `crm.view`, `sales.view` | `opportunities:read` (no tool) | `pipeline:ready` | as above |
| | Data-quality findings | area `crm_quality` (missing details, possible duplicates) | `contacts.view` | | `crm_quality:ready` | none |
| | Summary counts | `crm_summary_report` | `analytics.view` | `reports:read` | counts only; no email or phone in the reply | none |
| **Performance Analyst** | Verified performance metrics | area `performance` (last 30 days against the 30 before) | `analytics.view` | `reports:read` | `performance:ready` with measures, change and source | none |
| | Conversion results | `performance` records; `crm_summary_report` deal counts | `analytics.view` | | **counts only** | **Gap.** The snapshot itself says conversion rates, revenue and costs are not recorded; none is offered |
| | Attribution reports | none | | | not available | **Gap.** No attribution source exists to expose |

Gaps are reported, not papered over: **no tool for approved service information, per-opportunity reads, conversion rates or attribution**, and the honest "not set up" states are already the snapshot's.

## 5. Existing components reused (nothing duplicated)

Hermes credential rows and the vault (`integration_credentials`, `credential_references`); the run gate `runtimeReadySql` and `agent_runs`; the one-minute `crm_agent_tokens` and `callAgentTool` (role
allowlist, person's permissions, automation gate, approval path, `forceApprovalWrites`); `assertWorkforceWorkspaceAccess`; `app.user_can_access_org` / `app.has_permission`; `recordAudit`,
`tool_executions`; the rate limiter (`agentToolAuthFailureByIp`, `agentToolCallsByEmployee`); the tool-inventory verifier (`verifyToolInventory`, `runHealthCheck`) and the complete-catalog contract; the
provisioning preview; the catalog overlay and its `SHA256SUMS`; the existing CI patterns; `startMockHermes` and the fixtures. No new tables, routes or competing authentication systems.

## 6. Files changed, migrations

Source: `src/server/env.ts` (secret, previous secret, revoked ids, boot checks), `src/server/workforce/hermes-business-mcp.ts` (authentication, people boundary), **new**
`hermes-business-mcp-credential.ts`, `hermes-business-mcp-issue.ts`, `src/server/workforce/provisioning.ts` (preview names the dedicated variable), `src/server/integrations/hermes/inventory.ts`
(alias; provenance), `scripts/hermes-business-mcp-token.ts`, `package.json` (one script), `.env.example`. Harness: `services/hermes-business-mcp-acceptance/*`,
`.github/workflows/hermes-business-mcp-compat.yml`. Tests: five new test files (credential, auth, inventory, pinned runtime, capability matrix), two support files, two updated. Docs: this file and `hermes-business-mcp-credentials.md`.

**Migrations: none proposed. Nothing is left unapplied.**

## 7. Verification

Run on the Windows development machine, on the branch's working tree, against synthetic data only.

| Check | Result |
| --- | --- |
| D3 and MCP tests (`hermes-business-mcp-credential`, `-auth`, `-context`, `-provisioning`, `-route`, `-policy`, `-dependencies`, `-inventory`, `-capability-matrix`) | pass |
| Existing inventory, tool-policy and CRM agent-tool tests re-run after the changes | pass |
| Pinned-runtime compatibility test (real Hermes 0.21.5, runtime rebuilt from nothing by `prepare-runtime.mjs`) | 38 of 38 pass; also verified to skip without a runtime and to fail when one is required but absent |
| Mutation checks (each protection removed in turn) | tests fail without the protection; two database predicates are redundant with other layers and cannot be isolated |
| TypeScript (app and scripts), ESLint on every new and changed file | clean |
| Full test suite (723 files, run on this commit's source and tests) | 11,334 tests passed, 10 failed, 40 skipped. All 10 failures are inside the nine files already failing on production master; the repository's guard reports `KNOWN_FAILURES_ONLY` (no regression). The skips include the pinned-runtime tests, which need a runtime and were not given one in this run, as designed |
| ESLint, whole repository | 0 errors, 3 warnings (the same three as before this work: two in `src/server/aqi/service.ts`, one in `src/server/chat/service.ts`) |
| Operator script on synthetic inputs (issue, verify, refuse to overwrite, refuse bad input) | works; prints no credential or secret |

**Not done, and not claimed:**

- The **production build** was not run: the nested worktree cannot find `next` on its own, so it has to be run from the parent worktree checked out detached on this commit.
- **Linux CI:** the pinned-runtime test passed (run 41041177963). The full-suite job did not run (its path filter does not match these files); the full suite passed locally.
- No hosted migration, deployment, push to `master`, production setting or secret change, and no model call, was made. The review branch was pushed once, for CI only; the only production access was the two read-only version checks in section 3.5.

## 8. Security findings, remaining blockers, and what must be resolved before production business tools

New or sharpened by this phase:

1. **C3 resolved (D3).** The profile API key and the business credential are now separate and neither opens the other's door.
2. **C4 corrected.** The repeated "oldest agency workspace" subquery is not an ambiguity: the database allows exactly one agency workspace (`organizations_single_agency`) and refuses a client employee an
   internal profile name (`reserved_hermes_profile`). The subquery is redundant defence in depth.
3. **People boundary inconsistency fixed** (CRM tools did not apply the Super Admin check).
4. **Verifier gaps fixed** (server-name alias; MCP-looking tools without MCP provenance), found only by the real runtime and the negative tests.
5. **The credential lives in each Hermes profile's `.env`.** That raises the stakes of O1, O2 and O3 below: whatever can read a profile directory can read it. Its reach is small (read-only business
   information, only during that employee's live Chat turn, expires, individually revocable), but that is a reason to fix the exposure first, not to ignore it.
6. **A Hermes profile with a bad or expired credential retries hard.** In testing the address's failure limit (30 per 10 minutes) tripped within one probe, so answers became 429. Valid credentials are
   unaffected, but an expired credential will look like a retry storm. Credentials last 90 days; reissue at 60.
7. **Reads on the not-yet-opened agency CRM are empty, not "not set up"** (existing design); an employee cannot tell them apart. Open the agency CRM before A4 acceptance.

Open from earlier phases, restated with what they mean for A4:

| Finding | Must be resolved before production business tools? |
| --- | --- |
| Unexplained activity on the hosting account, and a diagnostic flag set outside this work | **Yes.** A4 adds a signing secret to that account's environment; the account must be trusted first (rotate its tokens, review its members) |
| O1: the gateway host exposes a public port and its firewall is inactive | **Yes**, or show that nothing reachable there can read a profile directory |
| O2: workers mount whole profile directories | **Yes** (mount only `SOUL.md` and `config.yaml`, or keep the credential out of what is mounted) before a credential is placed in a profile `.env` |
| O3: writable anonymous `/opt/data` volume in each worker | No (low) |
| W2: non-expiring Access service token | No for A4; set a rotation policy |
| Egress proxy still on the older image | No (affects inference egress only) |
| Inference latency 17 to 23 s against the 32/36/45 s limits | No for MCP (`tool_timeout` is 12 s per tool call); watch it in A4 chat |
| Gateway and `mcp` package versions on the real host | **Done 2026-10-30 (read-only): 0.21.5 and `mcp` 2.0.0, as tested** (section 3.5). Still open, not blocking by itself: the overlay files in the running image were not hashed, and upstream v0.21.6's security fixes are unassessed |

## 9. A4 readiness and the next request

**Not ready to start A4.** Both gates are met on what can be proven here (D3 locally; C6 on the pinned source runtime, with the production gateway's versions confirmed to match), but the infrastructure blockers above are open. A4
also needs its own written authorization, and it would be the first time the endpoint is switched on.

Recommended next requests, in this order, each separate:

1. **Done on 2026-10-30 (approved and pushed): the review branch was pushed for CI only** (no deploy, not `master`; Vercel also built a preview, which GitHub records as environment `Preview`, not production): the Linux run of `hermes-business-mcp-compat.yml`. It is the only workflow this push triggers: the full-suite job in `hermes-inference-worker.yml` is path-filtered and none of these files match it, and the full suite has already passed locally with only the nine recorded failures. The exact branch, commit, diff summary and
   verification results are in the final report.
2. **Done on 2026-10-30 (approved and run): two read-only checks on the real gateway**, `hermes --version` and the installed `mcp` package version. Both match (section 3.5). An optional third read-only check, hashing the eight overlay files inside the running image against `SHA256SUMS`, would turn the label-based match into a byte-level one; it needs its own approval.
3. **Decide O1, O2 and the hosting-account question** (section 8).
4. Only then, **A4a**: set the signing secret in the server environment with the flags still off; issue credentials with the script; install them on one profile (Zeng first) through the approved host
   procedure; switch the bridge on for a short, supervised window; run one business-tool acceptance chat; switch it off again.
