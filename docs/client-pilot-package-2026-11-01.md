# Supervised pilot: one real client, six employees (prepared 2026-11-01, not started)

**Status: prepared for a separate approval. Nothing here has been run on production, and nothing in this file starts it.** It turns section 2 of `client-provisioning-dependencies-2026-10-31.md` (item 7) into a checklist that can be approved, stopped and audited. The application side it relies on is described in section 0 of that file and is verified locally on synthetic clients; the client-only Hermes runtime it needs is **NOT RUN** anywhere.

## Preconditions (each is a decision for the founder, not for the build)

1. **A friendly client** who agrees in writing to a supervised trial, with no customer-facing automation. Test mode for their setup payment first.
2. **The client-only runtime exists** beside the internal gateway: restricted provisioner installed unprivileged, pinned image reviewed, capacity and placement decided (the last recorded headroom was about 6 GiB with no swap; six profiles per client), and the 0.21.x to 0.22.x security assessment done. Each is its own approval (section 2, items 1 to 5).
3. **Backups and a way back.** Confirm that the hosted database tier's backup and restore coverage is adequate before a real client's data goes in, or record the founder's explicit acceptance of the gap.
4. **Release.** The application commit that carries the launch readiness work is on `master` through the usual separate release approval. When this package was first written no migration was part of it; the milestone has since added migrations 0115 to 0118 (client credential ledger, chat message evidence, knowledge revisions, purge detach), each to be applied to production with a restore point before the code that reads it. See section 5 of `client-onboarding-provisioning-milestone-status-2026-11-02.md` for the full list of approvals and what is not yet proven.
5. **A named person watches** the whole run and can pause employees (the pause switches already exist).

## Sequence

1. Create the client workspace and complete the questionnaire as the client would. Expect: **Questionnaire submitted**, no provisioning job.
2. Record the setup payment (test mode). Expect: exactly the plan's provisioning jobs, once.
3. Watch each profile: the worker leaves its profile and key, the portal's own health check verifies identity, capabilities, restricted toolsets and the complete stable inventory. Expect each employee **Ready** only after that check; a failure shows as **Failed**, names iAcquire as the one to act, and creates no second job.
4. The client walks the panel on **/setup**: choose a host, use or set weekly hours, activate the calendar. Expect the public booking page to stay off.
5. The final checks start by themselves for every ready employee. Expect **100% Ready to Launch** only when all pass. A check that fails names what is missing.
6. Do not turn on customer messaging, the booking page or any automation as part of the pilot. Those are separate, per-workspace decisions after it.

## What to record, and when to stop

Record per employee: the profile name, the soul digest, the inventory digest, the provisioning job's attempts, the health observations and the final check's job. Stop and pause the employees on any of: a profile that is not the one expected for that client and role; any record or instruction from another workspace; a verification that reads Ready while a check failed; a message sent or a booking made that nobody asked for; a repeated failed health check; a worker that holds a lease past its expiry. Pausing does not delete anything; the client's data and configuration stay as they are.

## The two read-only tools

Both are built and tested on the embedded database only (`tests/client-provisioning-preflight.test.ts`, `tests/client-pilot-evidence.test.ts`). **Running either one against the hosted database is a separate approval.** Every query runs in a transaction the database itself holds READ ONLY, so neither can write whatever its statements say. They connect with the application's own connection string, not a restricted role (a restricted role would see every workspace table as empty and report a healthy database that is not). Pull the environment names (never values you do not need) from the hosting provider into a local file only if you want the environment checks decided; without it they read `unknown`, because this machine's own environment is not the hosted app's.

### 1. Provisioning preflight: is it safe to turn the provisioner on

```
npm run provisioning:preflight -- --live --expect dormant [--env-file <path>] [--out <file>]
npm run provisioning:preflight -- --live --expect enabled --env-file <path>
```

`--live` is required (without it the command stops, exit 2). `--expect dormant` is today's state: the provisioner off and no gateway attested. `--expect enabled` is the state the worker needs, and then an unset `HERMES_PROVISIONER_MAX_PROFILES` fails (the code treats the ceiling as optional; the preflight does not). `--out` writes the JSON and refuses to overwrite a file. Exit 0 means no check failed; 1 means one did; 2 means it could not run. A warning, an undecided (`????`) check and a manual item (`TODO`) are listed separately and are never a pass.

