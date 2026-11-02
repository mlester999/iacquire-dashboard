# Client onboarding and six-employee provisioning: milestone status (2026-11-02)

The application side of the milestone (a paying client completes one guided onboarding and gets six working, tenant-isolated AI employees, shown as Ready to Launch only when everything that applies has really passed) is built and tested on synthetic clients, in Waves 1 to 9. **Nothing here is live.** The client-only Hermes runtime and its provisioner have never run for a client, no worker image has been built from the worker changes in these waves (reliability, containment, business-tool delivery), migrations 0115 to 0118 are not applied to production, the scheduler is off, and every behaviour-changing switch is off. Read "Proven, and not proven" before treating any line below as production acceptance.

## 1. What each wave built

| Wave | Commit | What it added |
| --- | --- | --- |
| 1 | `413d65aa` | Provisioning that recovers and starts itself (requeue, claim hardening, payment and pause re-checks, first health check by itself, a watchdog), the industry CRM applied automatically (switch off), calendar verification before anything goes live |
| 2 | `fda69da7` | The questionnaire asks each thing once and uses every answer; the host is chosen by a person, hours are never invented; region and sales-stage drafts; an honest launch judge, round A |
| 3 | `cb133a13` | The client business-tool foundation: a credential ledger, the tool builder, ability enforcement, reviewed operator scripts for the client-only runtime |
| 4 | `c84e7051` | A plan change really configures and provisions an employee; the launch history is persisted; the client business-tool route opens for reads; a review says what it examined |
| 5 | `90fc4ee0` | The launch panel takes the safe next steps; an employee can propose changes that wait for approval; replies are marked by what they are; settings edits and calendar drift reach the right place |
| 6 | `70630b82`, `708affb1` | The launch panel live and accessible; client tool inventory and credential lifecycle (verify, rotate, expire, revoke); evidence labels in chat and approvals; knowledge revisions (migration 0117) that keep held edits from replacing approved text |
| 7 | `e0e742e6`, `22017093` | Re-verification and an autonomy gate (an employee goes autonomous only when its final check passed for its current configuration); every client's launch state visible to the agency; honest customer replies and booking confirmation; read-only preflight and pilot-evidence tools |
| 8 | `f216d4f3` | Containment of a removed client's runtime profile; fleet synchronization; the customer-facing activity gate (all default off); client role texts pinned and budget-checked; migration 0118 (a purge defect, section 4) |
| 9 | `ede6f700` | The worker side of the client business-tool credential; the agency's one place for runtime controls; the plan-to-employees table; the two-client provisioning chain acceptance test |

## 2. The nine things a paying client should get

1. **One guided questionnaire** (version 3): built; plan-aware (an employee outside the plan is not asked about); booking policy and lead targeting drafted from the client's own words.
2. **Approve business information, rules, services, goals and knowledge:** built; a held edit never replaces approved text; the review step names what is missing.
3. **Appointment hosts, time zones, hours and types during onboarding:** built; a person chooses the host (only the person who presses the button), the client's own suggested hours are applied only with their approval, types are drafted from the answers, and a calendar goes live only after its checks pass.
4. **Authorize integrations:** the panel is honest about channels and connections and what still waits on iAcquire. The Google and Microsoft calendar apps are not set up in production (approval 14).
5. **CRM, pipeline, calendar and resources configured automatically:** the industry CRM is applied by itself behind a switch (off); the calendar is drafted and then verified.
6. **Six tenant-isolated employee identities:** each employee has its own `c-<client>-<role>` profile name, its own key and its own business-tool credential; the chain acceptance test proves no profile, key or word crosses clients.
7. **Entitled employees provisioned and verified automatically:** provisioning waits for the cleared setup payment, is requested once per employee in the plan, recovers from a failed attempt, and is followed by the portal's own health check and one read-only final check per role.
8. **Actual progress, errors and remaining actions:** the launch panel states each item's real state and owner; the agency sees every client's state; stalls and regressions raise a single notice.
9. **100% Ready to Launch only after every applicable technical and functional check passes:** the judge treats a queued job, a drafted calendar or a created profile as not done, and an employee goes autonomous only after a passing check for its current configuration.

