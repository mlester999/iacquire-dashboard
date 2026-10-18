import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { describeMetaError, isMetaReconnectError, metaErrorCode, metaGraph, resolveMetaWhatsappToken } from "@/server/messaging/transports/meta-whatsapp";

// WhatsApp message templates from Meta's WhatsApp Business Cloud API, mirrored into whatsapp_templates (provider 'meta_whatsapp').
//
// Templates are created, edited and reviewed in Meta (WhatsApp Manager or Meta's API); iAcquire only reads them, with
// GET /{Version}/{WABA-ID}/message_templates, and never submits, edits or deletes one. Only an APPROVED template can be sent (Meta:
// "if it is rejected, or if its status changes to any other value, it cannot be sent"), so:
//
//   APPROVED                              → approved   (unless it needs something iAcquire can't send yet: then rejected, with the reason)
//   PENDING, IN_APPEAL, PAUSED            → pending    (not sendable now; may become sendable without changes)
//   REJECTED, DISABLED, ARCHIVED,
//   LIMIT_EXCEEDED, PENDING_DELETION,
//   DELETED, anything unknown             → rejected   (not sendable; the reason says why)
//
// Paused and disabled templates are never "approved" here: the send path only offers and sends approved rows. The sync is idempotent
// (upsert on the Meta template id; a template that disappeared from the account is marked not sendable, never deleted, because messages and
// native template definitions refer to it).

/** One positional or named value a template needs, in the order values are passed (header first, then body). */
export interface WhatsappTemplateVariable {
  /** 1-based order of the value in TransportSendRequest.template.params. */
  position: number;
  /** What the value is, for people choosing it ("{{1}}", "first_name"), with Meta's example when there is one. */
  label: string;
  component: "header" | "body";
  /** For templates with named parameters: the parameter_name Meta expects. */
  name?: string;
}

export type MappedStatus = "approved" | "pending" | "rejected";

const REJECTION_LABELS: Record<string, string> = {
  ABUSIVE_CONTENT: "the content violates Meta's policies",
  CATEGORY_NOT_AVAILABLE: "the category isn't available for this template",
  INCORRECT_CATEGORY: "the content doesn't match the template's category",
  INVALID_FORMAT: "the template's format is invalid",
  PROMOTIONAL: "the content violates Meta's policies (promotional)",
  SCAM: "the content violates Meta's policies (scam)",
  TAG_CONTENT_MISMATCH: "the content doesn't match the template's category",
};

/** Meta's template status as whatsapp_templates records it, with the reason a person sees when it can't be sent. */
export function mapMetaTemplateStatus(status: string, rejectedReason?: string | null, unsupported?: string | null): { status: MappedStatus; reason: string | null } {
  const s = status.toUpperCase();
  const why = rejectedReason && rejectedReason.toUpperCase() !== "NONE" ? REJECTION_LABELS[rejectedReason.toUpperCase()] ?? rejectedReason.toLowerCase().replace(/_/g, " ").slice(0, 60) : null;
  switch (s) {
    case "APPROVED":
      return unsupported ? { status: "rejected", reason: `Approved by Meta, but iAcquire can't send it yet: ${unsupported}` } : { status: "approved", reason: null };
    case "PENDING":
      return { status: "pending", reason: null };
    case "IN_APPEAL":
      return { status: "pending", reason: "Rejected by Meta; an appeal is under review." };
    case "PAUSED":
      return { status: "pending", reason: "Paused by Meta because of low quality. It can't be sent until Meta unpauses it." };
    case "REJECTED":
      return { status: "rejected", reason: why ? `Rejected by Meta: ${why}.` : "Rejected by Meta." };
    case "DISABLED":
      return { status: "rejected", reason: "Disabled by Meta after repeated low-quality pauses. Create a new template in WhatsApp Manager." };
    case "ARCHIVED":
      return { status: "rejected", reason: "Archived by Meta after a long time without use. Unarchive it in WhatsApp Manager to use it again." };
    case "LIMIT_EXCEEDED":
      return { status: "rejected", reason: "The WhatsApp Business Account has more templates than Meta allows." };
    case "PENDING_DELETION":
    case "DELETED":
      return { status: "rejected", reason: "Deleted in WhatsApp Manager." };
    default:
      return { status: "rejected", reason: `Meta reports the status "${s.replace(/[^A-Z_]/g, "").slice(0, 30)}", which can't be sent.` };
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const POSITIONAL = /\{\{\s*(\d{1,3})\s*\}\}/g;
const NAMED = /\{\{\s*([a-z_][a-z0-9_]{0,59})\s*\}\}/g;
const HAS_POSITIONAL = /\{\{\s*\d{1,3}\s*\}\}/;
const HAS_NAMED = /\{\{\s*[a-z_][a-z0-9_]{0,59}\s*\}\}/;
const SENDABLE_BUTTONS = new Set(["QUICK_REPLY", "PHONE_NUMBER", "URL", "VOICE_CALL"]);
const MAX_VARIABLES = 20;

function placeholders(text: string, named: boolean): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(named ? NAMED : POSITIONAL)) if (!found.includes(m[1])) found.push(m[1]);
  return named ? found : found.sort((a, b) => Number(a) - Number(b));
}

