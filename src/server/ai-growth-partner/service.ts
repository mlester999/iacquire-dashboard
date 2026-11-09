import "server-only";
import { createHash } from "node:crypto";
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
import { describeBusinessHours, validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import { recordAudit } from "@/server/audit";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import type { OrgContext } from "@/server/tenancy/context";
import type { StoredAnswers } from "@/lib/onboarding/types";
import type { ProfileKey, ProfileValues } from "@/lib/onboarding/business-profile";
import { isRuntimeOnline } from "@/lib/employee-runtime";
import { AGENT_ROLE_KEYS, workforceIdentityLabel, type AgentRoleKey, type AgentStatus } from "@/lib/agents";
import { scanInstructionText } from "@/lib/instruction-risk";

const personaSettingsSchema = z.record(z.string().min(1).max(120), z.unknown());
const draftInputSchema = z.object({
  businessBrain: BusinessBrainSchema,
  personaSettings: personaSettingsSchema.optional(),
}).strict();
const factDraftInputSchema = z.object({
  baseVersion: z.number().int().positive(),
  section: z.enum(BUSINESS_BRAIN_SECTIONS),
  key: z.string().trim().min(1).max(120).refine((key) => !/[\u0000-\u001f\u007f]/.test(key) && !["__proto__", "prototype", "constructor"].includes(key)),
  valueText: z.string().max(16_000),
}).strict();
export type GrowthPartnerBusinessBrainFactDraftSource = "partner_control_center" | "permanent_growth_partner_chat";
const activateVersionInputSchema = z.object({
  expectedCurrentVersion: z.number().int().positive().nullable(),
  version: z.number().int().positive(),
}).strict();

const MAX_BRAIN_BYTES = 1_048_576;
const MAX_PERSONA_SETTINGS_BYTES = 65_536;

const PROFILE_BRAIN_FACT: Record<ProfileKey, { section: (typeof BUSINESS_BRAIN_SECTIONS)[number]; key: string }> = {
  name: { section: "businessIdentity", key: "companyName" },
  industry: { section: "businessIdentity", key: "industry" },
  website: { section: "businessIdentity", key: "website" },
  region: { section: "businessIdentity", key: "serviceAreas" },
  timezone: { section: "businessOperations", key: "timeZone" },
  description: { section: "businessIdentity", key: "background" },
  services: { section: "productsServicesOffers", key: "services" },
  idealCustomers: { section: "idealCustomers", key: "targetTypes" },
  brandColor: { section: "businessIdentity", key: "brandColor" },
};

const COMPANY_KNOWLEDGE_BRAIN_FACT = {
  business_description: { section: "businessIdentity", key: "background" },
  products_services: { section: "productsServicesOffers", key: "services" },
  faq: { section: "salesKnowledge", key: "commonQuestions" },
  approved_pricing: { section: "productsServicesOffers", key: "pricing" },
  business_hours: { section: "businessOperations", key: "operatingHours" },
  policies: { section: "policies", key: "customerPolicies" },
  customer_service: { section: "businessOperations", key: "supportProcedures" },
  brand_voice: { section: "brandCommunication", key: "brandVoice" },
  escalation: { section: "businessOperations", key: "internalHandoffs" },
} as const satisfies Record<string, { section: (typeof BUSINESS_BRAIN_SECTIONS)[number]; key: string }>;

type CompanyKnowledgeRow = {
  section: string;
  content: string;
  version: number;
  updated_at: Date | string;
  review_status: string;
  risk_flags: string[];
};

type CompanyKnowledgeSnapshot = {
  rows: CompanyKnowledgeRow[];
  approvedBySection: Map<string, CompanyKnowledgeRow>;
  fingerprint: string;
  sourceVersions: Array<{ section: string; version: number }>;
};

async function loadCompanyKnowledgeSnapshot(db: Queryable, orgId: string): Promise<CompanyKnowledgeSnapshot> {
  const rows = (await db.query<CompanyKnowledgeRow>(
    `select section, content, version, updated_at, review_status, risk_flags
     from company_knowledge where org_id = $1 order by section`,
    [orgId],
  )).rows;
  const approvedBySection = new Map(rows
    .filter((row) => row.review_status === "approved" && row.risk_flags.length === 0)
    .map((row) => [row.section, row]));
  const sourceVersions = [...approvedBySection.values()]
    .filter((row) => row.content.trim().length > 0 && row.section in COMPANY_KNOWLEDGE_BRAIN_FACT)
    .map(({ section, version }) => ({ section, version }));
  const fingerprintInput = [...approvedBySection.values()]
    .filter((row) => row.content.trim().length > 0 && row.section in COMPANY_KNOWLEDGE_BRAIN_FACT)
    .map((row) => ({ section: row.section, version: Number(row.version), content: row.content.trim() }));
  const fingerprint = createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex");
  return { rows, approvedBySection, fingerprint, sourceVersions };
}

function companyKnowledgeSourceId(row: CompanyKnowledgeRow): string {
  return `company_knowledge:${row.section}@${row.version}`;
}

type CompanyKnowledgeConflict = {
  kind: "company_knowledge_conflict";
  section: string;
  disputedValue: unknown;
  disputedState: BusinessBrain["sections"]["businessIdentity"][string]["state"];
  knowledgeValue: string;
};

function isCompanyKnowledgeConflict(value: unknown, section: string): value is CompanyKnowledgeConflict {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).kind === "company_knowledge_conflict"
    && (value as Record<string, unknown>).section === section
    && "disputedValue" in value
    && typeof (value as Record<string, unknown>).disputedState === "string"
    && "knowledgeValue" in value);
}

