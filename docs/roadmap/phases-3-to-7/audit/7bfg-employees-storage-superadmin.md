# Phase 7B / 7F / 7G: six AI Employees readiness, storage and integrations, Super Admin operations (worktree .data/wt-phases-3-7, branch feat/phases-3-7, HEAD 9a495af)

## Summary
The six-employee platform is well built and fail-closed where it matters: a server preflight (assertAgentRunPreflight, startAgentRun) and the client readiness function agree on enabled, applied config, passing health, a non-revoked credential, a recorded tool inventory and, for internal employees, identity plus Super Admin acknowledgement. Production reality (docs only; I queried nothing): no client employee has a Hermes profile, the live-run gate is closed by design, the VPS tool-policy package was prepared but never executed, and the only host-side provisioner lives on unmerged branches (codex/client-ai-onboarding, codex/hermes-gha-acceptance, sandbox pass only, migration 0084 unapplied). 'Ready' therefore means only 'Hermes connection, config and inventory verified'. It says nothing about role prerequisites (calendar, pipeline, channel, knowledge), and 'online' goes stale because no scheduler job probes Hermes. In the code there are real control gaps. Pauses and the agency pause (automationGate) are not applied to AI work jobs, schedules, lead research, social publishing or calendar sync. Offboarding disconnects only integration_connections and leaves calendar, social and Automation Studio secrets live. App-level sealed secrets cannot be key-rotated. Every role shares the same web-capable toolset, so role fences are prompt plus regex. Storage is private, tenant-keyed and honestly described (no unlimited claim anywhere), but the managed-vs-connected entitlement exists only for social media, is time-unaware there, and Google Drive and OneDrive do not exist on any ref. Super Admin coverage is broad and mostly guarded (audit, AQi Operations, health, usage, support, team), with gaps: no generic feature-rollout registry (only inbox_rollout), no security-events page outside the AQi copilot, no provider probes, a thin workload view, and RLS that lets assigned staff and every Agency Manager read approvals and activity without a support session.

## Matrix

- [existing-verified] 7B Identity and registry of the six employees
    evidence: src/lib/agents.ts (AGENT_ROLE_KEYS, AGENCY_HERMES_PROFILE_IDS, canChat); ensureAgentInstances src/server/workforce/service.ts:83; tests/workforce-config.test.ts (12), tests/ai-workforce-experience.test.ts (15)
    note: Exactly six roles, one agent_instances row per org and role, fixed internal profile ids, client profile names carry a slug digest (suggestedProfileName). No seventh employee path exists.
- [existing-incomplete] 7B Client Hermes profile provisioning (queue plus operator runbook)
    evidence: src/server/workforce/provisioning.ts (buildSoul, buildConfigYaml, getProvisioningBundle, requestProvisioning, updateProvisioningJob with lease/retry); migration 0082; tests/client-employee-provisioning.test.ts (4), tests/agency-hermes-workforce.test.ts (10)
    note: Portal never touches the VPS. Eligible only for non-demo, active, onboarded clients with a verified owner. A human creates the profile with the runbook, then maps it via connectHermesProfile (service.ts:834).
- [blocked-external] 7B Restricted host-side client provisioner (worker, claim/complete routes, 0084)
    evidence: Absent from this tree. Exists only on codex/client-ai-onboarding (bda64ac) and codex/hermes-gha-acceptance (195d279 / origin 8fabb19): services/hermes-provisioner/worker.py, src/server/workforce/hermes-provisioner.ts, src/app/api/internal/hermes-provisioner/{claim,complete}/route.ts, supabase/migrations/0084_restricted_hermes_provisioner.sql
    note: Branch docs report SANDBOX PASS on GitHub Actions (12 synthetic profiles, 48/48 python tests) and production NOT RUN. Needs a separate client-only Hermes runtime on the VPS, founder approval, migration 0084. Port decision belongs to the founder.
- [blocked-external] 7B Hermes in production
    evidence: docs/hermes-live-acceptance.md, docs/integrations.md, docs/client-ai-onboarding-release.md ('Read-only prerequisite audit' 2026-10-21), docs/automation-studio/production-audit-2026-10-22.md:59; project memory hermes-profile-policy-state
    note: No client employee mapped. Six internal employees were not all configured/verified when last audited (2 configured with passing health, 3 setup-required, 1 provisioning; no run ever started). Policy merge package v2.0 prepared but selftest/dry-run on the VPS not run. Customer replies, website chat and CRM tools all depend on this.
- [existing-verified] 7B Server-side run gate (enabled, status, applied config, credential, inventory digest, TTL, identity, acknowledgement)
    evidence: assertAgentRunnable / assertAgentRunPreflight / startAgentRun src/server/integrations/hermes/client.ts:542-765; used by chat/service.ts:727, leads/research-job.ts:270, messaging/responder.ts:134, workforce/preview.ts:206; tests/hermes-run-gate.test.ts (12), tests/hermes-tool-inventory.test.ts (29), tests/workforce-inventory-health.test.ts (6)
    note: Single entry point for every Hermes run. Fail-closed, re-checks right before submit. Strongest part of the area.
- [existing-incomplete] 7B Client-facing readiness (deriveEmployeeReadiness)
    evidence: src/lib/workforce-readiness.ts:155-370; callers gallery.tsx:44, employee-detail.tsx:130, chat-workspace.tsx:205, onboarded-banner.tsx:24, admin employees page; tests/workforce-readiness.test.ts (15)
    note: Correct for Hermes connection state and matches the server gate. Gaps: credentialOk defaults to true when a caller omits credentialCurrent (line 193); no role-specific prerequisites; no owner-visible age of the last health check.
- [missing] 7B Role-specific operational prerequisites (calendar for Appointment Setter, pipeline for Sales/CRM, targeting for Lead Hunter, channel for customer replies, knowledge)
    evidence: No code. capabilities report honest reasons ad hoc (workforce/appointment-availability.ts) but readiness never reflects them
    note: An employee can read 'Ready for authorized work' with no calendar, no pipeline, no sending channel and no approved knowledge.
- [broken] 7B Consistency of 'online' across dashboards
    evidence: Weaker predicates: src/server/crm/blueprints/checklist.ts:308 (status + base_url + credential_id only), src/server/setup/snapshots.ts:472, src/server/admin/queries.ts:240, src/server/admin/tenants.ts:287, src/app/(portal)/settings/integrations/page.tsx:42, src/server/onboarding/service.ts:288, src/server/aqi/ops/tools/health.ts:66
    note: Seven separate SQL definitions; the Blueprint checklist tells owners 'passed its connection check' without checking last_health_ok, revocation or inventory.
