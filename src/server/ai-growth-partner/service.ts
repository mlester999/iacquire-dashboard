import "server-only";
import { z } from "zod";
import { parseEvidenceMarker, type EvidenceMarker } from "@/lib/evidence-class";
import {
  AI_GROWTH_PARTNER_NAME,
  BUSINESS_BRAIN_SECTIONS,
  BusinessBrainSchema,
  generateBusinessBrainFromOnboarding,
  preserveClientOverrides,
  type BusinessBrain,
} from "@/lib/ai-growth-partner";
import { recordAudit } from "@/server/audit";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import type { StoredAnswers } from "@/lib/onboarding/types";
import { isRuntimeOnline } from "@/lib/employee-runtime";
import type { AgentStatus } from "@/lib/agents";

const personaSettingsSchema = z.record(z.string().min(1).max(120), z.unknown());
const draftInputSchema = z.object({
  businessBrain: BusinessBrainSchema,
  personaSettings: personaSettingsSchema.default({}),
}).strict();
const factDraftInputSchema = z.object({
  baseVersion: z.number().int().positive(),
  section: z.enum(BUSINESS_BRAIN_SECTIONS),
  key: z.string().trim().min(1).max(120).refine((key) => !/[\u0000-\u001f\u007f]/.test(key) && !["__proto__", "prototype", "constructor"].includes(key)),
  valueText: z.string().max(16_000),
}).strict();

const MAX_BRAIN_BYTES = 1_048_576;
const MAX_PERSONA_SETTINGS_BYTES = 65_536;