function applyCompanyKnowledgeFacts(
  input: BusinessBrain,
  snapshot: CompanyKnowledgeSnapshot,
  now: string,
): { brain: BusinessBrain; changed: number; conflicts: number; preservedOverrides: number } {
  const brain = structuredClone(input);
  let changed = 0;
  let conflicts = 0;
  let preservedOverrides = 0;

  for (const [knowledgeSection, target] of Object.entries(COMPANY_KNOWLEDGE_BRAIN_FACT)) {
    const existing = brain.sections[target.section][target.key];
    if (!existing) continue;
    const row = snapshot.approvedBySection.get(knowledgeSection);
    const approvedText = row?.content.trim() ?? "";
    const conflictValue = isCompanyKnowledgeConflict(existing.value, knowledgeSection)
      ? existing.value as CompanyKnowledgeConflict
      : null;

    if (!row || !approvedText) {
      if (conflictValue) {
        const priorProvenance = existing.provenance.filter((item) =>
          item.source !== "company_knowledge" || !item.sourceId?.startsWith(`company_knowledge:${knowledgeSection}@`));
        brain.sections[target.section][target.key] = {
          ...existing,
          value: conflictValue.disputedValue,
          state: conflictValue.disputedState,
          provenance: priorProvenance.slice(-50),
          updatedAt: now,
          clientOverride: false,
        };
        changed++;
      } else if (existing.provenance.at(-1)?.source === "company_knowledge"
        && existing.provenance.at(-1)?.sourceId?.startsWith(`company_knowledge:${knowledgeSection}@`)) {
        brain.sections[target.section][target.key] = {
          value: null,
          state: "unknown",
          provenance: [...existing.provenance, {
            source: "company_knowledge" as const,
            sourceId: `company_knowledge:${knowledgeSection}@removed`,
            evidenceUrl: null,
            observedAt: now,
          }].slice(-50),
          updatedAt: now,
          clientOverride: false,
        };
        changed++;
      }
      continue;
    }

    const provenanceSourceId = companyKnowledgeSourceId(row);
    const source = {
      source: "company_knowledge" as const,
      sourceId: provenanceSourceId,
      evidenceUrl: null,
      observedAt: (row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at)).toISOString(),
    };
    const addSource = (provenance: BusinessBrain["sections"]["businessIdentity"][string]["provenance"]) => [
      ...provenance.filter((item) => item.source !== "company_knowledge" || item.sourceId !== provenanceSourceId),
      source,
    ].slice(-50);

    if (conflictValue) {
      if (conflictValue.disputedValue === approvedText) {
        brain.sections[target.section][target.key] = {
          ...existing,
          value: conflictValue.disputedValue,
          state: conflictValue.disputedState,
          provenance: addSource(existing.provenance),
          updatedAt: now,
          clientOverride: false,
        };
        changed++;
        continue;
      }
      if (conflictValue.knowledgeValue === approvedText && existing.provenance.at(-1)?.sourceId === provenanceSourceId) {
        conflicts++;
        continue;
      }
      brain.sections[target.section][target.key] = {
        ...existing,
        value: { ...conflictValue, knowledgeValue: approvedText },
        provenance: addSource(existing.provenance),
        updatedAt: now,
      };
      changed++;
      conflicts++;
      continue;
    }

    if (existing.clientOverride) {
      if (existing.value !== approvedText) preservedOverrides++;
      else if (!existing.provenance.some((item) => item.sourceId === provenanceSourceId)) {
        brain.sections[target.section][target.key] = { ...existing, provenance: addSource(existing.provenance) };
        changed++;
      }
      continue;
    }

    if (existing.value === approvedText) {
      const nextState = existing.state === "client_confirmed" ? "client_confirmed" : "verified";
      const nextProvenance = addSource(existing.provenance);
      if (existing.state !== nextState || nextProvenance.length !== existing.provenance.length
        || existing.provenance.at(-1)?.sourceId !== provenanceSourceId) {
        brain.sections[target.section][target.key] = {
          ...existing,
          state: nextState,
          provenance: nextProvenance,
          updatedAt: now,
        };
        changed++;
      }
      continue;
    }

    if (existing.state === "unknown" || existing.value === null
      || (existing.state === "verified" && existing.provenance.at(-1)?.source === "company_knowledge"
        && existing.provenance.at(-1)?.sourceId?.startsWith(`company_knowledge:${knowledgeSection}@`))) {
      brain.sections[target.section][target.key] = {
        value: approvedText,
        state: "verified",
        provenance: addSource(existing.provenance),
        updatedAt: now,
        clientOverride: false,
      };
      changed++;
      continue;
    }

    brain.sections[target.section][target.key] = {
      value: {
        kind: "company_knowledge_conflict",
        section: knowledgeSection,
        disputedValue: existing.value,
        disputedState: existing.state,
        knowledgeValue: approvedText,
      },
      state: "draft_suggestion",
      provenance: addSource(existing.provenance),
      updatedAt: now,
      clientOverride: false,
    };
    changed++;
    conflicts++;
  }

  if (changed) brain.generatedAt = now;
  return { brain: BusinessBrainSchema.parse(brain), changed, conflicts, preservedOverrides };
}

