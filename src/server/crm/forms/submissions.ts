import "server-only";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, crmWrite, type CrmActor } from "@/server/crm/actor";
import { ATTRIBUTION_LABELS, formatAnswer, type Attribution } from "@/lib/crm/forms/logic";
import type { AnswerValue, Answers, FormQuestion, QuestionType } from "@/lib/crm/forms/spec";
import { UUID } from "@/server/crm/forms/store";

// Submissions as the team reads them: the answers against the exact version that was answered, the attribution the visit actually
// carried, the consent wording agreed to, how processing went, and the contact and deal it led to. Reading follows the row-level
// security rule (people who may see contacts); retrying and marking spam change what happens to a person's details, so they need
// "edit contacts".

export type SubmissionStatus = "received" | "processed" | "failed" | "spam";
export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = ["received", "processed", "failed", "spam"];
export type SubmissionSource = "website" | "hosted" | "api" | "import";

export interface SubmissionAnswerView {
  key: string;
  label: string;
  type: QuestionType;
  /** The answer in words (choice labels, Yes/No). */
  text: string;
  /** A hidden attribution field. */
  hidden: boolean;
}

export interface FormSubmissionView {
  id: string;
  formId: string;
  formName: string;
  version: number;
  source: SubmissionSource;
  host: string | null;
  pageSlug: string | null;
  answers: SubmissionAnswerView[];
  attribution: Array<{ key: string; label: string; value: string }>;
  consentText: string | null;
  marketingOptIn: boolean;
  marketingText: string | null;
  status: SubmissionStatus;
  attempts: number;
  /** Why it failed or was set aside, or a note about something processing couldn't do (a field that no longer exists). */
  note: string | null;
  contact: { id: string; name: string } | null;
  opportunity: { id: string; name: string } | null;
  createdAt: string;
  processedAt: string | null;
}

export interface SubmissionPage {
  rows: FormSubmissionView[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<SubmissionStatus, number>;
}

interface Row {
  id: string; form_id: string; form_name: string; version: number; fields: FormQuestion[]; source: SubmissionSource; host: string | null; page_slug: string | null;
  answers: Answers; attribution: Attribution; consent_text: string | null; marketing_opt_in: boolean; marketing_text: string | null; status: SubmissionStatus; attempts: number;
  error: string | null; contact_id: string | null; contact_name: string | null; opportunity_id: string | null; opportunity_name: string | null; created_at: Date; processed_at: Date | null;
}

const SELECT = `
  select s.id, s.form_id, f.name as form_name, v.version, v.fields, s.source, s.host, s.page_slug, s.answers, s.attribution, s.consent_text, s.marketing_opt_in, s.marketing_text,
         s.status, s.attempts, s.error, s.contact_id, c.display_name as contact_name, s.opportunity_id, o.name as opportunity_name, s.created_at, s.processed_at
  from crm_form_submissions s
  join crm_forms f on f.id = s.form_id and f.org_id = s.org_id
  join crm_form_versions v on v.id = s.version_id and v.org_id = s.org_id
  left join contacts c on c.id = s.contact_id and c.org_id = s.org_id and c.deleted_at is null
  left join crm_opportunities o on o.id = s.opportunity_id and o.org_id = s.org_id`;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/** A stored submission as the team reads it. Answers keep the version's order; an answer to a question the version lacks is still shown. */
export function toSubmissionView(r: Row): FormSubmissionView {
  const answers: SubmissionAnswerView[] = [];
  const seen = new Set<string>();
  for (const q of r.fields ?? []) {
    const v = r.answers?.[q.key] as AnswerValue | undefined;
    seen.add(q.key);
    if (v === undefined) continue;
    answers.push({ key: q.key, label: q.label, type: q.type, text: formatAnswer(q, v), hidden: q.type === "hidden" });
  }
  for (const [key, v] of Object.entries(r.answers ?? {})) if (!seen.has(key)) answers.push({ key, label: key, type: "short_text", text: formatAnswer(undefined, v as AnswerValue), hidden: false });
  const attribution = Object.entries(r.attribution ?? {})
    .filter(([, v]) => typeof v === "string" && v)
    .map(([key, value]) => ({ key, label: ATTRIBUTION_LABELS[key as keyof Attribution] ?? key, value: String(value) }));
  return {
    id: r.id, formId: r.form_id, formName: r.form_name, version: r.version, source: r.source, host: r.host, pageSlug: r.page_slug, answers, attribution,
    consentText: r.consent_text, marketingOptIn: r.marketing_opt_in, marketingText: r.marketing_text, status: r.status, attempts: r.attempts, note: r.error,
    contact: r.contact_id && r.contact_name !== null ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null,
    opportunity: r.opportunity_id && r.opportunity_name !== null ? { id: r.opportunity_id, name: r.opportunity_name } : null,
    createdAt: iso(r.created_at)!, processedAt: iso(r.processed_at),
  };
}

export interface SubmissionQuery {
  formId?: string | null;
  status?: SubmissionStatus | "all";
  contactId?: string | null;
  page?: number;
  pageSize?: number;
}

export async function listFormSubmissions(actor: CrmActor, q: SubmissionQuery = {}): Promise<SubmissionPage> {
  assertCan(actor, "contacts.view", "Submissions contain people's details, so they need permission to see contacts.");
  if (q.formId && !UUID.test(q.formId)) throw new AppError("not_found", "Form not found.");
  if (q.contactId && !UUID.test(q.contactId)) throw new AppError("not_found", "Contact not found.");
  const pageSize = Math.min(100, Math.max(5, Math.floor(q.pageSize ?? 25)));
  const page = Math.max(1, Math.floor(q.page ?? 1));
  const status = q.status && q.status !== "all" && SUBMISSION_STATUSES.includes(q.status) ? q.status : null;
  return crmRead(actor, async (db) => {
    const where = "s.org_id = $1 and ($2::uuid is null or s.form_id = $2) and ($3::uuid is null or s.contact_id = $3)";
    const params = [actor.orgId, q.formId ?? null, q.contactId ?? null];
    const counts = await db.query<{ status: SubmissionStatus; n: string }>(`select s.status, count(*)::text as n from crm_form_submissions s where ${where} group by s.status`, params);
    const byStatus = Object.fromEntries(SUBMISSION_STATUSES.map((st) => [st, 0])) as Record<SubmissionStatus, number>;
    for (const c of counts.rows) byStatus[c.status] = Number(c.n);
    const total = status ? byStatus[status] : Object.values(byStatus).reduce((a, b) => a + b, 0);
    const { rows } = await db.query<Row>(
      `${SELECT} where ${where} and ($4::text is null or s.status = $4) order by s.created_at desc, s.id limit $5 offset $6`,
      [...params, status, pageSize, (page - 1) * pageSize],
    );
    return { rows: rows.map(toSubmissionView), total, page, pageSize, counts: byStatus };
  });
}

export async function getFormSubmission(actor: CrmActor, id: string): Promise<FormSubmissionView> {
  assertCan(actor, "contacts.view", "Submissions contain people's details, so they need permission to see contacts.");
  if (!UUID.test(id)) throw new AppError("not_found", "Submission not found.");
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(`${SELECT} where s.id = $1 and s.org_id = $2`, [id, actor.orgId]);
    if (!rows[0]) throw new AppError("not_found", "Submission not found.");
    return toSubmissionView(rows[0]);
  });
}

