# Automation Studio: decisions only the founder can make

Each has a recommended default that the code already follows, so nothing is blocked; changing a default is a small edit.

| # | Decision | What the code does now | Why it matters |
| --- | --- | --- | --- |
| 1 | **Is the existing CRM workflow builder core or premium?** | Core. Workflows built in the CRM screens (and every workflow that existed) need no plan and are never paused by the plan's lifecycle. Only workflows built in Automation Studio, and steps that only the plan includes, are premium. | The brief says the $299 plan must not be required for ordinary core CRM functionality, and also lists "native premium workflow creation and execution". The two readings differ for clients who already use `/crm/workflows`. If the CRM builder should become premium too, set `origin = 'studio'` for new CRM-screen workflows and decide what happens to existing ones (grandfather them is recommended). |
| 2 | **Fair-use defaults** | 5,000 runs, 50,000 steps, 300 builder messages, 500 employee requests, 10,000 integration calls per month; 25 workflows switched on; 500 runs in progress. Provisional. Hard stop on. | Real cost data (LLM tokens per builder message, connector costs) does not exist yet. Set these from the first month of measured usage. |
| 3 | **Grace period for a failed payment** | 7 days (`PAYMENT_GRACE_DAYS`). | Disclosed on the upgrade page. |
| 4 | **What a lapse keeps, and for how long** | Everything is kept for as long as the workspace exists (definitions, versions, run history). Workflows are paused, in-progress runs wait. | The brief asks for "the disclosed retention policy"; none existed. Confirm this one or set a limit, then change `STUDIO_LAPSE_POLICY` and the sweeper together. |
| 5 | **Who verifies payment** | An agency member, by recording it (`recordVerifiedPayment`). | A recurring PayMongo (or other) subscription is not built (`docs/build-progress.md`). Without it the plan is only as automatic as the team's bookkeeping. |
| 6 | **Route and name** | `Automation Studio`, `automation-studio`. | "Studio" already means Website Studio in this repository. |
| 7 | **Canvas technology** | Not chosen. | Custom SVG (no new dependency, more work) or `@xyflow/react` (faster, adds a dependency). Needed to start Phase 3. |
| 8 | **First connectors** | Not chosen. | Each needs credentials or an OAuth app registered by the founder (Google, Microsoft, Slack, Stripe). A generic HTTP-request step needs none and covers many cases. |
| 9 | **Scheduler activation** | Off in production. | Nothing here runs there until it is turned on (`docs/production-scheduler.md`); merge the `withinInterval` fix first. |
| 10 | **Applying migration `0069`** | Not applied to any hosted database. | Apply before deploying code that reads the new columns. The rollback is `supabase/rollbacks/0069_automation_studio_foundation.down.sql`. |
| 11 | **AI employee names in the brief** | Templates will use the six real roles. | "AI Lead Qualifier" and "AI Receptionist" do not exist. Adding roles is a separate piece of work that touches Hermes profiles. |
