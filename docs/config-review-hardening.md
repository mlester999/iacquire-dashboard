# AI employee configuration review & approval hardening

Status: implemented and verified locally; merged into the local `release/ai-workforce-notif-security` integration; not pushed, deployed or applied to production.
Original baseline: production commit `02a77ad`; integrated onto current `master` (`27fe4f7`).
Implementation branch: `codex/config-review-hardening`.
Integration branch: `release/ai-workforce-notif-security`.

No production database writes, migrations, deployments, employee activation, health checks, Hermes runs, VPS changes or Cloudflare changes were performed. Operations Manager configuration v1 was not approved or applied.

## 1. Root cause and corrections

The hosted `iAcquire` agency workspace contains one held configuration version:

| Field | Value |
| --- | --- |
| Version | `v1` (Operations Manager) |
| Status | `pending_agency_review` |
| Source | `client_edit` |
| Risk flag | `approval_bypass` |
| Created | 2026-10-20 12:55:02 SGT |
| Submitted by | the internal Super Admin owner |
| Active config | `null` |

The exact trigger was this sentence in `roleAnswers.approval_rules`:

> Routine monitoring, information retrieval, internal analysis, and drafting recommendations may proceed **without approval** when permitted by system policies.

The old `approval_bypass` regex matched the substring `without approval` without considering intent. That sentence is a restrictive description of routine internal work; it is inside the quoted `<client_context>` block, and the immutable agency policy that follows it requires human approval for customer-facing work.

Corrections implemented:

- Replaced the single-pass regex with sentence-level, intent-aware instruction scanning. Restrictive language such as “never send without approval”, “do not access other clients' data” and “never ask for passwords” no longer triggers a flag.
- Kept explicit bypass detection. “Send it automatically without approval” still produces `approval_bypass`.
- Kept and strengthened hard blocks for instruction override, prompt probing, role hijack, permission grants, secret requests, cross-tenant access, prompt markup and disabling safety controls.
- Added deterministic structural classification for guardrail removal, guardrail weakening, approval-scope reduction, escalation-destination changes, tool re-enablement and impersonation-risk names.
- Added the exact Operations Manager sentence as a regression test.

## 2. Decision matrix

| Outcome | Examples | Behaviour |
| --- | --- | --- |
| `AUTO_APPLY` | Tone, reply length, language, ordinary name change, ordinary role answers, adding a guardrail, switching a tool off | Applied immediately after schema, sanitisation, tool-allowlist and instruction validation |
| `REVIEW_REQUIRED` | Approval-bypass wording, ambiguous customer-facing instructions, guardrail deletion/weakening, approval-scope reduction, escalation-destination change, re-enabling a disabled action, impersonation-risk name, review-level company-profile text | A version is saved as `pending_agency_review`; the live configuration stays active; a person must decide |
| `BLOCKED` | Instruction override, system-prompt probing, role hijack, permission/tool grant, secret request, cross-tenant access, prompt-control markup, disabling safety controls | The save is rejected and no version is created; this applies to clients and agency Super Admins alike |

All three outcomes still pass through the existing server-side enforcement: Zod schema limits, text sanitisation, the role-default tool allowlist, the reserved-profile guard, the immutable agency policy and the provider/profile health boundary.

## 3. Internal Super Admin vs client editing

| Behaviour | Client admin | Internal Super Admin |
| --- | --- | --- |
| Routine save | `source=client_edit`, applied immediately | `source=agency`, actor kind `agency`, applied immediately |
| Sensitive save | `pending_agency_review`, agency reviewer decides | `pending_agency_review`, internal reviewer decides at `/admin/workforce/reviews` |
| Blocked save | Rejected, no version | Rejected, no version; no bypass because the actor is a Super Admin |
| Version-history source | “Client edit” | “Internal edit” |
| Review decision | Client cannot approve; requires `agency.workforce.manage` and tenant access | Super Admin only for the internal workspace; audited |
| Stale held version | Approval is refused when a newer configuration is already applied | Same |
| Legacy misattributed v1 | — | Stored source remains `client_edit` for audit integrity; UI derives “Internal edit” from the agency organization and shows a legacy notice in the review card |

Attribution is derived from authenticated server context (`ctx.org.kind` and `ctx.user.platformRole`), never from client-supplied input. Audit metadata now includes `actorKind`, `actorRole`, `actorPlatformRole`, `orgKind`, `source`, `reviewDecision` and risk fields.

## 4. Pending Operations Manager v1 recovery

v1 was not modified. The recovery path is:

1. Deploy this branch through the normal approved release process.
2. Sign in as an agency Super Admin and open **Admin → AI Workforce**. If internal reviews are pending, a banner links to **Configuration reviews** (`/admin/workforce/reviews`).
3. Open the Operations Manager v1 review. The card shows the stored `approval_bypass` reason, a legacy notice explaining that the current validator no longer flags the text, the proposed diff, the submitter and the timestamp.
4. Either:
   - **Approve & apply** with a decision note. This activates v1 exactly as submitted; the note is recorded in `audit_logs`; or
   - **Reject**, then open the employee's **Version history → Continue editing v1**. The Configure screen now loads the saved, unapplied v1 instead of defaults. Saving creates a new version; because the current validator considers the text safe, that new version can auto-apply. This preserves v1 in history and produces a new applied version.