/**
 * The values a template needs, from its {{n}} (positional) or {{name}} (named) placeholders: the text header's first, then the body's.
 * The sender passes them in exactly this order. Meta's examples, when present, are added to the label to help people pick values.
 */
export function templateVariables(components: unknown[], parameterFormat?: string | null): WhatsappTemplateVariable[] {
  const header = components.map(obj).find((c) => str(c?.type)?.toUpperCase() === "HEADER" && (str(c?.format) ?? "TEXT").toUpperCase() === "TEXT");
  const body = components.map(obj).find((c) => str(c?.type)?.toUpperCase() === "BODY");
  const texts = [str(header?.text) ?? "", str(body?.text) ?? ""];
  const named = parameterFormat ? parameterFormat.toUpperCase() === "NAMED" : !texts.some((t) => HAS_POSITIONAL.test(t)) && texts.some((t) => HAS_NAMED.test(t));
  const out: WhatsappTemplateVariable[] = [];
  const add = (component: "header" | "body", source: Record<string, unknown> | undefined | null) => {
    const text = str(source?.text) ?? "";
    const example = obj(source?.example);
    const keys = placeholders(text, named);
    keys.forEach((key, i) => {
      let sample: string | null = null;
      if (named) {
        const list = arr(example?.[component === "header" ? "header_text_named_params" : "body_text_named_params"]);
        sample = str(obj(list.find((p) => str(obj(p)?.param_name) === key))?.example);
      } else {
        sample = component === "header" ? str(arr(example?.header_text)[i]) : str(arr(arr(example?.body_text)[0])[i]);
      }
      const base = named ? key : `{{${key}}}`;
      const label = `${component === "header" ? "Header " : ""}${base}${sample ? ` (e.g. ${sample.replace(/\s+/g, " ").trim().slice(0, 40)})` : ""}`;
      out.push({ position: out.length + 1, label: label.slice(0, 80), component, ...(named ? { name: key } : {}) });
    });
  };
  add("header", header);
  add("body", body);
  return out.slice(0, MAX_VARIABLES);
}

