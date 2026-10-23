import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { readAuthorizedPrivateFile } from "@/server/storage/private";
import { createZip, type ZipEntry } from "@/server/offboarding/zip";
import { maskCustomerLinks } from "@/server/messaging/redact";

// What a client takes with them. Every query is filtered by the one organization id the caller was authorized for, and the list below is an
// allowlist of tables: anything not named here (credentials, integration connections, other clients, agency-internal notes) is never read.

const MAX_ROWS = 100_000;
const MAX_FILE_BYTES = 150 * 1024 * 1024;

interface TableSpec {
  file: string;
  table: string;
  /** Extra SQL condition on the table alias "t". The organization filter is always applied. */
  where?: string;
  order?: string;
  /** Columns removed from every row because they are internal or sensitive. */
  omit?: string[];
  /** If set, only these columns are exported. */
  pick?: string[];
  /** Text columns that may hold a customer's booking link (a bearer secret): exported with the link replaced by a label. */
  mask?: string[];
  limit?: number;
}

const TABLES: TableSpec[] = [
  { file: "business/profile.json", table: "company_profiles" },
  { file: "business/knowledge.json", table: "company_knowledge", order: "section" },
  { file: "business/onboarding-answers.json", table: "onboarding_answers" },
  { file: "business/knowledge-documents.json", table: "knowledge_documents", order: "created_at" },
  { file: "business/messaging-settings.json", table: "messaging_settings" },
  { file: "business/messaging-channels.json", table: "messaging_channels", omit: ["credential_id"] },
  { file: "business/whatsapp-templates.json", table: "whatsapp_templates" },
  { file: "team/members.json", table: "organization_memberships", omit: ["invited_by"] },
  { file: "team/invitations.json", table: "invitations", omit: ["token_hash"] },
  { file: "team/staff-profiles.json", table: "staff_profiles", omit: ["alert_phone"] },
  { file: "customers/contacts.json", table: "contacts", order: "created_at" },
  { file: "customers/contact-identities.json", table: "contact_identities" },
  { file: "customers/contact-merges.json", table: "contact_merges" },
  { file: "customers/contact-memories.json", table: "contact_memories" },
  { file: "customers/consent-history.json", table: "contact_consent_events", order: "created_at" },
  { file: "customers/suppressions.json", table: "suppressions" },
  { file: "conversations/conversations.json", table: "conversations", order: "created_at", mask: ["last_message_preview"] },
  { file: "conversations/messages.json", table: "conversation_messages", order: "created_at", omit: ["dedupe_key", "claimed_at", "reservation_id"], mask: ["body"] },
  { file: "conversations/delivery-events.json", table: "message_delivery_events", order: "occurred_at" },
  { file: "conversations/follow-up-plans.json", table: "follow_up_plans" },
  { file: "conversations/follow-up-steps.json", table: "follow_up_steps" },
  { file: "conversations/escalations.json", table: "human_escalations" },
  { file: "conversations/lifecycle-events.json", table: "conversation_events", order: "created_at" },
  { file: "sales/leads.json", table: "leads", order: "created_at" },
  { file: "sales/lead-research-requests.json", table: "lead_research_requests" },
  { file: "sales/lead-targeting-profiles.json", table: "lead_targeting_profiles" },
  { file: "sales/crm-pipelines.json", table: "crm_pipelines" },
  { file: "sales/crm-opportunities.json", table: "crm_opportunities" },
  { file: "sales/notes.json", table: "record_notes" },
  { file: "sales/tasks.json", table: "tasks" },
  { file: "crm/workspace.json", table: "crm_workspaces" },
  { file: "crm/capability-owners.json", table: "crm_capability_providers" },
  { file: "crm/companies.json", table: "crm_companies", omit: ["search_text"], order: "created_at" },
  { file: "crm/contact-companies.json", table: "crm_contact_companies" },
  { file: "crm/tags.json", table: "crm_tags" },
  { file: "crm/contact-tags.json", table: "crm_contact_tags" },
  { file: "crm/company-tags.json", table: "crm_company_tags" },
  { file: "crm/custom-fields.json", table: "crm_custom_fields" },
  { file: "crm/custom-field-values.json", table: "crm_field_values" },
  { file: "crm/smart-lists.json", table: "crm_smart_lists" },
  { file: "crm/folders.json", table: "crm_folders" },
  { file: "crm/timeline.json", table: "crm_activities", order: "occurred_at" },
  { file: "crm/external-ids.json", table: "crm_external_ids" },
  // fetch_state is a GoHighLevel migration step's reading state; while it reads, it holds the location's users (their emails).
  { file: "crm/import-history.json", table: "crm_import_jobs", omit: ["claimed_at", "fetch_state"], order: "created_at" },
  { file: "crm/support-access-log.json", table: "crm_support_sessions", pick: ["mode", "reason", "started_at", "expires_at", "ended_at"], order: "started_at" },
  // What was applied to this workspace from the agency's CRM Blueprints, item by item, and which records each Blueprint asset became.
  // The Blueprints themselves are the agency's library and are not part of the client's data.
  { file: "crm/blueprint-applications.json", table: "crm_blueprint_applications", omit: ["idempotency_key", "plan_digest"], order: "created_at" },
  { file: "crm/blueprint-application-items.json", table: "crm_blueprint_application_items", omit: ["after_hash"], order: "position" },
  { file: "crm/blueprint-links.json", table: "crm_blueprint_links", omit: ["asset_hash", "native_hash"] },
  { file: "sales/pipeline-stages.json", table: "crm_pipeline_stages" },
  { file: "sales/opportunity-history.json", table: "crm_opportunity_history", order: "changed_at" },
  { file: "sales/opportunity-tags.json", table: "crm_opportunity_tags" },
  { file: "sales/task-comments.json", table: "crm_task_comments", order: "created_at" },
  { file: "team/permission-overrides.json", table: "member_permission_overrides" },
  { file: "appointments/appointments.json", table: "appointment_refs", order: "start_at", omit: ["manage_token_hash", "idempotency_key"] },
  { file: "appointments/calendars.json", table: "crm_calendars" },
  { file: "appointments/calendar-members.json", table: "crm_calendar_members" },
  { file: "appointments/appointment-types.json", table: "crm_appointment_types" },
  { file: "appointments/working-hours.json", table: "crm_availability_rules" },
  { file: "appointments/host-settings.json", table: "crm_host_settings" },
  { file: "appointments/time-off.json", table: "crm_availability_overrides" },
  { file: "appointments/appointment-hosts.json", table: "crm_appointment_hosts" },
  { file: "appointments/connected-calendars.json", table: "crm_calendar_connections", pick: ["provider", "account_label", "status", "check_conflicts", "write_events", "last_synced_at", "created_at"] },
  { file: "appointments/bookings.json", table: "appointment_bookings", omit: ["idempotency_key", "claimed_at"] },
  { file: "appointments/settings.json", table: "appointment_settings" },
  { file: "appointments/reminders.json", table: "appointment_reminders" },
  { file: "retention/programs.json", table: "retention_programs", omit: ["content_hash", "approved_hash"] },
  { file: "retention/enrollments.json", table: "retention_enrollments" },
  { file: "retention/steps.json", table: "retention_steps" },
  { file: "retention/accounts.json", table: "retention_accounts" },
  { file: "retention/feedback.json", table: "customer_feedback" },
  { file: "retention/service-history.json", table: "service_history" },
  { file: "website/sites.json", table: "websites" },
  { file: "website/versions.json", table: "website_versions", order: "version desc", limit: 20 },
  { file: "website/publications.json", table: "website_publications", order: "number desc", limit: 20 },
  { file: "website/domains.json", table: "website_domains", omit: ["verification_token", "created_by", "purchase_approved_by"] },
  { file: "website/enquiries.json", table: "website_form_submissions", order: "created_at" },
  // Social media. An account is exported by name and status only: never what signs in as it (the token), the platform's id for the person who connected it, the
  // permissions granted, the platform's limits or the token's dates. Publishing jobs and sign-in states are internal working state and are not exported.
  { file: "social/accounts.json", table: "social_accounts", pick: ["id", "platform", "adapter", "external_id", "name", "username", "avatar_url", "status", "status_detail", "capabilities", "connected_at", "disconnected_at", "created_at"], order: "created_at" },
  { file: "social/posts.json", table: "social_posts", order: "created_at" },
  { file: "social/post-history.json", table: "social_post_events", order: "at" },
  { file: "social/post-metrics.json", table: "social_post_metrics", order: "fetched_at" },
  { file: "social/campaigns.json", table: "social_campaigns", order: "created_at" },
  { file: "social/media-library.json", table: "social_media_assets", order: "created_at" },
  { file: "social/ai-suggestions.json", table: "social_ai_runs", order: "created_at" },
  { file: "social/settings.json", table: "social_settings" },
  { file: "ai-team/employees.json", table: "agent_instances", omit: ["credential_id", "hermes_base_url", "hermes_profile"] },
  { file: "ai-team/employee-knowledge.json", table: "employee_knowledge_entries", order: "updated_at" },
  { file: "ai-team/configuration-versions.json", table: "agent_config_versions", order: "created_at" },
  { file: "ai-team/approvals.json", table: "approval_requests", omit: ["idempotency_key"], order: "created_at" },
  { file: "ai-team/approval-events.json", table: "approval_events", order: "created_at" },
  { file: "support/tickets.json", table: "support_tickets", omit: ["idempotency_key", "agency_last_read_at", "priority", "assigned_to"], order: "created_at" },
  { file: "support/messages.json", table: "support_messages", where: "t.internal = false", omit: ["client_message_id"], order: "created_at" },
  // Only the timeline entries written for the client; the team's own history (priority, escalation, assignment names) stays internal.
  { file: "support/timeline.json", table: "support_ticket_events", where: "t.visibility = 'client'", omit: ["seq", "actor_user_id"], order: "created_at" },
  { file: "projects/requests.json", table: "client_project_requests" },
  { file: "projects/quotes.json", table: "project_quotes", omit: ["content_hash"] },
  { file: "projects/projects.json", table: "client_projects" },
  { file: "projects/milestones.json", table: "project_milestones" },
  { file: "billing/payments.json", table: "payments", omit: ["provider_checkout_id", "provider_payment_id", "checkout_url", "fee_minor", "fx_source"], order: "created_at" },
  { file: "billing/credit-ledger.json", table: "credit_ledger_entries", order: "created_at" },
  { file: "billing/usage.json", table: "metered_usage_events", omit: ["provider_reference", "rate_version_id"], order: "occurred_at" },
  { file: "billing/provider-fees.json", table: "provider_fees" },
  { file: "billing/settings.json", table: "billing_settings" },
  { file: "billing/balance.json", table: "credit_accounts" },
  { file: "records/activity-history.json", table: "audit_logs", pick: ["action", "actor_kind", "target_type", "result", "created_at"], order: "created_at" },
];