- [missing] 7B Employee health monitoring (scheduled probe)
    evidence: No Hermes job in src/server/ops/tick.ts. runHealthCheck is called only from chat page (refreshAgentHealthIfStale service.ts:954), chat send (chat/service.ts:248), admin actions, setup connectors, tool-policies. Incident collector src/server/ops/collectors.ts:242 reads stored status only
    note: A Hermes outage is invisible until someone opens chat. Customer replies (repliesChecked job) never refresh health.
- [existing-incomplete] 7B Knowledge scope per employee
    evidence: employeeKnowledgeContext src/server/workforce/knowledge.ts:80-120; KNOWLEDGE_SECTIONS src/server/knowledge/service.ts:16; per-widget section selection only in website chat (migration 0087)
    note: Every employee receives all approved company knowledge plus its own notes and assigned documents under one 6000-char budget. No per-role section scoping or sensitivity class. Documents need applied_at and carry risk flags.
- [existing-verified] 7B Role capability allowlist and caller permission
    evidence: src/lib/workforce-capabilities.ts (11 capabilities, allowedRoles, requiredPermission); dispatchCapabilityJob src/server/workforce/capability-dispatch.ts:20-90; runReadOnlyReviewJob re-checks role read-only-review.ts:92; tests/workforce-review-capabilities.test.ts (9), tests/workforce-jobs.test.ts (11), tests/workforce-chat-assignment.test.ts (4)
    note: Role, agents.use and the capability permission are all checked server-side; reviews are deterministic SQL reads, not model output.
- [existing-incomplete] 7B Role fence inside Hermes (tools) and out-of-scope refusal
    evidence: PORTAL_SAFE_TOOLSETS identical for all roles src/server/integrations/hermes/tool-policy.ts:10; REQUIRED_INVENTORY_TOOLS requires web_search/web_extract for every profile inventory.ts:47; regex guard src/lib/workforce-chat-guardrail.ts:29-100 (its own comment admits shared research tools)
    note: Prospect research by a non-Lead-Hunter is prevented by a keyword regex and prompt only. Easy to rephrase around.
