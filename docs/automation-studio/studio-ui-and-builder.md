# Automation Studio: the builder, the canvas and the screens

How the chat-first builder, the live canvas and the manual editor fit together, what is enforced where, and how to test them. Written for
the people who maintain it. The plan rules are in [audit-and-gap-analysis.md](audit-and-gap-analysis.md); what is done and what is not is in
[implementation-checklist.md](implementation-checklist.md).

## One model, two ways to edit it

There is exactly one definition of an automation: `crm_workflows.draft` (the working copy) and the immutable `crm_workflow_versions` rows
(what actually runs). Auto Mode and Manual Mode both edit the working copy through the same operations layer
(`src/lib/crm/workflow/operations.ts`), so switching modes converts nothing and loses nothing.

| | Auto Mode (chat + canvas) | Manual Mode (full editor) |
| --- | --- | --- |
| Who proposes a change | The AI Automation Builder, as JSON operations | The person, as canvas gestures (drag, connect, delete, duplicate, palette) |
| Where it is checked | `parseOperations` → `applyOperations` in **strict** mode on the server, in a locked transaction against the **latest** draft | `applyOperations` in **draft** mode in the browser, then the same server checks on save |
| How it reaches the canvas | The server streams `applied` with the validated operations; the canvas replays them one by one, then settles on the saved definition | Immediately |
| Undo | `history.ts`, rebuilt after a reload from `automation_studio_changes` | same |

Layout (`ui.x`, `ui.y`) is part of the draft but never part of the content hash, so moving a node can never change what is approved or
how a workflow runs.

## The AI Automation Builder (not AQi)

`src/server/automation-studio/builder/`

- `prompt.ts` builds the system prompt from the live workspace (tags, templates, pipelines, employees, calendars: only ids that exist),
  the step catalog generated from the zod schemas (`z.toJSONSchema`), the current definition, the selected step, the validation problems
  and the last failed runs.