Customer-facing activity stays off until setup is finished: the gate (off by default) holds the five switches that reach a client's customers until the setup payment and, for calendar activity, a verified calendar.

## 3. Proven, and not proven

**Proven (synthetic clients, embedded database, simulated worker and gateway):** the whole provisioning chain for two isolated clients (`tests/client-provisioning-chain-acceptance.test.ts`), questionnaire to 100% ready for a six-role and a five-role client (`tests/client-launch-acceptance.test.ts`), containment, fleet sync, the gate, the plan table, the runtime controls, the business-credential delivery on both sides, and the migrations with their rollbacks. The Python provisioner suite (151 tests). Linux CI (the full suite, typecheck, lint and the production build) was green for Waves 1 to 6; Waves 7 to 9 were pushed after that, and their results are the GitHub runs for `22017093`, `f216d4f3` and `ede6f700`, which this file does not track.

**Not proven, and each is a gate before a real client:**
- The restricted provisioner has never created a real client profile, and the client-only runtime has never run a client employee.
- **A running gateway needs a restart to load a profile's business-tool entry (observed for the agency tier, assumed for the client tier).** On the pinned Hermes 0.21.5 gateway with this repository's overlay, the A4a hot-reload test (`tests/hermes-business-mcp-hot-reload.test.ts`, which runs only in the pinned-runtime CI job) observed that an `mcp_servers` entry, toolset and credential written into a live profile are **not** picked up by the running gateway and are picked up after a restart. The client tier uses the same mechanism and image but has no test of its own. So a synchronization that installs the tier will end `runtime_tool_policy_unverified` (after its three attempts, in front of a person) until the client gateway is restarted, a window that interrupts every tenant's chat on that gateway, and then **Synchronize** completes it; the credential the worker already wrote is kept, never rotated, and the portal accepts no call from it until the completion registers it. Whether a replaced key and the tools-off policy (containment) also need a restart is **not known**: the worker waits, and if the gateway has not applied them reports `revoke_not_applied`, and the portal changes nothing until the worker proves it.
- That two client profiles in one gateway each send only their own credential: the pinned-runtime test for this is **not written** (`docs/hermes-client-business-mcp-2026-11-01.md`, section 4).
- Real inference quality of the six client employees with a client's own knowledge: no real model call was made for a client.
- A real client's payment, a real calendar connection, real message channels, a real customer conversation.
- Capacity: the headroom of the client host is unmeasured.
- Production data: nothing was run against the hosted database, and the preflight and pilot-evidence tools have never been executed.

## 4. Findings this work produced

1. **Purge defect (fixed in migration 0118, not applied):** no provisioned client could ever have been deleted, because the append-only audit table refused the `ON DELETE SET NULL` that deleting an employee needs. Nothing was lost (the purge is all or nothing and has never been switched on).
2. **Prompt budget (open, a founder decision):** with the longest answers the questionnaire accepts, the Lead Hunter's per-run instructions are over the restricted worker's 20,000-character cap, and a chat message with the workspace snapshot is over it for every role (`docs/client-role-texts-review-2026-11-01.md`, section 5, with three options). Typical answers are far shorter.
3. **B7-P2 (database isolation hardening) is not built:** its trigger would contradict `tests/hermes-provisioner-attest.test.ts`, which builds that state on purpose to prove the claim-time guard. The same invariant is enforced at claim time and at attestation.
4. **Provisioning with the business tier already on:** a first provision never carries the tier (an id needs an existing profile); the agency presses Synchronize in the runtime controls, or the tier switch opens the synchronizations.
5. **A repo guard worth knowing:** a textual test keeps the signing secret's variable name to the environment schema and the credential module; a read-only tool that merely classifies an env file takes the name from that module's constant.

## 5. Approvals still needed (each is yours; nothing here has been done)