export interface GrowthPartnerControlState {
  id: string;
  name: typeof AI_GROWTH_PARTNER_NAME;
  status: "setup_required" | "provisioning" | "configured" | "paused" | "migration_required";
  runtimeAgentInstanceId: string | null;
  runtimeEnabled: boolean | null;
  runtimeStatus: AgentStatus | null;
  runtimeHealthOk: boolean | null;
  conversationId: string | null;
  conversationLastMessageAt: Date | null;
  currentVersion: number | null;
  currentBusinessBrain: BusinessBrain | null;
  draftVersion: number | null;
  draftBusinessBrain: BusinessBrain | null;
  versions: Array<{
    version: number;
    source: string;
    createdBy: string | null;
    createdAt: Date;
    active: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

export async function getGrowthPartnerControlState(ctx: OrgContext): Promise<GrowthPartnerControlState | null> {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "You don't have access to the AI Growth Partner.");

  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      id: string;
      status: GrowthPartnerControlState["status"];
      runtime_agent_instance_id: string | null;
      runtime_enabled: boolean | null;
      runtime_status: AgentStatus | null;
      runtime_health_ok: boolean | null;
      conversation_id: string | null;
      conversation_last_message_at: Date | null;
      current_version: number | null;
      business_brain: unknown | null;
      latest_version: number | null;
      latest_business_brain: unknown | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `select p.id, p.status, p.runtime_agent_instance_id, p.current_version,
              runtime.enabled as runtime_enabled, runtime.status as runtime_status, runtime.last_health_ok as runtime_health_ok,
              conversation.id as conversation_id, conversation.last_message_at as conversation_last_message_at,
              active.business_brain, latest.version as latest_version,
              latest.business_brain as latest_business_brain, p.created_at, p.updated_at
       from ai_growth_partners p
       left join agent_instances runtime on runtime.id = p.runtime_agent_instance_id and runtime.org_id = p.org_id and runtime.role_key = 'growth_partner'
       left join ai_growth_partner_versions active
         on active.org_id = p.org_id and active.partner_id = p.id and active.version = p.current_version
       left join lateral (
         select c.id, c.last_message_at
         from chat_conversations c
         join agent_instances a on a.id = c.agent_instance_id and a.org_id = c.org_id
         where c.org_id = p.org_id and c.growth_partner_id = p.id and c.deleted_at is null
           and c.agent_instance_id = p.runtime_agent_instance_id and a.role_key = 'growth_partner'
         limit 1
       ) conversation on true
       left join lateral (
         select v.version, v.business_brain
         from ai_growth_partner_versions v
         where v.org_id = p.org_id and v.partner_id = p.id
         order by v.version desc limit 1
       ) latest on true
       where p.org_id = $1`,
      [ctx.org.orgId],
    );
    const row = rows[0];
    if (!row) return null;
    const versions = await db.query<{
      version: number;
      source: string;
      created_by: string | null;
      created_at: Date;
    }>(
      `select version, source, created_by, created_at
       from ai_growth_partner_versions
       where org_id = $1 and partner_id = $2
       order by version desc limit 20`,
      [ctx.org.orgId, row.id],
    );
    return {
      id: row.id,
      name: AI_GROWTH_PARTNER_NAME,
      status: row.status === "paused" || row.status === "migration_required"
        ? row.status
        : row.current_version !== null && row.runtime_enabled === true && isRuntimeOnline(row.runtime_status) && row.runtime_health_ok === true
          ? "configured"
          : row.runtime_status === "provisioning" || row.status === "provisioning"
            ? "provisioning"
            : "setup_required",
      runtimeAgentInstanceId: row.runtime_agent_instance_id,
      runtimeEnabled: row.runtime_enabled,
      runtimeStatus: row.runtime_status,
      runtimeHealthOk: row.runtime_health_ok,
      conversationId: row.conversation_id,
      conversationLastMessageAt: row.conversation_last_message_at,
      currentVersion: row.current_version,
      currentBusinessBrain: row.business_brain === null ? null : BusinessBrainSchema.parse(row.business_brain),
      draftVersion: row.latest_version === row.current_version ? null : row.latest_version,
      draftBusinessBrain: row.latest_version === row.current_version || row.latest_business_brain === null
        ? null
        : BusinessBrainSchema.safeParse(row.latest_business_brain).data ?? null,
      versions: versions.rows.map((version) => ({
        version: Number(version.version),
        source: version.source,
        createdBy: version.created_by,
        createdAt: version.created_at,
        active: Number(version.version) === row.current_version,
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/** Saves one client-confirmed fact as a new draft version without changing the active snapshot. */
export async function saveGrowthPartnerBusinessBrainFactDraft(ctx: OrgContext, rawInput: unknown) {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can edit the AI Growth Partner.");
  const input = factDraftInputSchema.parse(rawInput);

  return withSystem(async (db) => {
    const partner = (await db.query<{ id: string; current_version: number | null }>(
      "select id, current_version from ai_growth_partners where org_id = $1 for update",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before editing its Business Brain.");

    const latest = (await db.query<{ version: number; business_brain: unknown }>(
      `select version, business_brain from ai_growth_partner_versions
       where org_id = $1 and partner_id = $2 order by version desc limit 1`,
      [ctx.org.orgId, partner.id],
    )).rows[0];
    if (!latest) throw new AppError("not_found", "Prepare the Business Brain before editing its facts.");
    if (Number(latest.version) !== input.baseVersion) {
      throw new AppError("conflict", "The Business Brain changed in another session. Refresh this page before editing again.");
    }

    const brain = BusinessBrainSchema.parse(latest.business_brain);
    if (!Object.prototype.hasOwnProperty.call(brain.sections[input.section], input.key)) {
      throw new AppError("not_found", "That Business Brain fact is no longer available. Refresh the page and try again.");
    }
    const existing = brain.sections[input.section][input.key];
    if (!existing) throw new AppError("not_found", "That Business Brain fact is no longer available. Refresh the page and try again.");

    const text = input.valueText.trim();
    let value: unknown = text || null;
    if (text && Array.isArray(existing.value)) {
      const items = text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      value = items.length > 0 ? items : null;
    } else if (text && typeof existing.value === "object" && existing.value !== null) {
      try {
        value = JSON.parse(text);
      } catch {
        throw new AppError("invalid_input", "Check the structured value and try again.");
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new AppError("invalid_input", "Keep this fact in its current structured format.");
      }
    }

    const now = new Date().toISOString();
    brain.sections[input.section][input.key] = {
      value,
      state: value === null ? "unknown" : "client_confirmed",
      provenance: [...existing.provenance, { source: "client_edit" as const, sourceId: null, evidenceUrl: null, observedAt: now }].slice(-50),
      updatedAt: now,
      clientOverride: value !== null,
    };
    const nextVersion = Number((await db.query<{ next: number }>(
      "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
      [ctx.org.orgId, partner.id],
    )).rows[0].next);
    const snapshot = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, '{}'::jsonb, 'client_edit', $5::jsonb, $6)
       returning id`,
      [partner.id, ctx.org.orgId, nextVersion, JSON.stringify(brain), JSON.stringify({
        submittedFrom: "partner_control_center",
        basedOnVersion: input.baseVersion,
        editedSection: input.section,
        editedFact: input.key,
      }), ctx.user.id],
    )).rows[0];

    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "ai_growth_partner.business_brain_fact_edited",
      targetType: "ai_growth_partner_version",
      targetId: snapshot.id,
      result: "success",
      metadata: { version: nextVersion, basedOnVersion: input.baseVersion, section: input.section, fact: input.key, activeVersionChanged: false },
    }, db);
    return { id: snapshot.id, partnerId: partner.id, version: nextVersion, status: "draft" as const, activated: false as const };
  });
}

/**
 * Creates only the logical identity row. It never provisions Hermes, enables a capability or
 * turns a legacy role profile off. Repeated requests return the existing tenant identity.
 */
export async function ensureGrowthPartnerIdentity(ctx: OrgContext) {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can set up the AI Growth Partner.");

  return withSystem(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `insert into ai_growth_partners (org_id) values ($1)
       on conflict (org_id) do nothing returning id`,
      [ctx.org.orgId],
    );
    const id = inserted.rows[0]?.id ?? (await db.query<{ id: string }>(
      "select id from ai_growth_partners where org_id = $1",
      [ctx.org.orgId],
    )).rows[0]?.id;
    if (!id) throw new AppError("internal", "The AI Growth Partner identity could not be loaded.");

    if (inserted.rowCount > 0) {
      await recordAudit({
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        action: "ai_growth_partner.identity_created",
        targetType: "ai_growth_partner",
        targetId: id,
        result: "success",
      }, db);
    }
    return { id, created: inserted.rowCount > 0 };
  });
}

/** Saves a new immutable draft snapshot. It does not make the draft active or change runtime state. */
export async function saveGrowthPartnerBusinessBrainDraft(ctx: OrgContext, rawInput: unknown) {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can edit the AI Growth Partner.");
  const input = draftInputSchema.parse(rawInput);
  const brain = JSON.stringify(input.businessBrain);
  const personaSettings = JSON.stringify(input.personaSettings);
  if (Buffer.byteLength(brain, "utf8") > MAX_BRAIN_BYTES) throw new AppError("invalid_input", "The Business Brain draft is too large to save.");
  if (Buffer.byteLength(personaSettings, "utf8") > MAX_PERSONA_SETTINGS_BYTES) throw new AppError("invalid_input", "The partner settings draft is too large to save.");

  return withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>(
      "select id from ai_growth_partners where org_id = $1 for update",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before saving its Business Brain.");

    const nextVersion = Number((await db.query<{ next: number }>(
      "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
      [ctx.org.orgId, partner.id],
    )).rows[0].next);
    const version = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, 'client_edit', '{"submittedFrom":"partner_control_center"}'::jsonb, $6)
       returning id`,
      [partner.id, ctx.org.orgId, nextVersion, brain, personaSettings, ctx.user.id],
    )).rows[0];

    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "ai_growth_partner.business_brain_drafted",
      targetType: "ai_growth_partner_version",
      targetId: version.id,
      result: "success",
      metadata: { version: nextVersion, activeVersionChanged: false },
    }, db);
    return { id: version.id, partnerId: partner.id, version: nextVersion, status: "draft" as const, activated: false };
  });
}

/**
 * Adds an immutable Business Brain snapshot from the existing onboarding ledger. The first
 * client-approved onboarding submission activates its generated version; later submissions remain
 * drafts so an existing client-approved version is never silently replaced.
 */
export async function draftGrowthPartnerBusinessBrainFromOnboarding(
  db: Queryable,
  ctx: OrgContext,
  storedAnswers: StoredAnswers,
  generatedAt: Date,
  questionnaireVersion: number,
  sourceSubmittedAt: Date = generatedAt,
) {
  if (!ctx.can("agents.configure")) return null;

  const partner = (await db.query<{ id: string; current_version: number | null }>(
    "select id, current_version from ai_growth_partners where org_id = $1 for update",
    [ctx.org.orgId],
  )).rows[0];
  // A submitted questionnaire alone must not silently migrate an existing six-role tenant.
  // New-client creation establishes this identity before onboarding starts.
  if (!partner) return null;

  // A repeated onboarding handoff or a retried one-time migration action must not create a
  // second copy of the same submitted snapshot.
  const prior = (await db.query<{ id: string; version: number; business_brain: unknown }>(
    `select id, version, business_brain from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 and source = 'onboarding'
       and source_metadata->>'questionnaireVersion' = $3::text
       and source_metadata->>'submittedAt' = $4
     order by version desc limit 1`,
    [ctx.org.orgId, partner.id, questionnaireVersion, sourceSubmittedAt.toISOString()],
  )).rows[0];
  if (prior) {
    let activeVersionChanged = false;
    if (partner.current_version === null) {
      const activated = await db.query(
        "update ai_growth_partners set current_version = $2 where id = $1 and current_version is null returning id",
        [partner.id, Number(prior.version)],
      );
      activeVersionChanged = activated.rowCount > 0;
    }
    const priorBrain = BusinessBrainSchema.parse(prior.business_brain);
    const factCount = Object.values(priorBrain.sections).reduce((total, section) =>
      total + Object.values(section).filter((fact) => fact.state !== "unknown").length, 0);
    return { partnerId: partner.id, id: prior.id, version: Number(prior.version), factCount, activeVersionChanged, reused: true as const };
  }

  const latest = (await db.query<{ business_brain: unknown }>(
    `select business_brain from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 order by version desc limit 1`,
    [ctx.org.orgId, partner.id],
  )).rows[0];
  const generated = generateBusinessBrainFromOnboarding(storedAnswers, generatedAt);
  const existing = latest ? BusinessBrainSchema.safeParse(latest.business_brain) : null;
  const brain = existing?.success ? preserveClientOverrides(existing.data, generated) : generated;
  const version = Number((await db.query<{ next: number }>(
    "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
    [ctx.org.orgId, partner.id],
  )).rows[0].next);
  const sourceMetadata = {
    questionnaireVersion,
    submittedAt: sourceSubmittedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
  };
  const snapshot = (await db.query<{ id: string }>(
    `insert into ai_growth_partner_versions
       (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
     values ($1, $2, $3, $4::jsonb, '{}'::jsonb, 'onboarding', $5::jsonb, $6)
     returning id`,
    [partner.id, ctx.org.orgId, version, JSON.stringify(brain), JSON.stringify(sourceMetadata), ctx.user.id],
  )).rows[0];

  const activated = partner.current_version === null
    ? await db.query(
      "update ai_growth_partners set current_version = $2 where id = $1 and current_version is null returning id",
      [partner.id, version],
    )
    : { rowCount: 0 };
  const activeVersionChanged = activated.rowCount > 0;

  const factCount = Object.values(brain.sections).reduce((total, section) =>
    total + Object.values(section).filter((fact) => fact.state !== "unknown").length, 0);
  await recordAudit({
    orgId: ctx.org.orgId,
    actorUserId: ctx.user.id,
    actorKind: "user",
    action: "ai_growth_partner.business_brain_drafted",
    targetType: "ai_growth_partner_version",
    targetId: snapshot.id,
    result: "success",
    metadata: { source: "onboarding", version, questionnaireVersion, factCount, activeVersionChanged },
  }, db);
  return { partnerId: partner.id, id: snapshot.id, version, factCount, activeVersionChanged, reused: false as const };
}

export interface GrowthPartnerConversationMessage {
  id: string;
  role: "user" | "assistant" | "notice";
  authorUserId: string | null;
  authorLabel: string | null;
  content: string;
  status: "streaming" | "complete" | "failed" | "cancelled" | "superseded";
  runId: string | null;
  workJobId: string | null;
  errorCode: string | null;
  evidence: EvidenceMarker | null;
  createdAt: Date;
}

export interface GrowthPartnerConversationPage {
  conversation: {
    id: string;
    title: string;
    lastMessageAt: Date | null;
    createdAt: Date;
  };
  messages: GrowthPartnerConversationMessage[];
  hasMore: boolean;
}

/** Loads history only from the single verified Growth Partner thread; role chats are never considered. */
export async function getGrowthPartnerConversationPage(ctx: OrgContext, before?: Date): Promise<GrowthPartnerConversationPage | null> {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "You don't have access to the AI Growth Partner conversation.");

  return withUser(ctx.user.id, async (db) => {
    const conversation = (await db.query<{
      id: string;
      title: string;
      last_message_at: Date | null;
      created_at: Date;
    }>(
      `select c.id, c.title, c.last_message_at, c.created_at
       from ai_growth_partners p
       join chat_conversations c on c.growth_partner_id = p.id and c.org_id = p.org_id
       join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id
       where p.org_id = $1 and c.agent_instance_id = p.runtime_agent_instance_id
         and a.role_key = 'growth_partner' and c.deleted_at is null
       limit 1`,
      [ctx.org.orgId],
    )).rows[0];
    if (!conversation) return null;

    const result = await db.query<{
      id: string;
      role: GrowthPartnerConversationMessage["role"];
      author_user_id: string | null;
      author_label: string | null;
      content: string;
      status: GrowthPartnerConversationMessage["status"];
      run_id: string | null;
      work_job_id: string | null;
      error_code: string | null;
      evidence: unknown;
      created_at: Date;
    }>(
      `select page.id, page.role, page.author_user_id,
              coalesce(nullif(u.full_name, ''), case when page.author_user_id is null then null else 'Workspace member' end) as author_label,
              page.content, page.status, page.run_id, page.work_job_id, page.error_code, page.evidence, page.created_at
       from (
         select m.id, m.role, m.author_user_id, m.content, m.status, m.run_id, m.work_job_id, m.error_code, m.evidence, m.created_at
         from chat_messages m
         where m.org_id = $1 and m.conversation_id = $2 and m.status <> 'superseded'
           and ($3::timestamptz is null or m.created_at < $3::timestamptz)
         order by m.created_at desc limit 61
       ) page
       left join users u on u.id = page.author_user_id
       order by page.created_at asc`,
      [ctx.org.orgId, conversation.id, before ?? null],
    );
    const hasMore = result.rows.length > 60;
    const pageRows = hasMore ? result.rows.slice(1) : result.rows;
    return {
      conversation: {
        id: conversation.id,
        title: conversation.title,
        lastMessageAt: conversation.last_message_at,
        createdAt: conversation.created_at,
      },
      messages: pageRows.map((row) => ({
        id: row.id,
        role: row.role,
        authorUserId: row.author_user_id,
        authorLabel: row.author_label,
        content: row.content,
        status: row.status,
        runId: row.run_id,
        workJobId: row.work_job_id,
        errorCode: row.error_code,
        evidence: parseEvidenceMarker(row.evidence),
        createdAt: row.created_at,
      })),
      hasMore,
    };
  });
}

export interface GrowthPartnerConversationSearchResult {
  id: string;
  role: "user" | "assistant" | "notice";
  authorLabel: string | null;
  excerpt: string;
  createdAt: Date;
}

/** Searches message text in the one canonical thread without exposing other conversations. */
export async function searchGrowthPartnerConversation(ctx: OrgContext, rawQuery: string): Promise<GrowthPartnerConversationSearchResult[]> {
  if (!ctx.can("agents.use")) throw new AppError("forbidden", "You don't have access to the AI Growth Partner conversation.");
  const query = rawQuery.trim().replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 120);
  if (!query) return [];