function applyBusinessProfileFacts(brain: BusinessBrain, values: ProfileValues, changed: readonly ProfileKey[], now: string): { brain: BusinessBrain; changed: ProfileKey[] } {
  const next = structuredClone(brain);
  const updated: ProfileKey[] = [];
  for (const profileKey of new Set(changed)) {
    const target = PROFILE_BRAIN_FACT[profileKey];
    const value = values[profileKey].trim() || null;
    const existing = next.sections[target.section][target.key];
    const state = value === null ? "unknown" : "client_confirmed";
    if (existing && JSON.stringify(existing.value) === JSON.stringify(value) && existing.state === state && existing.clientOverride === (value !== null)) continue;
    next.sections[target.section][target.key] = {
      value,
      state,
      provenance: [...(existing?.provenance ?? []), {
        source: "client_confirmed" as const,
        sourceId: `settings.profile.${profileKey}`,
        evidenceUrl: null,
        observedAt: now,
      }].slice(-50),
      updatedAt: now,
      clientOverride: value !== null,
    };
    updated.push(profileKey);
  }
  if (updated.length) next.generatedAt = now;
  return { brain: BusinessBrainSchema.parse(next), changed: updated };
}

function applyMessagingHoursFact(brain: BusinessBrain, hours: string, now: string): { brain: BusinessBrain; changed: boolean } {
  const next = structuredClone(brain);
  const existing = next.sections.businessOperations.operatingHours;
  if (existing.value === hours && existing.state === "client_confirmed" && existing.clientOverride) return { brain, changed: false };
  next.sections.businessOperations.operatingHours = {
    value: hours,
    state: "client_confirmed",
    provenance: [...existing.provenance, {
      source: "client_confirmed" as const,
      sourceId: "messaging_settings.business_hours",
      evidenceUrl: null,
      observedAt: now,
    }].slice(-50),
    updatedAt: now,
    clientOverride: true,
  };
  next.generatedAt = now;
  return { brain: BusinessBrainSchema.parse(next), changed: true };
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keeps the active Brain and any saved draft aligned with the owner's Messaging business-hours setting. */
export async function syncGrowthPartnerOperatingHoursFromMessaging(
  db: Queryable,
  input: { orgId: string; actorUserId: string; actorKind: "agency" | "user"; businessHours: BusinessHours },
): Promise<{ status: "updated" | "unchanged" | "not_ready"; activeVersion: number | null; draftVersion: number | null }> {
  const hours = validateBusinessHours(input.businessHours);
  if (hours === null) throw new AppError("invalid_input", "Business hours could not be synchronized because the saved schedule is invalid.");
  const partner = (await db.query<{ id: string; current_version: number | null }>(
    `select p.id, p.current_version from ai_growth_partners p
     join organizations o on o.id = p.org_id
     where p.org_id = $1 and o.kind = 'client' and not o.is_demo
     for update of p`,
    [input.orgId],
  )).rows[0];
  if (!partner || partner.current_version === null) return { status: "not_ready", activeVersion: null, draftVersion: null };

  const active = (await db.query<{ version: number; business_brain: unknown; persona_settings: unknown }>(
    `select version, business_brain, persona_settings from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 and version = $3`,
    [input.orgId, partner.id, partner.current_version],
  )).rows[0];
  if (!active) throw new AppError("conflict", "The active Business Brain could not be found. Review it before changing business hours.");
  const parsedActive = BusinessBrainSchema.safeParse(active.business_brain);
  if (!parsedActive.success) throw new AppError("conflict", "The active Business Brain needs review before business hours can be synchronized.");

  const latest = (await db.query<{
    version: number;
    business_brain: unknown;
    persona_settings: unknown;
    source: string;
    source_metadata: unknown;
  }>(
    `select version, business_brain, persona_settings, source, source_metadata
     from ai_growth_partner_versions where org_id = $1 and partner_id = $2
     order by version desc limit 1`,
    [input.orgId, partner.id],
  )).rows[0];
  const hasDraft = Boolean(latest && Number(latest.version) > Number(partner.current_version));
  let draftBrain: BusinessBrain | null = null;
  if (hasDraft) {
    const parsedDraft = BusinessBrainSchema.safeParse(latest!.business_brain);
    if (!parsedDraft.success) throw new AppError("conflict", "The saved Business Brain draft needs review before business hours can be synchronized.");
    draftBrain = parsedDraft.data;
  }

  const now = new Date().toISOString();
  const value = describeBusinessHours(hours);
  const activeUpdate = applyMessagingHoursFact(parsedActive.data, value, now);
  const draftUpdate = draftBrain ? applyMessagingHoursFact(draftBrain, value, now) : null;
  const rebaseDraft = hasDraft && Boolean(activeUpdate.changed || draftUpdate?.changed);
  if (!activeUpdate.changed && !rebaseDraft) {
    return { status: "unchanged", activeVersion: Number(partner.current_version), draftVersion: hasDraft ? Number(latest!.version) : null };
  }

  let nextVersion = Number((await db.query<{ next: number }>(
    "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
    [input.orgId, partner.id],
  )).rows[0].next);
  let activeVersion = Number(partner.current_version);
  let draftVersion: number | null = hasDraft ? Number(latest!.version) : null;

  if (activeUpdate.changed) {
    activeVersion = nextVersion++;
    const snapshot = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, 'client_edit', $6::jsonb, $7) returning id`,
      [partner.id, input.orgId, activeVersion, JSON.stringify(activeUpdate.brain), JSON.stringify(active.persona_settings ?? {}), JSON.stringify({
        submittedFrom: "workspace_settings",
        syncKind: "messaging_hours",
        basedOnVersion: Number(active.version),
        setting: "businessHours",
      }), input.actorUserId],
    )).rows[0];
    const pointer = await db.query(
      "update ai_growth_partners set current_version = $3 where id = $1 and org_id = $2 and current_version = $4 returning id",
      [partner.id, input.orgId, activeVersion, partner.current_version],
    );
    if (!pointer.rowCount) throw new AppError("conflict", "The active Business Brain changed while business hours were being saved. Refresh and try again.");
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      action: "ai_growth_partner.business_brain_settings_synced",
      targetType: "ai_growth_partner_version",
      targetId: snapshot.id,
      result: "success",
      metadata: { version: activeVersion, basedOnVersion: Number(active.version), syncKind: "messaging_hours", activeVersionChanged: true },
    }, db);
  }

  if (draftUpdate?.changed || rebaseDraft) {
    draftVersion = nextVersion;
    const metadata = metadataRecord(latest!.source_metadata);
    const draft = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8) returning id`,
      [partner.id, input.orgId, draftVersion, JSON.stringify(draftUpdate!.brain), JSON.stringify(latest!.persona_settings ?? active.persona_settings ?? {}), latest!.source, JSON.stringify({
        ...metadata,
        submittedFrom: "workspace_settings",
        syncKind: "messaging_hours",
        basedOnVersion: Number(latest!.version),
        setting: "businessHours",
        rebasedAt: now,
      }), input.actorUserId],
    )).rows[0];
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      action: "ai_growth_partner.business_brain_draft_rebased",
      targetType: "ai_growth_partner_version",
      targetId: draft.id,
      result: "success",
      metadata: { version: draftVersion, basedOnVersion: Number(latest!.version), syncKind: "messaging_hours", activeVersionChanged: activeUpdate.changed },
    }, db);
  }

  return { status: activeUpdate.changed || rebaseDraft ? "updated" : "unchanged", activeVersion, draftVersion };
}

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
export async function saveGrowthPartnerBusinessBrainFactDraft(
  ctx: OrgContext,
  rawInput: unknown,
  options: { submittedFrom?: GrowthPartnerBusinessBrainFactDraftSource } = {},
) {
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can edit the AI Growth Partner.");
  const input = factDraftInputSchema.parse(rawInput);
  const submittedFrom = options.submittedFrom ?? "partner_control_center";

  return withSystem(async (db) => {
    const partner = (await db.query<{ id: string; current_version: number | null }>(
      "select id, current_version from ai_growth_partners where org_id = $1 for update",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before editing its Business Brain.");

    const latest = (await db.query<{ version: number; business_brain: unknown; persona_settings: unknown }>(
      `select version, business_brain, persona_settings from ai_growth_partner_versions
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
       values ($1, $2, $3, $4::jsonb, $5::jsonb, 'client_edit', $6::jsonb, $7)
       returning id`,
      [partner.id, ctx.org.orgId, nextVersion, JSON.stringify(brain), JSON.stringify(personaSettingsSchema.parse(latest.persona_settings ?? {})), JSON.stringify({
        submittedFrom,
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
      metadata: { version: nextVersion, basedOnVersion: input.baseVersion, section: input.section, fact: input.key, submittedFrom, activeVersionChanged: false },
    }, db);
    return { id: snapshot.id, partnerId: partner.id, version: nextVersion, status: "draft" as const, activated: false as const };
  });
}

/** Activates only the newest saved Business Brain draft after an owner/admin explicitly reviews it. */
export async function activateGrowthPartnerBusinessBrainVersion(ctx: OrgContext, rawInput: unknown) {
  if (ctx.org.kind !== "client") throw new AppError("forbidden", "The AI Growth Partner is available in client workspaces.");
  if (!ctx.can("agents.configure")) throw new AppError("forbidden", "Only workspace owners and admins can activate a Business Brain version.");
  const input = activateVersionInputSchema.parse(rawInput);

  return withSystem(async (db) => {
    const partner = (await db.query<{ id: string; current_version: number | null }>(
      "select id, current_version from ai_growth_partners where org_id = $1 for update",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "The AI Growth Partner is not set up for this workspace.");

    const currentVersion = partner.current_version === null ? null : Number(partner.current_version);
    if (currentVersion === input.version) {
      return { version: input.version, previousVersion: currentVersion, activated: false, alreadyActive: true };
    }
    if (currentVersion !== input.expectedCurrentVersion) {
      throw new AppError("conflict", "The active Business Brain changed in another session. Refresh and review the latest version.");
    }

    const latest = (await db.query<{ id: string; version: number; business_brain: unknown; persona_settings: unknown }>(
      `select id, version, business_brain, persona_settings from ai_growth_partner_versions
       where org_id = $1 and partner_id = $2 order by version desc limit 1`,
      [ctx.org.orgId, partner.id],
    )).rows[0];
    if (!latest || Number(latest.version) !== input.version || (currentVersion !== null && input.version <= currentVersion)) {
      throw new AppError("conflict", "Only the latest saved Business Brain draft can be activated. Refresh and review the current draft.");
    }
    BusinessBrainSchema.parse(latest.business_brain);
    personaSettingsSchema.parse(latest.persona_settings ?? {});

    const updated = await db.query(
      `update ai_growth_partners set current_version = $3, updated_at = now()
       where id = $1 and org_id = $2 and current_version is not distinct from $4
       returning id`,
      [partner.id, ctx.org.orgId, input.version, currentVersion],
    );
    if (!updated.rowCount) throw new AppError("conflict", "The active Business Brain changed in another session. Refresh and review the latest version.");

    await recordAudit({
      orgId: ctx.org.orgId,
      actorUserId: ctx.user.id,
      actorKind: "user",
      action: "ai_growth_partner.business_brain_activated",
      targetType: "ai_growth_partner_version",
      targetId: latest.id,
      result: "success",
      metadata: { version: input.version, previousVersion: currentVersion, activeVersionChanged: true },
    }, db);
    return { version: input.version, previousVersion: currentVersion, activated: true, alreadyActive: false };
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
  if (Buffer.byteLength(brain, "utf8") > MAX_BRAIN_BYTES) throw new AppError("invalid_input", "The Business Brain draft is too large to save.");

  return withSystem(async (db) => {
    const partner = (await db.query<{ id: string }>(
      "select id from ai_growth_partners where org_id = $1 for update",
      [ctx.org.orgId],
    )).rows[0];
    if (!partner) throw new AppError("not_found", "Set up the AI Growth Partner before saving its Business Brain.");

    const latest = (await db.query<{ persona_settings: unknown }>(
      `select persona_settings from ai_growth_partner_versions
       where org_id = $1 and partner_id = $2 order by version desc limit 1`,
      [ctx.org.orgId, partner.id],
    )).rows[0];
    const personaSettings = JSON.stringify(personaSettingsSchema.parse(input.personaSettings ?? latest?.persona_settings ?? {}));
    if (Buffer.byteLength(personaSettings, "utf8") > MAX_PERSONA_SETTINGS_BYTES) throw new AppError("invalid_input", "The partner settings draft is too large to save.");

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

  const partner = (await db.query<{ id: string; current_version: number | null; status: string }>(
    "select id, current_version, status from ai_growth_partners where org_id = $1 for update",
    [ctx.org.orgId],
  )).rows[0];
  // A submitted questionnaire alone must not silently migrate an existing six-role tenant.
  // New-client creation establishes this identity before onboarding starts.
  if (!partner) return null;

  // A repeated onboarding handoff or a retried one-time migration action must not create a
  // second copy of the same submitted snapshot.
  const knowledge = await loadCompanyKnowledgeSnapshot(db, ctx.org.orgId);
  const prior = (await db.query<{ id: string; version: number; business_brain: unknown }>(
    `select id, version, business_brain from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 and source = 'onboarding'
       and source_metadata->>'questionnaireVersion' = $3::text
       and source_metadata->>'submittedAt' = $4
       and (source_metadata->>'companyKnowledgeHash' = $5
         or ($6::boolean and source_metadata->>'companyKnowledgeHash' is null))
     order by version desc limit 1`,
    [ctx.org.orgId, partner.id, questionnaireVersion, sourceSubmittedAt.toISOString(), knowledge.fingerprint, knowledge.sourceVersions.length === 0],
  )).rows[0];
  if (prior) {
    let activeVersionChanged = false;
    if (partner.current_version === null && partner.status !== "migration_required") {
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

  const latest = (await db.query<{ business_brain: unknown; persona_settings: unknown }>(
    `select business_brain, persona_settings from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 order by version desc limit 1`,
    [ctx.org.orgId, partner.id],
  )).rows[0];
  const generated = generateBusinessBrainFromOnboarding(storedAnswers, generatedAt);
  const existing = latest ? BusinessBrainSchema.safeParse(latest.business_brain) : null;
  const baseBrain = existing?.success ? preserveClientOverrides(existing.data, generated) : generated;
  const knowledgeMerge = applyCompanyKnowledgeFacts(baseBrain, knowledge, generatedAt.toISOString());
  const brain = knowledgeMerge.brain;
  const version = Number((await db.query<{ next: number }>(
    "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
    [ctx.org.orgId, partner.id],
  )).rows[0].next);
  const sourceMetadata = {
    questionnaireVersion,
    submittedAt: sourceSubmittedAt.toISOString(),
    generatedAt: generatedAt.toISOString(),
    companyKnowledgeHash: knowledge.fingerprint,
    companyKnowledgeSections: knowledge.sourceVersions,
    companyKnowledgeFactCount: knowledge.sourceVersions.length,
    companyKnowledgeConflictCount: knowledgeMerge.conflicts,
  };
  const snapshot = (await db.query<{ id: string }>(
    `insert into ai_growth_partner_versions
       (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, 'onboarding', $6::jsonb, $7)
     returning id`,
    [partner.id, ctx.org.orgId, version, JSON.stringify(brain), JSON.stringify(personaSettingsSchema.parse(latest?.persona_settings ?? {})), JSON.stringify(sourceMetadata), ctx.user.id],
  )).rows[0];

  // Existing-tenant migration candidates must stay inactive until their owner reviews the draft.
  const activated = partner.current_version === null && partner.status !== "migration_required"
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
    metadata: {
      source: "onboarding",
      version,
      questionnaireVersion,
      factCount,
      activeVersionChanged,
      companyKnowledgeFactCount: knowledge.sourceVersions.length,
      companyKnowledgeConflictCount: knowledgeMerge.conflicts,
    },
  }, db);
  return {
    partnerId: partner.id,
    id: snapshot.id,
    version,
    factCount,
    activeVersionChanged,
    companyKnowledgeFactCount: knowledge.sourceVersions.length,
    companyKnowledgeConflictCount: knowledgeMerge.conflicts,
    reused: false as const,
  };
}

/**
 * Applies only approved, risk-free company knowledge to the Growth Partner's immutable Brain.
 * Active facts are updated in a new version; unresolved differences become draft suggestions so
 * the runtime cannot use either side until an owner reviews the field.
 */
export async function syncGrowthPartnerBusinessBrainFromCompanyKnowledge(
  db: Queryable,
  input: { orgId: string; actorUserId: string; actorKind: "agency" | "user" | "system" },
): Promise<{ status: "updated" | "unchanged" | "not_ready"; activeVersion: number | null; draftVersion: number | null; conflictCount: number }> {
  const partner = (await db.query<{ id: string; current_version: number | null }>(
    `select p.id, p.current_version from ai_growth_partners p
     join organizations o on o.id = p.org_id
     where p.org_id = $1 and o.kind = 'client' and not o.is_demo
     for update of p`,
    [input.orgId],
  )).rows[0];
  if (!partner) return { status: "not_ready", activeVersion: null, draftVersion: null, conflictCount: 0 };

  const latest = (await db.query<{
    version: number;
    business_brain: unknown;
    persona_settings: unknown;
    source_metadata: unknown;
  }>(
    `select version, business_brain, persona_settings, source_metadata
     from ai_growth_partner_versions where org_id = $1 and partner_id = $2
     order by version desc limit 1`,
    [input.orgId, partner.id],
  )).rows[0];
  if (!latest) return { status: "not_ready", activeVersion: null, draftVersion: null, conflictCount: 0 };
  const latestBrain = BusinessBrainSchema.safeParse(latest.business_brain);
  if (!latestBrain.success) throw new AppError("conflict", "The saved Business Brain needs review before company knowledge can be synchronized.");

  const hasActive = partner.current_version !== null;
  const active = hasActive ? (await db.query<{
    version: number;
    business_brain: unknown;
    persona_settings: unknown;
    source_metadata: unknown;
  }>(
    `select version, business_brain, persona_settings, source_metadata from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 and version = $3`,
    [input.orgId, partner.id, partner.current_version],
  )).rows[0] : null;
  if (hasActive && !active) throw new AppError("conflict", "The active Business Brain could not be found. Review it before company knowledge changes are applied.");
  const activeBrain = active ? BusinessBrainSchema.safeParse(active.business_brain) : null;
  if (active && !activeBrain?.success) throw new AppError("conflict", "The active Business Brain needs review before company knowledge can be synchronized.");

  const snapshot = await loadCompanyKnowledgeSnapshot(db, input.orgId);
  const now = new Date().toISOString();
  const basedOnVersion = Number(latest.version);
  const latestUpdate = applyCompanyKnowledgeFacts(latestBrain.data, snapshot, now);
  const hasDraft = !hasActive || Number(latest.version) > Number(partner.current_version);
  const activeUpdate = activeBrain?.success ? applyCompanyKnowledgeFacts(activeBrain.data, snapshot, now) : null;
  const initialNextVersion = Number((await db.query<{ next: number }>(
    "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
    [input.orgId, partner.id],
  )).rows[0].next);
  let nextVersion = initialNextVersion;
  let nextActiveVersion = partner.current_version;
  let nextDraftVersion: number | null = hasDraft ? basedOnVersion : null;
  let writes = 0;

  const insertSnapshot = async (args: {
    version: number;
    brain: BusinessBrain;
    personaSettings: unknown;
    basedOnVersion: number;
    conflicts: number;
    active: boolean;
  }) => {
    const sourceMetadata = {
      ...metadataRecord(args.active ? active?.source_metadata : latest.source_metadata),
      syncKind: "company_knowledge",
      basedOnVersion: args.basedOnVersion,
      companyKnowledgeHash: snapshot.fingerprint,
      companyKnowledgeSections: snapshot.sourceVersions,
      companyKnowledgeFactCount: snapshot.sourceVersions.length,
      companyKnowledgeConflictCount: args.conflicts,
      companyKnowledgeFactsChanged: args.active ? activeUpdate?.changed ?? 0 : latestUpdate.changed,
      activeVersionChanged: args.active,
      syncedAt: now,
    };
    const inserted = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, 'knowledge_sync', $6::jsonb, $7)
       returning id`,
      [partner.id, input.orgId, args.version, JSON.stringify(args.brain), JSON.stringify(args.personaSettings ?? {}), JSON.stringify(sourceMetadata), input.actorUserId],
    )).rows[0];
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      action: args.active ? "ai_growth_partner.business_brain_knowledge_synced" : "ai_growth_partner.business_brain_draft_rebased",
      targetType: "ai_growth_partner_version",
      targetId: inserted.id,
      result: "success",
      metadata: {
        syncKind: "company_knowledge",
        version: args.version,
        basedOnVersion: args.basedOnVersion,
        companyKnowledgeHash: snapshot.fingerprint,
        companyKnowledgeFactCount: snapshot.sourceVersions.length,
        companyKnowledgeFactsChanged: args.active ? activeUpdate?.changed ?? 0 : latestUpdate.changed,
        companyKnowledgeConflictCount: args.conflicts,
        activeVersionChanged: args.active,
      },
    }, db);
    writes++;
    return inserted.id;
  };

  if (!hasActive) {
    if (!latestUpdate.changed) {
      return { status: "unchanged", activeVersion: null, draftVersion: basedOnVersion, conflictCount: latestUpdate.conflicts };
    }
    await insertSnapshot({
      version: nextVersion++,
      brain: latestUpdate.brain,
      personaSettings: latest.persona_settings,
      basedOnVersion,
      conflicts: latestUpdate.conflicts,
      active: false,
    });
    nextDraftVersion = nextVersion - 1;
  } else if (activeUpdate?.changed) {
    const activeVersion = nextVersion++;
    await insertSnapshot({
      version: activeVersion,
      brain: activeUpdate.brain,
      personaSettings: active?.persona_settings,
      basedOnVersion: Number(active?.version),
      conflicts: activeUpdate.conflicts,
      active: true,
    });
    const pointer = await db.query(
      "update ai_growth_partners set current_version = $3 where id = $1 and org_id = $2 and current_version = $4 returning id",
      [partner.id, input.orgId, activeVersion, partner.current_version],
    );
    if (!pointer.rowCount) throw new AppError("conflict", "The active Business Brain changed while company knowledge was being synchronized. Refresh and try again.");
    nextActiveVersion = activeVersion;
  }

  if (hasActive && hasDraft && (latestUpdate.changed || Boolean(activeUpdate?.changed))) {
    const draftVersion = nextVersion++;
    await insertSnapshot({
      version: draftVersion,
      brain: latestUpdate.brain,
      personaSettings: latest.persona_settings,
      basedOnVersion,
      conflicts: latestUpdate.conflicts,
      active: false,
    });
    nextDraftVersion = draftVersion;
  }

  return {
    status: writes ? "updated" : "unchanged",
    activeVersion: nextActiveVersion,
    draftVersion: nextDraftVersion,
    conflictCount: activeUpdate?.conflicts ?? latestUpdate.conflicts,
  };
}

/**
 * Carries only the explicitly changed Settings profile facts into the Growth Partner's immutable
 * Business Brain history. The new active snapshot is based on the current active version. If a
 * newer draft exists, a rebased copy is kept as a draft so this Settings save cannot activate or
 * erase unrelated client edits.
 */
export async function syncGrowthPartnerBusinessBrainFromProfile(
  db: Queryable,
  input: {
    orgId: string;
    actorUserId: string;
    actorKind: "agency" | "user";
    changed: readonly ProfileKey[];
    values: ProfileValues;
  },
): Promise<{ status: "updated" | "held" | "unchanged" | "not_ready"; draftRebased: boolean }> {
  if (!input.changed.length) return { status: "unchanged", draftRebased: false };
  const partner = (await db.query<{ id: string; current_version: number | null }>(
    `select p.id, p.current_version from ai_growth_partners p
     join organizations o on o.id = p.org_id
     where p.org_id = $1 and o.kind = 'client' and not o.is_demo
     for update of p`,
    [input.orgId],
  )).rows[0];
  if (!partner || partner.current_version === null) return { status: "not_ready", draftRebased: false };

  const active = (await db.query<{ version: number; business_brain: unknown; persona_settings: unknown }>(
    `select version, business_brain, persona_settings from ai_growth_partner_versions
     where org_id = $1 and partner_id = $2 and version = $3`,
    [input.orgId, partner.id, partner.current_version],
  )).rows[0];
  if (!active) throw new AppError("conflict", "The active Business Brain version could not be found. Review it before changing the company profile.");
  const parsedActive = BusinessBrainSchema.safeParse(active.business_brain);
  if (!parsedActive.success) throw new AppError("conflict", "The active Business Brain needs review before company profile changes can be synchronized.");

  const latest = (await db.query<{
    version: number;
    business_brain: unknown;
    persona_settings: unknown;
    source: string;
    source_metadata: unknown;
  }>(
    `select version, business_brain, persona_settings, source, source_metadata
     from ai_growth_partner_versions where org_id = $1 and partner_id = $2
     order by version desc limit 1`,
    [input.orgId, partner.id],
  )).rows[0];
  const hasDraft = Boolean(latest && Number(latest.version) > Number(partner.current_version));
  const parsedDraft = hasDraft ? BusinessBrainSchema.safeParse(latest!.business_brain) : null;
  if (hasDraft && !parsedDraft?.success) throw new AppError("conflict", "The saved Business Brain draft needs review before company profile changes can be synchronized.");

  const now = new Date().toISOString();
  const reviewRequired = input.changed.some((key) => scanInstructionText(input.values[key]).length > 0);
  const activeUpdate = applyBusinessProfileFacts(parsedActive.data, input.values, input.changed, now);
  const maxVersion = Number((await db.query<{ next: number }>(
    "select coalesce(max(version), 0)::int + 1 as next from ai_growth_partner_versions where org_id = $1 and partner_id = $2",
    [input.orgId, partner.id],
  )).rows[0].next);
  let nextVersion = maxVersion;
  let activeVersion: number | null = null;

  if (!reviewRequired && activeUpdate.changed.length) {
    activeVersion = nextVersion++;
    const snapshot = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, 'client_edit', $6::jsonb, $7)
       returning id`,
      [partner.id, input.orgId, activeVersion, JSON.stringify(activeUpdate.brain), JSON.stringify(active.persona_settings ?? {}), JSON.stringify({
        submittedFrom: "workspace_settings",
        syncKind: "business_profile",
        basedOnVersion: Number(active.version),
        changedProfileFields: activeUpdate.changed,
      }), input.actorUserId],
    )).rows[0];
    const pointer = await db.query(
      "update ai_growth_partners set current_version = $3 where id = $1 and org_id = $2 and current_version = $4 returning id",
      [partner.id, input.orgId, activeVersion, partner.current_version],
    );
    if (!pointer.rowCount) throw new AppError("conflict", "The active Business Brain changed while the company profile was being saved. Refresh and try again.");
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      action: "ai_growth_partner.business_brain_profile_synced",
      targetType: "ai_growth_partner_version",
      targetId: snapshot.id,
      result: "success",
      metadata: { version: activeVersion, basedOnVersion: Number(active.version), changedProfileFields: activeUpdate.changed, activeVersionChanged: true },
    }, db);
  }

  const keepDraft = hasDraft || reviewRequired;
  if (keepDraft) {
    const draftBase = parsedDraft?.success ? parsedDraft.data : parsedActive.data;
    const draftUpdate = applyBusinessProfileFacts(draftBase, input.values, input.changed, now);
    const draftVersion = nextVersion;
    const basedOnVersion = hasDraft ? Number(latest!.version) : Number(active.version);
    const draft = (await db.query<{ id: string }>(
      `insert into ai_growth_partner_versions
         (partner_id, org_id, version, business_brain, persona_settings, source, source_metadata, created_by)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::jsonb, $8)
       returning id`,
      [partner.id, input.orgId, draftVersion, JSON.stringify(draftUpdate.brain), JSON.stringify((hasDraft ? latest!.persona_settings : active.persona_settings) ?? {}), hasDraft ? latest!.source : "client_edit", JSON.stringify({
        submittedFrom: "workspace_settings",
        syncKind: "business_profile",
        basedOnVersion,
        changedProfileFields: [...new Set(input.changed)],
        rebasedAt: now,
        reviewRequired,
      }), input.actorUserId],
    )).rows[0];
    await recordAudit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      actorKind: input.actorKind,
      action: "ai_growth_partner.business_brain_draft_rebased",
      targetType: "ai_growth_partner_version",
      targetId: draft.id,
      result: "success",
      metadata: { version: draftVersion, basedOnVersion, changedProfileFields: [...new Set(input.changed)], activeVersionChanged: false, reviewRequired },
    }, db);
  }

  return { status: reviewRequired ? "held" : activeVersion ? "updated" : "unchanged", draftRebased: keepDraft };
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
  source: "growth_partner" | "previous_profile";
  profileLabel: string | null;
  excerpt: string;
  createdAt: Date;
}

/** Searches the shared Partner thread and the signed-in member's own retained role chats. */
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
      source: GrowthPartnerConversationSearchResult["source"];
      profile_role_key: AgentRoleKey | null;
      profile_name: string | null;
      excerpt: string;
      created_at: Date;
    }>(
      `with matches as (
         select m.id, m.role,
                coalesce(nullif(u.full_name, ''), case when m.author_user_id is null then null else 'Workspace member' end) as author_label,
                'growth_partner'::text as source, null::text as profile_role_key, null::text as profile_name,
                substring(m.content from greatest(position(lower($2) in lower(m.content)) - 120, 1) for 300) as excerpt,
                m.created_at
         from chat_messages m
         left join users u on u.id = m.author_user_id
         where m.org_id = $1 and m.conversation_id = $3 and m.status <> 'superseded'
           and m.content <> '' and position(lower($2) in lower(m.content)) > 0

         union all

         select m.id, m.role,
                coalesce(nullif(u.full_name, ''), case when m.author_user_id is null then null else 'Workspace member' end) as author_label,
                'previous_profile'::text as source, a.role_key::text as profile_role_key, a.display_name as profile_name,
                substring(m.content from greatest(position(lower($2) in lower(m.content)) - 120, 1) for 300) as excerpt,
                m.created_at
         from chat_messages m
         join chat_conversations c on c.id = m.conversation_id and c.org_id = m.org_id
         join agent_instances a on a.id = c.agent_instance_id and a.org_id = c.org_id
         left join users u on u.id = m.author_user_id
         where m.org_id = $1 and c.org_id = $1 and c.user_id = $4 and c.deleted_at is null
           and c.growth_partner_id is null and a.role_key = any($5::text[])
           and m.status <> 'superseded' and m.content <> '' and position(lower($2) in lower(m.content)) > 0
       )
       select id, role, author_label, source, profile_role_key, profile_name, excerpt, created_at
       from matches
       order by created_at desc limit 40`,
      [ctx.org.orgId, query, conversation.id, ctx.user.id, AGENT_ROLE_KEYS],
    );
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      authorLabel: row.author_label,
      source: row.source,
      profileLabel: row.source === "previous_profile" && row.profile_role_key
        ? workforceIdentityLabel(row.profile_role_key, row.profile_name)
        : null,
      excerpt: row.excerpt,
      createdAt: row.created_at,
    }));
  });
}