- [existing-incomplete] 7B CRM agent tools (role scopes, tokens, approvals, HTTP route)
    evidence: src/server/crm/agent-tools/*, ROLE_SCOPES catalog.ts:54-61, src/app/api/agent-tools/[tool]/route.ts, tests/crm-agent-tools.test.ts (28); issueAgentToolToken (tokens.ts:46) has no caller in src
    note: Well designed and tested, but dead: nothing issues a token and the reviewed Hermes inventory forbids plugin/MCP tools, so no profile can call it. Page src/components/crm/agent-tools/ai-tools-screen.tsx:61 shows 'Not in use yet' only while liveRunsVerified is false.
- [existing-verified] 7B Actions an employee can really take today
    evidence: Chat (memory/web/todo/vision toolsets only), 11 read-only capability jobs (work-runner.ts HANDLERS), customer reply drafts through responder.ts plus requestBooking behind automationGate (responder.ts:222), docs/hermes-crm-tools.md
    note: No employee can change CRM records by itself. All writes are deterministic server code behind approvals.
- [existing-incomplete] 7B Memory and context isolation
    evidence: memoryScope iaq:<org>:<role> for staff chat (chat/service.ts:577), iaq:<org>:contact:<id> for customer replies (responder.ts:134), preview scope preview.ts:212; profile tools memory and session_search enabled; docs/verification-status.md:97 (memory not inspectable)
    note: Cross-tenant is separated by dedicated profiles. Within a tenant, memory is per employee and shared across users, and the portal's per-user conversation privacy (chat_conversations RLS) does not extend to Hermes memory/session_search. Unverified against a live profile.
- [existing-verified] 7B Tenant isolation of employees
    evidence: loadConnection/resolveCredential org+provider match (service.ts:811, security/credentials.ts:76); unique (gateway, profile) and reserved iacquire-* names for clients (service.ts:882-890); tests/tenant-isolation-generic.test.ts; agent_instances RLS can_access_org
    note: Schema-wide RLS guard test reads the live catalog, so new tables are checked automatically.
- [broken] 7B Pause, mode and agency pause enforcement
    evidence: automationGate src/server/automation/gate.ts:59 is called only from booking, agent-booking, messaging send/responder/web-chat-send and CRM agent tools. Not called from capability-dispatch.ts:56, schedules.ts:318, triggers.ts, work-runner.ts, leads/service.ts:75, leads/scheduled-research.ts
    note: gate.ts documents the 'job' scope as stopping on the agency pause, but job paths only check enabled and status.
- [existing-verified] 7B Notifications, escalation, audit/logs
    evidence: kinds agent_status, integration_disconnected, agent_task_completed (src/lib/notification-groups.ts:9); human_escalations + src/lib/escalation.ts; recordAudit agent.* in service.ts/provisioning.ts; agent_runs, tool_executions, ai_work_events
    note: Health transitions notify owners/admins; every health check writes an audit row (volume matters if probed frequently).
- [deferred-intentionally] 7B Scheduling of employee work
    evidence: ai_work_schedules / triggers (0078, 0079), WORKFORCE_SCHEDULES_ENABLED gate schedules.ts:35, scheduler never run (docs/production-readiness-closeout.md section 2)
    note: Dormant by design until the founder approves the scheduler stages.
- [existing-incomplete] 7B Usage and cost safeguards
    evidence: usage_limits hard stop for staff chat/lead research/help (src/server/usage.ts:13-80, chat/service.ts:272); customer replies gated only by credit balance and metered via chargeModelUsage when an llm rate is published (messaging/responder.ts:225-228, 285-299); fair-use ai_runs_30d counts agent_runs only (fairuse/service.ts:20)
    note: Customer-facing replies create no usage_events or agent_runs rows, so they are invisible to usage limits, fair-use and /admin/usage.
- [existing-verified] 7B Client customization (config versions, risk flags, agency review, draft preview)
    evidence: createConfigVersion/decideHeldVersion service.ts:326-660, src/lib/instruction-risk.ts, src/server/workforce/preview.ts, tests/workforce-config.test.ts, config-review-hardening docs
    note: Client text is layered under immutable policy (src/server/workforce/policy.ts) and cannot grant tools.
- [existing-verified] 7F Vault-backed credentials (Hermes, GHL, n8n, LLM, messaging providers, voice)
    evidence: src/server/security/credentials.ts (saveCredential, resolveCredential org+provider check, revokeCredential, super-admin only); tests/integrations-security.test.ts (26); docs/credential-security.md
    note: Real Vault exercised in production only for the Hermes gateway credential (live audit 2026-10-18); other providers are test-memory in CI.
- [existing-incomplete] 7F App-level sealed secrets (calendar OAuth tokens, CalDAV, ICS URLs, social tokens, Automation Studio connections, webhook secrets)
    evidence: encryptSecret/decryptSecret src/server/security/crypto.ts:64-80 single key; users in calendars/connections.ts:36, social/credentials.ts:8, automation-studio/connections.ts:128, crm/webhooks.ts:157
    note: AES-256-GCM, never returned to browsers. decryptSecret ignores APP_ENCRYPTION_KEY_PREVIOUS although signing code honours it, so rotation destroys every sealed secret.
- [existing-verified] 7F Calendar OAuth (Google, Microsoft)
    evidence: src/server/calendars/adapters/oauth.ts (PKCE S256, offline access, minimal Google scopes), connections.ts (single-use state, refresh before expiry and after 401, needs_reauth, notification, revoke), routes src/app/api/crm/calendar-oauth/[provider]/{start,callback}; tests/crm-calendar-connections.test.ts
    note: Live use needs GOOGLE_CALENDAR_CLIENT_* / MICROSOFT_CALENDAR_CLIENT_* app registrations. Microsoft grant is not revoked upstream on disconnect (connections.ts:784 Google only). docs/integrations.md still says 'No connector yet'.
- [existing-verified] 7F Social account connections (Meta)
    evidence: src/server/social/accounts.ts (status connected/needs_reauth/error/revoked/disconnected, token_expires_at, data_access_expires_at, deauthorize and data-deletion webhooks, 6-hour health job), providers/simulated.ts
    note: Best in-repo pattern for a connection lifecycle. Live publish blocked on Meta app review and META_SOCIAL_WRITES_ENABLED.
- [missing] 7F Google Drive connection
    evidence: git grep for onedrive|google drive|drive scopes on all 65 refs: only comments in src/lib/social/media-policy.ts on feat/phases-3-7
    note: No table, route, scope or UI on any ref. Blocked on a Google OAuth app (and likely Google verification).
- [missing] 7F OneDrive connection
    evidence: same search, zero hits on any ref
    note: Blocked on a Microsoft app registration.
- [missing] 7F Permission-aware AI access to client-connected storage
    evidence: Nothing exists; knowledge pipeline to reuse: knowledge_documents applied_at, agent_instance_id, risk_flags (src/server/workforce/knowledge.ts, knowledge/service.ts)
    note: Design below keeps the AI inside owner-selected folders only.
- [existing-verified] 7F Email, SMS and WhatsApp providers (Resend, Twilio, Meta WhatsApp, GHL) and webhooks
    evidence: src/server/messaging/channels.ts:202, transports/*, webhook routes src/app/api/webhooks/{resend,twilio,meta-whatsapp,ghl,paymongo,vapi,retell}/route.ts with signature checks; docs/production-readiness-closeout.md (all provider write switches false)
    note: Locally verified; live sending blocked-external. Mailbox OAuth (Gmail/Outlook) is listed as not available (src/lib/automation-studio/connections.ts:22).
- [existing-incomplete] 7F Slack and other channels
    evidence: Tenant Slack incoming webhook and HTTP connections in Automation Studio (migration 0072, connections.ts, outbound.ts); agency Slack alert via env
    note: Webhook only; Slack sign-in and channel picker are explicitly 'not yet available'. SSRF guard via pinned-https.ts.
- [existing-verified] 7F CRM public API keys and outbound/inbound webhooks
    evidence: src/server/crm/api-keys.ts (sha256 only, scopes bounded by creator permissions, per-key rate limit), crm/webhooks.ts, crm/workflows/inbound.ts (signed URLs), src/app/api/v1/crm
    note: Org always taken from the key row. No finding.
- [existing-verified] 7F Private storage (buckets, paths, permissions)
    evidence: src/server/storage/private.ts (org-prefixed UUID paths, MIME and signature checks, signed URLs 1-120 s), app.file_permission supabase/migrations/0089_social_media_manager.sql:324, buckets private (0011, 0015, 0020, 0049, 0089)
    note: aqi-attachments explicitly denies agency staff. No tests dedicated to the storage module itself (coverage is via feature tests and tests/supabase-security.test.ts).
- [existing-incomplete] 7F Storage entitlement: managed storage vs client-connected storage
    evidence: mediaStoragePolicy src/lib/social/media-policy.ts and getMediaPolicy src/server/social/media.ts:32-40 (raw statuses active/past_due/cancel_requested); Studio's time-aware entitlementFor src/lib/automation-studio/plan.ts:53; every other upload goes through uploadPrivateFile with no plan check
    note: Rule applies to social media only. Knowledge, support, project, brand and AQi uploads are unconditional. past_due keeps managed social storage forever (no grace end).
- [existing-incomplete] 7F Fair use and storage limits
    evidence: src/lib/fair-use.ts, src/server/fairuse/service.ts (policy default none, only storage_bytes can block_new), assertStorageAllowed called once in storage/private.ts:85; website_asset_blobs insert websites/service.ts:503 bypasses it; tests/fair-use-inactivity.test.ts (19)
    note: Honest ('No limit set') but no limit ships and publish-time copies are never blocked.
- [existing-verified] 7F Unlimited-storage claims
    evidence: git grep -i unlimited across src/docs/tests: only negative statements (help assistant prompt src/server/help/service.ts:84, project exclusions, tests/assistant-projects.test.ts:46); fair-use-card.tsx copy
    note: No place presents managed storage as unlimited. The card does say files are hosted 'with no monthly platform fee', which conflicts with the managed-plan rule for social media.
- [existing-incomplete] 7G Prospects
    evidence: access_requests via /get-started, /admin/requests (super admin only); docs/sales-and-demo-funnel-audit.md
    note: A lead list, not a prospect pipeline (no demo, notes, assignment, conversion). 7D owns the build.
- [existing-verified] 7G Clients and workspace provisioning
    evidence: src/app/(admin)/admin/clients/*, src/server/admin/tenants.ts (create, assign staff, suspend), setup templates, offboarding; tests/offboarding.test.ts, tests/setup-fleet-health.test.ts
    note: Client AI provisioning is the incomplete part (see 7B).
- [existing-verified] 7G AI Employees administration
    evidence: /admin/employees (+/[slug], /clients, /policies, /reviews), hermes gateways, tool policies, acknowledgements; tests/agency-hermes-workforce.test.ts, hermes-tool-policies.test.ts
    note: Super-admin gated for internal employees; permissions agency.workforce.*, agency.tool_policies.*.
- [existing-verified] 7G Integrations administration
    evidence: /admin/integrations (agency.integrations.health / manage), src/server/integrations/manager.ts, tests/integration-health-permissions.test.ts, tests/integrations-security.test.ts
    note: Secrets replace-only, fingerprints shown.
- [existing-incomplete] 7G Subscription plans
    evidence: /admin/maintenance (maintenance_subscriptions lifecycle), src/server/maintenance/service.ts, src/lib/automation-studio/plan.ts, /admin/billing, PayMongo webhook; tests/maintenance.test.ts
    note: The US$299 plan lifecycle works. No PayPal code anywhere; PayMongo is agency-side only.
- [existing-incomplete] 7G Usage and cost visibility
    evidence: /admin/usage, fair_use_status, usage_events, getLimits
    note: Excludes customer-facing AI replies.
- [existing-verified] 7G Requests (support, custom projects, access requests)
    evidence: /admin/support (+analytics, settings), /admin/projects, /admin/requests; tests/support-agency.test.ts, tests/aqi-support.test.ts
    note: Granular agency.support.* permissions.
- [existing-incomplete] 7G Staff assignments and workload
    evidence: staff_assignments, agency_user_client_scopes, /admin/team (+/[userId]); workload = open setup tasks + open tickets only (src/components/admin/agency-team-member-details.tsx:353) and support analytics workload table
    note: No combined workload across provisioning jobs, projects, held config reviews, website reviews.
- [existing-incomplete] 7G Platform errors and incidents
    evidence: incidents, src/server/ops/collectors.ts, /admin/health incidents panel, src/server/diagnostics.ts; tests/operations.test.ts
    note: Collectors observe stored state only. Vercel runtime logs were inaccessible at last audit (docs/production-readiness-closeout.md section 5).
- [existing-incomplete] 7G Provider health
    evidence: /admin/health ServiceCards from getSystemHealth, integration_status, hermes_gateways.status
    note: Shows the last recorded check, never probes (no Hermes, GHL, n8n, email probe job).
- [existing-verified] 7G Scheduler status
    evidence: /api/health scheduler field, worker_job_runs, claimSchedulerTick lease, /admin/health jobs; tests/scheduler-intervals.test.ts, scheduler-job-allowlist.test.ts, operations.test.ts
    note: Display is correct; scheduler has never run in production (needs CRON_SECRET and SCHEDULER_ENABLED approval).
- [missing] 7G Feature rollouts
    evidence: Only inbox_rollout (migration 0083, src/server/messaging/inbox-rollout.ts, /admin/inbox-rollout). No feature_flags table on any ref
    note: Web chat, social, lead scoring and missed-call recovery are 'dormant' through env switches, scheduler state and client-side toggles, not an agency-controlled per-workspace rollout.
- [existing-incomplete] 7G Security events
    evidence: AQi Operations tool security.events src/server/aqi/ops/tools/security.ts (AUDIT_GROUPS), login rate limit, crm.support_session_* audit; tests/aqi-ops-tools.test.ts
    note: Only reachable through the AQi Operations copilot (super admin). No stand-alone page, no alert rule on denied access or unusual volume.
- [existing-verified] 7G Audit logs
    evidence: /admin/audit (requireAgency('super_admin')), audit_logs_no_update trigger supabase/migrations/0004_support_ops.sql:169
    note: Append-only, super-admin only.
- [existing-verified] 7G AQi knowledge and insights
    evidence: /admin/aqi, /admin/aqi/insights (super admin), src/server/aqi/*, tests/aqi-*.test.ts
    note: Insights are aggregates by design.
- [existing-incomplete] 7G No private client content for unauthorized staff
    evidence: CRM, inbox, calls, analytics gated by crm_support_sessions in app.has_permission / app.permitted_orgs (migrations 0042, 0060:270-318; src/server/crm/actor.ts:233). Not gated: approvals.view, activity.view, knowledge.view, leads.view
    note: Support sessions are reasoned, time-limited and audited, but only write sessions notify the client. Agency Managers default to all_clients scope.

## Other refs

- codex/client-ai-onboarding (7 commits ahead of feat/phases-3-7, tip bda64ac) :: services/hermes-provisioner/{worker.py,Dockerfile,compose.client.yaml,client-config.yaml.example,client.env.example,DEPLOYMENT.md,test_worker.py,test_deployment.py,catalog-overlay/,catalog-overlay-v0223/}; src/server/workforce/hermes-provisioner.ts; src/server/workforce/provisioner-http.ts; src/app/api/internal/hermes-provisioner/{claim,complete}/route.ts; supabase/migrations/0084_restricted_hermes_provisioner(.down).sql; tests/hermes-provisioner.test.ts; edits to src/server/workforce/{provisioning,service}.ts, src/server/integrations/hermes/{client,inventory}.ts, src/server/security/credentials.ts, src/server/env.ts :: Restricted host-side provisioner: typed manifests, lease/claim/complete routes, Vault key storage, profile config sync, fresh-session SOUL challenge, complete-catalog gate. 58 files, about 19k lines, most of it vendored Hermes overlay. Reserved migration 0084 must not be renumbered carelessly; the branch is 13 commits behind this tree, so it will conflict in service.ts, client.ts and env.ts. Not assumed mergeable.
- codex/hermes-gha-acceptance (local 195d279, origin/codex/hermes-gha-acceptance 8fabb19; 39/38 ahead) :: .github/workflows/hermes-client-acceptance.yml; services/hermes-provisioner/{acceptance_harness.py,compose.acceptance.yaml,test_acceptance_harness.py}; docs/client-ai-onboarding-release.md; docs/hermes-restricted-provisioner.md :: Everything above plus the Buildx acceptance harness and the recorded SANDBOX PASS (GitHub Actions run 39801131835, 12 synthetic profiles, 72 cross-tenant denials). The only evidence in the repo that client isolation was exercised against a real Hermes gateway, still synthetic and not production.
- codex/109d-readiness-consistency-hotfix (ca91bc3) and codex/109d-current-master-integration (ae2f49c) :: src/lib/workforce-readiness.ts, src/server/chat/service.ts, src/server/integrations/hermes/client.ts, tests/workforce-readiness.test.ts :: One commit, 'Fix internal workforce readiness consistency'. Diffed against this tree: this tree already contains a newer superset (chat/service.ts and client.ts here are larger). Treat as superseded; do not port.
- origin/feat/native-crm 64c824f 'Fix portal origin validation for integrations' :: src/server/security/portal-origin.ts, src/app/api/admin/integrations/route.ts :: Already present in this tree (portal-origin.ts exists); no action.
- Not a git ref: sibling directory hermes-tool-catalog-dev/ (per project memory, not verified in this audit) :: docker/profiles/, dist/iacquire-hermes-profile-policy-2.0-20261019.tar.gz :: VPS tool-policy merge package (rev 3, 122 tests). Prepared, never run on the VPS. Any per-role toolset change must be mirrored here.
- All 65 refs searched for: Google Drive, OneDrive, feature_flags, storage_connections, cloud storage :: none :: No hits other than the comments in src/lib/social/media-policy.ts. Nothing to port for external storage or a rollout registry.

## Reuse
- src/lib/workforce-readiness.ts deriveEmployeeReadiness and src/server/integrations/hermes/client.ts assertAgentRunPreflight: extend, do not fork; add a thin server wrapper that returns one readiness object per employee and use it everywhere.
- src/server/automation/gate.ts automationGate(scope 'job') and checkOrgAutomation: the only pause/mode/agency-pause authority; wire it into job, schedule, research, publisher and sync paths.
- src/server/social/accounts.ts + providers/simulated.ts + social_oauth_states: the connection lifecycle (statuses, reauth notification, deauth webhook, 6-hour health job, simulated provider for tests without a live app) to copy for storage connections.
- src/server/calendars/adapters/oauth.ts and connections.ts: PKCE, single-use state, refresh-before-expiry, revoke; copy for Google Drive and Microsoft Graph.
- src/server/security/crypto.ts encryptSecret/decryptSecret and credentials.ts: keep one sealing path, add a key id (see design) instead of a second scheme; Vault stays for agency-held provider credentials.
- src/lib/automation-studio/plan.ts entitlementFor + src/server/automation-studio/entitlement.ts: the time-aware maintenance-plan entitlement (grace, expiry, lapse never deletes); extract the plan-state part into a shared module used by Studio and storage.
- src/server/storage/private.ts uploadPrivateFile, app.file_permission, validPrivateFileSignature, fairuse assertStorageAllowed: the single upload choke point to attach purpose-based entitlement to.
- src/server/workforce/knowledge.ts + knowledge/service.ts (applied_at, agent_instance_id, risk_flags, extraction): the only way external files may reach an employee.
- src/server/ops/tick.ts JOBS registry with everyMinutes and scripts/rehearse-phase4-migrations.mjs for rehearsal of the next migration.
- src/server/messaging/inbox-rollout.ts and src/components/admin/inbox-rollout-admin.tsx: the rollout UI and server pattern to generalise; keep inbox_rollout working.
- src/server/aqi/ops/tools/security.ts AUDIT_GROUPS: data source for a non-AI security-events page.
- src/server/crm/actor.ts crm_support_sessions and the gated-permission list in app.has_permission (0042) and app.permitted_orgs (0060): extend rather than invent a second access mechanism.
- tests/support (messagingOrg, crmOrg fixtures) and tests/tenant-isolation-generic.test.ts: new tables get RLS coverage automatically.

## Risks
- Hermes is not provisioned in production and the only client-profile automation is on unmerged branches; every employee-facing claim (customer replies, website chat, social AI drafts, CRM tools) is local-only evidence.
- Role-fence reliance on a keyword regex: a non-Lead-Hunter employee can do web research with the shared toolset. A per-role tool allowlist needs the inventory verifier, the provisioning config and the VPS policy package to change together.
- Hermes memory and session_search are enabled for all profiles and keyed by org+role (staff chat) or org+contact (customers). Whether one user's, or one customer's, content can surface in another's session is unverified; it needs a live two-session canary before any customer-facing launch.
- The CRM agent-tool subsystem cannot run under the current reviewed inventory (no plugin/MCP). When live runs become verified, liveRunsVerified will hide the 'Not in use yet' banner although no token issuer exists, so the page would imply tools are active.
- AI spend: customer replies are bounded only by the credit balance and are metered only if an llm unit rate is published; once the scheduler runs, repliesChecked answers every pending message each tick. There is no per-tenant reply cap and no usage_events trail.
- Rotating APP_ENCRYPTION_KEY today would invalidate calendar, social, Automation Studio and webhook secrets at once; there is no key id or re-seal tool.
- Offboarding and org suspension leave live third-party credentials (Google/Microsoft calendar tokens, Meta page tokens, Slack webhooks, API keys) and let the social publisher and calendar sync keep running.
- Changing app.has_permission or app.permitted_orgs is a high-blast-radius RLS change: both must change together, 0060 pins the old definitions, admin queries that count approvals via withUser (src/server/admin/queries.ts:317) would silently return zero for staff without a session.
- Google Drive access scopes beyond per-file selection are Google restricted scopes (security assessment, weeks of lead time); Microsoft work accounts may need tenant-admin consent. Verify against current provider documentation before registering apps; not verified in this audit.
- Entitlement drift: Studio treats past_due as entitled only until grace ends; social uses raw statuses. Any new gated feature copying the social code inherits the drift.
- The audit table would grow quickly if every employee were health-probed every few minutes (runHealthCheck writes an audit row and an integration_status upsert each time).
- Working-tree hygiene: git shows uncommitted edits in src/server/storage/private.ts (490-line diff on a 245-line file, looks like a line-ending rewrite), src/server/websites/forms.ts, scripts/inbox-mock-llm.mjs, scripts/ui-qa.vitest.config.ts. A careless commit would carry noise into a security-sensitive file. Not touched by this audit.
- Documentation lags code: docs/integrations.md and docs/verification-status.md:289 say Google Calendar has no connector, but a full OAuth connector exists.

## Findings in existing code
- [high] src/server/offboarding/service.ts:218 Shutdown step 2 disconnects only integration_connections rows (hermes, ghl, n8n, google_calendar and similar). crm_calendar_connections OAuth tokens, social_accounts page tokens, automation_connections secrets, CRM API keys and webhook secrets stay live, and src/server/social/publisher.ts:114 (claimNext) and calendars/sync.ts never check org status or automation_pauses, so approved posts and calendar write-back can continue after 'Workspace is closing'.
- [medium] src/server/workforce/capability-dispatch.ts:56 AI work jobs check only enabled, status and applied config. automationGate (employee mode paused, agency pause, org suspended) is never called for capability dispatch, schedules (schedules.ts:318), triggers, work-runner.ts:59, lead research start/retry (leads/service.ts:75,113) or scheduled research, although gate.ts:34 defines the 'job' scope to stop on the agency pause. A paused or agency-paused workspace can still start and run Hermes-backed lead research and reviews.
- [medium] src/server/security/crypto.ts:72 decryptSecret uses only the current APP_ENCRYPTION_KEY and ignores APP_ENCRYPTION_KEY_PREVIOUS, which crm/reviews.ts:84 and crm/workflows/inbound.ts:36 do honour. Rotating the key makes every calendar token, CalDAV password, ICS URL, social token, Automation Studio connection secret and webhook secret undecryptable; there is no key id in the envelope.
- [medium] src/server/integrations/hermes/inventory.ts:47 The inventory verifier requires web_search and web_extract for every profile and tool-policy.ts:10 gives all six roles the same toolsets, so any employee can research the web. The only barrier for non-Lead-Hunter roles is the keyword regex in src/lib/workforce-chat-guardrail.ts:29, which a rephrased request avoids.
- [medium] src/server/ops/tick.ts:105 No scheduled job probes Hermes. Employee status stays 'online' until someone opens chat (service.ts:954), an admin runs a check or a chat send triggers one; fleet counts (admin/queries.ts:240, setup/snapshots.ts:472) and the client 'Ready' banner show stale state, and the incident collector (ops/collectors.ts:242) only reads the stored status.
- [medium] src/server/crm/blueprints/checklist.ts:308 The Blueprint checklist computes employee 'ready' as enabled and status online/busy and base_url and credential_id not null, then tells owners 'passed its connection check'. It ignores last_health_ok, credential revocation, applied config and inventory. Six other places (setup/snapshots.ts:472, admin/queries.ts:240, admin/tenants.ts:287, settings/integrations/page.tsx:42, onboarding/service.ts:288, aqi/ops/tools/health.ts:66) use their own weaker definitions of 'online'.
- [medium] src/server/messaging/responder.ts:134 Customer-facing AI replies start a Hermes run with no assertWithinLimits, no usage_events row and no agent_runs row. They are limited only by the credit balance (line 225) and metered only if an llm unit rate exists (line 294), and they are absent from fair-use ai_runs_30d (fairuse/service.ts:20) and /admin/usage.
- [medium] supabase/migrations/0042_company_delete_permission.sql:63 app.has_permission (and app.permitted_orgs, 0060:270) gate support-session-only access for CRM, inbox, calls and analytics but not approvals.view, activity.view, knowledge.view or leads.view. approval_requests (title, target_label, action jsonb) and agent_runs are readable by every assigned staff member and by every Agency Manager with the default all_clients scope, without a reasoned, audited session. permissions.ts:74 says staff reach customer data only through audited tooling. No admin UI path was found that displays the rows (counts only), so this is database-level exposure.
- [medium] src/server/chat/service.ts:577 Hermes long-term memory is keyed iaq:<org>:<role> for all users of an employee while memory and session_search are enabled for every profile; the portal's per-user conversation privacy (chat_conversations RLS, 0002_workforce.sql:364) does not reach Hermes. Likewise the customer-reply scope (responder.ts:134) relies on a key rather than on session_search being scoped. Within-tenant cross-user or cross-customer recall is unverified and untested.
- [low] src/components/crm/agent-tools/ai-tools-screen.tsx:61 The 'Not in use yet' notice depends on liveRunsVerified (crm/agent-tools/overview.ts:71, tasks.ts:48). It disappears as soon as any employee passes the run gate, although issueAgentToolToken (tokens.ts:46) has no caller and the reviewed inventory excludes any tool that could call the endpoint, so the page would claim live tool use.
- [low] src/server/social/media.ts:32 Managed-storage entitlement uses raw statuses ['active','past_due','cancel_requested'] instead of the time-aware entitlementFor (automation-studio/plan.ts:53), so a past_due plan beyond its grace period keeps managed social storage indefinitely and the same rule is absent from every other upload bucket.
- [low] src/server/websites/service.ts:503 Publishing inserts image bytes into website_asset_blobs without assertStorageAllowed, which uploadPrivateFile (storage/private.ts:85) calls. A workspace set to block_new storage can still add stored bytes on every publish (capped at 40 MB per publish).
- [low] src/lib/workforce-readiness.ts:193 credentialOk = credentialCurrent !== false, so a caller that omits credentialCurrent is treated as having a valid credential. All six current callers pass it, but the default fails open. Related: admin/queries.ts:131 has_credential and workforce/agency-registry.ts:102 count credential_id not null without checking revocation.
- [low] src/server/calendars/connections.ts:784 Disconnect revokes the upstream grant only for Google; a Microsoft calendar disconnect leaves the grant valid at the provider, and the UI copy is not specific about it. Docs (docs/integrations.md, docs/verification-status.md:289) still state that no Google Calendar connector exists.

## Founder decisions
- Port or rebuild the restricted client-profile provisioner (codex/client-ai-onboarding, codex/hermes-gha-acceptance) and approve a separate client-only Hermes runtime on the VPS, migration 0084, and the production activation sequence. Until then no client employee can ever be 'ready'.
- Approve (or defer) running the Hermes policy merge package selftest and dry run on the VPS for the six internal profiles.
- Per-role Hermes tools: should only the Lead Hunter have web research? It requires changing the verified inventory contract and the VPS package.
- Which storage is included in the US$1,499 core and which requires the US$299 managed plan (knowledge, support attachments, project files, website assets, social media, AQi attachments). Today only social media follows the plan rule and the usage page says files are hosted with no monthly fee.
- Lapse rules for managed storage: whether past_due and cancel_requested keep upload rights, the grace length, and whether files become read-only or are eventually removed.
- Storage allowances: when to set storage_bytes and other fair-use limits (they ship unset), and which enforcement (report only vs block new uploads).
- Register Google and Microsoft OAuth apps for Drive and OneDrive, choose per-file/app-folder scopes versus whole-drive read, and accept provider verification lead times and any review cost.
- Whether an agency pause and offboarding must stop approved social posts, calendar write-back and Automation Studio connections (recommended yes), and whether shutdown should revoke upstream tokens automatically.
- Whether Agency Managers should default to all_clients scope, and whether approvals, activity, knowledge and leads should require an audited support session for staff.
- Whether read-only support sessions should notify the client (today only write sessions notify).
- AI cost controls for customer-facing replies: publish llm unit rates, set a per-tenant monthly reply cap, and decide what a customer sees when it is reached.
- Health probe cadence, who is alerted when Hermes is down, and approval to include employeeHealth in the first scheduler stage.
- Key rotation: approve introducing sealed-secret key ids and a one-time re-seal of existing secrets before the first production rotation.
- Scope of the feature-rollout registry and which dormant Phase 2-4 features move under it before launch.
- Legal and provider reviews that gate Drive/OneDrive data handling (data processing terms, retention of extracted text) and Meta app review for social.

## Recommended design
## Principles
Reuse what works; no seventh employee; nothing live without approval; every new table tenant-keyed with composite (id, org_id) FKs, RLS select-only grants, additive migration plus rollback in supabase/rollbacks. Numbering: propose 0090_external_storage and 0091_support_gate_and_usage (re-run scripts/rehearse-phase4-migrations.mjs and check all refs first; 0084 stays reserved for the provisioner).

## P0: trust fixes (about 2,000 lines incl. tests, no new feature)
1. **Job gate.** New src/server/automation/job-gate.ts: assertJobAllowed(db,{orgId,agentId}) wraps automationGate(scope 'job') (mode paused, agency pause, org inactive, not ready) and throws AppError('automation_blocked', detail). Call it in dispatchCapabilityJob (before createWorkJob), runWorkJob at claim (finish 'blocked' with failureCode = gate reason, no retry), runDueSchedules/runDueTriggers (record lastSkippedReason), leads/service.ts startResearch and retryResearchRequest, leads/scheduled-research.ts. Staff chat stays allowed while paused (documented in gate.ts). Tests: each entry point x {mode paused, agency pause, suspended org} -> no job created or run.
2. **One readiness.** Add src/lib/workforce-prerequisites.ts (pure): per-role PREREQUISITES with severity blocking|advisory and a fact key. Add src/server/workforce/readiness.ts: loadWorkspaceFacts(orgId) in one query (company profile saved, approved knowledge section count, active native calendar, pipeline exists, enabled messaging channel, lead targeting set) and employeeReadiness(orgId, role) = deriveEmployeeReadiness + gaps. deriveEmployeeReadiness gains tier 'ready' | 'ready_with_gaps' and credentialCurrent becomes required (remove the default-true at workforce-readiness.ts:193). Replace the seven SQL 'online' predicates with one SQL helper (view or function app.employee_chat_ready(a)) generated from the same rules; add a parity test that runs deriveEmployeeReadiness and the SQL helper over a fixture matrix (disabled, no config, no health, revoked credential, expired inventory, internal without acknowledgement). Gap copy states what is missing; never 'Ready' when a blocking gap exists for the capability being offered.
3. **Health probe.** tick job employeeHealth (everyMinutes 10) in two tiers: (a) per gateway, one capabilities + models read recorded on hermes_gateways (last_probe_at, last_probe_ok, existing status) and, if a gateway is down, mark its mapped employees offline once; (b) per employee full runHealthCheck only when last_health_check_at is older than 6 hours or the employee is in provisioning, capped at 20 per tick, with an audit row only on a status change (add an option to runHealthCheck). Existing notification transitions apply. Dormant until the scheduler stage is approved.
4. **AI tools banner.** Add const AGENT_TOOLS_WIRED = false in src/server/crm/agent-tools/tasks.ts; overview.ts liveRunsVerified = AGENT_TOOLS_WIRED && ...; flip only when a token issuer and a reviewed Hermes toolset exist.
5. **Shutdown completeness.** Extend src/server/offboarding/service.ts step 2 to: disconnectCalendar for every crm_calendar_connections row, mark social_accounts revoked and null credentials, revoke automation_connections (existing revoke path), revoke crm_api_keys and webhook subscriptions, disable voice connections; report each. Add checkOrgAutomation(db, orgId, 'outbound') to social publisher claimNext (join organizations.status and automation_pauses) and org-status check to calendars/sync.ts and write-back. Tests in tests/offboarding.test.ts style.
6. **Sealed-secret key ids.** New envelope v2.<kid>.<iv>.<tag>.<ct>; kid = first 8 hex of sha256(key). decryptSecret tries the kid key, then APP_ENCRYPTION_KEY_PREVIOUS list; v1 still readable. Script scripts/reseal-secrets.ts (dry run default, counts only, table list from a registry) re-seals calendars, social, automation_connections, webhook secrets. Tests: rotate key, old rows still decrypt, re-seal then drop previous key.
7. **Usage visibility for customer replies.** After a successful reply in responder.ts, insert usage_events(kind 'customer_reply', quantity 1, tokens) and count them in measureOrg ai_runs_30d and /admin/usage. Add nullable usage_limits.monthly_customer_replies (null = reported, never presented as unlimited); when set, respondToConversation skips with reason 'usage_limit' and escalates to a person. Founder sets numbers.
8. **Support-session gate for content-bearing permissions.** Migration 0091 recreates app.has_permission and app.permitted_orgs together (keep identical bodies except the gated list) adding approvals.view, activity.view (and, pending decision, knowledge.view, leads.view) to the support-session-only list and to the read-session allowlist in src/server/crm/actor.ts AGENCY_READ_PERMISSIONS. First change src/server/admin/queries.ts:317 and src/app/(admin)/admin/employees/[slug]/page.tsx:79 (approval counts) to withSystem + app.user_can_access_org so admin counts survive. Tests: staff assigned, manager default scope, super admin, with and without session; update tests/rls-initplan-equivalence.test.ts and the permission-matrix drift test.

## P1: storage entitlement and role fence
9. **Shared plan entitlement.** Move the plan-state part of entitlementFor into src/lib/plan/entitlement.ts (pure, time-aware: active, cancelling, past_due within grace, expired). Studio and storage both import it. src/lib/storage/policy.ts replaces media-policy.ts: PURPOSES = social_media | knowledge | support | project | brand | aqi_attachment | website_assets with a table purpose -> rule (core | managed_plan) that the founder fills in; storagePolicy(purpose, {planEntitlement, connections}) returns options with honest reasons, 'no media storage available' when neither applies, never an 'unlimited' string (lint test greps copy).
10. **Central enforcement.** uploadPrivateFile resolves purpose from bucket and calls assertManagedStorageAllowed(orgId, purpose, bytes) beside assertStorageAllowed; the website publish copy path calls assertStorageAllowed too. Lapse behaviour mirrors Studio: new uploads blocked, existing files readable and exportable, nothing deleted, grace period shown. Fix copy in src/components/fairuse/fair-use-card.tsx once the founder decides.
11. **Per-role tool allowlist (only if approved).** tool-policy.ts: PORTAL_TOOLSETS_BY_ROLE (web only for lead_hunter); inventory.ts REQUIRED_INVENTORY_TOOLS_BY_ROLE and verifyToolInventory(role); buildConfigYaml(role); hermes-tool-catalog-dev policy generated per profile. Keep the regex guard as a second layer and log refusals. Tests per role in tests/hermes-tool-inventory.test.ts.

## P2: external storage (local part now, live part blocked on OAuth apps)
12. **Migration 0090_external_storage.** Tables, all with org_id and composite FKs:
 - storage_connections(id, org_id, provider check in ('google_drive','onedrive','simulated'), connected_by, account_label, external_account_id, credentials text (sealed v2), scopes text[], status check in ('connected','needs_reauth','error','revoked','disconnected'), status_detail, token_expires_at, last_checked_at, last_success_at, connected_at, disconnected_at, unique (id, org_id), partial unique (org_id, provider, external_account_id) where status <> 'disconnected').
 - storage_oauth_states(id, org_id, user_id, provider, state_hash, pkce_verifier sealed, return_path, expires_at, used_at) copied from social_oauth_states.
 - storage_folders(id, org_id, connection_id, external_id, label, purpose check in ('social_media','knowledge'), status check in ('selected','removed'), selected_by, selected_at, sync_cursor sealed/text) with FK (connection_id, org_id).
 - storage_files(id, org_id, connection_id, folder_id, external_id, name, mime_type, size_bytes, external_revision, status check in ('discovered','ready','stale','blocked','removed'), block_reason, last_seen_at, knowledge_document_id, social_media_asset_id) no bytes stored for knowledge; social media fetched at publish with a size cap.
 - storage_sync_runs(id, org_id, connection_id, started_at, finished_at, status, counts jsonb, error).
 - Additive columns: knowledge_documents.source_connection_id, external_file_id, external_revision; social_media_assets.source = 'google_drive'|'onedrive' is already in the policy type.
 RLS: select only for iaq_app_user via permitted_orgs('storage.view'); no staff row for storage.view (like aqi-attachments); credentials column not granted.
13. **State machines.** Connection: pending(oauth state) -> connected <-> needs_reauth | error -> revoked (provider told us) | disconnected (person). Entering needs_reauth stops syncing, sets files to stale, notifies owners (storage_account_attention). File: discovered -> ready (type, size, signature and risk-flag checks pass) -> stale (revision changed or folder removed) -> removed; blocked if risk flags or extraction fails. Disconnect or revoke: delete extracted_text and cached bytes, set knowledge_documents status deleted, audit.
14. **Permissions.** storage.view (CLIENT roles), storage.connect and storage.select (owner, admin). Add to PERMISSION_MATRIX, role_permissions seed, AGENCY rows none. Admin side shows connection status only on /admin/clients/[id]/integrations, never file names.
15. **Server and files.** src/lib/storage/{policy,providers}.ts; src/server/storage/connections.ts (start, complete, disconnect, health, listFolders, selectFolder); src/server/storage/external/{types,simulated,google-drive,onedrive}.ts (simulated first, production-refusing like social simulated); src/server/storage/sync.ts (incremental with provider change cursors, caps, backoff, per-connection lease); src/server/storage/knowledge-bridge.ts (create knowledge_documents rows pending owner 'apply', then existing extraction and risk-flag pipeline; assign to employees with the existing agent_instance_id mechanism). Routes /api/storage/oauth/[provider]/{start,callback} (same-origin check, PKCE, single-use state, no-store, no-referrer) mirroring calendar routes. Page /settings/storage (connect, pick folders, status, what the AI can see, disconnect). Social composer reads media from selected folders through storagePolicy.
16. **Permission-aware AI.** The AI never sees a drive: only files inside owner-selected folders, only after the owner applies them, assignable per employee, text-only, risk-flagged, truncated by the existing 6000-char budget; no Drive tool exists in the Hermes inventory (the contract forbids it). Provider scopes: prefer per-file or app-folder scopes with a picker (Google drive.file, Microsoft Files.Read.Selected or app folder) over whole-drive read; confirm against current provider docs and Google's verification requirements before registering.
17. **Jobs and notifications.** tick: storageHealth (360), storageSync (60, selected folders only), storageRetention (1440, removes disconnected metadata after the retention window). Notification kinds storage_account_attention, storage_sync_failed (notification-groups.ts). Optional Automation Studio trigger storage.connection_lost in src/lib/crm/workflow/spec.ts. All dormant until the scheduler and the OAuth apps exist.
18. **Tests.** Tenant isolation of every table (generic test), state replay and expiry, refresh, revocation purge, cross-tenant folder id, entitlement lapse (grace boundary), simulated provider drive failure and quota, no token in logs/audit, copy lint for 'unlimited', Playwright-free page tests following tests/social-* style.

## P3: Super Admin completion
19. **Rollout registry.** feature_rollouts(org_id, feature_key, state check in ('off','pilot','on'), reason, set_by, set_at, unique(org_id, feature_key)); src/lib/rollouts.ts (keys web_chat, social_media, lead_scoring, missed_call_recovery, customer_ai_replies, external_storage; default off; prerequisites such as 'Hermes verified'); isFeatureOn(db, orgId, key) enforced server-side at each public and job entry point; unified_inbox delegates to inbox_rollout. Page /admin/rollouts reusing inbox-rollout-admin UI, super admin only, audit rollout.changed, owner notification. Does not change existing behaviour until a flag is first set (migration seeds 'on' for workspaces that already use a feature).
20. **Security events page.** /admin/security (super admin) renders AUDIT_GROUPS data with filters and denied-access counts; no AI. Add one incident collector for repeated support-session denials and failed sign-ins.
21. **Workload.** Extend src/server/admin/team.ts and the member detail with open provisioning jobs, held config reviews, website reviews, projects; add a column to /admin/team.
22. **Client notification for read support sessions** (decision below) in startSupportSession.

## Ordering
P0 items 1, 4, 5, 6 first (small, independent), then 2, 3, 7, 8. P1 9 and 10 before any new gated feature. P2 only the simulated provider and policy until the founder supplies OAuth apps. P3 after P0. Provisioner port (other_refs) is a separate approved track that unblocks real employees; do not start it from this plan.

## Not to do
No new employee, no second scheduler, no rebuild of Vault, calendars OAuth, social accounts, fair-use or support sessions; no live provider call, hosted migration, push or scheduler start without approval.