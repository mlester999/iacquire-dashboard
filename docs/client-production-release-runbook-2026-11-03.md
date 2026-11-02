# Client onboarding and provisioning: production release runbook (2026-11-03)

Prepared, not executed. **Nothing in this file has been applied to production, merged to master, deployed, restarted or changed on the VPS.** Every step names the approval it needs. Keep every new switch OFF at release.

## 1. What was verified on 2026-11-03

| Check | Result |
| --- | --- |
| Live master | `7598ab73` (read from GitHub); an ancestor of the integration branch, so the release is a **fast-forward**: as of `c8887175` (the tip pushed for CI on 2026-11-03) 36 commits, 416 files (+58,764 / -1,308), four migrations and four rollbacks, no other schema change. Re-count against the live master before the approval: `git rev-list --count master..integration/hermes-bridge-final` |
| Whole migration history (`scripts/rehearse-combined-migrations.mjs`, embedded Postgres) | Sections A to G pass: every file applies in order; each migration applied one at a time on a populated database leaves every earlier row unchanged; schema equals the fresh chain; every rollback runs newest first and forward again; the reserved 0084 slots in; the hosted procedure from **the production ledger as it is now (108 rows, 0115 to 0118 pending)**: backup, dry run lists exactly 0115, 0116, 0117, 0118, each applied with per-step checks, restoring the backup returns ledger 108 |
| Linux CI on `c8887175` | Both workflows passed: the full suite, typecheck, lint and the production build (60 minutes), the pinned Hermes worker checks, the operator scripts, and the two-client real-gateway proof (`hermes-business-mcp-compat`). Runs 41434614732 and 41434614653 |
| Prompt budget | Fixed by priority fitting (section 6): all six roles fit at their ceiling for three differently shaped clients |
| Real pinned gateway, two clients (`tests/hermes-client-business-mcp-pinned-runtime.test.ts`) | 22 tests pass against Hermes 0.21.5 with this repository's overlay: eight profiles (six for one client, the two the other bought), separate keys, credentials, tools and records |
| Reload behaviour of a running gateway | Observed, section 7 |
| Browser and accessibility check of the runtime controls | Section 9 |
| Existing clients | Section 4: nothing starts, switches on or notifies by itself |

## 2. The four migrations (0115 to 0118)

All are additive or a narrow function replacement. **They are backward compatible with the code that is live now**, so they can be applied BEFORE the release (expand first, release after) and the live site keeps working while they are in.