const NOT_EXPORTED = [
  "Passwords, access tokens and any other credential or secret",
  "Connection settings for the services iAcquire uses to run your system",
  "Anything belonging to another iAcquire client",
  "iAcquire's own internal notes, tooling and agency-side records",
  "The iAcquire software, website templates and AI employee setup that run your workspace (licensed to you for use while you are a customer)",
];

const strip = (row: Record<string, unknown>, spec: TableSpec) => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (spec.pick && !spec.pick.includes(k)) continue;
    if (spec.omit?.includes(k)) continue;
    out[k] = spec.mask?.includes(k) && typeof v === "string" ? maskCustomerLinks(v) : v;
  }
  return out;
};

async function hasOrgColumn(db: Queryable, table: string): Promise<boolean> {
  const r = await db.query("select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = 'org_id'", [table]);
  return r.rows.length > 0;
}

export interface ExportResult {
  filename: string;
  bytes: Buffer;
  counts: Record<string, number>;
  filesIncluded: number;
  filesOmitted: number;
}

/**
 * Builds the client's data export as a ZIP: readable JSON for everything they own, their uploaded files and website images, a plain-language
 * README and DOMAINS guide. Files beyond a size cap are listed rather than silently dropped.
 */
export async function buildExport(orgId: string, opts: { now?: Date } = {}): Promise<ExportResult> {
  const now = opts.now ?? new Date();
  const entries: ZipEntry[] = [];
  const counts: Record<string, number> = {};
  const truncated: string[] = [];
  const skippedTables: string[] = [];
  const json = (name: string, value: unknown) => entries.push({ name, data: Buffer.from(JSON.stringify(value, null, 2), "utf8") });

  const org = await withSystem(async (db) => {
    const o = await db.query<{ id: string; name: string; slug: string; industry: string | null; website: string | null; region: string | null; timezone: string; created_at: Date }>(
      "select id, name, slug, industry, website, region, timezone, created_at from organizations where id = $1",
      [orgId],
    );
    if (!o.rows[0]) throw new Error("Workspace not found.");
    return o.rows[0];
  });
  json("business/organization.json", org);

  for (const spec of TABLES) {
    const rows = await withSystem(async (db) => {
      if (!(await hasOrgColumn(db, spec.table))) {
        skippedTables.push(spec.table);
        return null;
      }
      const limit = Math.min(spec.limit ?? MAX_ROWS, MAX_ROWS);
      const res = await db.query<Record<string, unknown>>(`select t.* from ${spec.table} t where t.org_id = $1${spec.where ? ` and ${spec.where}` : ""}${spec.order ? ` order by ${spec.order}` : ""} limit ${limit + 1}`, [orgId]);
      if (res.rows.length > limit) truncated.push(spec.table);
      return res.rows.slice(0, limit);
    });
    if (!rows) continue;
    counts[spec.table] = rows.length;
    json(spec.file, rows.map((r) => strip(r, spec)));
  }

  // Team members' names and emails, joined here so the member list is readable on its own.
  const people = await withSystem((db) =>
    db.query<{ user_id: string; email: string; full_name: string; role: string; status: string }>(
      "select m.user_id, u.email::text as email, u.full_name, m.role, m.status from organization_memberships m join users u on u.id = m.user_id where m.org_id = $1 order by m.created_at",
      [orgId],
    ),
  );
  json("team/people.json", people.rows);

  // Uploaded files and website images, within a total size cap.
  const files = await withSystem((db) =>
    db.query<{ id: string; bucket: string; filename: string; mime_type: string; size_bytes: number }>(
      "select id, bucket, filename, mime_type, size_bytes from private_files where org_id = $1 and status = 'ready' and visibility = 'client' and bucket in ('company-documents', 'brand-assets', 'social-media') order by created_at",
      [orgId],
    ),
  );
  let budget = MAX_FILE_BYTES;
  const omitted: Array<{ name: string; reason: string }> = [];
  let included = 0;
  for (const f of files.rows) {
    if (f.size_bytes > budget) {
      omitted.push({ name: f.filename, reason: "Over the export size limit. Ask iAcquire support for a separate copy." });
      continue;
    }
    try {
      const file = await readAuthorizedPrivateFile(f.id);
      entries.push({ name: `files/${f.bucket}/${f.id.slice(0, 8)}-${f.filename.replace(/[^A-Za-z0-9._-]+/g, "_")}`, data: file.bytes });
      budget -= f.size_bytes;
      included += 1;
    } catch {
      omitted.push({ name: f.filename, reason: "Could not be read from storage at export time. Ask iAcquire support for a separate copy." });
    }
  }
  const blobs = await withSystem((db) => db.query<{ sha256: string; mime_type: string; bytes: Buffer }>("select sha256, mime_type, bytes from website_asset_blobs where org_id = $1 order by created_at", [orgId]));
  for (const b of blobs.rows) {
    const ext = b.mime_type === "image/png" ? "png" : b.mime_type === "image/webp" ? "webp" : "jpg";
    if (b.bytes.length > budget) {
      omitted.push({ name: `website image ${b.sha256.slice(0, 8)}`, reason: "Over the export size limit. Ask iAcquire support for a separate copy." });
      continue;
    }
    entries.push({ name: `website/images/${b.sha256}.${ext}`, data: Buffer.from(b.bytes) });
    budget -= b.bytes.length;
    included += 1;
  }

  entries.push({ name: "DOMAINS.md", data: Buffer.from(await domainGuide(orgId), "utf8") });
  json("manifest.json", { exportedAt: now.toISOString(), organization: { id: org.id, name: org.name }, tables: counts, truncatedTables: truncated, skippedTables, filesIncluded: included, filesOmitted: omitted, notExported: NOT_EXPORTED });
  entries.unshift({ name: "README.md", data: Buffer.from(readme(org.name, now, truncated, omitted.length), "utf8") });

  const date = now.toISOString().slice(0, 10);
  return { filename: `iacquire-export-${org.slug}-${date}.zip`, bytes: createZip(entries, now), counts, filesIncluded: included, filesOmitted: omitted.length };
}

