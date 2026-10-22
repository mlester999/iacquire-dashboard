# Phase 2 release readiness

Branch `feat/phase2-lead-conversion`, from `origin/master` `447249d`. Date of this record: 2026-10-22. Nothing is committed, pushed, deployed or applied to a hosted database; no provider setting or switch was changed; no customer communication was enabled; no real person was a recipient of anything.

## Decision

**NO-GO for switching anything on for customers, and for applying 0085 / 0086 to the hosted database, today.**
**GO for founder review, and for the staged, approval-gated rollout in `02-operations-and-rollout.md`** (hosted dry run, then one internal workspace, team-only first).

Why not "go": the code is complete and tested against simulated providers, but none of it has been seen working against a real database, a real scheduler, a real telephony provider, a real carrier or a real model. Those are the things that fail first.

## Completion and readiness

**Feature completion: about 90% of the directive.** Phases 2A to 2F are built and tested. The remaining ~10% is two items that depend on things the platform does not have: a voice adapter for plain business lines (Twilio Voice, GoHighLevel call webhooks) and an executable AI call-back (no outbound-calling credential or contract). Both are modelled honestly (the call-back is recorded as blocked and never as done) and documented, not hidden.

**Evidence-based production readiness: about 45%.** Counted as verified gates out of the 14 that must hold before a real customer is affected:

| # | Gate | Verified? |
| --- | --- | --- |
| 1 | Logic and data rules under test (181 new tests; 4,991 in the whole suite, 0 failed) | Yes (simulated) |
| 2 | Tenant isolation, authorization and privacy under test, and as the application role in a database probe | Yes (simulated + rehearsed) |
| 3 | Migration rehearsal: unique numbers, order against 0084, data through up / down / up | Yes (embedded Postgres) |
| 4 | Rollback rehearsal: refuses with data, exact schema return without | Yes (embedded Postgres) |
| 5 | Browser QA at phone, tablet and desktop, light and dark, accessibility | Yes, with listed gaps |
| 6 | Typecheck (two configs), lint, clean build | Yes |
| 7 | Scale probe (20,000 contacts / 8,000 cases) | Yes, indicative only |
| 8 | Hosted migration dry run and backup | **No** |
| 9 | Scheduler run for real (staged, internal workspace) | **No** |
| 10 | A real missed call from a provider to an internal test number, end to end | **No** |
| 11 | A real text to an approved internal test recipient | **No** |
| 12 | Held-out evaluation of the language model on real messages | **No** |
| 13 | Legal review of the consent rule for callers who only phoned | **No** |
| 14 | Telephony coverage for plain business lines | **No** (not built) |

## Issues

**P0 (defects that block release):** none open. No cross-tenant read, unsafe send path, unguarded migration or data-loss path was found; everything found was fixed and has a test.

**P1 (must be settled before customers rely on it):**
1. A missed call to a plain business line is not seen: only Vapi / Retell assistants and calls a person logs feed the detector.
2. An AI call-back cannot run (no outbound-calling credential or contract). The screens say so.
3. Nothing recovers or re-scores until the scheduler runs, and the production scheduler has never run. The first live run's statement counts (about 20 per case, about 24 per lead) are the number to watch.
4. The language model path is untested against real messages. It is off by default; keep it off until evaluated.

**P2 (known, small):**
1. The Inbox unread-count badge is white on brand blue at 3.49:1 in dark mode (shared Phase 1 token, not changed here).
2. Two unused-variable warnings in `src/server/calendars/` that were already on master.
3. A queued text shows "1 text tried" in the case header; "queued" would be clearer.
4. The default scoring profile reads "Rules v0" until a workspace saves one.
5. Browser gaps: agency (support-session) CRM routes, the Inbox on a phone with the Customer details sheet open, the contacts list on a phone.

Fixed during this pass, found by browser QA (see `04-verification.md`): a contradictory recovery banner, small touch targets, a missing image role on checklist icons, and a Phase 1 Inbox bug that widened the page to 477 px on a 375 px phone.

## What needs the founder's approval

1. Apply 0085 then 0086 to the hosted database, after a verified backup and `--dry-run`, one file at a time.
2. Push the branch and merge to master. (Safe while dormant: policy is off by default, nothing is scored or sent until the scheduler runs, and the new tables are unused by older code.)
3. Start the scheduler in the staged order: `crmEventDispatch` + `leadScoreReassessment`, then `missedCallRecovery`, then one internal workspace in team-only mode. No send mode before item 4.
4. Legal review of the consent rule, per country and state where callers live, before any workspace uses "draft for approval" or "send automatically". Especially the "anyone who phoned us" option.
5. Whether the language model may read customer messages for lead signals (and a key to evaluate it).
6. Scope and credentials for a plain-line voice adapter, and for outbound AI call-backs.
7. Internal numbers only for every first live test; never real customers.

## Rollback

* **Switches (seconds):** drop `missedCallRecovery`, `leadScoreReassessment` and `phase2Retention` from `SCHEDULER_JOBS_ONLY` (or stop the scheduler); turn a workspace's recovery policy off; turn its scoring off. No provider setting was ever changed by Phase 2, so there is none to restore.
* **Code:** redeploy the previous commit. Safe at any time: the new tables are unused by older code, the six `contacts` columns are nullable, and the notification constraint keeps the two new kinds.
* **Database:** `supabase/rollbacks/0086_lead_scoring.down.sql` then `0085_missed_call_recovery.down.sql` in one transaction each, scheduler jobs stopped first. Each refuses while recovery history, assessments, an override, a customised profile or a contact priority exists, so export first. Afterwards delete the ledger row so the migration can run again. Rehearsed on embedded Postgres only.
