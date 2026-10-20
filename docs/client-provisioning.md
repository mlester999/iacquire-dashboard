# Client provisioning guide

The client provides company information and approves business decisions. The agency configures
technical services. Setup progress, integration health, preparation job status and activation
readiness are separate persisted records.

## Start with a client workspace

1. Open **Admin → Clients**, create the client and send an invitation through the configured
   provider. Invitations are the only signup path; the application role comes from the invitation,
   not browser metadata. See `supabase-setup.md` before connecting a development project.
   The portal reports what the mailer really did: **Email sent**, **not delivered** (the environment is
   in `EMAIL_PROVIDER=capture` mode) or **failed** with the provider's reason. If the owner has not
   received it, open the client and choose **Resend invite** (header, or **Team & staff** for each
   pending invitation, expired ones included). Resending issues a fresh link and revokes the old one;
   it is limited to six resends per hour per invitation. Production needs `EMAIL_PROVIDER=resend`,
   `RESEND_API_KEY` and an `EMAIL_FROM` address on a domain verified with the provider.
2. The client accepts the invitation, verifies their email, and completes company onboarding.
3. The existing onboarding service saves the company profile, knowledge and selected employee
   configurations transactionally. It creates the setup instance and queues preparation jobs with
   stable tenant-specific idempotency keys: three jobs for a native CRM client, plus the manual
   GoHighLevel mapping job only when the client keeps GoHighLevel. Resubmitting cannot duplicate
   those jobs.
4. Open **Client → Setup** and choose the package services. CRM, AI, automations, calendar and
   email have their own milestones. Custom websites and standard funnels are separate optional
   services. Existing client package selections and task history are retained.

## Agency work

Open `/admin/clients/<client-id>/provisioning`. Every operation has a tenant, idempotency key,
attempt count, retry limit, timestamps, lease, result references and audit history.

- **Prepare AI configuration drafts** creates versions from the company's current settings and
  business context. It does not apply those drafts, create remote Hermes profiles or turn on tools.
  Re-running the same job reuses its configuration version IDs.
- **Prepare safe automation configuration** records the timezone, approved communication
  preferences and disabled outreach/write/activation flags. It does not edit n8n or GHL.
- **Prepare manual CRM mapping task** records an actionable administrative step for a
  **GoHighLevel** client. Create the GoHighLevel sub-account manually using the approved Master
  Snapshot, then configure/test its Location ID in the client's Integrations Manager. The portal
  never creates sub-accounts or assumes that a snapshot was installed. Never assign the internal
  agency location to a client or access Aster Homes. Native clients already have their
  `crm_workspaces` row; they do not get this job.
- **Prepare dedicated profile runbook** produces tenant-specific suggested identities for enabled
  employees. Use the existing agency workforce runbook after separately reviewing the installed
  Hermes version and security configuration. Do not clone or reuse the six agency profiles.
  Remote profile creation is an agency task because no supported safe creation API is assumed.
- **Verify configured integrations** runs available read-only provider checks, records the result
  and fails visibly if any required check is missing or failing. It never activates anything.

Jobs run through an explicit authorized agency action. The model supports a future agency worker;
there is no unreviewed background service making external writes. Failures use exponential backoff
(30, 60, 120 seconds) with three attempts by default. Retry the same job after its displayed retry
time. An interrupted attempt is recovered only after its five-minute lease expires. Concurrent
execution of the same live lease is refused. Exhausted retries need agency investigation and a new
deliberate request. Preparation success is not proof that an integration is connected.

## Edit and review setup

In `/admin/clients/<client-id>/setup`, staff assigned to that client can edit task progress,
descriptions, responsible staff, known estimated dates, prerequisites, order, internal/client
notes and evidence. Attach confidential files through private project storage. Client-visible
files remain authorized on download; links never grant access to an unrelated tenant.

A manual human task such as website design can be completed by staff. A technical task such as
Google authorization, domain publication, profile safety or live CRM access requires a provider
check. Recording agency evidence moves an unsupported technical step to review and leaves its
health **Attested / evidence only**. It cannot complete the technical task or allow activation.
The additive migration withdraws old attestation-only technical completions and retains the
original evidence and append-only history.

Every mutation locks the setup instance, validates the status/dependencies/approvals, saves history
and audit events, increments its revision and persists applicable notifications. Scoped SSE and
five-second revision polling update clients across app instances; browser refetching recovers
disconnections. The server revalidates access on pushes/polls. When Supabase is configured, each open
screen also joins exactly one private Realtime topic, `setup:<organization>`, authorized by Row Level
Security for people who hold setup access to that organization. It carries only a revision number; the
screen then refetches its authorized snapshot, renews its short-lived token before it expires, and falls
back to the stream and polling if Realtime fails. Nothing subscribes to all organization data. Delivery
through hosted Supabase Realtime is unverified until it is tested against a live project.

Clients visit `/dashboard/setup` (redirect to `/setup`) to follow progress, provide requested
business information, review their website/funnel and approve communication preferences. They
never configure gateway secrets, workflows, Docker, CRM scopes or advanced prompts.

## Provider steps that require a real connection

Google Calendar requires the supported provider OAuth consent; an email address is not consent.
Email sending requires actual provider/DNS verification. Website design approval is distinct from
domain and publication verification. Until those connectors and their supported provider flows
are authorized/configured, the portal displays actionable setup steps with unverified health.
No address, URL, manual checkbox or agency attestation claims a live connection.

## Final approval

Open `/admin/clients/<client-id>/activation` for required tasks, provider checks, client approvals
and immutable agency review history. Mark the setup ready for review through the Setup Manager.
An agency super admin must approve with a fresh authenticated session; the server reruns checks,
validates current permissions, blocks failed/running preparation jobs and records the decision.
An incomplete/failed/attested required provider check blocks approval. Reopening required work
cancels its final-review state.

Portal approval never grants authorization to activate external workflows or outreach. Review rows
explicitly record `external_activation_authorized=false`. The existing Draft GHL workflows and
Inactive n8n Appointment Event Processor remain untouched. Live activation requires your separate
authorization after end-to-end tests.

## Notifications and support

Clients receive persisted in-app milestones, action requests, reconnection issues and readiness
updates, with unread counts and links. Email updates require both a real configured provider and
the recipient's notification preference. The help assistant links to setup guidance and human
support. Never put keys in notes, uploaded evidence, chat or screenshots.

## Local verification versus live acceptance

Automated tests use isolated in-memory PostgreSQL with Supabase schema emulation, a mock Auth SDK
and local HTTP adapter doubles. They verify state transitions, tenant isolation, retry recovery,
approval history and safe failures; they are not live Supabase/Hermes/GHL/n8n verification.
After authorizing a development Supabase project, use the live acceptance checklist in
`verification-status.md`. No production deployment or remote repository push is part of this work.