1. **Apply migrations 0115, 0116, 0117 and 0118 to production,** each before the code that reads it is released. The hosted project is on the Supabase Free plan with no backups, so a restore point comes first. Rollbacks exist and are tested. 0118 must be applied before any provisioned client is deleted.
2. **Turn on the client business-tool tier:** `HERMES_CLIENT_BUSINESS_MCP_ENABLED`, later the proposals phase, then per workspace (runtime controls). Only after the pinned-runtime proof.
3. **Roll out the new client-only worker image** (reliability, containment, business-tool delivery): a canary profile first, a gateway **restart** window (the tier's tools load only after one, and it interrupts every tenant's chat on that gateway), VPS egress to the portal verified, then the pinned-runtime proof.
4. **Turn on containment** (`HERMES_PROVISIONER_DEPROVISION_ENABLED`) only after the worker image that contains `revoke` is out and proven on a synthetic profile.
5. **Enable the automatic industry CRM** (`CLIENT_CRM_AUTO_SETUP_ENABLED`): a standing automation under a named Super Admin's authority.
6. **Turn on the customer-facing gate** (`CLIENT_CUSTOMER_FACING_GATE_ENABLED`), and decide whether it should extend to the places listed in `docs/client-lifecycle-containment-and-gate-2026-11-02.md` (website, forms, workflows, social, proposals, retention, campaigns, review requests).
7. **Enable the scheduler** (`SCHEDULER_ENABLED`, `CRON_SECRET`, `SCHEDULER_JOBS_ONLY`) with the new jobs (`provisioningWatchdog`, `launchWatch`, `bookingConfirmationWatch`, `clientBusinessCredentialExpiry`). It has never run in production.
8. **Choose the capacity number and host plan** for the client runtime (`HERMES_PROVISIONER_MAX_PROFILES`, any larger VPS): a cost and placement decision with no measured headroom.
9. **Backup location and encryption key holder** for client profile data, then run the backup and restore scripts on the VPS (a new account or cost).
10. **Run any privileged script on the VPS** (secrets, preflight, gateway attestation, tunnel overlay, egress proxy: the proxy changes what the Lead Hunter's web tool can reach).
11. **Define which purchased plan includes which employees.** The table mechanism exists (`src/lib/plan-employees.ts`) and every entry is all six; there is one product (`launch-2026-10`), no plan catalogue.
12. **Review the customer-facing strings** listed in section 6, item 18.
13. **Policy calls:** whether agency activation approval needs 100% launch; whether an autonomous employee drops to approval-required after a customer-facing edit (`autonomy_reconfirm`, off).
14. **Google and Microsoft calendar OAuth apps** in production (verification and env values).
15. **Run the preflight and pilot-evidence tools against the hosted database** (a read-only role), and approve the supervised pilot itself: the friendly client and the written agreement (`docs/client-pilot-package-2026-11-01.md`).
16. **The deprovision purge stage** (irreversible deletion of a profile): set a retention period first; containment covers the interim.
17. **Release the milestone to master and production** as its own gated step (the rollback target stays the deployment recorded in the completion checklist).

**An order that respects the dependencies** (each step its own approval; stop at the first failed gate): (a) the decisions that change what ships: items 11 to 13, the strings and wording questions in section 6, and the prompt-budget choice (section 4, item 2); (b) a restore point, then migrations 0115 to 0118 (item 1), then the release to master and production with every switch still off (item 17); (c) the runtime side, separate from the release: capacity and placement (item 8), backup (item 9), privileged scripts (item 10), then the new worker image on one canary profile in a restart window (item 3); (d) the pinned-runtime proof for the client tier, a test that is still to be written and can only be iterated in the pinned-runtime CI job; (e) the switches, one at a time and each reversible: the business-tool tier (item 2), containment after a synthetic revoke has been proven (item 4), the automatic CRM (item 5), the scheduler (item 7), the customer-facing gate (item 6); (f) the supervised pilot (item 15), and the purge stage only after it (item 16).

## 6. Decisions found while building (each has a safe default in code; none blocks the work)

1. The consultation calendar spec (video, no meeting tool, no join text) now fails the connections check: add join text or connect a meeting tool.
2. A client who wants appointments must give opening or bookable hours before approving the questionnaire.
3. A workspace whose only open item is a channel iAcquire must connect reads "Provisioning" (owner iAcquire), not "Action required".
4. Publishing a calendar is stricter for every calendar (hosts need weekly hours, a video type needs a meeting tool or join text, a stated Google or Microsoft busy calendar needs a connected read).
5. The busy-calendar requirement is derived from the CRM setup guide and the questionnaire.
6. Zeng: the brief lists Zeng as each client's Operations Manager; the code keeps Zeng as the agency's own employee and clients name their own. Which is intended?
7. Which purchased plan includes which employees (approval 11).
8. The launch ledger (state-change audit rows, the first "needs you" notice, the "ready to launch" notice, regression notices, agency stall notices after 30, 15 and 60 minutes) is not behind a flag: once released, every non-demo client workspace starts getting them. Confirm, or ask for a default-off switch.
9. Existing clients will see different Setup wording after release (an in-progress item older than its threshold becomes "Action required", owned by iAcquire).
10. Disabling an employee needs a reason of 5 or more characters for every caller, and revokes its client business-tool credentials; re-enabling issues a new one only when the profile is next synchronized.
11. The "last approved answers" used while a questionnaire edit is pending are reconstructed from what is applied.
12. A client approval created by an AI employee's proposal stays approved/blocked if the workspace switch is turned off before a person approves it.
13. Tunable numbers: at most 25 waiting proposals per client employee, 30 tool calls a minute per person, a 48-hour credential rotation overlap, a 30-day expiry warning.
14. The "invite my team" button sends an invitation to each address the client listed (one press, the addresses named first): the one outbound step the launch panel can trigger. Confirm.
15. The "retry the industry CRM setup" button is shown to someone who can manage the profile and never while there are unapproved edits: should clients see it at all?
16. Settings edits reach employee instructions, but role answers derived from the same answers stay "behind" until the "Update my employees" step.
17. **Autonomy gate:** an employee can be switched to autonomous only when its final check passed for its current configuration. This applies to every non-demo client workspace even with the feature off; the extra rule that drops an employee to approval-required after a customer-facing edit is behind `autonomy_reconfirm` (off).
18. **Customer-facing strings to review:** the reserved message ("We've reserved {time} for you. The team will confirm it shortly. Reply here if you need to change it."), the host-confirmed message ("Good news: {time} is now confirmed. We look forward to seeing you. Reply here if you need to change it."), the unchanged message for types that need no confirmation ("You're booked for {time}. We look forward to seeing you. Reply here if you need to change it."), the staff chat line, the held-reply escalations and the restricted-topic note, the inbox draft warning, the change-request card, and the KPI labels "Appointments booked" and "Awaiting host confirmation".
19. The restricted-topic guard reads the saved answers: an unapproved edit that removes a restricted topic relaxes the guard immediately.
20. The launch watch records a silent first ledger row for each existing client (no owner notice); its first pass still sends the one-time agency stall and calendar-drift notices.
21. Pilot evidence: the snapshot self-check is strict, so a snapshot taken while the worker writes audit rows may need retaking; the outbound email queue cannot be observed per workspace.
22. A held onboarding version for an employee that still works does not block 100%; decide whether 100% should wait for the reviewer.
23. Provisioning in a workspace already in the business-tool tier: the tools arrive by a synchronization (section 4, item 4).
24. The prompt-budget breaches (section 4, item 2): fit by priority on the restricted path (recommended), lower the longest answers, or raise the cap and reopen the budget decision.

## 7. Acceptance matrix (synthetic evidence only)

Every row is proven on synthetic clients with the embedded test database, a simulated worker and a simulated gateway. The right-hand column is what the row does **not** show; that column is the work left for the supervised pilot. None of this is production acceptance.

| Acceptance criterion | Evidence (files under `tests/` unless noted) | Not shown |
| --- | --- | --- |
| Two or more isolated client organizations | `client-launch-acceptance`, `client-provisioning-chain-acceptance` | A second real organization on the real runtime |
| A cleared setup payment triggers provisioning, once, for the plan | `client-provisioning-chain-acceptance`, `client-launch-acceptance` (replayed payment event), `purchase-intents`, `provisioner-claim-gates` | A real payment provider's event |
| CRM and calendar created automatically | `client-crm-provisioning` (behind its switch), `client-launch-acceptance` (calendar through its own checks), `launch-intents` | A real client's data; the CRM switch is off in production |
| Hosts, availability and appointment types | `onboarding-host-from-answers`, `launch-host-choice`, `onboarding-scheduling-rules`, `onboarding-scheduling-drafts`, `client-launch-acceptance` (a client's own time zone, no time offered twice) | Real Google or Microsoft busy calendars |
| Six distinct employee identities | `client-provisioning-chain-acceptance` (profile name, key and credential per employee), `hermes-provisioner`, `hermes-provisioner-attest`, `services/hermes-provisioner/test_worker.py` | Six real profiles on a real gateway |
| Entitlement-aware activation | `plan-employees`, `onboarding-plan-awareness`, `client-launch-acceptance` (a five-role client, a client without the appointment employee) | A real plan catalogue (one product exists) |
| A dedicated Hermes profile per employee | `hermes-provisioner`, `hermes-provisioner-route-acceptance`, `provisioner-claim-gates`, the Python suite (151 tests) | The real gateway creating a client's profile |
| Tenant and credential isolation | `hermes-client-business-mcp-auth`, `hermes-client-business-credential`, `hermes-client-business-mcp-permissions`, `hermes-client-business-mcp-guards`, `hermes-client-business-mcp-limits`, `client-business-credentials-migration`, `hermes-client-business-mcp-delivery`, `client-provisioning-chain-acceptance` | Two client profiles on one real gateway (the pinned-runtime test is not written) |
| Employee-specific knowledge | `client-launch-acceptance` (each employee gets its own business's instructions and nothing from the other client), `client-role-text-digest`, `client-prompt-budget` (with the over-budget finding recorded) | Real model behaviour with that knowledge |
| Real, authorized, read-only capabilities | `hermes-client-business-mcp-permissions`, `-inventory`, `-route`, `-turn`, `launch-verification-inputs`, `launch-sweep` (one read-only final check per role) | The real gateway's tool names (assumed equal to the portal's) |
| Human approval for sensitive actions | `hermes-client-business-mcp-proposals`, `autonomy-reconfirm`, `runtime-controls-actions` (Super Admin, written reason) | The approval screens in a signed-in browser |
| Retries, recovery, no duplicate provisioning | `provisioning-requeue`, `provisioning-failure`, `provisioning-watchdog`, `provisioner-claim-gates`, `fleet-sync`, `client-provisioning-chain-acceptance` (a failed attempt that is retried and completes, replayed completions and requests), `client-launch-acceptance` (a half-failed provisioning shown as it is, recovered without touching the others) | Recovery from a real worker or gateway outage |
| Accurate readiness, 100% only when every check passed | `launch-readiness`, `launch-readiness-server`, `launch-ledger`, `launch-watch`, `client-launch-acceptance` | A real client's live rows; the preflight and pilot-evidence tools (`client-provisioning-preflight`, `client-pilot-evidence`) have never run on the hosted database |
| Containment and deletion of a removed client's runtime | `hermes-provisioner-deprovision`, `offboarding-runtime-profiles`, `audit-purge-detach-migration`, `client-provisioning-chain-acceptance` (one employee contained, its siblings and the other client untouched), the Python `RevokeTests` | A real profile revoke on the pinned gateway |
| Customer-facing activity held until setup is finished | `customer-facing-gate`, `client-launch-acceptance` (nothing sent, booked or published) | The gate switched on in production |
