import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

// Migration 0094 (reputation follow-through): what it adds, what its constraints refuse, that its backfill only sets the derived flag, and that its rollback runs on an unused
// database and refuses once a survey answer, an escalation, an acknowledgement, a resolution or a reputation notice exists. Every case runs inside a transaction that is
// always rolled back, so the shared test database is untouched. (The same migration is also rehearsed on a populated database by scripts/rehearse-combined-migrations.mjs.)

class Done extends Error {}
const up = readFileSync("supabase/migrations/0094_reputation_followthrough.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0094_reputation_followthrough.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const NEW_KINDS = ["feedback_follow_up_overdue", "review_needs_reply", "review_reply_requested", "review_reply_decided", "review_reply_failed", "review_connection_attention"];

/** Runs fn in a savepoint and says whether the statement was accepted (the savepoint is always rolled back). */
async function accepted(db: Db, sql: string, params: unknown[] = []): Promise<{ ok: boolean; message: string }> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: String((e as Error).message) };
  } finally {
    await db.query("rollback to savepoint probe");
  }
}

async function world() {
  const org = await createOrg({ name: "Migration Reputation Co" });
  const other = await createOrg({ name: "Other Migration Reputation Co" });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, other, owner };
}

/** A contact and a review request in the workspace (plain rows, the way the migration's tables see them). */
async function seed(db: Db, orgId: string) {
  const contact = (await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Migration Customer') returning id", [orgId])).rows[0].id;
  const request = (await db.query<{ id: string }>(
    "insert into crm_review_requests (org_id, contact_id, channel, token_hash, status, expires_at) values ($1, $2, 'sms', md5(gen_random_uuid()::text) || md5(gen_random_uuid()::text), 'sent', now() + interval '60 days') returning id", [orgId, contact])).rows[0].id;
  const task = (await db.query<{ id: string }>("insert into tasks (org_id, title, category, status, source) values ($1, 'Follow up', 'crm', 'open', 'system') returning id", [orgId])).rows[0].id;
  return { contact, request, task };
}

/** A survey form's submission by this contact, in this workspace (what a survey answer can be tied to). */
async function submissionFor(db: Db, orgId: string, contact: string, tag: string): Promise<string> {
  const form = (await db.query<{ id: string }>("insert into crm_forms (org_id, key, name, kind, purpose) values ($1, $2, 'Survey', 'survey', 'survey') returning id", [orgId, `mig-${tag}`])).rows[0].id;
  const version = (await db.query<{ id: string }>("insert into crm_form_versions (org_id, form_id, version, fields, content_hash) values ($1, $2, 1, '[]'::jsonb, repeat('a', 64)) returning id", [orgId, form])).rows[0].id;
  return (await db.query<{ id: string }>(
    "insert into crm_form_submissions (org_id, form_id, version_id, source, answers, dedupe_key, contact_id) values ($1, $2, $3, 'hosted', '{}'::jsonb, $4, $5) returning id", [orgId, form, version, `mig-${tag}-submission`, contact])).rows[0].id;
}
const SURVEY_ANSWER = "insert into customer_feedback (org_id, contact_id, source, scale, rating, form_submission_id) values ($1, $2, $3, 'csat5', 4, $4)";

const FEEDBACK = "insert into customer_feedback (org_id, contact_id, review_request_id, source, rating, nps_score, scale, comment, low_score, follow_up_status, escalated_task_id, resolved_at, escalation_id, acknowledged_at) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)";
const feedbackWith = (orgId: string, x: { contact: string; request: string }, o: Partial<{ source: string; rating: number | null; nps: number | null; scale: string; comment: string | null; low: boolean; status: string; task: string | null; resolvedAt: string | null; escalation: string | null; ackAt: string | null }>) => [
  orgId, x.contact, x.request, o.source ?? "review_request", o.rating === undefined ? 4 : o.rating, o.nps ?? null, o.scale ?? "csat5", o.comment === undefined ? null : o.comment, o.low ?? false, o.status ?? "new", o.task ?? null, o.resolvedAt ?? null, o.escalation ?? null, o.ackAt ?? null,
];

describe("migration 0094: what it adds", () => {
  it("adds the columns with the defaults the earlier rows need, and a settings table that starts empty", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const cols = async (table: string) => Object.fromEntries((await db.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
        "select column_name, column_default, is_nullable from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((r) => [r.column_name, r]));
      const f = await cols("customer_feedback");
      for (const c of ["scale", "nps_score", "low_score", "escalation_id", "acknowledged_at", "acknowledged_by", "resolved_at", "resolved_by", "resolution_note", "sla_notified_at", "form_submission_id"]) expect(f[c], c).toBeDefined();
      expect(f.scale).toMatchObject({ column_default: "'csat5'::text", is_nullable: "NO" });
      expect(f.low_score).toMatchObject({ column_default: "false", is_nullable: "NO" });
      const r = await cols("crm_review_requests");
      expect(r.kind).toMatchObject({ column_default: "'review'::text", is_nullable: "NO" });
      expect(r.scale).toMatchObject({ column_default: "'csat5'::text", is_nullable: "NO" });
      expect(Object.keys(await cols("reputation_settings")).sort()).toEqual([
        "acknowledge_within_hours", "ai_replies_enabled", "escalate_at_or_below", "nps_detractor_max", "org_id", "outcome_nudges_enabled", "public_review_alert_at_or_below", "reply_style_note", "sla_reminders_enabled", "updated_at", "updated_by", "version",
      ]);
      expect((await db.query("select 1 from reputation_settings where org_id = $1", [w.org.id])).rows).toHaveLength(0);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("refuses answers that make no sense, and accepts the ones the follow-up writes", async () => {
    const w = await world();
    const other = await world();
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      const y = await seed(db, other.org.id);
      const esc = (await db.query<{ id: string }>(
        "insert into conversations (org_id, contact_id, channel) values ($1, $2, 'sms') returning id", [other.org.id, y.contact])).rows[0].id;
      const foreignEscalation = (await db.query<{ id: string }>(
        "insert into human_escalations (org_id, conversation_id, contact_id, category, urgency, summary) values ($1, $2, $3, 'complaint', 'urgent', 'x') returning id", [other.org.id, esc, y.contact])).rows[0].id;
      const ins = (o: Parameters<typeof feedbackWith>[2]) => accepted(db, FEEDBACK, feedbackWith(w.org.id, x, o));

      expect((await ins({ rating: 2, low: true, status: "escalated", task: x.task })).ok).toBe(true);
      expect((await ins({ scale: "nps10", rating: null, nps: 6, low: true })).ok).toBe(true);
      expect((await ins({ rating: null, comment: "Only a comment." })).ok).toBe(true);
      expect((await ins({ source: "manual", rating: null, comment: null })).ok).toBe(true); // hand-recorded feedback from before is exempt
      expect((await ins({ status: "resolved", resolvedAt: new Date().toISOString() })).ok).toBe(true);

      for (const [what, o, re] of [
        ["a zero-to-ten score above ten", { scale: "nps10", rating: null, nps: 11 }, /nps_score|check/],
        ["a zero-to-ten score on the five-star scale", { nps: 5 }, /customer_feedback_nps_scale_check/],
        ["a star rating on the zero-to-ten scale", { scale: "nps10", rating: 3, nps: 5 }, /customer_feedback_csat_scale_check/],
        ["an unknown scale", { scale: "stars" }, /scale/],
        ["an answer from a customer that says nothing", { rating: null, comment: null }, /customer_feedback_has_content_check/],
        ["a resolution time on an item that is not resolved", { status: "new", resolvedAt: new Date().toISOString() }, /customer_feedback_resolved_check/],
        ["another workspace's escalation", { escalation: foreignEscalation }, /customer_feedback_escalation_fk|foreign key/],
      ] as const) {
        const r = await ins(o);
        expect(r.ok, what).toBe(false);
        expect(r.message, what).toMatch(re);
      }
      await db.query(FEEDBACK, feedbackWith(w.org.id, x, { rating: 3 }));
      expect((await accepted(db, "update customer_feedback set resolution_note = $2 where org_id = $1", [w.org.id, "x".repeat(601)])).ok, "a resolution note over 600 characters").toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("ties a survey answer to one submission of its own workspace, only once, and lets the answer outlive the submission", async () => {
    const w = await world();
    const other = await world();
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      const y = await seed(db, other.org.id);
      const mine = await submissionFor(db, w.org.id, x.contact, "a");
      const theirs = await submissionFor(db, other.org.id, y.contact, "b");
      expect((await accepted(db, SURVEY_ANSWER, [w.org.id, x.contact, "survey", mine])).ok).toBe(true);
      // Only a survey's answer comes from a submission; a submission of another workspace can't be named.
      const notSurvey = await accepted(db, SURVEY_ANSWER, [w.org.id, x.contact, "review_request", mine]);
      expect(notSurvey.ok).toBe(false);
      expect(notSurvey.message).toMatch(/customer_feedback_submission_source_check/);
      const foreign = await accepted(db, SURVEY_ANSWER, [w.org.id, x.contact, "survey", theirs]);
      expect(foreign.ok).toBe(false);
      expect(foreign.message).toMatch(/customer_feedback_submission_fk|foreign key/);
      // One submission makes at most one answer; an answer from nobody (no contact) is allowed.
      await db.query(SURVEY_ANSWER, [w.org.id, x.contact, "survey", mine]);
      const twice = await accepted(db, SURVEY_ANSWER, [w.org.id, x.contact, "survey", mine]);
      expect(twice.ok).toBe(false);
      expect(twice.message).toMatch(/customer_feedback_submission_idx|duplicate key/);
      expect((await accepted(db, SURVEY_ANSWER, [w.org.id, null, "survey", null])).ok).toBe(true);
      // Removing the submission keeps the answer (it is a count) and forgets the link.
      await db.query("delete from crm_form_submissions where id = $1", [mine]);
      expect((await db.query<{ n: string }>("select count(*)::text as n from customer_feedback where org_id = $1 and form_submission_id is null and source = 'survey'", [w.org.id])).rows[0].n).toBe("1");
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("sets the low flag for feedback the old rule had already escalated, and for nothing else", async () => {
    const w = await world();
    const backfill = statements(up).find((s) => /^update customer_feedback set low_score = true/i.test(s));
    expect(backfill).toBeTruthy();
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      const escalated = (await db.query<{ id: string }>(`${FEEDBACK} returning id`, feedbackWith(w.org.id, x, { rating: 1, status: "escalated", task: x.task }))).rows[0].id;
      const plain = (await db.query<{ id: string }>(`${FEEDBACK} returning id`, feedbackWith(w.org.id, x, { rating: 5 }))).rows[0].id;
      await db.query(backfill!);
      const low = async (id: string) => (await db.query<{ low_score: boolean }>("select low_score from customer_feedback where id = $1", [id])).rows[0].low_score;
      expect(await low(escalated)).toBe(true);
      expect(await low(plain)).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("widens where a request can start from, adds the kind and scale, and keeps the token hash out of the application role's reach", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      for (const via of ["manual", "workflow", "api", "program", "batch"]) {
        expect((await accepted(db, "update crm_review_requests set requested_via = $2 where id = $1", [x.request, via])).ok, via).toBe(true);
      }
      expect((await accepted(db, "update crm_review_requests set requested_via = 'carrier_pigeon' where id = $1", [x.request])).ok).toBe(false);
      expect((await accepted(db, "update crm_review_requests set kind = 'survey', scale = 'nps10' where id = $1", [x.request])).ok).toBe(true);
      expect((await accepted(db, "update crm_review_requests set kind = 'poll' where id = $1", [x.request])).ok).toBe(false);
      expect((await accepted(db, "update crm_review_requests set scale = 'stars' where id = $1", [x.request])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    // The application role reads the new columns and still cannot read the hash.
    const readable = await withUser(w.owner.id, (db) => db.query("select kind, scale, status from crm_review_requests limit 1"));
    expect(readable.rows).toBeDefined();
    await expect(withUser(w.owner.id, (db) => db.query("select token_hash from crm_review_requests limit 1"))).rejects.toThrow(/permission denied/);
  });

  it("refuses settings outside their ranges at the database too, and takes all six reputation notice kinds beside every earlier one", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const bad: Array<[string, string]> = [["escalate_at_or_below", "0"], ["escalate_at_or_below", "4"], ["nps_detractor_max", "3"], ["nps_detractor_max", "8"], ["acknowledge_within_hours", "0"],
        ["acknowledge_within_hours", "169"], ["public_review_alert_at_or_below", "5"]];
      for (const [col, v] of bad) expect((await accepted(db, `insert into reputation_settings (org_id, ${col}) values ($1, ${v})`, [w.org.id])).ok, `${col}=${v}`).toBe(false);
      expect((await accepted(db, "insert into reputation_settings (org_id, reply_style_note) values ($1, $2)", [w.org.id, "x".repeat(601)])).ok).toBe(false);
      expect((await accepted(db, "insert into reputation_settings (org_id, escalate_at_or_below, nps_detractor_max, acknowledge_within_hours) values ($1, 3, 7, 168)", [w.org.id])).ok).toBe(true);
      for (const kind of [...NEW_KINDS, "retention_attention", "social_post_failed", "booking_needs_action", "system"]) {
        expect((await accepted(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, $3, 'x')", [w.org.id, w.owner.id, kind])).ok, kind).toBe(true);
      }
      expect((await accepted(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'not_a_kind', 'x')", [w.org.id, w.owner.id])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("migration 0094: review request batches", () => {
  const CRITERIA = { source: "appointments_showed", from: "2026-10-01", to: "2026-10-31" };
  const INSERT = "insert into review_request_batches (org_id, name, channel, criteria) values ($1, $2, 'sms', $3::jsonb) returning id";
  const insertBatch = async (db: Db, orgId: string, criteria: unknown = CRITERIA) => (await db.query<{ id: string }>(INSERT, [orgId, "Test batch", JSON.stringify(criteria)])).rows[0].id;

  it("adds the two tables and the request's batch link, with row-level security on and nothing but SELECT for the application role", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const cols = async (table: string) => (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((r) => r.column_name).sort();
      expect(await cols("review_request_batches")).toEqual([
        "approval_id", "approved_at", "approved_binding", "approved_by", "approved_hash", "cancelled_by", "channel", "completed_at", "counts", "created_at", "created_by", "criteria", "estimate", "id", "kind", "name",
        "org_id", "rate_per_minute", "requested_at", "requested_by", "scale", "started_at", "status", "template_id", "updated_at",
      ]);
      expect(await cols("review_request_batch_items")).toEqual(["appointment_id", "batch_id", "contact_id", "fact_at", "opportunity_id", "org_id", "queued_at", "reason", "request_id", "status", "updated_at"]);
      expect(await cols("crm_review_requests")).toContain("batch_id");
      const rls = (await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname in ('review_request_batches', 'review_request_batch_items')")).rows;
      expect(rls.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual([["review_request_batch_items", true], ["review_request_batches", true]]);
      const grants = (await db.query<{ table_name: string; privilege_type: string }>(
        "select table_name, privilege_type from information_schema.role_table_grants where grantee = 'iaq_app_user' and table_name in ('review_request_batches', 'review_request_batch_items') order by 1, 2")).rows;
      expect(grants.map((g) => `${g.table_name}:${g.privilege_type}`)).toEqual(["review_request_batch_items:SELECT", "review_request_batches:SELECT"]);
      const noPublic = await db.query("select 1 from information_schema.role_table_grants where grantee in ('anon', 'authenticated', 'PUBLIC') and table_name in ('review_request_batches', 'review_request_batch_items')");
      expect(noPublic.rows).toHaveLength(0);
      await insertBatch(db, w.org.id);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    await expect(withUser(w.owner.id, (db) => db.query("insert into review_request_batches (org_id, name, channel, criteria) values ($1, 'x', 'sms', $2::jsonb)", [w.org.id, JSON.stringify(CRITERIA)]))).rejects.toThrow(/permission denied/);
    await expect(withUser(w.owner.id, (db) => db.query("select token_hash from crm_review_requests limit 1"))).rejects.toThrow(/permission denied/);
    expect((await withUser(w.owner.id, (db) => db.query("select batch_id from crm_review_requests limit 1"))).rows).toBeDefined();
  });

  it("can't hold criteria that name how a customer felt, or anything but a completed service and where it happened: the column refuses it", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const tries = (criteria: unknown) => accepted(db, INSERT, [w.org.id, "t", JSON.stringify(criteria)]);
      for (const source of ["appointments_showed", "deals_won", "customers_since"]) expect((await tries({ ...CRITERIA, source })).ok, source).toBe(true);
      expect((await tries({ ...CRITERIA, calendarIds: ["0b5f9c1e-7a52-4a0e-9a1d-2f4f2f6f1a11"], appointmentTypeIds: [], pipelineId: "x" })).ok).toBe(true);
      for (const key of ["rating", "nps", "nps_score", "score", "sentiment", "feedback", "follow_up_status", "low_score", "escalated", "complaint", "lead_score", "tag", "minRating", "status"]) {
        const r = await tries({ ...CRITERIA, [key]: 5 });
        expect(r.ok, key).toBe(false);
        expect(r.message, key).toMatch(/check/);
      }
      expect((await tries({ from: "2026-10-01", to: "2026-10-31" })).ok, "no service named").toBe(false);
      expect((await tries({ ...CRITERIA, source: "happy_customers" })).ok, "an unknown service").toBe(false);
      expect((await tries([CRITERIA])).ok, "not an object").toBe(false);
      expect((await tries({ ...CRITERIA, calendarIds: ["x".repeat(5000)] })).ok, "oversized").toBe(false);
      // The same check holds when an existing batch is updated.
      const id = await insertBatch(db, w.org.id);
      expect((await accepted(db, "update review_request_batches set criteria = criteria || '{\"rating\": 5}'::jsonb where id = $1", [id])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("keeps the pace, the status and an approval consistent", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const id = await insertBatch(db, w.org.id);
      for (const [what, sql, ok] of [
        ["a pace of 1", "update review_request_batches set rate_per_minute = 1 where id = $1", true],
        ["a pace of 60", "update review_request_batches set rate_per_minute = 60 where id = $1", true],
        ["a pace of 0", "update review_request_batches set rate_per_minute = 0 where id = $1", false],
        ["a pace of 61", "update review_request_batches set rate_per_minute = 61 where id = $1", false],
        ["an unknown status", "update review_request_batches set status = 'running' where id = $1", false],
        ["an unknown kind", "update review_request_batches set kind = 'poll' where id = $1", false],
        ["an unknown scale", "update review_request_batches set scale = 'stars' where id = $1", false],
        ["an unknown channel", "update review_request_batches set channel = 'fax' where id = $1", false],
        ["an empty name", "update review_request_batches set name = '   ' where id = $1", false],
        ["a name over 120 characters", `update review_request_batches set name = '${"x".repeat(121)}' where id = $1`, false],
        ["sending without an approval", "update review_request_batches set status = 'sending' where id = $1", false],
        ["a hash with no binding", `update review_request_batches set approved_hash = repeat('a', 64) where id = $1`, false],
        ["a binding with no hash", `update review_request_batches set approved_binding = '{}'::jsonb where id = $1`, false],
        ["an approval that is not a sha256", `update review_request_batches set approved_hash = 'abc', approved_binding = '{}'::jsonb where id = $1`, false],
        ["an approved batch", `update review_request_batches set status = 'approved', approved_hash = repeat('a', 64), approved_binding = '{"v":1}'::jsonb where id = $1`, true],
        ["a stopped batch with no approval", "update review_request_batches set status = 'stopped' where id = $1", true],
      ] as const) {
        expect((await accepted(db, sql, [id])).ok, what).toBe(ok);
      }
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("belongs to one workspace: a batch can't use another's template, a customer row can't name another's contact, and a request can't claim another's batch", async () => {
    const w = await world();
    const other = await world();
    await expect(withSystem(async (db) => {
      const mine = await seed(db, w.org.id);
      const theirs = await seed(db, other.org.id);
      const template = async (orgId: string, key: string) => (await db.query<{ id: string }>("insert into crm_message_templates (org_id, key, name, channel) values ($1, $2, 'T', 'sms') returning id", [orgId, key])).rows[0].id;
      const ownTemplate = await template(w.org.id, "own-template");
      const foreignTemplate = await template(other.org.id, "foreign-template");
      const batch = await insertBatch(db, w.org.id);
      const foreignBatch = await insertBatch(db, other.org.id);
      expect((await accepted(db, "update review_request_batches set template_id = $2 where id = $1", [batch, ownTemplate])).ok).toBe(true);
      const t = await accepted(db, "update review_request_batches set template_id = $2 where id = $1", [batch, foreignTemplate]);
      expect(t.ok).toBe(false);
      expect(t.message).toMatch(/foreign key/);
      const ITEM = "insert into review_request_batch_items (org_id, batch_id, contact_id) values ($1, $2, $3)";
      expect((await accepted(db, ITEM, [w.org.id, batch, mine.contact])).ok).toBe(true);
      for (const [what, args] of [["another workspace's contact", [w.org.id, batch, theirs.contact]], ["another workspace's batch", [w.org.id, foreignBatch, mine.contact]]] as const) {
        const r = await accepted(db, ITEM, [...args]);
        expect(r.ok, what).toBe(false);
        expect(r.message, what).toMatch(/foreign key/);
      }
      const claim = await accepted(db, "update crm_review_requests set batch_id = $2 where id = $1", [mine.request, foreignBatch]);
      expect(claim.ok).toBe(false);
      expect(claim.message).toMatch(/crm_review_requests_batch_fk|foreign key/);
      // One row per customer in a batch.
      await db.query(ITEM, [w.org.id, batch, mine.contact]);
      const twice = await accepted(db, ITEM, [w.org.id, batch, mine.contact]);
      expect(twice.ok).toBe(false);
      expect(twice.message).toMatch(/duplicate key|pkey/);
      expect((await accepted(db, "update review_request_batch_items set status = 'sent' where batch_id = $1", [batch])).ok).toBe(false);
      expect((await accepted(db, "update review_request_batch_items set reason = $2 where batch_id = $1", [batch, "x".repeat(121)])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("takes a batch's customer rows with it, keeps the requests it made (forgetting the link), and takes a customer's rows with the customer", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      const batch = await insertBatch(db, w.org.id);
      await db.query("insert into review_request_batch_items (org_id, batch_id, contact_id, status, request_id) values ($1, $2, $3, 'queued', $4)", [w.org.id, batch, x.contact, x.request]);
      await db.query("update crm_review_requests set batch_id = $2, requested_via = 'batch' where id = $1", [x.request, batch]);
      await db.query("delete from review_request_batches where id = $1", [batch]);
      expect((await db.query("select 1 from review_request_batch_items where batch_id = $1", [batch])).rows).toHaveLength(0);
      expect((await db.query<{ batch_id: string | null }>("select batch_id from crm_review_requests where id = $1", [x.request])).rows[0].batch_id).toBeNull();
      const again = await insertBatch(db, w.org.id);
      await db.query("insert into review_request_batch_items (org_id, batch_id, contact_id) values ($1, $2, $3)", [w.org.id, again, x.contact]);
      await db.query("delete from contacts where id = $1", [x.contact]);
      expect((await db.query("select 1 from review_request_batch_items where batch_id = $1", [again])).rows).toHaveLength(0);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("is readable by the workspace's own people and nobody else's: row-level security, tested with real sessions", async () => {
    const w = await world();
    const other = await world();
    const stranger = await createUser();
    await addMember(other.org.id, stranger.id, "owner");
    const ids = await withSystem(async (db) => ({ mine: await insertBatch(db, w.org.id), theirs: await insertBatch(db, other.org.id) }));
    const seen = async (userId: string) => (await withUser(userId, (db) => db.query<{ id: string }>("select id from review_request_batches order by id"))).rows.map((r) => r.id);
    expect(await seen(w.owner.id)).toEqual([ids.mine]);
    expect(await seen(stranger.id)).toEqual([ids.theirs]);
    const outsider = await createUser();
    expect(await seen(outsider.id)).toEqual([]);
    const items = async (userId: string) => (await withUser(userId, (db) => db.query("select * from review_request_batch_items"))).rows.length;
    expect(await items(outsider.id)).toBe(0);
    // These were committed (a session can only see committed rows); take them away so the rollback tests below start from a database without batches.
    await withSystem((db) => db.query("delete from review_request_batches where id = any($1::uuid[])", [[ids.mine, ids.theirs]]));
  });
});

describe("migration 0094: its rollback", () => {
  const runDown = async (db: Db) => {
    for (const stmt of statements(down)) await db.query(stmt);
  };

  it("runs on a database where the follow-through was never used, and puts everything back", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      await runDown(db);
      const has = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows.length > 0;
      expect(await has("select 1 from information_schema.tables where table_name in ('reputation_settings', 'review_request_batches', 'review_request_batch_items')")).toBe(false);
      expect(await has("select 1 from information_schema.columns where table_name = 'crm_review_requests' and column_name = 'batch_id'")).toBe(false);
      expect(await has("select 1 from pg_policies where policyname in ('review_request_batches_select', 'review_request_batch_items_select')")).toBe(false);
      expect(await has("select 1 from information_schema.columns where table_name = 'customer_feedback' and column_name in ('scale', 'nps_score', 'low_score', 'escalation_id', 'acknowledged_at', 'resolved_at', 'sla_notified_at', 'form_submission_id')")).toBe(false);
      expect(await has("select 1 from pg_indexes where indexname in ('customer_feedback_submission_idx', 'customer_feedback_sla_idx', 'customer_feedback_contact_idx', 'customer_feedback_period_idx')")).toBe(false);
      expect(await has("select 1 from information_schema.columns where table_name = 'crm_review_requests' and column_name in ('kind', 'scale')")).toBe(false);
      expect(await has("select 1 from role_permissions where permission in ('reviews.view', 'reviews.respond', 'reviews.reply_publish')")).toBe(false);
      expect(await has("select 1 from role_permissions where permission = 'reviews.manage'")).toBe(true);
      // The earlier constraint is back: a request cannot start from a program any more, and the six kinds are gone while the others remain.
      const contact = (await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'C') returning id", [w.org.id])).rows[0].id;
      const ins = (via: string) => accepted(db, "insert into crm_review_requests (org_id, contact_id, channel, token_hash, status, requested_via, expires_at) values ($1, $2, 'sms', repeat('d', 64), 'sent', $3, now() + interval '1 day')", [w.org.id, contact, via]);
      expect((await ins("workflow")).ok).toBe(true);
      expect((await ins("program")).ok).toBe(false);
      expect((await accepted(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'feedback_follow_up_overdue', 'x')", [w.org.id, w.owner.id])).ok).toBe(false);
      expect((await accepted(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'retention_attention', 'x')", [w.org.id, w.owner.id])).ok).toBe(true);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("refuses once there is something it would lose, and not for the flag it can recompute", async () => {
    const w = await world();
    const user = await createUser();
    const refuses = async (setup: (db: Db, x: Awaited<ReturnType<typeof seed>>) => Promise<void>) => {
      let message = "";
      await expect(withSystem(async (db) => {
        const x = await seed(db, w.org.id);
        await setup(db, x);
        try {
          await runDown(db);
        } catch (e) {
          message = String((e as Error).message);
          throw new Done();
        }
        throw new Error("the rollback ran");
      })).rejects.toBeInstanceOf(Done);
      return message;
    };
    const feedback = (db: Db, x: { contact: string; request: string }, o: Parameters<typeof feedbackWith>[2]) => db.query(FEEDBACK, feedbackWith(w.org.id, x, o));

    expect(await refuses((db, x) => feedback(db, x, { scale: "nps10", rating: null, nps: 4, low: true }).then(() => undefined))).toMatch(/Rollback refused: private feedback/);
    expect(await refuses((db, x) => feedback(db, x, { ackAt: new Date().toISOString() }).then(() => undefined))).toMatch(/Rollback refused: private feedback/);
    expect(await refuses((db, x) => feedback(db, x, { status: "resolved", resolvedAt: new Date().toISOString() }).then(() => undefined))).toMatch(/Rollback refused: private feedback/);
    expect(await refuses((db, x) => feedback(db, x, { rating: 4, low: true }).then(() => undefined))).toMatch(/Rollback refused: private feedback/); // low, but not by the old rule
    expect(await refuses(async (db, x) => {
      await db.query(SURVEY_ANSWER, [w.org.id, x.contact, "survey", await submissionFor(db, w.org.id, x.contact, "down")]);
    })).toMatch(/Rollback refused: private feedback/); // an answer from a survey form
    expect(await refuses((db, x) => db.query("update crm_review_requests set kind = 'survey' where id = $1", [x.request]).then(() => undefined))).toMatch(/Rollback refused: satisfaction surveys/);
    expect(await refuses((db, x) => db.query("update crm_review_requests set requested_via = 'batch' where id = $1", [x.request]).then(() => undefined))).toMatch(/Rollback refused: satisfaction surveys/);
    expect(await refuses((db) => db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'review_needs_reply', 'x')", [w.org.id, user.id]).then(() => undefined))).toMatch(/Rollback refused: reputation notifications/);
    // A review request batch, even a draft nobody approved, and a request that names one.
    expect(await refuses((db) => db.query("insert into review_request_batches (org_id, name, channel, criteria) values ($1, 'Draft', 'sms', $2::jsonb)", [w.org.id, JSON.stringify({ source: "deals_won", from: "2026-10-01", to: "2026-10-31" })]).then(() => undefined))).toMatch(/Rollback refused: review request batches/);
    expect(await refuses(async (db, x) => {
      const batch = (await db.query<{ id: string }>("insert into review_request_batches (org_id, name, channel, criteria) values ($1, 'Draft', 'sms', $2::jsonb) returning id", [w.org.id, JSON.stringify({ source: "deals_won", from: "2026-10-01", to: "2026-10-31" })])).rows[0].id;
      await db.query("update crm_review_requests set batch_id = $2 where id = $1", [x.request, batch]);
    })).toMatch(/Rollback refused: satisfaction surveys or requests started by a retention program or a batch/);

    // A low flag the old rule would have set (a rating of two or less, with its task) is derived data: the rollback still runs, and an unused settings row goes with its table.
    await expect(withSystem(async (db) => {
      const x = await seed(db, w.org.id);
      await feedback(db, x, { rating: 2, low: true, status: "escalated", task: x.task });
      await db.query("insert into reputation_settings (org_id) values ($1)", [w.org.id]);
      await runDown(db);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});
