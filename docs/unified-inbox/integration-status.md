# Integration with the AI Workforce: status and the exact dependency

Written 2026-10-22. On the founder's instruction the integration branch was pushed to `origin/master` and migrations `0081` to `0083` were applied to production (see [release-verification.md](./release-verification.md)). The local master checkout and its working tree were not touched.

## 1. Where the pieces are

| Piece | Ref | Commit | On `origin`? | Notes |
| --- | --- | --- | --- | --- |
| Mainline | `origin/master` | `18e6e32` | yes | Automation Studio audit, **one commit ahead of local `master` (`22c68c2`)**, no migrations |
| AI Workforce release candidate | `codex/all-six-workforce-release` | `cbbc9ee` | **no (local branch only)** | One commit on `22c68c2`: 45 files, migrations `0081` and the `0077`-`0081` rollbacks |
| Client AI onboarding | `codex/client-ai-onboarding` | `5025d4a` | **no (local branch only)** | One commit on top of `cbbc9ee`: provisioning queue, migration `0082_client_employee_provisioning` |
| Unified Inbox | `feat/unified-inbox` | `b03f14b` | no (by instruction) | Based on `22c68c2`; migration `0083_unified_inbox` |
| **Integration** | `integrate/unified-inbox-workforce` | see section 4 | **yes, pushed to `origin/master` on 2026-10-22** | `origin/master` + `codex/client-ai-onboarding` + `feat/unified-inbox`; its inherited upstream was removed so a stray push cannot target master |

**Have the workforce changes been committed?** Yes, since 2026-10-21 23:03, but **on branches, not on master, and not pushed anywhere.** Master's own working tree still shows them as uncommitted: **44 of its 54 modified or new files are byte-identical to
`cbbc9ee`** (the stale remainder of the work that was then committed elsewhere), and 10 are Hermes cutover documents and scripts (`docs/hermes-production-cutover.md`, `scripts/hermes-cutover/*`, `scripts/build_iacquire_system_guide.py`) that **differ from the branch and exist
only in that working tree**. I did not touch any of it.

## 2. How the integration was made, and the conflicts

`git merge` of real commits into a branch cut from `origin/master`; nothing was copied from any working tree.

1. `codex/client-ai-onboarding` (which contains `codex/all-six-workforce-release`) into `origin/master`: **no conflicts** (the Automation Studio commit and the workforce chain touch different files).
2. `feat/unified-inbox` into that: **three conflicts, all trivial, the same three as in every rehearsal since the first**; the Automation Studio change to `src/lib/crm/workflow/spec.ts` merged automatically with the inbox's edits to the same file.

| File | Conflict | Resolution |
| --- | --- | --- |
| `src/server/messaging/send.ts` | one insert-parameter line: workforce `extra.sendAfter ?? req.now ?? new Date()`, inbox adds `fence` | both kept |
| `tests/aqi-ops-registration.test.ts` | expected job list | shipped list, Studio sweep, `inboxAttention` right after `repliesChecked`, the AQi Operations pair, then the five workforce jobs |
| `tests/scheduler-intervals.test.ts` | the five-minute jobs | the three workforce jobs, `crmWorkflowRecovery` and `inboxAttention` (sorted) |

The integrated tree passes the whole suite (see [release-verification.md](./release-verification.md)), and the suite also passes with the new inbox switched on for every workspace and with the global switch on.

## 3. Are the six AI employees still working?

* Their workforce, chat, readiness, role-playbook, job, schedule, trigger, proactive and provisioning suites pass on the integrated tree **in all three inbox states**: default (off for the workspaces they create), switched on for every workspace, and `INBOX_DISABLED=true`.
* In the integrated build all six render on `/employees` (Operations Manager, Lead Hunter, Appointment Setter, Sales Assistant, CRM Manager, Performance Analyst).
* The inbox lets only the two reply-capable employees be attached to a conversation; the server refuses the other four (a test, not just a hidden control), and no workforce code path calls anything only the new inbox uses (`tests/unified-inbox-entrypoints.test.ts`).
* Not verified: a real Hermes run (needs the VPS dry-run gate and credentials).

## 4. Commit sequence on `integrate/unified-inbox-workforce`

`18e6e32` (origin/master) → `3ba63b3` merge of the workforce chain → `69f3558` merge of the inbox → then this pass's commits (migration audit and `MIGRATION_PREREQUISITES`, entry-point audit, in-app-by-default notices, scheduler rehearsal and the test matrix knob, runner flags, `SCHEDULER_JOBS_ONLY`, performance work, staging readiness and these documents). The tip hash is in the final report and in `git log`.

## 5. The exact dependency, and what to do

1. **Master cannot take this integration while its working tree is dirty** with stale copies of the workforce files: a merge would conflict with them. Its owner must clean that tree first (the 44 identical files can simply be discarded once `cbbc9ee` is on master; the **10 Hermes cutover files must be committed or kept somewhere first**, because they exist nowhere else).
2. **The workforce stream has to decide to land `codex/client-ai-onboarding` (or only `codex/all-six-workforce-release`) on master.** Until it does, the inbox cannot be merged "onto the AI Workforce" on master; this integration branch is the prepared result. If only `all-six` lands, `0082` drops out and `0083` is unaffected (checked: the two are independent either order).
3. **Back the workforce branches up.** `cbbc9ee` and `5025d4a` exist only on this machine.
4. When those land, re-create this integration on top of them (the same two merges, the same three resolutions) or merge `integrate/unified-inbox-workforce` after rebasing it; then re-run the suite and `scripts/rehearse-migration-order.mjs`. The audit script's first check scans every ref for a clashing migration number.

## 6. What I deliberately did not do

Merge into, reset or overwrite `master`; touch its working tree; push anything; delete or move another stream's branch; apply any migration anywhere hosted.
