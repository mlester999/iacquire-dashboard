# Native-first release audit (2026-10-19)

This is the final gate before pushing the native-first transition. It records what was checked against the exact commit tree, not only the working checkout.

## Release set

`origin/master..master` contains **6 commits**, touching **16 files** and **no migrations, generated artifacts or secrets**:

| Commit | Purpose |
| --- | --- |
| `97e4711` | Client surfaces native-first: integration cards, sales redirect, fleet health |
| `f8caaa5` | Exact Supabase staging plan and approval list |
| `25314c2` | AQi browser-QA timing determinism |
| `cf04e1b` | CRM QA declaration for the streamed-redirect helpers |
| `c870cf5` | Full quality-gate record |
| `95b18c2` | Explicit, tested sales-route ownership guard |

The audit ran in a separate worktree checked out at the release commit, with a copy of the isolated PGlite QA database on port 3231. The dirty working tree (an unrelated AQi UX refactor) was **not** part of the tree, build, tests or push.

## 1. New-client creation paths

| Path | Finding | Evidence |
| --- | --- | --- |
| Admin-created client | Defaults to `native`. The request schema defaults `crmMode` to `native`; the create form starts at `native`; the organization trigger creates a native `crm_workspaces` row; the explicit insert records the chosen mode. A GoHighLevel choice still works and is mapped afterwards. | `src/server/admin/tenants.ts`, `src/components/admin/create-client.tsx`, `tests/crm-blueprints-onboarding.test.ts` (native default, explicit GoHighLevel, Blueprint applied to native) |
| Invitations | An invitation adds a user to an existing organization or the agency team; it never creates a client organization or CRM workspace. No CRM default applies. | `src/server/auth/service.ts` `applyInvitation`; no organization insert in the invitation paths |
| Client onboarding | The setup guide opens on the workspace's native provider step (`CRM provider` = Configured), and the provider choice schema defaults to native. GoHighLevel is an explicit second choice, and choosing it connects nothing until iAcquire maps and verifies the location. | `src/server/setup/crm-guide.ts` `chooseInitialCrmProvider`, `src/lib/onboarding/crm-setup.ts` `providerStep`; browser `/crm/setup` on the native QA client |
| Demo-to-client conversion | No conversion product path exists. `is_demo` is set only by seed scripts; there is no service or route that converts a demo workspace into a client. If one is ever added, it must go through `createClientTenant`. | code search for `is_demo` writes and organization inserts |
| Direct-purchase onboarding | No self-serve organization creation path exists. Checkout creates prepaid credits for an existing workspace; it does not create a tenant or choose a CRM. | `src/server/billing/*`; organization-insert search |
| Blueprint / setup initialization | `crm_workspaces` is created native by the organization trigger and by `loadWorkspace`. Blueprint apply reads the mode and refuses GoHighLevel workspaces; in a hybrid it leaves GoHighLevel-owned sections out. Applying a Blueprint never changes the provider mode. | `supabase/migrations/0027_native_crm.sql` trigger, `src/server/crm/workspace.ts`, `src/server/crm/blueprints/apply.ts`; `tests/crm-blueprints-onboarding.test.ts` |

## 2. Ownership and routing

- `resolveCapabilities(mode, rows)`: native → all native; GoHighLevel → all GoHighLevel; hybrid → explicit owner, native when missing.
- `assertNativeOwner` and `provider-guard` enforce the same rule on every native write, sender, booking path and worker.
- `/settings/integrations` derives the same ownership for its cards.
- `/sales` uses the explicit `shouldRedirectSalesToNative` guard: only a **client** workspace that can view the CRM and whose **opportunities** capability is native is redirected to `/crm/opportunities`. A GoHighLevel-owned capability, including in a hybrid, stays on `/sales`; agency workspaces never redirect.

Browser evidence on the release tree:

| Role/workspace | Route | Result |
| --- | --- | --- |
| Native owner | `/sales` | Finished at `/crm/opportunities` with the native CRM workspace |
| GoHighLevel owner | `/sales` | Stayed at `/sales`; the GoHighLevel sales view rendered |
| GoHighLevel owner | `/crm/contacts` | GoHighLevel-owned notice and `GHL` navigation badges; no native editing claim |
| Native owner | `/crm/contacts`, `/crm/opportunities`, `/crm/tasks`, `/crm/calendar` | Rendered with the native CRM workspace and real data; no GoHighLevel requirement |