| Migration | What it does | Rollback | Refuses when |
| --- | --- | --- | --- |
| `0115_client_business_credentials` | New table `agent_business_credentials` (ledger of a client employee's tool credentials), three indexes, a guard trigger, row-level security, all privileges revoked from the application roles | drops the table | it holds credentials |
| `0116_chat_message_evidence` | One nullable column `chat_messages.evidence jsonb` and a shape check (validated after it is added) | drops column and check | the column holds evidence |
| `0117_company_knowledge_revisions` | Two nullable columns on `company_knowledge`, one on `knowledge_documents`, new table `company_knowledge_revisions` with row-level security. The application role may SELECT and INSERT its own workspace's revisions under policies (declared in the rehearsal as the one intentional insert); it can never update or delete one | drops the table and columns | the history holds rows |
| `0118_audit_logs_purge_detach` | Replaces the function `app.audit_logs_append_only()`: the audit trail stays append-only except that, while a purge has declared itself, a row may lose its `agent_instance_id` and nothing else. Fixes a defect (no provisioned client could ever have been purged) | restores the previous function | never |

Apply with the runner's own `--only <name>`, one at a time, in this order, each after its dry run; a failed post-check stops the sequence. `docs/demo-external-registration.md` and `docs/roadmap/phases-3-to-7/release-record-2026-10-26.md` have the connection details the earlier release used.

## 3. Restore point plan (the hosted project is on the Supabase Free plan: no managed backups)

A real, **independently verified** restore point comes first and is its own approval (it reads the production database with the production connection string and writes a dump that contains client data to disk).

1. **Take it.** `pg_dump -Fc --no-owner` of schemas `public` and `app`, run from the machine that holds the production connection string, into a folder outside the repository that only the operator can read. Record the file name, the size, the UTC time and the number of entries `pg_restore --list` prints. (The 2026-10-26 release produced 2,703,012 bytes and 5,331 entries.)
2. **Prove it restores.** Restore it into a throwaway local PostgreSQL cluster of the same major version as the project (the project reports 17.11; the 2026-10-26 proof used 18). A handful of benign "already exists" errors is normal; an error about a table, a policy or a function is not.
3. **Run the real runner on the copy.** `scripts/migrate.ts --dry-run` against the restored copy must list exactly the four migrations; apply them there with `--only`, one at a time; run the production post-checks against the copy (ledger rows, row-level security on every table, row counts of the workspace tables, the fingerprint of what the application role can see for every real user, taken before and after).
4. **Only then** apply to production, in the same order, with the same post-checks (read-only), and keep the dump until the release has been verified and the founder says it can go. Delete the throwaway cluster.
5. **The way back.** The rollbacks come first (they are tested above and keep data); restoring the dump is the last resort because anything written after it is lost.

Not provable from here: the production database's actual size and the restore time; both are measured in step 1 and 2.

## 4. No existing client is started, switched on or told anything

Every behaviour added by this release is behind a switch whose default is off. Nothing changes for a client that is already using the product until a switch below is moved.

| Behaviour | Switch (default) | What it holds back |
| --- | --- | --- |
| Launch, calendar and booking-reminder **notices** to owners, admins, hosts and iAcquire | `LAUNCH_NOTIFICATIONS_ENABLED` (off); a workspace's `launch_notifications` feature overrides it either way | "100% ready", "needs another look", "needs something from you", a stalled step, a calendar that stopped passing, a booking still waiting for a person. The record in the audit trail is written regardless |
| **Automatic final checks** (one read-only check per ready employee, started by itself) | `LAUNCH_AUTOMATION_SINCE` (unset: no workspace) | Starts only for a workspace whose onboarding finished on or after the date. The panel's own "run the checks" button is unaffected |
| Customer-facing activity held until setup is finished | `CLIENT_CUSTOMER_FACING_GATE_ENABLED` (off) | Only tightens: a client may switch automatic replies, the website chat, reminders, AI booking and the public page on only after the setup payment and a verified calendar |
| Automatic industry CRM | `CLIENT_CRM_AUTO_SETUP_ENABLED` (off) | A standing automation under a named Super Admin |
| Client business tools and proposals | `HERMES_CLIENT_BUSINESS_MCP_ENABLED`, `..._PROPOSALS_ENABLED` (off) and each workspace's own switch | The tier |
| Containment of a removed client's runtime profile | `HERMES_PROVISIONER_DEPROVISION_ENABLED` (off) | A worker never receives a containment job |
| Client provisioning | `HERMES_PROVISIONER_ENABLED` (off) and the verified-gateway pin | Nothing is claimed |
| Scheduler jobs (`provisioningWatchdog`, `launchWatch`, `bookingConfirmationWatch`, `clientBusinessCredentialExpiry`) | `SCHEDULER_ENABLED` (off) | They never run |
| Every customer-facing activity | its own switch, **off** in the schema for a new workspace (`tests/customer-facing-defaults.test.ts`) | Nothing reaches a customer |

Also true, and tested: a new client's six employees are separate identities (a client's Zeng is a separate employee from iAcquire's Zeng: own profile name, keys and credential, and the database refuses to map it onto an `iacquire-` profile); an employee a client did not buy or has switched off gets no job, no profile and no place in the capacity count (`tests/provisioner-claim-gates.test.ts`).

**One thing to decide, not changed:** the website chat widget starts with its AI answering and with booking through it switched ON *inside a chat that is itself OFF*. The whole chat flow assumes it (eleven chat tests fail if they start off). Starting them off is a product decision; see the status document, section 6.

## 5. Image and portal compatibility

There is no client provisioner image in production yet, so there is no mixed-version window to manage: the worker image is built from the same commit as the portal release.

| Portal | Worker | Result |
| --- | --- | --- |
| This release, every switch off | image built from this commit | Manifests are the 17-key manifests the worker has always accepted |
| This release, tier ON | an image built before this release | The worker refuses the two new optional manifest keys (`invalid_manifest`, permanent). Never turn the tier on before the image is rolled out |
| This release, containment ON | an image without `revoke` | A containment job would be refused. Never turn it on before the image is rolled out |
| Either | any | `tests/hermes-provisioner-code-parity.test.ts` and `tests/hermes-client-business-mcp-delivery.test.ts` read the worker's own key sets, so the two sides cannot drift in one commit |

## 6. The prompt budget (fixed)

The restricted inference path pins 20,000 characters of instructions and 24,576 bytes for the whole message. A client can fill every answer to its longest, so the sum of the parts used to be too large (the Lead Hunter's run instructions by about 1,430 characters; every chat with the workspace snapshot by 5,000 to 8,000). Now:

1. **Never shortened:** the protected agency policy, the employee's role and operating standard, the client's business description, services, company rules, "never promise", escalation rules, the live booking and pipeline facts, the snapshot's framing and the state of every area, and the person's own message.
2. **Shortened in this order, each only as far as needed, and only when the parts do not fit:** the snapshot's record samples (it keeps how many exist and says detail was left out); then the approved company knowledge, most important first (prices, who the business is and what it sells, hours, policies, escalation, the employee's own notes, procedures, FAQ, tone, reference documents), with a line naming what was left out and telling the employee not to guess it; and last the client's own longer free-text answers inside the employee's configuration, each keeping its opening sentences (never fewer than 320 characters, 160 for style preferences) and marked `[...]`, with one note saying so. History is dropped first of all, oldest turn first.
3. **Typical clients are unchanged, byte for byte.** The result is recorded in the audit trail as `workforce.client_prompt_fitted` (block names and sizes only) when a chat had to be shortened.

Evidence (`tests/client-prompt-budget.test.ts`, 22 tests, three clients with every answer at its longest, knowledge at its limit, live facts at their cap): every role's run instructions are at most 19,955 characters and fit a full-length first message; every role's chat is at most 19,993 characters; a full conversation (eight turns) fits by keeping the newest turns. **The one corner that cannot be fitted by construction:** a Lead Hunter with every answer at its longest AND a message of 2,000 characters in a script that takes three bytes a character (about 6,000 bytes) leaves less room than its protected parts need; the fit then says `fits: false`, the restricted path would refuse it (safe), and the audit row records it. The same applies to any client whose own answers are in such a script, because the byte budget binds before the character cap. The remedy for such clients is a larger byte budget (the earlier D2 cost decision), not more shortening.

## 7. Does a running gateway need a restart? Observed on Hermes 0.21.5 (real gateway, this repository's overlay)

| Change to a running gateway's profile | Applied without a restart? |
| --- | --- |
| **Install the business tools** (an `mcp_servers` entry, the toolset, a credential) in a profile that is already loaded | **No.** Not loaded after 60 seconds; loaded after a restart |
| The same for a **new profile** created with the tools already in its configuration | **No for the tools.** The profile is discovered within the rescan and answers, but has no business tool until the gateway restarts |
| **Remove the business tools** from a profile | **Yes.** They leave the inventory within the gateway's profile rescan (every 30 seconds; observed inside the 90 seconds the test allows) |
| **Contain** a profile (replace its API key, tools-off policy, no credential; what the worker's `revoke` does) | **Yes.** The old key is refused (401) and the new one accepted within the rescan; no tool remains. The worker's 90-second wait is long enough |
| **Revoke a credential in the portal** | **Immediately and with no gateway change:** the portal checks the credential on every call (tested through Hermes' own MCP client) |

So: **turning the tier ON for a workspace needs one gateway restart; turning it OFF, revoking and containing do not.** Not tested: Hermes has a `/reload-mcp` command; whether the API server accepts it for one profile without a model is unknown and would be worth one experiment before the pilot.

### Supervised restart procedure (its own approval, on the client-only gateway, never the internal one)

1. **Before.** Read the runtime controls: every employee of the workspaces to be switched shows what it is waiting for; no chat or job of any client is in flight that cannot be repeated (the restart interrupts every tenant's chat on that gateway for the seconds it takes); take the window outside the clients' working hours; the portal's `HERMES_PROVISIONER_ENABLED` stays on so that nothing queues unseen.
2. **Switch the tier on** for the one workspace (runtime controls, with the reason). Its employees read "not online" and each synchronization writes the profile and then fails its check as expected (`runtime_tool_policy_unverified`, three attempts), keeping the credential it wrote.
3. **Restart the client gateway** (the unit named in the operator guide), wait for its health route, then for every profile's complete inventory.
4. **Press Synchronize** for the workspace. Each synchronization now passes and registers the credential's hash; the portal's own health check puts each employee online.
5. **Verify** with the pilot evidence tool (read-only) and one real read per role during a live turn.
6. **If anything is wrong:** switch the tier off again (no restart needed), which removes the tools within a minute; the credentials end in the portal at once.

## 8. B7-P2, the database isolation hardening, reviewed (not built, not applied)

**What it would add:** a trigger on `agent_instances` that refuses mapping an agency employee to an attested client-only gateway; a trigger on `hermes_gateways` that refuses setting the attestation while an agency employee is mapped; same-tenant composite foreign keys across the provisioning tables; and column-level read limits on `agent_provisioning_jobs` (`lease_token`, `lease_expires_at`, `result_reference`, manifest hashes).

**What already stands without it:** the claim refuses any gateway that has an agency employee mapped (`ELIGIBLE_JOBS`), the attestation script refuses the same state before it writes, the database refuses a client employee on an agency profile name (`reserved_hermes_profile`, 0002), an employee mapped to a gateway without its profile or with a profile that does not match the gateway (`hermes_gateway_requires_profile_mapping`, `hermes_profile_gateway_mismatch`, 0034), and a second agency organisation (`organizations_single_agency`). Every application query names the workspace.

**The exact unresolved risk:** all of the above are application-level or per-field rules. Someone with **direct write access to the production database** (the service role or the SQL console) could map an agency employee onto the client gateway, set the attestation columns by hand, or point a provisioning row at another tenant's configuration version or credential. The claim would still refuse to hand out provisioning jobs for a mixed gateway (it is fail-closed), but chat for the mapped agency employee would be routed there, and cross-tenant references would not be refused by the database. Nothing in the application can produce these states. The risk is therefore an operator or console mistake, or a compromised service credential, not a user-reachable path.

**Why it was not built:** `tests/hermes-provisioner-attest.test.ts` ("a gateway the attestation has just approved is claimable, and one it refused stays unclaimable even if the columns are forced") forces the attestation columns while an agency employee is mapped, to prove the claim's own guard. The second trigger would refuse that setup.

**The safest compatible fix, in three independent, separately approved migrations:**
1. The two triggers only (no data rewrite, no foreign keys). The two forcing tests disable the new trigger inside their own transaction (`alter table ... disable trigger`) to reach the claim's guard, so **both layers stay and both stay tested**; the assertion of the test does not change.
2. Composite same-tenant keys, each added `NOT VALID`, validated only after a read-only preflight reports zero violations on production.
3. The column-level limits, last, after confirming nothing in the application reads those columns as the application role.

Recommendation: do (1) before the supervised pilot only if the founder wants the console-mistake risk closed first; the pilot itself does not depend on it.

## 9. Runtime controls panel: browser and accessibility check

On the development preview (`/dev/runtime-controls-preview`, sample data, development only): the 404 and 500 messages seen earlier were **not product errors**: they came from earlier development servers (one run with the production environment so `/dev` was hidden, one that crashed when the disk filled, and their dead hot-reload sockets). The current page loads with every resource at 200 and no console error. At 375 px: no horizontal overflow and no tap target under 32 px; the header was stacked (the description now sits under the title). Dark mode, page and confirmation dialog open: **0 accessibility violations** (the automated tool lists colour contrast on the gradient background and a Radix hidden-focus pattern as "cannot be verified automatically", as on the other previews). Light mode reported two issues, both in the preview's own wrapper (no banner landmark, no heading), fixed; light mode was not re-run after that fix. Not checked in a browser: the real admin page behind a Super Admin sign-in.

## 10. Real client-only runtime acceptance (what is proven, what only a real runtime can prove)

| Required proof | Proven now, and where | Needs the real client runtime |
| --- | --- | --- |
| Six separate profiles for one entitled six-role client; a second client isolated | Real gateway, real MCP client: eight profiles, distinct names, keys, credentials; a second client's key and credential cannot read the first's records (pinned-runtime test, CI job `hermes-business-mcp-compat`) | Provisioned by the real restricted worker on the VPS |
| Unique keys, memory, SOUL, knowledge | Keys and credentials proven above; the manifest's SOUL and knowledge are per employee (`tests/client-provisioning-chain-acceptance.test.ts`, `tests/client-role-text-digest.test.ts`) | The worker writing real SOUL files and the gateway's own memory directories |
| Correct role-specific tools | Real gateway inventory per role: exactly its reviewed business tools; web research for the Lead Hunter alone | The same on the production image |
| Real model inference; authorized business-data reads | Reads through Hermes' own MCP client with a live turn: own records only, refused without a turn and after revocation | A real model call with the provider key held only on the VPS |
| Scheduling and calendar access | Synthetic acceptance (`tests/client-launch-acceptance.test.ts`) | A real calendar connection |
| Approval-required actions blocked | No write, proposal, message or booking tool is registered for any role while the proposals phase is off; approvals are portal-side | A person approving in the pilot |
| No unintended customer contact | Customer-facing switches start off; the gate holds them; the acceptance run sends nothing | The pilot's own check that no message left |
| Retries, synchronization, recovery | Worker and portal tests; containment and credential revocation need no restart | A real failed attempt recovering on the VPS |
| Real health verification and readiness | The portal's health check against a real gateway for the agency tier (C6); the launch judge on synthetic clients | The same for a client profile on the VPS |

The Docker-based acceptance (`hermes-client-acceptance.yml`, branch `codex/hermes-gha-acceptance`) last passed on 2026-10-26 against the earlier worker; it is the way to prove the real provisioner image end to end in CI before the VPS, and it needs to be re-run on this code (it runs from that branch, not this one).

## 11. Switch by switch: how to turn it on, what to check, how to turn it back

Every switch is an environment setting of the portal (or, where noted, a workspace setting in the runtime controls). "Back" means the previous value, which is the safe state. Nothing below needs a database change.

| Switch | On | Check right after | Back |
| --- | --- | --- | --- |
| `CLIENT_CUSTOMER_FACING_GATE_ENABLED` | `true` | A test client that has not paid cannot switch the website chat on (the refusal says "Finish setup first"); the agency's own workspace is unaffected | `false`; nothing already on is touched |
| `LAUNCH_AUTOMATION_SINCE` | the release time (ISO) | Only a workspace whose onboarding finished after it gets automatic final checks; an older client's panel shows none started | unset |
| `LAUNCH_NOTIFICATIONS_ENABLED`, or `launch_notifications` on the pilot workspace only | `true` / on | The pilot's owner receives exactly one "needs something from you" notice and later one "ready"; no other workspace receives anything | `false` / off |
| `HERMES_PROVISIONER_ENABLED`, `..._GATEWAY_ID`, `..._TOKEN`, `..._MAX_PROFILES` | as the operator guide says | The preflight (read-only) reports the pin, the token and the capacity; the worker's claim is empty with no client paid | `HERMES_PROVISIONER_ENABLED=false` |
| `HERMES_CLIENT_BUSINESS_MCP_ENABLED` + the workspace's switch (runtime controls) | on, with the supervised restart (section 7) | Every profile's inventory shows exactly its role's tools; one live read per role; the employee is online | the workspace switch off (no restart), then the deployment flag |
| `CLIENT_CRM_AUTO_SETUP_ENABLED` | `true` | A paid client's questionnaire submission applies the matching industry CRM once, under the named Super Admin; nothing else is created | `false`; what was applied stays and can be archived |
| `HERMES_PROVISIONER_DEPROVISION_ENABLED` | `true`, only after the image with `revoke` is out and a synthetic profile was contained | A contained synthetic profile's old key is refused and its tools are gone | `false` |
| `SCHEDULER_ENABLED`, `CRON_SECRET` | last | The four new jobs report their counts and write no notice to a client that has launch notices off | `SCHEDULER_ENABLED=false` |

Rollback of the release itself, in order: switch the switches off (no data change); redeploy the previous production deployment recorded in the completion checklist (read it again before use: it moves with every release); the four migrations are additive, so they stay in place and need no rollback for the previous code to run; the rollbacks and then the restore point (section 3) are for a migration that is itself at fault.

## 12. Order of approvals

1. **Restore point:** take, verify and restore-test it (section 3).
2. Apply migrations 0115 to 0118, one at a time, then release to master and production with every switch off (a fast-forward of `integration/hermes-bridge-final`).
3. Runtime side: capacity and placement, backups of client profile data, then the worker image on one canary profile.
4. The switches in this order, each reversible: `CLIENT_CUSTOMER_FACING_GATE_ENABLED`; `LAUNCH_AUTOMATION_SINCE` (the release time) and `LAUNCH_NOTIFICATIONS_ENABLED` for the pilot workspace; `HERMES_PROVISIONER_ENABLED` with the gateway pin and `HERMES_PROVISIONER_MAX_PROFILES`; the business-tool tier (with the supervised restart); `CLIENT_CRM_AUTO_SETUP_ENABLED`; containment; the scheduler.
5. The supervised pilot: payment cleared, onboarding completed, native CRM and calendar configured, six roles configured, entitled profiles provisioned, real tools verified, role-specific acceptance, a genuine 100% Ready to Launch. Controlled test data first; no real customer message or booking without separate approval. Stop rules are in `docs/client-pilot-package-2026-11-01.md`.