  return withUser(ctx.user.id, async (db) => {
    const conversation = (await db.query<{ id: string }>(
      `select c.id
       from ai_growth_partners p
       join chat_conversations c on c.growth_partner_id = p.id and c.org_id = p.org_id
       join agent_instances a on a.id = p.runtime_agent_instance_id and a.org_id = p.org_id
       where p.org_id = $1 and c.agent_instance_id = p.runtime_agent_instance_id
         and a.role_key = 'growth_partner' and c.deleted_at is null
       limit 1`,
      [ctx.org.orgId],
    )).rows[0];
    if (!conversation) return [];

    const { rows } = await db.query<{
      id: string;
      role: GrowthPartnerConversationSearchResult["role"];
      author_label: string | null;
      excerpt: string;
      created_at: Date;
    }>(
      `select m.id, m.role,
              coalesce(nullif(u.full_name, ''), case when m.author_user_id is null then null else 'Workspace member' end) as author_label,
              substring(m.content from greatest(position(lower($3) in lower(m.content)) - 120, 1) for 300) as excerpt,
              m.created_at
       from chat_messages m
       left join users u on u.id = m.author_user_id
       where m.org_id = $1 and m.conversation_id = $2 and m.status <> 'superseded'
         and m.content <> '' and position(lower($3) in lower(m.content)) > 0
       order by m.created_at desc limit 40`,
      [ctx.org.orgId, conversation.id, query],
    );
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      authorLabel: row.author_label,
      excerpt: row.excerpt,
      createdAt: row.created_at,
    }));
  });
}