## 3. GoHighLevel remains optional

- A native workspace's Integrations page shows **iAcquire CRM** and **iAcquire Calendar**, with real counts, and an explicit “GoHighLevel is optional” notice. There is no unconnected GoHighLevel CRM card.
- A GoHighLevel workspace still sees **GoHighLevel CRM** and **GoHighLevel Calendar**, its saved location and check state.
- Admin client creation keeps GoHighLevel as an explicit choice and, after creation, links to the client's Integrations tab to map the location.
- Choosing GoHighLevel in the setup guide changes only the provider mode; it does not claim a connection. The guide says iAcquire maps and verifies the location.
- Provider switching tests cover moving capabilities both ways, hybrid explicit owners, and rollback preserving the earlier ownership.

## 4. Native CRM without GoHighLevel

The native QA client has no GoHighLevel mapping and no GoHighLevel connection rows. It completed browser checks on contacts, opportunities, tasks and calendar, and its `/crm/setup` guide shows the CRM provider as Configured with no GoHighLevel mention in the guide body. The full unit suite covers contacts, deals, tasks, calendars, forms and lead capture.

## 5. UI/UX recheck

| Page | Desktop light | Desktop dark | Phone dark |
| --- | --- | --- | --- |
| `/settings/integrations` (native) | Pass; 0 axe; no overflow | Pass; 0 axe; no overflow | Pass; 0 axe; no overflow |
| `/settings/integrations` (GoHighLevel) | — | Pass; 0 axe; no overflow | — |
| `/crm/setup` (native) | Pass; no overflow | Pass; no overflow | Pass; no overflow |
| `/setup` (native) | Pass; no overflow | — | — |
| `/admin/clients` (agency) | — | Pass; no overflow | Pass; no overflow |

One `/crm/contacts` run logged a React hydration warning during a cold dev compile. It did not reproduce in three fresh loads with the same theme state, and the contact page rendered correctly every time. It is recorded as a dev-compile transient, not a confirmed product defect.

## 6. Migration and schema dependency

Read-only hosted check against `lkkiavjwxaeoqgsbjyso` on 2026-10-19:

- pending migrations: **none**
- latest ledger rows: `0061_aqi_phase3_guidance`, `0062_agency_manager_blueprint_permissions`, `0063_aqi_phase3_hardening`
- public tables: **259**
- public tables without RLS: **0**
- `aqi_knowledge_versions` exists; `create-contact` v1 archived and v2 published with `contact_created`
- `0063` declares `0061` as its prerequisite in `src/server/db/index.ts`

The release contains **no SQL migration**. It needs the schema already applied on hosted (it is), so no risky migration is part of the push.

## 7. Gates on the release tree

- Full unit suite on `95b18c2`: **3,003 passed / 3,003 (180 files)**.
- Focused creation/ownership tests on `c870cf5`: 45 (client creation, Blueprint onboarding, provisioning, native-first) + 64 (provider switching and reporting).
- Focused native-first tests on `95b18c2`: 16 (integration cards, fleet health, sales-route ownership).
- `tsc --noEmit --incremental false`: exit 0.
- `eslint src tests scripts --max-warnings=0`: exit 0.
- `next build --webpack`: compiled successfully in 112 s; TypeScript passed; `/settings/integrations`, `/sales` and `/crm/opportunities` emitted.
- Native CRM interactions against the release tree: **8 passed / 0 failed** — create a contact, add a tag, move a deal with the keyboard, open an inbox thread, advance the setup guide, open the GoHighLevel migration panel (not connected), preview the provider-switch wizard, and the sales-rep permission boundary. The public-form lead interaction was not completed because the isolated dev server stalled on a cold compile; forms/lead creation are covered by the full suite (`crm-forms.test.ts`, 45 tests) and the earlier post-merge browser run.

## 8. Remaining before production claims

- No hosted staging project exists; the acceptance matrix in [staging-environment.md](staging-environment.md) has not run there.
- The full all-route CRM browser matrix was not completed on this release tree; the interactions and focused browser checks above passed, and the earlier post-merge 114-route evidence remains local.
- Hermes live-run acceptance, Website Studio publishing/domain checks and a screen-reader pass remain separate acceptance items.
- After the push: verify the new Vercel deployment SHA and production `/api/health` / `/login`; the production scheduler, provider writes and any new migration stay unchanged.