/** Why iAcquire can't send a template yet (it needs a media or location header, a button value, or a component type sent differently), or null. */
export function unsupportedReason(components: unknown[], variables: WhatsappTemplateVariable[]): string | null {
  if (!components.map(obj).some((c) => str(c?.type)?.toUpperCase() === "BODY")) return "it has no body text.";
  for (const raw of components) {
    const c = obj(raw);
    const type = (str(c?.type) ?? "").toUpperCase();
    if (type === "HEADER") {
      const format = (str(c?.format) ?? "TEXT").toUpperCase();
      if (format !== "TEXT") return `it has a ${format.toLowerCase()} header, which iAcquire can't attach.`;
    } else if (type === "BUTTONS") {
      for (const b of arr(c?.buttons)) {
        const button = obj(b);
        const bt = (str(button?.type) ?? "").toUpperCase();
        if (!SENDABLE_BUTTONS.has(bt)) return `it has a ${bt.toLowerCase().replace(/_/g, " ") || "special"} button, which needs a value iAcquire can't provide.`;
        if (bt === "URL" && /\{\{/.test(str(button?.url) ?? "")) return "it has a link button with a variable part, which iAcquire can't fill in yet.";
      }
    } else if (type !== "BODY" && type !== "FOOTER") {
      return `it uses a ${type.toLowerCase().replace(/_/g, " ") || "special"} component, which iAcquire can't send yet.`;
    }
  }
  if (variables.length >= MAX_VARIABLES) return `it needs more than ${MAX_VARIABLES - 1} values.`;
  // The dispatcher fills a template from the message text by its numbered body placeholders ({{1}}, {{2}} …): a value in the header or a
  // named value ({{first_name}}) has nowhere to come from, so the provider would refuse the message.
  if (variables.some((v) => v.name)) return "it uses named values like {{first_name}}; iAcquire fills in numbered values ({{1}}, {{2}}) only.";
  if (variables.some((v) => v.component === "header")) return "its header has a value to fill in, which iAcquire can't do yet.";
  return null;
}

/** The components kept with the row: structure and text only (examples and media handles are dropped), within the column's size limit. */
function storedComponents(components: unknown[]): unknown[] {
  const kept = components.slice(0, 10).flatMap((raw) => {
    const c = obj(raw);
    const type = str(c?.type);
    if (!c || !type) return [];
    return [{
      type: type.toUpperCase().slice(0, 40),
      ...(str(c.format) ? { format: str(c.format)!.toUpperCase().slice(0, 20) } : {}),
      ...(str(c.text) ? { text: str(c.text)!.slice(0, 1024) } : {}),
      ...(Array.isArray(c.buttons)
        ? {
            buttons: c.buttons.slice(0, 10).map((b) => {
              const o = obj(b) ?? {};
              return { type: (str(o.type) ?? "").toUpperCase().slice(0, 40), text: (str(o.text) ?? "").slice(0, 60), ...(str(o.url) ? { url: str(o.url)!.slice(0, 300) } : {}), ...(str(o.phone_number) ? { phone_number: str(o.phone_number)!.slice(0, 30) } : {}) };
            }),
          }
        : {}),
    }];
  });
  return JSON.stringify(kept).length <= 12000 ? kept : [];
}

const CATEGORY: Record<string, "marketing" | "utility" | "authentication"> = { MARKETING: "marketing", UTILITY: "utility", AUTHENTICATION: "authentication" };
const META_TEMPLATE_ID = /^[0-9]{1,40}$/;

export interface MappedTemplate {
  templateId: string;
  name: string;
  language: string;
  body: string;
  status: MappedStatus;
  category: "marketing" | "utility" | "authentication" | null;
  variables: WhatsappTemplateVariable[];
  components: unknown[];
  rejectionReason: string | null;
}

/** One template from GET /message_templates as a whatsapp_templates row, or the reason it can't be stored. */
export function mapMetaTemplate(raw: unknown): MappedTemplate | { skip: string } {
  const t = obj(raw);
  const id = str(t?.id);
  const name = str(t?.name);
  const language = str(t?.language);
  if (!t || !id || !META_TEMPLATE_ID.test(id)) return { skip: "no template id" };
  if (!name || name.length > 120 || !/^[a-z0-9_]+$/.test(name)) return { skip: "a name iAcquire can't store (over 120 characters or unexpected characters)" };
  if (!language || !/^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,4})?$/.test(language)) return { skip: "an unexpected language code" };
  const components = arr(t.components);
  const variables = templateVariables(components, str(t.parameter_format));
  const body = str(obj(components.map(obj).find((c) => str(c?.type)?.toUpperCase() === "BODY"))?.text) ?? "";
  const mapped = mapMetaTemplateStatus(str(t.status) ?? "", str(t.rejected_reason), unsupportedReason(components, variables));
  return {
    templateId: id,
    name,
    language,
    body: body.slice(0, 1024),
    status: mapped.status,
    category: CATEGORY[(str(t.category) ?? "").toUpperCase()] ?? null,
    variables,
    components: storedComponents(components),
    rejectionReason: mapped.reason?.slice(0, 300) ?? null,
  };
}

export type WhatsappTemplateSyncResult =
  | { ok: true; fetched: number; saved: number; skipped: number; retired: number; approved: number }
  | { ok: false; reason: "not_connected" | "credential_unavailable" | "reconnect_required" | "provider_error"; detail: string };

const RETIRED_REASON = "No longer in the WhatsApp Business Account (deleted in WhatsApp Manager, or a different account is connected now).";
const MAX_PAGES = 30;

