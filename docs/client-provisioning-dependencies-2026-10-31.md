# Client AI Employees: where automatic provisioning stands, and what is left after internal A4

**Next major product milestone (kept on the roadmap, 2026-10-31):** automatic provisioning of six working, tenant-isolated AI Employees for every new paying client. This file is its dependency list; `hermes-d3-c6-release-readiness-2026-10-31.md`, section 14, records where it sits in the sequence after the internal A4a acceptance.

**Status (2026-10-31): read-only review of the repository and its recorded evidence. Nothing was deployed, applied or probed, and no client was provisioned.** The goal this serves: every new paying client automatically receives six isolated, properly configured AI Employees after onboarding and payment clearance. This is the dependency and gap list, with honest labels.

## 0. Application side, 2026-11-01: one onboarding, one honest launch state

**Built and verified locally on synthetic clients (test database; nothing released, no migration, no Hermes write, no production change).** The portal now answers "is this client ready to launch?" from the workspace's own records, and the steps to get there run from one checklist.

| Piece | What it does | Evidence |
| --- | --- | --- |
| Launch readiness (`src/lib/launch-readiness.ts`, `src/server/setup/launch-readiness.ts`, the panel on `/setup`) | One state: Not started, Questionnaire submitted, Provisioning, Action required, Ready for review, **100% Ready to Launch**. 100% means every applicable, required setup and verification check passed. A queued job, a drafted calendar or a created profile is never "done"; optional or unpurchased items never block; things that do not apply (no appointments, a role outside the plan) are "not applicable"; an employee with no record is something iAcquire must look at. Each unfinished item says who moves next. | 23 pure tests, 6 database tests |
| Guided calendar (`src/server/setup/launch-intents.ts`) | Make me the host (only the person pressing it), use the hours the client's own answers suggested, check and activate (the public booking page stays off). Hours are never invented; a role without calendar management is refused. | 8 tests |
| Final checks (`src/lib/launch-verification.ts`) | Each employee runs one reviewed read-only capability on the client's real records. One job per employee and configuration version; stale when the configuration changes; the Appointment Setter passes only if a real bookable time exists in the next seven days. | same suites |
| Automatic start (`src/server/setup/launch-sweep.ts`, `dispatchSystemCapabilityJob`) | After a passing health check, and after a calendar, Blueprint or channel event, the checks start by themselves for ready employees. They name the workspace owner as the accountable requester (the worker refuses work with none and re-checks that person's permission), are audited as the system's, only ever start read-only capabilities, and never retry a failed check. | 7 tests |
| Booking policy and targeting | The questionnaire (version 3) also asks gap between appointments, whether a person confirms each booking, whether customers may reschedule or cancel and until when, and the video tool; the drafted appointment types carry the answers. The Lead Hunter's empty targeting is filled once from the client's own words (areas, services, qualification, ideal customer), never over existing rules. | 10 tests |
| Two-client acceptance (`tests/client-launch-acceptance.test.ts`) | A Chicago roofing company (six employees, appointments) and a Manila dental practice (no appointments, no Sales Assistant in the plan): nothing before payment; the payment event, replayed, opens the plan's profiles once; unique identities; no cross-client knowledge or instructions; a half-failed provisioning shown honestly and recovered; guided calendar in the host's time zone; checks start by themselves; both reach 100%; nothing sent, nobody booked, no public page; cross-workspace refusals; a video type that needs Google stays at "action required". | 10 tests |

**What this does not change.** The client-only Hermes runtime and the restricted provisioner are still not running anywhere (section 1, **NOT RUN**), so a real client's employees stay "Pending setup" until that is installed and the pilot passes. The final checks verify the portal path (dispatch, worker, tenant-scoped reads, result), not the Hermes profile itself, which the health check verifies separately.

**Client business tools: still not built, and it is not a small step.** Client employees are answered from reviewed capability jobs and a read-only evidence packet, both tenant-scoped and now exercised by the final checks. The signed MCP credential is minted around the internal role-to-profile table (`AGENCY_HERMES_PROFILE_IDS`) and the endpoint requires that employee's own active chat turn; a client tier needs a credential whose profile claim comes from the agent's recorded profile, a read-only tool list per plan with writes only as approval proposals, new off-by-default flags, a worker image that mounts the MCP server for client profiles, and a security review. The last two touch the production runtime and need their own approval. The next step that is within reach without touching production is the credential and policy layer behind a flag, with two-tenant tests.

See `docs/client-pilot-package-2026-11-01.md` for the supervised pilot, prepared for a separate approval.

## 1. Where it stands

| Piece | What exists | Label |
| --- | --- | --- |
| Six client employee records per workspace | `ensureAgentInstances` creates them for every workspace (application, tested) | **Complete** in the application; Hermes profiles are a separate matter |
| Provisioning jobs, leases, retries, idempotency | migrations 0082 (jobs) and 0084 (restricted provisioner); `src/server/workforce/provisioning.ts`; tests (two-tenant, replay, recovery) | **Verified Locally** |
| Restricted client-only provisioner service | `services/hermes-provisioner` (unprivileged worker, client-only Hermes image with the catalog overlay, Compose files, 48 service tests) | **Verified Locally** and **SANDBOX PASS** (two synthetic tenants, 12 profiles, 72 cross-tenant denials, 132 wrong-key denials, effective-SOUL canaries, recovery, audit redaction; GitHub Actions run 40059587299, 2026-10-24, on a branch-scoped workflow) |
| The same on the current commit | the sandbox pass predates the commits since 2026-10-24 (the docs say so themselves) | **Not re-run** |
| Real production provisioning | no client-only Hermes runtime, provisioner worker or client profile exists on the VPS; no real profile was provisioned | **NOT RUN** (production); needs approval |
| Payment and onboarding trigger | `src/server/billing/after-clearing.ts` calls into provisioning when a payment clears, and a client who finished onboarding first is provisioned then | **Verified Locally** on synthetic data; **not verified** against a real payment in production |
| Honest Pending Setup and Ready states | persisted setup, health and readiness records; an employee is Ready only after the portal's own health check (identity, capabilities, restricted toolsets, complete stable inventory); a host callback alone never makes one Ready | **Verified Locally** |
| Client business tools | none: the signed business MCP credential (D3) is bound to the internal agency workspace and its Super Admins (`o.kind = 'agency'`), and the database refuses a client employee an internal profile | **Not built.** A client tier needs its own design |

## 2. What is left, in order, after the internal A4 acceptance

Each needs its own approval; none is started by this document.

1. **Reconcile the hosted migrations.** The 2026-10-24 documents say 0084 was missing from the production ledger while 0085 and 0086 were applied. The 2026-10-30 production dry run (read-only) reported nothing pending, which means 0084 has since been applied, but this review did not re-read the ledger. Before anything else: a read-only ledger query, the duplicate-open-job query in `client-ai-onboarding-release.md`, a verified backup and a rollback plan.
2. **Re-run the sandbox acceptance on the release commit** (the workflow already exists; it needs a push of a branch-scoped ref), so the pass covers the code that would ship.
3. **Capacity and placement.** A separate client-only Hermes runtime beside the internal gateway and the six inference workers on one VPS. The last recorded headroom was about 6 GiB of memory with no swap; every client adds six profiles. Decide the per-client footprint, the number of clients one host takes, and where the next host comes from before the first client, not after the tenth.
4. **Install the separate client-only runtime and the restricted provisioner, unprivileged,** with the pinned base image and overlay reviewed, no Docker socket, no published ports, no agency profiles, and the privileged isolation attestation plus a pinned service credential the portal checks. The worker stays disabled in the portal until the attestation, the credential and migration 0084 are confirmed.
5. **Security review of the client runtime's Hermes version.** The overlay README says the 0.21.5 candidate is not approved for production because upstream's later security fixes are unassessed; the client image is a different pin (0.22.x). Assess the upstream security changes for whichever version ships, and decide upgrade versus accept, before client data is on it (see the results report for this assessment).
6. **Approved role instructions and knowledge for clients.** The portal compiles per-tenant instructions from saved settings and approved knowledge; the approval flow exists. What is missing is the review of the six client role texts as shipped, the knowledge-approval policy for a new client's first day, and the prompt-size budget for the client path (the internal budget was 24 KiB and every internal role exceeded the first 6 KiB limit).
7. **First real client, supervised ("pilot"):** payment cleared in test mode first, then onboarding, then provisioning of six profiles for one friendly client; verify per profile: fresh-session SOUL, identity, complete safe inventory, isolated key, and the portal's Ready state; then one real Chat and one role task each. Anything that fails leaves the employee honestly in Pending Setup.
8. **Client business tools (a separate design, after the pilot).** The signed credential would need a tenant-scoped form (bound to a client workspace and its client users instead of the agency's Super Admins), its own people boundary, rate limits and audit, and a CRM-sync and booking story for what a client's employees may do. None of that exists. Until it does, client employees chat and prepare drafts; they do not read the client's CRM through tools.
9. **Operations:** retries and dead-letter handling in production, rollback of one tenant without touching others, audit-log review, alerting when an employee leaves Ready, and a credential-rotation routine for the per-profile keys.

## 3. What would make this fully automatic

Automatic provisioning needs, at least: steps 1 to 5 done once, a pilot client through step 7, and an on-call answer for step 9. After that the trigger already exists: payment clearance starts the jobs, and the worker (enabled by the same approval that enables the provisioner) creates the profiles. Employees stay in Pending Setup, visibly, until each passes its checks.

## 4. Estimates (implementation versus live readiness)

| Area | Implementation | Live production readiness |
| --- | --- | --- |
| Internal AI Employees (six) | about 90% (model path live-proven by A3; business tools built, tested locally, on the pinned 0.21.5 runtime and in CI) | about 45%: business tools not released, activated or accepted on production; O1, O2 and the account items open |
| Automatic client provisioning | about 70% (jobs, provisioner, states, trigger built and sandbox-passed) | about 10%: nothing client-side runs on production; no real payment, profile or client has gone through it |

These are judgments from the recorded evidence, not measurements.
