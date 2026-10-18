import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { compileContactFilter, type CompileContext } from "@/server/crm/filter-sql";
import { loadCustomFieldMetas } from "@/server/crm/directory";
import { crmWordingFitsWhatsappTemplate, currentWhatsappTemplateProvider, tokenValuesFor } from "@/server/crm/message-templates";
import { getBalance, monthToDateSpendMicros } from "@/server/billing/ledger";
import { isTransportName, transportWritesEnabled } from "@/server/messaging/transports";
import { TRANSPORT_LABELS, type TransportName } from "@/server/messaging/transports/types";
import { isGroup, parseFilter, type FilterGroup } from "@/lib/crm/filters";
import { CHANNEL_LABELS, identityKind, smsSegments, validateBusinessHours, type Channel } from "@/lib/messaging";
import {
  customValueKeyOf, customValueKeysUsed, customValueTokenKey, describeMissing, renderMessage, TEMPLATE_TOKENS, tokenDef, tokensUsed,
  type CustomValueTokenDef, type TokenKey, type TokenValues,
} from "@/lib/messaging/tokens";
import { UNIT_LABELS, type UnitType } from "@/lib/billing";

// Shared rules for compliant campaigns (crm_campaigns, crm_campaign_recipients): who on a Smart List may receive a marketing message on a
// channel right now, what an owner's approval is bound to, which templates a campaign may send, and what a message costs at the published
// rate. Used by the service (src/server/crm/campaigns.ts) and by the sending job (./job.ts), so the preview and the send apply one rule set.