/**
 * Reads every template of the workspace's connected WhatsApp Business Account and mirrors it into whatsapp_templates. Read-only towards
 * Meta. All pages are fetched before anything is written, so a partial read never marks templates as gone; the write is one transaction.
 */
export async function syncWhatsappTemplates(orgId: string): Promise<WhatsappTemplateSyncResult> {
  const { rows } = await withSystem((db) =>
    db.query<{ provider_account_id: string | null; credential_id: string | null }>(
      "select provider_account_id, credential_id from messaging_channels where org_id = $1 and channel = 'whatsapp' and provider = 'meta_whatsapp'",
      [orgId],
    ),
  );
  const ch = rows[0];
  if (!ch?.provider_account_id || !ch.credential_id || !/^[0-9]{5,25}$/.test(ch.provider_account_id)) {
    return { ok: false, reason: "not_connected", detail: "WhatsApp through Meta isn't connected for this workspace." };
  }
  const token = await resolveMetaWhatsappToken(ch.credential_id, orgId);
  if (!token) return { ok: false, reason: "credential_unavailable", detail: "The stored WhatsApp credential is missing, revoked or unreadable. Reconnect WhatsApp." };

  const fetched: unknown[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await metaGraph("GET", `${ch.provider_account_id}/message_templates`, token, {
      query: { fields: "id,name,language,status,category,components,rejected_reason,parameter_format", limit: "100", ...(after ? { after } : {}) },
      timeoutMs: 15000,
    });
    if (!res.reached) return { ok: false, reason: "provider_error", detail: "Meta could not be reached. Templates were not changed." };
    if (res.status !== 200) {
      const code = metaErrorCode(res.json);
      if (isMetaReconnectError(res.status, code)) return { ok: false, reason: "reconnect_required", detail: `${describeMetaError(code ?? 190)} Templates were not changed.` };
      return { ok: false, reason: "provider_error", detail: `Meta answered ${res.status} when listing templates. Templates were not changed.` };
    }
    fetched.push(...arr(res.json?.data));
    const paging = obj(res.json?.paging);
    after = str(obj(paging?.cursors)?.after);
    if (!after || !paging?.next) {
      after = null;
      break;
    }
  }
  // More pages than we read: the list is incomplete, so nothing may be marked as gone.
  const complete = after === null;

  const mapped = fetched.map(mapMetaTemplate);
  const keep = mapped.filter((m): m is MappedTemplate => !("skip" in m));
  return withSystem(async (db) => {
    let saved = 0;
    for (const t of keep) {
      const r = await db.query(
        `insert into whatsapp_templates (org_id, template_id, name, language, body, status, checked_at, provider, category, variables, components, rejection_reason)
         values ($1, $2, $3, $4, $5, $6, now(), 'meta_whatsapp', $7, $8::jsonb, $9::jsonb, $10)
         on conflict (org_id, template_id) do update set name = excluded.name, language = excluded.language, body = excluded.body, status = excluded.status,
           checked_at = excluded.checked_at, category = excluded.category, variables = excluded.variables, components = excluded.components, rejection_reason = excluded.rejection_reason
         where whatsapp_templates.provider = 'meta_whatsapp'
         returning template_id`,
        [orgId, t.templateId, t.name, t.language, t.body, t.status, t.category, JSON.stringify(t.variables), JSON.stringify(t.components), t.rejectionReason],
      );
      // A GoHighLevel template with the same id is never overwritten.
      if (r.rows[0]) saved++;
    }
    let retired = 0;
    if (complete) {
      const gone = await db.query(
        `update whatsapp_templates set status = 'rejected', rejection_reason = $3, checked_at = now()
         where org_id = $1 and provider = 'meta_whatsapp' and not (template_id = any($2::text[])) and (status <> 'rejected' or rejection_reason is distinct from $3)
         returning template_id`,
        [orgId, keep.map((t) => t.templateId), RETIRED_REASON],
      );
      retired = gone.rows.length;
    }
    return { ok: true as const, fetched: fetched.length, saved, skipped: mapped.length - keep.length + (keep.length - saved), retired, approved: keep.filter((t) => t.status === "approved").length };
  });
}