const readme = (name: string, now: Date, truncated: string[], omitted: number) => `# ${name}: your data from iAcquire

Exported ${now.toISOString()}.

## What is in this archive

- **business/**: your profile, knowledge, onboarding answers and messaging settings.
- **customers/** and **conversations/**: your contacts, their consent history, and every conversation and message, as readable JSON.
- **sales/**, **appointments/**, **retention/**: leads, pipeline, appointments, reminders and customer programs.
- **website/**: your website's content, every published version, your domains and enquiries, and the images, as files.
- **ai-team/**: how your AI employees were set up (names, modes, configuration versions) and every approval request and decision.
- **billing/**: payments, your credit ledger, usage and fees.
- **support/**, **projects/**, **records/**: support conversations, custom projects and the activity history.
- **social/**: your Facebook and Instagram accounts (never their sign-in tokens), posts and their history, campaigns, media library records, the numbers the platforms returned for your posts, and your social media settings.
- **files/**: documents, brand images and social media pictures and videos you uploaded.
- **DOMAINS.md**: where your domains are and how to move them.
- **manifest.json**: counts for each file, and anything that could not be included.

## What is not here

${NOT_EXPORTED.map((x) => `- ${x}`).join("\n")}

## Ownership

Your business information, your customers' information and your domains belong to you. The software and templates that ran your workspace are licensed to you for use while you are a customer. This summary is not legal advice; your agreement with iAcquire is what governs.
${truncated.length ? `\n## Large tables\n\nThese were cut off at ${MAX_ROWS.toLocaleString("en-US")} rows. Ask iAcquire support for the rest: ${truncated.join(", ")}.\n` : ""}${omitted ? `\n## Files not included\n\n${omitted} file${omitted === 1 ? " was" : "s were"} too large or could not be read. They are listed in manifest.json. Ask iAcquire support for a separate copy.\n` : ""}`;

