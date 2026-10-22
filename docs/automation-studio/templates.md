# Automation Studio: ready-made automations (templates)

Phase C, 2026-10-21. **20 executable templates** (`src/lib/automation-studio/templates.ts`). A template here is a complete workflow graph built from the
steps the engine runs; it is not a prompt (the "Start from an idea" starters are still prompts and are not counted).

How one becomes a workflow (`createStudioFromTemplate`, `src/server/automation-studio/templates.ts`):

1. The person picks a template on the Studio home and answers only the choices that are the workspace's own (a tag, an approved message, a connection…).
2. The server looks every choice up in the workspace (an id from another workspace, the wrong kind of connection, an unapproved message and a
   template without a review link are all refused), builds the graph, validates it with the workspace's real options, and creates an Automation
   Studio draft (plan required, checked on the server). A connection that is not verified yet may be chosen: the draft says so and cannot be published
   until it is.
3. It opens in the same editor as everything else. **Auto and Manual both work on it**: the AI builder edits it through the same operations as any
   workflow, and the canvas edits it by hand.
4. A test run describes every step and sends nothing. Publishing freezes a version; any version that reaches outside iAcquire (messages, Slack, HTTP, an
   AI employee) needs the owner's approval of that exact version before it can be switched on.

The CRM builder's own templates (`WORKFLOW_TEMPLATES`, five of them, Core) are unchanged and cannot create these, and these cannot be created without
the plan.

| # | Template | Trigger | Reaches outside | Asks for (* = required) |
| --- | --- | --- | --- | --- |
| 1 | New lead alert in Slack | contact created | Slack | Slack connection* |
| 2 | Welcome message, then a nudge | contact created | approved message | message* |
| 3 | Speed to lead: escalate if untouched | contact created | nothing | none |
| 4 | Website form: tag, task and Slack | form submitted | Slack (optional) | tag*, form, Slack |
| 5 | Leads from another system | inbound webhook | nothing | tag* (the signed address is generated) |
| 6 | AI employee reviews new leads | contact created | AI employee | AI employee* |
| 7 | Confirm a booking and remind the day before | appointment booked | approved messages | confirmation*, reminder*, calendar |
| 8 | No-show recovery | no-show | approved message | message* |
| 9 | Brief the team on every booking | appointment booked | Slack (optional) | Slack |
| 10 | Ask for a review after a visit | showed up | review request | review template* |
| 11 | Won deal: hand off to onboarding | deal won | Slack (optional) | tag*, pipeline, Slack |
| 12 | Lost deal: win-back in 30 days | deal lost | approved message | message* |
| 13 | Stalled deal watch | deal moved to a stage | nothing | stage* |
| 14 | VIP fast lane | tag added | Slack (optional) | tag*, Slack |
| 15 | Private feedback alert | feedback received | Slack (optional) | Slack |
| 16 | Consent withdrawn: protect the contact | consent changed | nothing | tag* |
| 17 | Weekly pipeline review reminder | schedule (Mondays 09:00) | Slack | Slack connection* |
| 18 | Send new leads to another system | contact created | HTTP | HTTP connection*, tag* |
| 19 | Send bookings to another system | appointment booked | HTTP | HTTP connection* |
| 20 | Won deal: tell the billing system | deal won | HTTP | HTTP connection* |

Evidence (`tests/automation-studio-templates.test.ts`, 132 tests): every template is created through the real service in a realistic workspace with no
validation errors; has only real references (no empty id, no raw address, no secret); draws on the canvas with every link leading somewhere; dry-runs
with no failing step and no outside call; accepts rename, add-step and position operations; publishes, needs approval exactly when it reaches outside,
cannot be switched on without it, and then switches on. Two templates (the Slack alert and the lead sync) are also run end to end with the transport
replaced: the filled message and request leave once, the task and tag appear, and a refusal from the other system leaves the contact untagged and the run
failed with the reason.

All twenty are also **started and run to the end through the scheduler's own runner** (`tests/automation-studio-templates-run.test.ts`, 20 tests, simulated clock: the 30-day win-back finishes in seconds): each leaves a readable row for every step (a customer message with no consent is recorded as "blocked", an AI employee request as "blocked" while live AI runs are off, a repeat tag as "skipped"), none leaves a run unfinished, and the ones that don't promise an outside call make none. The gallery on the home screen can be searched (any words, in any order, with a category: `templateMatches`).

Honest limits: the templates only use the six real AI employee roles and the triggers and steps that exist (the brief's "AI Receptionist" and "AI Lead
Qualifier" do not exist as roles). Slack text uses contact and appointment fields only (the engine has no deal-name placeholder).