- `output.ts` streams the reply text to the chat and holds back the fenced ```operations block. The person never sees raw JSON.
- `service.ts` (`runBuilderTurn`) order of events: permission → plan (`assertStudioEntitled`) → per-user rate limit → model connection
  → monthly message allowance (`admitBuilderMessage`) → store the message → call the model → parse → apply in strict mode against the
  latest draft (manual edits made meanwhile are preserved) → save with the revision check → store the assistant message and the change
  → count tokens. A refused proposal goes back to the model with the reason (at most `MAX_REPAIRS` = 2 times); if it still fails,
  nothing is changed and the person is told why.
- The builder can only edit a draft. It cannot publish, switch on, send, run, or set a webhook address (strict mode refuses it).
- SSE event vocabulary (`src/lib/automation-studio/types.ts`): `start`, `status`, `delta`, `applied`, `refused`, `done`, `error`. Nothing
  is sent that did not happen: the canvas animates only what an `applied` event carries.

## The canvas

`src/components/automation-studio/canvas/` (React Flow, `@xyflow/react` 12.12.0, pinned)

- `flow-model.ts` is pure: definition ↔ nodes and edges, tidy layout for steps without a saved position, change marks.
- `gestures.ts` is pure: every gesture (drop, connect, delete, duplicate, insert-after, reposition) becomes operations, or a refusal with a
  reason in words. Nothing mutates the definition directly.
- `workflow-canvas.tsx` renders it and applies the replayed operations step by step with a short entrance animation per node; it honours
  `prefers-reduced-motion`. While a turn is running the editor is locked (the builder is working on the latest draft).
- `static-canvas.tsx` is the read-only, labelled "Example" canvas on the upgrade page. It is a sample definition, never a claim about the
  person's own workspace.

## Screens and routes

| Route | What it is | Who sees what |
| --- | --- | --- |
| `/automation-studio` | Home. With the plan: the "What would you like to automate?" box, suggestions, searchable ideas and the person's automations. Without it: the upgrade page | Server decides from the maintenance plan |
| `/automation-studio/[id]` | The workspace (chat + canvas, or the full editor). Read-only with the reason when the plan has lapsed or the person may not change automations | An automation built on the CRM screens redirects to `/crm/workflows/[id]` (it is Core) |
| `POST /api/automation-studio/[id]/chat` | The builder's stream | Same server checks as above |

The sidebar entry sits in the CRM group with a lock when the workspace has no plan (`ShellData.automationStudio.entitled`). The lock is
cosmetic: every page, action and API route checks the plan again.

## What is enforced where

- **Plan**: `assertStudioEntitled` at every boundary (create, save, publish, switch on, test, run, approve, Blueprint writes, builder
  turns), and the engine re-checks before a run starts or advances. See `tests/automation-studio-engine.test.ts` and `-hardening.test.ts`.
- **Permissions**: `workflows.view` to see, `workflows.manage` to build or change. Owner-only approval of anything that messages customers or
  calls outside systems is unchanged.
- **Tenant isolation**: every table is keyed by `org_id`; RLS lets people with `workflows.view` read their own workspace's rows only and
  nobody write from outside the server. Tested with a second workspace in `tests/automation-studio-hardening.test.ts`.
- **Storage**: conversations (`automation_studio_messages`) and the change trail (`automation_studio_changes`, newest 100 per workflow)
  come from migration `0070` (not applied anywhere but local and test databases). Its rollback refuses while rows exist.
- **Menu lock**: the shell asks `app.automation_studio_plan(org)` (migration `0071`, security definer, only for people with `workflows.view`,
  four facts only) because the plan's lifecycle columns are intentionally not table-granted to the app role. Reading them directly made every
  portal page fail with "permission denied" in the first browser run; `tests/shell-query.test.ts` now covers it.

## Testing it

- Unit and service tests: `npx vitest run tests/automation-studio-*.test.ts tests/workflow-operations.test.ts` (no network, no provider).
- Browser QA against an isolated app with a **scripted stand-in for the model** (not a real model; it recognises three kinds of request
  and answers with fixed, valid operations):

  ```bash
  node scripts/run-automation-qa-seed.mjs   # once; copies the Native CRM QA database, gives Brightside (QA) an active plan
  node scripts/automation-qa.mjs            # app on 127.0.0.1:3262 + the stand-in on 127.0.0.1:3263
  node scripts/automation-browser-qa.mjs    # real Chromium; screenshots in .data/automation-qa/screens, report.json
  ```

  Everything but a few named variables is the Native CRM QA environment (`scripts/automation-qa-env.mjs` enforces it and
  `tests/automation-qa-safety.test.ts` tests that it refuses anything else). It needs Playwright (set `PLAYWRIGHT_MODULE`, or run the
  Native CRM QA setup once). Do not edit source files while the browser run is in progress: the dev server's reload would interrupt it.

## What the first browser run found (and fixed)

Real Chromium against the isolated app found six defects that no unit test had: (1) every portal page failed with "permission denied" because
the menu read plan columns the app role is not granted (now `0071`); (2) in development the editor's "still mounted" flag was only ever
cleared, so the builder's changes never reached the canvas and saves never finished (fixed; `tests/automation-studio-editor-hook.test.tsx`
renders it under StrictMode and fails on the old code); (3) the chat column was wider than its pane and cut off messages; (4) the home screen
wrote dates in the server's time zone and the browser's, a hydration mismatch (now in the workspace's time zone); (5) the canvas was drawn
inside a hidden pane on a phone, which measured nothing and filled the console with NaN errors (now not drawn while hidden); (6) canvas
connection points carried an `aria-label` without a role, failing the accessibility audit (now a plain `title`).

## What this does not prove

- Quality of a real model's operations. Only the protocol, validation, saving and the screens are exercised; the stand-in is not a model.
- Anything on a hosted database or a deployed build. Nothing has been pushed, deployed or migrated outside local and test databases.
- Production-build behaviour of the browser pages. The run is against `next dev` (webpack): React's development-only double mounting and
  React Flow's "parent container needs a width and a height" warning on first mount appear there; the production build has not been driven in a browser.
- Dragging from the palette onto the canvas, dragging a connection between two nodes, and keyboard-only canvas use were not driven (clicking a palette
  entry, undo, redo, history, publish and the mode switch were). The pure gesture layer for them is unit-tested.
- That a customer-facing message was sent: none is. Every automation the QA builds only creates tasks and notifications inside the QA copy.