/** Where each domain is and how to take it with you. Domains the client owns are never held back. */
export async function domainGuide(orgId: string): Promise<string> {
  const { rows } = await withSystem((db) =>
    db.query<{ hostname: string; kind: string; status: string; acquisition: string; registrar: string | null; renews_at: Date | null; is_primary: boolean }>(
      "select hostname, kind, status, acquisition, registrar, renews_at, is_primary from website_domains where org_id = $1 and removed_at is null order by is_primary desc, hostname",
      [orgId],
    ),
  );
  const lines = ["# Your domains", "", "Domains registered in your own name are yours and can be moved at any time. Nothing here holds a domain back.", ""];
  if (!rows.length) lines.push("No domains are connected to your website.");
  for (const d of rows) {
    lines.push(`## ${d.hostname}${d.is_primary ? " (primary)" : ""}`);
    if (d.kind === "platform") {
      lines.push("This is the free address iAcquire hosts for you. It belongs to iAcquire's hosting and stops working when your website is unpublished or your workspace is deleted. To keep a web presence, point a domain you own at wherever your website now lives.");
    } else if (d.acquisition === "purchased") {
      lines.push(`Registered through ${d.registrar ?? "a registrar"} in your name${d.renews_at ? `, renewing ${d.renews_at.toISOString().slice(0, 10)}` : ""}. To move it, unlock it at the registrar and request a transfer authorization code, then give that code to your new registrar. If you can't sign in to the registrar, ask iAcquire support and we will help you regain control the same day.`);
    } else {
      lines.push("You connected this domain from your own registrar. Point its DNS records to your new host to move your website, and remove the iAcquire verification and routing records when you're done.");
    }
    lines.push("");
  }
  return lines.join("\n");
}