What it checks, by area: the migration ledger (the required versions, the local files not yet applied, applied versions with no file, two files sharing one number, the declared prerequisites); the schema objects by name (tables, columns, the one-open-job index with its predicate, the five guard triggers and that each is enabled, the helper functions, the server version); row-level security and grants (on, a read policy where the application role may read, no write for the application role on the provisioning tables, nothing for the browser-facing roles, whether a member can read a lease token); the jobs (two open jobs for one employee, a last-attempt job holding an expired lease, a job that used all three attempts, one waiting too long for the health check, a claimable job for a workspace the claim would refuse); the profile table (six employees per client, reserved or internal profile names on a client, a profile that is not the identity derived for its workspace and role, gateway pairing, two employees behind one normalised profile, credential ownership and sharing, an employee shown online with no profile, configuration versions and source jobs that belong to another employee or workspace, exactly one agency workspace, an agency employee on a client-only gateway); the gateways (inventory, attestation state, the pinned gateway); the environment by name (the provisioner's switch, token length class, pinned gateway id, the profile ceiling, switch combinations that should not exist, tool-enforcement mode); and capacity.

It also prints four things it cannot see, which are never a pass: the host's memory and processor limits, that the database has a backup and a restore was tried, the apply plan for any pending migration, and that the client-only runtime is separate from the internal one.

The preflight reads the database as it is. Before any pending migration is applied, `npm run rehearse:migrations` replays the whole migration history and every rollback on embedded Postgres only (it reads no environment file and cannot reach a hosted database); it is the rollback-readiness evidence, and it does not replace a backup.

Its output holds counts, ids, role keys, version and object names and booleans. It never holds a profile name, a slug, a company name, a credential or its fingerprint, a URL, or the text of a row.

### 2. Pilot evidence: the record and the ten stops

```
npm run pilot:evidence -- preflight [--org <workspace id>] [--roles a,b,c] [--expect-provisioner on|off] [--env-file <path>]
npm run pilot:evidence -- baseline --org <workspace id> --out <file>
npm run pilot:evidence -- snapshot --baseline <file> [--out <file>]
npm run pilot:evidence -- verify --baseline <file>
```

It refuses the agency's own workspace, a demo workspace and an id that is not a workspace. `preflight` is the pilot's own machine checklist (migrations, the attested gateway and that no agency profile is on it, the provisioner and tool-enforcement switches, that the workspace is a real client's with a verified owner, that the switched-on employees are exactly the plan's, that every customer-facing switch is off, the payment state and that no provisioning job exists before payment) plus the manual items. `baseline` records the time, the row counts of every workspace table and the plan's roles, just before the window opens. `snapshot` writes the per-employee record; it reads every table's row count before and after itself and, if any count moved, writes nothing and says so (take it again). `verify` reads the record again, lists every table that changed since the baseline, and evaluates the ten stop conditions. Exit 1 means a stop condition was met: pause the employees.

The ten stops: a profile that is not the one derived for that client and role (or a profile on an employee the plan does not include); another client named in this client's applied instructions or knowledge (a count, never the text); an employee recorded ready while its final check failed or ran against an older configuration; an outbound or customer-visible table changed, or a customer-facing switch turned on; three failed health probes in a row; a lease held past its expiry; all three attempts used without success; a job waiting more than an hour for the health check; a duplicate provisioning job; a write in any table outside the pilot's allow-list. An employee the plan does not include is shown `not_applicable` and is never judged, except that it must hold no profile.

Two things to know when reading it:

- **The final check is a portal read-only job** (`evidenceClass: portal_read_only_job`). It reads the client's records for the portal and does not call the employee's model. A passed check says the portal's own read of the client's data works; it does not say what an employee's model can do. The first proof of an employee acting is a chat turn with a business tool, which this pilot does not run.
- **`email_outbox` is not in the outbound list.** It is the system's own mail queue (account, invitation and receipt mail) and has no workspace column, so a per-workspace comparison cannot see it. `verify` prints its system-wide count since the baseline as a note: an invitation the client sent shows up there, and it may include other workspaces' mail.

What the command prints is verdicts, role keys, ids and short digest prefixes. The record file written by `snapshot --out` is the operator's own: it holds the profile and the expected profile (that is what the wrong-profile stop compares), which identify the client, so keep it out of the repository and out of chat.

### Pilot record template (fill one per run, outside the repository)

| Item | Value |
| --- | --- |
| Window | baseline time, last verify time |
| Plan roles | the employees switched on, from the baseline |
| Preflight | the date, the command's exit code, any warning accepted and by whom |
| Per employee | profile as expected (yes/no), credential live, configuration version and profile version, soul / effective-config / inventory digest prefixes, provisioning attempts and any failure code, health observation (last result, failures in a row), final check (passed / failed / stale) |
| Verify | each of the ten stops: OK or FAIL, and the note lines |
| Notes | the system-mail count, anything the supervisor saw that the tool cannot |
| Decision | continue, pause the employees, or stop |

## Rollback

Pause the six employees (reversible) and leave the workspace as it was. Removing the client's profiles from the runtime is not automated: the provisioner handles provision and sync only (the deprovision job kind exists in the database but no worker acts on it), so taking a pilot client's profiles off the runtime is a manual step that needs its own approval. The application release is a fast-forward and can be reverted like the earlier ones. No migration is involved, so there is nothing to undo in the database.