/** Scheduled sync for every workspace that sends WhatsApp through Meta. One failure never stops the others; nothing secret is logged. */
export async function syncAllWhatsappTemplates(): Promise<{ synced: number; failed: number }> {
  const { rows } = await withSystem((db) =>
    db.query<{ org_id: string }>("select org_id from messaging_channels where channel = 'whatsapp' and provider = 'meta_whatsapp' and credential_id is not null and provider_account_id is not null order by org_id"),
  );
  let synced = 0;
  let failed = 0;
  for (const { org_id } of rows) {
    try {
      const r = await syncWhatsappTemplates(org_id);
      if (r.ok) synced++;
      else {
        failed++;
        console.warn("[iacquire] whatsapp template sync did not complete", { reason: r.reason });
      }
    } catch (err) {
      failed++;
      console.error("[iacquire] whatsapp template sync failed", { type: err instanceof Error ? err.name : "unknown" });
    }
  }
  return { synced, failed };
}

/**
 * Template events after which the template can't be sent. APPROVED, UNARCHIVED, REINSTATED, FLAGGED (at risk, still sendable) and LOCKED
 * (can't be edited, still sendable) never downgrade anything; they and any event Meta adds later only trigger a full sync.
 */
const UNSENDABLE_EVENTS = new Set(["ARCHIVED", "DELETED", "DISABLED", "IN_APPEAL", "LIMIT_EXCEEDED", "PAUSED", "PENDING", "PENDING_DELETION", "REJECTED"]);

/**
 * A message_template_status_update webhook. A change that makes a template unsendable (paused, rejected, disabled, archived, deleted …) is
 * applied at once to every workspace whose WhatsApp channel uses that WhatsApp Business Account, so nothing is sent with it in the meantime.
 * An approval is not trusted on its own (the webhook carries no components, and an edited template may have changed): those workspaces are
 * returned for a full sync instead. The signature was verified by the caller; workspaces come only from our own channel records.
 */
export async function applyTemplateStatusEvent(
  db: Queryable,
  input: { accountId: string | null; value: Record<string, unknown>; entryTime: number | null },
): Promise<{ outcome: "processed" | "duplicate" | "ignored"; detail: string; orgIds: string[] }> {
  const templateId = typeof input.value.message_template_id === "number" || typeof input.value.message_template_id === "string" ? String(input.value.message_template_id) : "";
  const event = (str(input.value.event) ?? "").toUpperCase().replace(/[^A-Z_]/g, "").slice(0, 40);
  if (!input.accountId || !/^[0-9]{5,25}$/.test(input.accountId) || !META_TEMPLATE_ID.test(templateId) || !event) return { outcome: "ignored", detail: "Incomplete template event.", orgIds: [] };
  const { rows } = await db.query<{ org_id: string }>("select org_id from messaging_channels where channel = 'whatsapp' and provider = 'meta_whatsapp' and provider_account_id = $1", [input.accountId]);
  const orgIds = rows.map((r) => r.org_id);
  if (!orgIds.length) return { outcome: "ignored", detail: "The WhatsApp Business Account isn't connected to a workspace.", orgIds: [] };
  const externalId = `template:${templateId}:${event}:${input.entryTime ?? "0"}`;
  const receipt = await db.query("insert into webhook_receipts (provider, external_id, kind, org_id) values ('meta_whatsapp', $1, 'whatsapp.template', $2) on conflict do nothing returning external_id", [externalId, orgIds.length === 1 ? orgIds[0] : null]);
  if (!receipt.rows[0]) return { outcome: "duplicate", detail: "Already handled.", orgIds: [] };
  let detail = `Template ${event.toLowerCase()}: a full sync follows.`;
  if (UNSENDABLE_EVENTS.has(event)) {
    const mapped = mapMetaTemplateStatus(event, str(input.value.reason));
    if (mapped.status !== "approved") {
      const r = await db.query(
        "update whatsapp_templates set status = $3, rejection_reason = $4, checked_at = now() where org_id = any($1::uuid[]) and template_id = $2 and provider = 'meta_whatsapp' returning org_id",
        [orgIds, templateId, mapped.status, mapped.reason],
      );
      detail = `Template ${event.toLowerCase()}: ${r.rows.length} row${r.rows.length === 1 ? "" : "s"} marked not sendable.`;
    }
  }
  await db.query("update webhook_receipts set outcome = 'processed', detail = $2 where provider = 'meta_whatsapp' and external_id = $1", [externalId, detail.slice(0, 300)]);
  return { outcome: "processed", detail, orgIds };
}