5. Do not delete or overwrite v1. It remains part of the version history and audit trail.

No automatic approval or application occurs as part of the implementation.

## 5. Runtime approval enforcement status

`approvalPreference` is **not enforced** by the current runtime approval gate.

- `automationGate` decides from `organizations.status`, automation pauses, `agent_instances.enabled`, `agent_instances.status` and `agent_instances.mode` (`src/server/automation/gate.ts`). It does not read `approvalPreference`.
- The Hermes tool-policy model has an `approval_mode` field, but records it with `enforcementStatus: "not_enforced"` (`src/server/workforce/tool-policies.ts`).
- `approvalPreference` previously appeared only in the settings schema, the Configure toggle and the diff display.

Because wiring it into every message, booking, CRM, campaign and provider-run path is a broader approval-policy project, this change does not invent partial enforcement. Instead:

- The misleading interactive toggle is replaced with a read-only “Fixed by iAcquire policy” display.
- `createConfigVersion` pins `approvalPreference` to the applied value (or the conservative default `always`) and rejects an attempted change with a clear error.
- Rollback preserves the currently pinned value rather than reintroducing a stale preference.
- A separate implementation requirement is recorded for a future runtime approval-policy layer.

## 6. Files changed

New:

- `src/lib/instruction-risk.ts`
- `src/lib/config-review.ts`
- `src/server/workforce/reviews.ts`
- `src/components/admin/config-review-card.tsx`
- `src/app/(admin)/admin/workforce/reviews/page.tsx`
- `tests/config-review-hardening.test.ts`

Modified:

- `src/server/workforce/service.ts`
- `src/server/workforce/compiler.ts`
- `src/server/workforce/preview.ts`
- `src/server/admin/queries.ts`
- `src/server/settings/service.ts`
- `src/server/onboarding/service.ts`
- `src/server/setup/jobs.ts`
- `src/app/actions/workforce.ts`
- `src/app/actions/chat.ts`
- `src/app/(admin)/admin/actions.ts`
- `src/app/(admin)/admin/workforce/page.tsx`
- `src/app/(portal)/workforce/[slug]/page.tsx`
- `src/components/admin/client-detail.tsx`
- `src/components/workforce/employee-detail.tsx`
- `src/components/workforce/config-test-dialog.tsx`
- `src/lib/agent-settings.ts`
- `src/lib/workforce-types.ts`
- `tests/agency-team-permissions.test.ts`
- `tests/workforce-config.test.ts`

## 7. Verification

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- Focused review suite: `tests/config-review-hardening.test.ts` — 21/21 passed.
- Final focused regression set (review, workforce config, onboarding v2, agency permissions): 88/88 passed.
- Broader onboarding, knowledge, chat, approvals, agency and Hermes gate suites: 95/95 passed.
- Full Vitest suite: 194 files, 3,124 tests passed. One Vitest worker failed to start for `tests/agency-team-ui.test.tsx` with a pool timeout (infrastructure, not a test assertion); rerunning that file alone passed 14/14.
- `npm run build`: passed. The route table includes the new static `/admin/workforce/reviews` route. The build used local, non-resolving placeholder Supabase/Postgres values; it did not connect to or write to production.

## 8. Required migrations

**None.** The implementation uses the existing `agent_config_versions.source` value `agency`, the existing `risk_flags text[]` column, and the existing `audit_logs.metadata` JSONB column. No schema change is required.

## 9. Remaining limitations

- `approvalPreference` remains unenforced at runtime. The UI is locked and the stored value is pinned, but a true per-action approval-preference layer remains a separate project.
- Review diffs are recomputed from stored settings and the nearest previous applied version. There is no stored submission-time base snapshot or validator version per version. The legacy v1 notice covers the original misclassification.
- Internal sensitive edits can be reviewed by the same Super Admin who submitted them; there may be only one Super Admin in the internal workspace. The decision is audited. If two-person control is required, a separate reviewer-separation policy is needed.
- Client high-risk review still uses a single authorised agency reviewer; no dual-control requirement was introduced.
- Review-level company-profile text is allowed to save (block-level text is rejected immediately). It is caught by the next employee configuration generation; existing compiled prompts do not change until a new version is applied. This is consistent with the versioned prompt model.
- `tool_policies.approval_mode` remains marked not enforced. Provider toolset/profile restrictions are unchanged.
- No production verification was performed for the internal review page or the v1 recovery procedure; both are covered by local service/query tests and typechecked UI.

## 10. Local commit and deployment readiness

Local branch: `codex/config-review-hardening`.
Base: `02a77ad` (production baseline).
Implementation commit: `5d334c786b99e424c3a1b4acd97323ad858504cc`.
Documentation commit: this file is committed separately so it can record the implementation SHA.
Deployment readiness: code, tests, typecheck, lint and production build are the gate. No push, deployment, production migration or production data change has been performed.