async function changeStatus(actor: CrmActor, id: string, from: SubmissionStatus[], sql: string, action: string, missing: string): Promise<void> {
  assertCan(actor, "contacts.edit", "Changing what happens to a submission needs permission to edit contacts.");
  if (!UUID.test(id)) throw new AppError("not_found", "Submission not found.");
  await crmWrite(actor, async (db) => {
    const cur = await db.query<{ status: SubmissionStatus }>("select status from crm_form_submissions where id = $1 and org_id = $2 for update", [id, actor.orgId]);
    if (!cur.rows[0]) throw new AppError("not_found", "Submission not found.");
    if (!from.includes(cur.rows[0].status)) throw new AppError("conflict", missing);
    await db.query(`update crm_form_submissions set ${sql} where id = $1 and org_id = $2`, [id, actor.orgId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action, targetType: "crm_form_submission", targetId: id, result: "success", metadata: { from: cur.rows[0].status } }, db);
  });
}

/** Puts a failed submission back in the queue: the next scheduler run processes it again (a contact and deal are never made twice). */
export function retryFormSubmission(actor: CrmActor, id: string): Promise<void> {
  return changeStatus(actor, id, ["failed"], "status = 'received', attempts = 0, error = null, processed_at = null", "crm.form_submission_retried", "Only a submission that failed can be tried again.");
}

/** Sets a submission aside as spam. One that was already processed keeps the contact it made (remove that contact separately if needed). */
export function markSubmissionSpam(actor: CrmActor, id: string): Promise<void> {
  return changeStatus(actor, id, ["received", "failed", "processed"], "status = 'spam', spam_cleared = false, error = 'Marked as spam by your team.', processed_at = coalesce(processed_at, now())", "crm.form_submission_marked_spam", "This submission is already marked as spam.");
}

/**
 * A submission set aside as spam that is really from a person: it goes back in the queue and is processed like any other. The decision is
 * recorded (spam_cleared), so the automatic spam check never sets it aside again.
 */
export function markSubmissionNotSpam(actor: CrmActor, id: string): Promise<void> {
  return changeStatus(actor, id, ["spam"], "spam_cleared = true, status = case when contact_id is null then 'received' else 'processed' end, processed_at = case when contact_id is null then null else processed_at end, attempts = 0, error = null", "crm.form_submission_not_spam", "This submission isn't marked as spam.");
}