export const CAMPAIGN_STATUSES = ["draft", "awaiting_approval", "scheduled", "sending", "paused", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const RECIPIENT_STATUSES = ["pending", "excluded", "queued", "sent", "delivered", "failed", "bounced", "unsubscribed"] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/**
 * Why someone on the list was left out. Stored in crm_campaign_recipients.reason; a refusal of the send rules that has no code of its own is
 * stored as blocked:<reason>.
 */
export const EXCLUSION_REASONS = [
  "no_address", "suppressed", "consent_withdrawn", "no_marketing_consent", "missing_values", "deleted", "archived", "frequency_limit", "template_mismatch",
  "not_linked", "wait_expired", "campaign_cancelled",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** The most people one campaign may go to. A larger list is refused rather than sent in part. */
export const MAX_RECIPIENTS = 50_000;
export const DEFAULT_RATE_PER_MINUTE = 30;
export const MAX_RATE_PER_MINUTE = 600;
/** How long a campaign scheduled for a time that has already passed may still be approved (a page left open for a minute). */
export const SCHEDULE_GRACE_MS = 2 * 60_000;
/** The furthest ahead a campaign can be scheduled. */
export const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 3600_000;
/** How long a person may wait for quiet hours, business hours or message spacing before they are left out of this campaign. */
export const MAX_WAIT_MS = 7 * 24 * 3600_000;

const UNIT_FOR: Record<Channel, UnitType> = { sms: "sms_segment", whatsapp: "whatsapp_message", email: "email_send" };
export const unitFor = (channel: Channel): UnitType => UNIT_FOR[channel];

export interface CampaignRow {
  id: string;
  org_id: string;
  name: string;
  channel: Channel;
  smart_list_id: string | null;
  template_id: string | null;
  template_version: number | null;
  status: CampaignStatus;
  scheduled_at: Date | null;
  rate_per_minute: number;
  estimate: Record<string, unknown>;
  approval_id: string | null;
  approved_hash: string | null;
  counts: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_by: string | null;
}

export const CAMPAIGN_COLUMNS =
  "id, org_id, name, channel, smart_list_id, template_id, template_version, status, scheduled_at, rate_per_minute, estimate, approval_id, approved_hash, counts, created_by, created_at, updated_at, started_at, completed_at, cancelled_by";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Approval binding
// ---------------------------------------------------------------------------

/** JSON with object keys sorted at every level, so the same content always produces the same text (and hash). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
}

/**
 * The business-wide values a message uses, by token ("business.name", "custom_values.offer_link"): the same for every recipient and filled
 * in when each message is queued, so they are part of what the owner approves. "" is an empty value; null a configuration value the
 * workspace doesn't have.
 */
export type BusinessValues = Record<string, string | null>;

/** Everything an owner's approval covers. Changing any of it (the list's filter included) produces a different hash and voids the approval. */
export interface ApprovalBinding {
  channel: Channel;
  smartListId: string;
  filter: FilterGroup;
  templateId: string;
  templateVersion: number;
  templateContentHash: string;
  whatsappTemplateId: string | null;
  /** Null: as soon as it is approved. */
  scheduledAt: string | null;
  ratePerMinute: number;
  /** The business details and configuration values the frozen wording uses, as they were when it was approved. */
  businessValues: BusinessValues;
}

export function campaignApprovalHash(b: ApprovalBinding): string {
  const canonical = stableJson({
    v: 2, channel: b.channel, smartListId: b.smartListId, filter: b.filter, templateId: b.templateId, templateVersion: b.templateVersion,
    templateContentHash: b.templateContentHash, whatsappTemplateId: b.whatsappTemplateId ?? null, scheduledAt: b.scheduledAt ? new Date(b.scheduledAt).toISOString() : null,
    ratePerMinute: b.ratePerMinute, businessValues: b.businessValues ?? {},
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The business-wide values a message's subject and body use, from a token value set (tokenValuesFor): each business.* token and each
 * {{custom_values.<key>}}, with its value as it would be rendered (trimmed; "" when empty). Contact, sender and appointment details are
 * the recipient's own and are not included.
 */
export function usedBusinessValues(values: TokenValues, customValues: ReadonlyArray<CustomValueTokenDef>, ...texts: Array<string | null | undefined>): BusinessValues {
  const out: BusinessValues = {};
  for (const k of tokensUsed(...texts)) {
    if (k.startsWith("business.")) out[k] = String(values[k] ?? "").trim();
  }
  const defs = new Map(customValues.map((d) => [d.key, d]));
  for (const key of customValueKeysUsed(...texts)) {
    const d = defs.get(key);
    out[customValueTokenKey(key)] = d ? String(d.value ?? "").trim() : null;
  }
  return out;
}

/** The business-wide values a template version uses, as they are in the workspace right now. */
export async function businessValuesNow(db: Queryable, orgId: string, version: { subject: string | null; body: string }): Promise<{ values: BusinessValues; customValues: CustomValueTokenDef[] }> {
  const set = await tokenValuesFor(db, orgId, {});
  return { values: usedBusinessValues(set.values, set.customValues, version.subject, version.body), customValues: set.customValues };
}

/** The values that differ between what was approved and what would be sent now, by token. */
export function changedBusinessValues(before: BusinessValues | undefined | null, after: BusinessValues): string[] {
  const b = before ?? {};
  const keys = [...new Set([...Object.keys(b), ...Object.keys(after)])].sort();
  return keys.filter((k) => (b[k] ?? null) !== (after[k] ?? null));
}

/** A changed business value in words: “Offer link” (a configuration value) or your business phone number. */
export function businessValuePhrase(token: string, customValues?: ReadonlyArray<CustomValueTokenDef> | null): string {
  const cv = customValueKeyOf(token);
  if (cv !== null) {
    const label = customValues?.find((d) => d.key === cv)?.label;
    return `the “${label ?? cv}” configuration value`;
  }
  return tokenDef(token)?.phrase ?? token;
}

/** Which parts of a binding differ, in words, for explaining why an approval no longer applies. */
export function bindingChanges(before: Partial<ApprovalBinding> | null, after: ApprovalBinding, customValues?: ReadonlyArray<CustomValueTokenDef> | null): string[] {
  if (!before) return ["what the campaign sends"];
  const out: string[] = [];
  if (before.channel !== after.channel) out.push("the channel");
  if (before.smartListId !== after.smartListId) out.push("the Smart List");
  else if (stableJson(before.filter ?? null) !== stableJson(after.filter)) out.push("the Smart List's filter");
  if (before.templateId !== after.templateId || before.templateVersion !== after.templateVersion || before.templateContentHash !== after.templateContentHash) out.push("the message");
  if ((before.whatsappTemplateId ?? null) !== (after.whatsappTemplateId ?? null)) out.push("the linked WhatsApp template");
  if ((before.scheduledAt ? new Date(before.scheduledAt).toISOString() : null) !== (after.scheduledAt ? new Date(after.scheduledAt).toISOString() : null)) out.push("the schedule");
  if (before.ratePerMinute !== after.ratePerMinute) out.push("the sending pace");
  // Only when the wording is the same: a different message uses different values anyway.
  if (!out.includes("the message")) out.push(...changedBusinessValues(before.businessValues, after.businessValues).map((k) => businessValuePhrase(k, customValues)));
  return out.length ? out : ["what the campaign sends"];
}

/** Reads a binding stored in an approval's action (never trusted for anything but explaining a change). */
export function readBinding(raw: unknown): Partial<ApprovalBinding> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  let filter: FilterGroup | undefined;
  try {
    filter = o.filter === undefined ? undefined : parseFilter(o.filter);
  } catch {
    filter = undefined;
  }
  return {
    channel: typeof o.channel === "string" ? (o.channel as Channel) : undefined,
    smartListId: typeof o.smartListId === "string" ? o.smartListId : undefined,
    filter,
    templateId: typeof o.templateId === "string" ? o.templateId : undefined,
    templateVersion: typeof o.templateVersion === "number" ? o.templateVersion : undefined,
    templateContentHash: typeof o.templateContentHash === "string" ? o.templateContentHash : undefined,
    whatsappTemplateId: typeof o.whatsappTemplateId === "string" ? o.whatsappTemplateId : null,
    scheduledAt: typeof o.scheduledAt === "string" ? o.scheduledAt : null,
    ratePerMinute: typeof o.ratePerMinute === "number" ? o.ratePerMinute : undefined,
    businessValues: readBusinessValues(o.businessValues),
  };
}

/** Business values stored with an approval: only string or null entries are kept; anything else reads as no values (so nothing matches). */
function readBusinessValues(raw: unknown): BusinessValues | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const out: BusinessValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" || v === null) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audience (a Smart List of contacts)
// ---------------------------------------------------------------------------

export interface AudienceList {
  id: string;
  name: string;
  visibility: "private" | "team";
  ownerUserId: string;
  archived: boolean;
  filter: FilterGroup | null;
  /** Why the saved filter can't be used, when it can't. */
  filterError: string | null;
}

/** A contact Smart List of this workspace, whoever owns it (the caller decides who may use it). */
export async function loadAudienceList(db: Queryable, orgId: string, id: string | null): Promise<AudienceList | null> {
  if (!id || !UUID_RE.test(id)) return null;
  const { rows } = await db.query<{ id: string; name: string; visibility: "private" | "team"; owner_user_id: string; archived_at: Date | null; filter: unknown; entity: string }>(
    "select id, name, visibility, owner_user_id, archived_at, filter, entity from crm_smart_lists where id = $1 and org_id = $2",
    [id, orgId],
  );
  const r = rows[0];
  if (!r || r.entity !== "contact") return null;
  const { filter, filterError } = readListFilter(r.filter);
  return { id: r.id, name: r.name, visibility: r.visibility, ownerUserId: r.owner_user_id, archived: Boolean(r.archived_at), filter, filterError };
}

/** A saved list's filter, or why a campaign can't use it. */
export function readListFilter(raw: unknown): { filter: FilterGroup | null; filterError: string | null } {
  let filter: FilterGroup | null = null;
  try {
    filter = parseFilter(raw);
  } catch {
    return { filter: null, filterError: "This Smart List's filter is no longer valid. Edit the list to fix it." };
  }
  if (usesPersonalOwner(filter)) {
    return { filter, filterError: "This Smart List uses “Owner is me”, which means something different for each person. Choose a list that names the owners instead." };
  }
  return { filter, filterError: null };
}

/** Whether a filter depends on who is looking at it ("owner is me"): a campaign's audience must be the same whoever approves or sends it. */
export function usesPersonalOwner(group: FilterGroup): boolean {
  return group.conditions.some((c) => (isGroup(c) ? usesPersonalOwner(c) : c.field === "owner" && c.op === "is_me"));
}

/** SQL that is true when a contact (alias c) has no value for a contact token, mirroring tokenValuesFor in message-templates.ts. */
const CONTACT_TOKEN_MISSING: Partial<Record<TokenKey, string>> = {
  "contact.first_name": "nullif(btrim(coalesce(nullif(c.first_name, ''), split_part(btrim(coalesce(c.display_name, '')), ' ', 1))), '') is null",
  "contact.last_name": "nullif(btrim(coalesce(c.last_name, '')), '') is null",
  "contact.full_name": "nullif(btrim(coalesce(nullif(c.display_name, ''), concat_ws(' ', nullif(c.first_name, ''), nullif(c.last_name, '')))), '') is null",
  "contact.email": "(c.email is null and not exists (select 1 from contact_identities ie where ie.org_id = c.org_id and ie.contact_id = c.id and ie.kind = 'email'))",
  "contact.phone": "(c.phone is null and not exists (select 1 from contact_identities ip where ip.org_id = c.org_id and ip.contact_id = c.id and ip.kind = 'phone'))",
};

export type AudienceOutcome = ExclusionReason | "eligible";

/**
 * The first rule that leaves a contact (alias c) out right now, in the order the send path checks them: an address for the channel, not
 * suppressed, marketing consent granted for the channel; then the contact details the message needs. `ch` and `kind` are SQL placeholders.
 * The joins it needs are in OUTCOME_JOINS.
 */
function outcomeCase(ch: string, contactTokens: TokenKey[], opts: { lifecycle?: boolean } = {}): string {
  const missing = contactTokens.map((t) => CONTACT_TOKEN_MISSING[t]).filter((s): s is string => Boolean(s));
  return `case
        ${opts.lifecycle ? "when c.deleted_at is not null then 'deleted' when c.archived_at is not null then 'archived'" : ""}
        when a.value is null then 'no_address'
        when exists (select 1 from suppressions s where s.org_id = c.org_id and s.channel = ${ch} and s.address = a.value and s.lifted_at is null) then 'suppressed'
        when k.status = 'revoked' then 'consent_withdrawn'
        when k.status is distinct from 'granted' then 'no_marketing_consent'
        ${missing.length ? `when ${missing.join(" or ")} then 'missing_values'` : ""}
        else 'eligible'
      end`;
}

const outcomeJoins = (ch: string, kind: string) => `
    left join lateral (select i.value from contact_identities i where i.org_id = c.org_id and i.contact_id = c.id and i.kind = ${kind} order by i.verified desc, i.created_at limit 1) a on true
    left join lateral (select e.status from contact_consent_events e where e.org_id = c.org_id and e.contact_id = c.id and e.channel = ${ch} and e.purpose = 'marketing' order by e.id desc limit 1) k on true`;

/**
 * A query over the list's contacts with, for each, the first rule that leaves them out right now or "eligible". Deleted and archived contacts
 * are not on the list at all, as on the Contacts screen. Values: $1 is the workspace.
 */
export async function audienceOutcomeSql(db: Queryable, orgId: string, timezone: string, filter: FilterGroup, channel: Channel, contactTokens: TokenKey[]): Promise<{ sql: string; params: unknown[] }> {
  const params: unknown[] = [orgId];
  const ctx: CompileContext = { params, userId: null, timezone, customFields: await loadCustomFieldMetas(db, orgId) };
  const cond = compileContactFilter(filter, ctx);
  params.push(channel);
  const ch = `$${params.length}::text`;
  params.push(identityKind(channel));
  const kind = `$${params.length}::text`;
  const sql = `
    select c.id as contact_id, ${outcomeCase(ch, contactTokens)} as outcome
    from contacts c ${outcomeJoins(ch, kind)}
    where c.org_id = $1 and c.deleted_at is null and c.archived_at is null and ${cond}`;
  return { sql, params };
}

/** The same rules for one person, again at the moment their message is queued (they may have opted out since the list was read). */
export async function personOutcome(db: Queryable, orgId: string, contactId: string, channel: Channel, contactTokens: TokenKey[]): Promise<AudienceOutcome> {
  const { rows } = await db.query<{ outcome: AudienceOutcome }>(
    `select ${outcomeCase("$3::text", contactTokens, { lifecycle: true })} as outcome
     from contacts c ${outcomeJoins("$3::text", "$4::text")}
     where c.org_id = $1 and c.id = $2`,
    [orgId, contactId, channel, identityKind(channel)],
  );
  return rows[0]?.outcome ?? "deleted";
}

export interface AudienceSummary {
  total: number;
  eligible: number;
  excluded: Partial<Record<ExclusionReason, number>>;
}

/** Counts only: how many are on the list, how many may receive the message now, and how many are left out for each reason. */
export async function summarizeAudience(db: Queryable, orgId: string, timezone: string, filter: FilterGroup, channel: Channel, contactTokens: TokenKey[]): Promise<AudienceSummary> {
  const q = await audienceOutcomeSql(db, orgId, timezone, filter, channel, contactTokens);
  const { rows } = await db.query<{ outcome: AudienceOutcome; n: string }>(`select x.outcome, count(*)::text as n from (${q.sql}) x group by x.outcome`, q.params);
  const out: AudienceSummary = { total: 0, eligible: 0, excluded: {} };
  for (const r of rows) {
    const n = Number(r.n);
    out.total += n;
    if (r.outcome === "eligible") out.eligible += n;
    else out.excluded[r.outcome] = (out.excluded[r.outcome] ?? 0) + n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Templates a campaign may send
// ---------------------------------------------------------------------------

export interface CampaignTemplate {
  id: string;
  name: string;
  kind: "template" | "canned_reply";
  channel: Channel | null;
  purpose: "service" | "marketing";
  status: "draft" | "approved" | "archived";
  currentVersion: number;
  approvedVersion: number | null;
  whatsappTemplateId: string | null;
  /** The requested version's frozen content (null when that version doesn't exist). */
  version: { number: number; subject: string | null; body: string; contentHash: string; tokens: TokenKey[] } | null;
  /** The content hash of the version that is approved now, if any. */
  approvedContentHash: string | null;
}

const KNOWN_TOKENS = new Set<string>(TEMPLATE_TOKENS.map((t) => t.key));

/** A template of this workspace with one frozen version (the campaign's, or the approved one when no version is named). */
export async function loadCampaignTemplate(db: Queryable, orgId: string, templateId: string | null, version?: number | null): Promise<CampaignTemplate | null> {
  if (!templateId || !UUID_RE.test(templateId)) return null;
  const { rows } = await db.query<{
    id: string; name: string; kind: "template" | "canned_reply"; channel: Channel | null; purpose: "service" | "marketing"; status: "draft" | "approved" | "archived"; current_version: number;
    approved_version: number | null; whatsapp_template_id: string | null; approved_hash: string | null;
  }>(
    `select t.id, t.name, t.kind, t.channel, t.purpose, t.status, t.current_version, t.approved_version, t.whatsapp_template_id,
            (select v.content_hash from crm_message_template_versions v where v.template_id = t.id and v.org_id = t.org_id and v.version = t.approved_version) as approved_hash
     from crm_message_templates t where t.id = $1 and t.org_id = $2`,
    [templateId, orgId],
  );
  const t = rows[0];
  if (!t) return null;
  const want = version ?? t.approved_version;
  let v: CampaignTemplate["version"] = null;
  if (want) {
    const vr = await db.query<{ version: number; subject: string | null; body: string; content_hash: string; tokens: string[] | null }>(
      "select version, subject, body, content_hash, tokens from crm_message_template_versions where template_id = $1 and org_id = $2 and version = $3",
      [t.id, orgId, want],
    );
    const r = vr.rows[0];
    if (r) v = { number: r.version, subject: r.subject, body: r.body, contentHash: r.content_hash, tokens: (r.tokens ?? []).filter((k): k is TokenKey => KNOWN_TOKENS.has(k)) };
  }
  return {
    id: t.id, name: t.name, kind: t.kind, channel: t.channel, purpose: t.purpose, status: t.status, currentVersion: t.current_version, approvedVersion: t.approved_version,
    whatsappTemplateId: t.whatsapp_template_id, version: v, approvedContentHash: t.approved_hash,
  };
}

/** Whether the campaign's frozen version is still the wording the template's owners approve (the same words; an edit withdraws it). */
export function wordingStillApproved(t: CampaignTemplate | null, contentHash: string | null, whatsappTemplateId: string | null): boolean {
  return Boolean(
    t && t.status === "approved" && t.version && t.approvedContentHash && t.approvedVersion === t.version.number && t.approvedContentHash === t.version.contentHash &&
      (!contentHash || contentHash === t.version.contentHash) && (t.whatsappTemplateId ?? null) === (whatsappTemplateId ?? null),
  );
}

export interface WhatsappLink {
  templateId: string;
  name: string;
  status: string;
  category: string | null;
  provider: "ghl" | "meta_whatsapp";
}

/**
 * Everything that stops a template from being sent as this campaign, as plain sentences (empty when it can be). Purpose, channel, approval,
 * opt-out wording and the WhatsApp template it relies on. Business details it needs are checked separately (messageProblems).
 */
export async function templateProblems(db: Queryable, orgId: string, t: CampaignTemplate | null, channel: Channel): Promise<{ problems: string[]; whatsapp: WhatsappLink | null }> {
  const label = CHANNEL_LABELS[channel];
  if (!t) return { problems: ["Choose the message this campaign sends."], whatsapp: null };
  if (t.kind !== "template") return { problems: ["Canned replies are typed into conversations by a person. Choose a message template."], whatsapp: null };
  if (t.status === "archived") return { problems: [`“${t.name}” is archived. Restore it in Templates or choose another message.`], whatsapp: null };
  if (t.channel !== channel) return { problems: [`“${t.name}” is written for ${t.channel ? CHANNEL_LABELS[t.channel] : "another channel"}. Choose a ${label} template.`], whatsapp: null };
  const problems: string[] = [];
  if (t.status !== "approved" || !t.approvedVersion) problems.push(`“${t.name}” isn't approved for automated sending. Someone with template access approves it in Templates first.`);
  else if (!t.version || t.version.number !== t.approvedVersion) problems.push(`“${t.name}” now has a different approved version (v${t.approvedVersion}). Choose the template again to use the approved wording.`);
  if (t.purpose !== "marketing") problems.push(`“${t.name}” is a service template. Campaigns are promotional, so choose a template approved for marketing.`);
  const body = t.version?.body ?? "";
  const tokens = t.version?.tokens ?? [];
  const personal = tokens.filter((k) => k.startsWith("appointment.") || k.startsWith("user."));
  if (personal.length) {
    problems.push(`The message uses ${personal.map((k) => `{{${k}}}`).join(", ")}. A campaign goes to a whole list from your business, so it can only use contact and business details.`);
  }
  if (channel === "sms" && t.version && !/\bstop\b/i.test(body)) {
    problems.push("Marketing texts must tell people how to opt out. Add wording such as “Reply STOP to opt out.” to the template and approve it again.");
  }
  let whatsapp: WhatsappLink | null = null;
  if (channel === "whatsapp") {
    if (!t.whatsappTemplateId) {
      problems.push("WhatsApp only delivers promotional messages with a template Meta approved. Link this template to its approved WhatsApp template in Templates.");
    } else {
      const provider = await currentWhatsappTemplateProvider(db, orgId);
      const { rows } = await db.query<{ template_id: string; name: string; status: string; category: string | null; body: string; variables: unknown }>(
        "select template_id, name, status, category, body, variables from whatsapp_templates where org_id = $1 and template_id = $2 and provider = $3",
        [orgId, t.whatsappTemplateId, provider],
      );
      const w = rows[0];
      if (!w) problems.push("The linked WhatsApp template isn't one this workspace's WhatsApp sends through now. Link one of its approved templates.");
      else {
        whatsapp = { templateId: w.template_id, name: w.name, status: w.status, category: w.category, provider };
        if (w.status !== "approved") problems.push(`The linked WhatsApp template “${w.name}” isn't approved by ${provider === "meta_whatsapp" ? "Meta" : "GoHighLevel"} yet.`);
        if (w.category && w.category !== "marketing") problems.push(`The linked WhatsApp template “${w.name}” is a ${w.category} template. Meta only allows promotional messages with a MARKETING template.`);
        if (provider === "meta_whatsapp" && t.version) {
          const fit = crmWordingFitsWhatsappTemplate(body, w);
          if (!fit.ok) problems.push(`WhatsApp would deliver the linked template's wording, not this message's. ${fit.detail}`);
        }
      }
    }
  }
  return { problems, whatsapp };
}

/**
 * What the message needs from the business that isn't there (its profile details, required configuration values), rendered with sample
 * contact details, plus the segment count with those values. The same for every recipient, so it stops the campaign rather than one person.
 */
export async function messageProblems(db: Queryable, orgId: string, t: CampaignTemplate | null): Promise<{ problems: string[]; segments: number; sample: { subject: string | null; body: string } | null }> {
  if (!t?.version) return { problems: [], segments: 1, sample: null };
  const set = await tokenValuesFor(db, orgId, { samples: true });
  const out = renderMessage({ subject: t.version.subject, body: t.version.body }, set.values, { customValues: set.customValues });
  const businessWide = out.missing.filter((k) => !k.startsWith("contact."));
  const problems = businessWide.length || out.unknown.length ? [`${describeMissing(businessWide, out.unknown, set.customValues)} Fill it in before this campaign can send.`] : [];
  return { problems, segments: t.channel === "sms" ? Math.max(1, smsSegments(out.body)) : 1, sample: { subject: out.subject, body: out.body } };
}

// ---------------------------------------------------------------------------
// The channel, prices, credits and policy
// ---------------------------------------------------------------------------

export async function channelProviderOf(db: Queryable, orgId: string, channel: Channel): Promise<TransportName> {
  const { rows } = await db.query<{ provider: string }>("select provider from messaging_channels where org_id = $1 and channel = $2", [orgId, channel]);
  return rows[0] && isTransportName(rows[0].provider) ? rows[0].provider : "ghl";
}

export const providerLabel = (p: TransportName) => TRANSPORT_LABELS[p] ?? p;
export const unitLabel = (u: UnitType) => UNIT_LABELS[u] ?? u;

/**
 * Whether the workspace can send this channel at all right now: enabled and verified, the provider allowed to send in this environment, and
 * for email the one-click unsubscribe every marketing email must carry (added by iAcquire's own email sending, not by GoHighLevel's).
 */
export async function channelProblems(db: Queryable, orgId: string, channel: Channel): Promise<{ provider: TransportName; problems: string[] }> {
  const label = CHANNEL_LABELS[channel];
  const { rows } = await db.query<{ enabled: boolean; provider: string }>("select enabled, provider from messaging_channels where org_id = $1 and channel = $2", [orgId, channel]);
  const provider: TransportName = rows[0] && isTransportName(rows[0].provider) ? rows[0].provider : "ghl";
  const problems: string[] = [];
  if (!rows[0]?.enabled) problems.push(`${label} isn't verified and switched on for this workspace yet. iAcquire sets up each channel; until then nothing can be sent on it.`);
  else if (!transportWritesEnabled(provider)) problems.push(`Sending through ${providerLabel(provider)} is switched off in this environment, so nothing would be sent.`);
  if (channel === "email" && provider === "ghl") {
    problems.push("Marketing emails must carry a one-click unsubscribe link. iAcquire adds it when email sends through its own email provider; this workspace's email goes through GoHighLevel, which doesn't carry it, so email campaigns can't be sent yet.");
  }
  return { provider, problems };
}

/** The rate iAcquire published for a provider's unit (what the client is charged per unit), or null when none is published. Never estimated. */
export async function publishedClientRate(db: Queryable, provider: TransportName, unit: UnitType): Promise<{ clientMicros: number; version: number } | null> {
  const { rows } = await db.query<{ c: string; version: number }>(
    `select r.client_micros_per_unit::text as c, v.version from usage_unit_rates r join usage_rate_versions v on v.id = r.rate_version_id
     where r.provider = $1 and r.unit_type = $2 order by v.version desc limit 1`,
    [provider, unit],
  );
  return rows[0] ? { clientMicros: Number(rows[0].c), version: rows[0].version } : null;
}

export interface CampaignEstimate {
  provider: TransportName;
  providerLabel: string;
  unit: UnitType;
  unitLabel: string;
  messages: number;
  /** Units per message (SMS segments with sample details; 1 for email and WhatsApp). */
  unitsPerMessage: number;
  units: number;
  /** The published rate, or null: then there is no price and no cost. */
  rate: { clientMicrosPerUnit: number; version: number } | null;
  costMicros: number | null;
}

/** The cost of sending to `messages` people at the provider's published rate. Without a published rate there is no number at all. */
export async function estimateCost(db: Queryable, channel: Channel, provider: TransportName, messages: number, unitsPerMessage: number): Promise<CampaignEstimate> {
  const unit = unitFor(channel);
  const rate = await publishedClientRate(db, provider, unit);
  const units = messages * unitsPerMessage;
  return {
    provider, providerLabel: providerLabel(provider), unit, unitLabel: unitLabel(unit), messages, unitsPerMessage, units,
    rate: rate ? { clientMicrosPerUnit: rate.clientMicros, version: rate.version } : null,
    costMicros: rate ? Math.ceil(rate.clientMicros * units) : null,
  };
}

export interface CreditCheck {
  /** enough: the balance covers the estimate; short: it doesn't; over_budget: it would pass the monthly limit that stops spending; unknown: no price. */
  status: "enough" | "short" | "over_budget" | "unknown";
  availableMicros: number;
  shortByMicros: number | null;
  budget: { limitMicros: number; spentMicros: number; reservedMicros: number; hardStop: boolean } | null;
}

/** The existing billing state against an estimate: available credit (balance less holds) and the monthly limit when it stops spending. */
export async function checkCredits(db: Queryable, orgId: string, costMicros: number | null): Promise<CreditCheck> {
  const bal = await getBalance(db, orgId);
  const { rows } = await db.query<{ monthly_budget_micros: string | null; hard_stop: boolean }>("select monthly_budget_micros, hard_stop from billing_settings where org_id = $1", [orgId]);
  const limit = rows[0]?.monthly_budget_micros ? Number(rows[0].monthly_budget_micros) : null;
  const budget = limit !== null ? { limitMicros: limit, spentMicros: await monthToDateSpendMicros(db, orgId), reservedMicros: bal.reservedMicros, hardStop: rows[0].hard_stop } : null;
  if (costMicros === null) return { status: "unknown", availableMicros: bal.availableMicros, shortByMicros: null, budget };
  if (costMicros > bal.availableMicros) return { status: "short", availableMicros: bal.availableMicros, shortByMicros: costMicros - bal.availableMicros, budget };
  if (budget?.hardStop && budget.spentMicros + budget.reservedMicros + costMicros > budget.limitMicros) return { status: "over_budget", availableMicros: bal.availableMicros, shortByMicros: null, budget };
  return { status: "enough", availableMicros: bal.availableMicros, shortByMicros: null, budget };
}

export interface SendingPolicy {
  quietStart: string;
  quietEnd: string;
  maxPerContact30d: number;
  minHoursBetween: number;
  businessHoursSet: boolean;
}

/** The rules every campaign message is held to (the program-message limit it shares, quiet hours, business hours). */
export async function sendingPolicy(db: Queryable, orgId: string): Promise<SendingPolicy> {
  const p = await db.query<{ quiet_hours_start: string; quiet_hours_end: string; max_retention_per_contact_30d: number; min_hours_between_retention: number }>(
    "select quiet_hours_start::text, quiet_hours_end::text, max_retention_per_contact_30d, min_hours_between_retention from messaging_policy limit 1",
  );
  const s = await db.query<{ business_hours: unknown }>("select business_hours from messaging_settings where org_id = $1", [orgId]);
  const hours = validateBusinessHours(s.rows[0]?.business_hours ?? {});
  const r = p.rows[0];
  return {
    quietStart: (r?.quiet_hours_start ?? "21:00").slice(0, 5),
    quietEnd: (r?.quiet_hours_end ?? "08:00").slice(0, 5),
    maxPerContact30d: r?.max_retention_per_contact_30d ?? 4,
    minHoursBetween: r?.min_hours_between_retention ?? 72,
    businessHoursSet: Boolean(hours && Object.keys(hours).length),
  };
}
