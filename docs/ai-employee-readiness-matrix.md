# AI employee readiness matrix

Last verified: 2026-10-25, on branch `feat/phases-3-7`. This is the honest answer to "is each of the six AI employees real?". It separates what runs in this repository and was tested here from what needs a live Hermes profile, which has **never** been connected for a client in production. A card that says "online" in a test or a screenshot is a simulated profile, and a simulated profile is not production-ready.

## The classes of evidence used here

| Class | Meaning |
| --- | --- |
| **Deterministic, tested** | Runs in this codebase against the database with no model: the 12 reviewed read-only capabilities. Tested end to end on embedded Postgres by `tests/six-employees-conformance.test.ts` and the per-capability tests. |
| **Simulated Hermes** | Needs a Hermes profile. Tested only against `tests/support/mock-hermes` (a local stand-in). Proves the portal's side (gates, preflight, streaming, persistence); proves nothing about the real model. |
| **Live Hermes** | A real profile answered. **None** has been recorded for any client employee. Six internal profiles were last audited as not all configured, and no run ever started. |

## The six roles

| Employee | Agency profile id (fixed) | Client profile name | Reviewed capabilities (all read-only) | Deterministic evidence | Needs a live profile for | Production status |
| --- | --- | --- | --- | --- | --- | --- |
| AI Lead Hunter | `iacquire-lead-hunter` | `c-<workspace slug>-<12-hex digest>-lead-hunter` | Lead research (Hermes), Lead generation review | Lead generation review completes and reads the research queue and backlog; research stops with its own reason when no profile is connected | Research itself: web research, qualification and source-backed leads | Not provisioned for any client |
| AI Operations Manager | `iacquire-operations-manager` | `c-…-operations-manager` | On-demand operations review | Completes and reads blocked or overdue work, failed runs, missing approvals and integration problems | Chat and coordination narrative | Not provisioned |
| AI Appointment Setter | `iacquire-appointment-setter` | `c-…-appointment-setter` | Appointment review, Calendar availability check, Missed-call review | All three complete; availability reads the real native calendar and says honestly when none exists | Replying to customers about booking (the booking itself is deterministic server code behind approvals) | Not provisioned |
| AI Sales Assistant | `iacquire-sales-assistant` | `c-…-sales-assistant` | Pipeline review, Lead priority review | Both complete against pipeline and lead-score records | Follow-up and proposal drafting text | Not provisioned |
| AI CRM Manager | `iacquire-crm-manager` | `c-…-crm-manager` | CRM quality review | Completes and reports missing details, duplicates and unverified identities | Chat | Not provisioned |
| AI Performance Analyst | `iacquire-analyst` | `c-…-performance-analyst` | Performance snapshot, Social media review, Receivables review, Reputation review | All four complete and state their period, definition and source; none invents a benchmark | Narrative explanation of the numbers | Not provisioned |

## What the conformance suite proves (20 tests, `tests/six-employees-conformance.test.ts`)

* Exactly six roles, with distinct names, slugs, mascots and fixed agency profile ids; every capability names real roles and is read-only; every role owns work it can do.
* A client's profile name is `c-…`, at most 63 characters, never an agency id, never starts with `iacquire-`, and differs for every workspace and role (18 distinct names for 3 workspaces and 6 roles).
* An employee that is switched on but not connected, provisioning, offline, in error or disabled reads as not ready and cannot chat.
* All 12 deterministic capabilities have a registered handler, run for the role that owns them and finish `completed` with a stated result (not an empty success). Lead research has a handler too and stops with a reason of its own without a live profile.
* The 65 role and capability pairs that are not allowed (6 roles times 13 capabilities, minus the 13 allowed pairs) are all refused (`forbidden`); a viewer cannot start AI work; a switched-off or not-yet-set-up employee is refused with its own reason.
* A workspace created by a purchase has all six employees in **Setup required**: none online, none able to chat, no credential, and a new owner cannot dispatch work to any of them.
* A pause (the employee's, the agency's or a suspended workspace) stops AI work jobs where they are requested, scheduled, triggered and claimed (`tests/ai-job-gate.test.ts`).

## What is not proven, by employee class

* **Chat, customer replies, lead research and every sentence a model writes** have never run against a real Hermes profile for a client. The role fence for research is a keyword guard plus prompt, not a tool allowlist (all six roles share one web-capable toolset, by the reviewed inventory contract): easy to rephrase around. A per-role allowlist needs the inventory verifier, the provisioning config and the VPS policy package to change together, and the founder's decision.
* **"Ready" means "Hermes connection, configuration and tool inventory verified"**, not that the role has what it needs. An Appointment Setter can read Ready with no calendar, a Sales Assistant with no pipeline, a customer-facing employee with no sending channel or approved knowledge. Role prerequisites are not part of readiness yet.
* **Health is not probed on a schedule**: an employee shows "online" until someone opens chat or an admin runs a check, and the Phase 7 audit found seven separate definitions of "online" in SQL (the strictest is the one the run gate uses; `audit/7bfg-employees-storage-superadmin.md`, finding on consistency).
* **Memory isolation** inside a workspace (per employee and role, shared across users) is not verified against a live profile; cross-tenant isolation is by dedicated profiles and is tested at the database level only.
* **Client profile provisioning** is a queue plus an operator runbook. The restricted host-side provisioner exists only on unmerged branches (`codex/client-ai-onboarding`, `codex/hermes-gha-acceptance`, sandbox pass only), and the VPS tool-policy package was prepared and never run.

## Distinguishing agency and client employees

The agency's own six employees are internal: fixed profile ids, an identity record and a Super Admin acknowledgement are required before one may run. A client's employees are provisioned per workspace with the `c-…` names above; reserved `iacquire-*` names cannot be mapped to a client. Both are checked by the run gate on every Hermes run (`assertAgentRunPreflight`), which re-reads the database immediately before submitting.
