import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { buildExport, EXPORT_TABLES } from "@/server/offboarding/export";
import { readZip } from "@/server/offboarding/zip";
import { addMember, createOrg, createUser } from "./support/fixtures";

// A client's data export must hold what the client can see, and nothing the agency wrote for itself. Custom-project rows carry agency-only columns (internal
// notes, who is assigned, which services staff suggested, who prepared and sent a quote); migration 0015 withholds them from the portal, so the download
// must too. A draft quote is not the client's yet either.

const fileText = (zip: Buffer, name: string) => readZip(zip).find((f) => f.name === name)?.data.toString("utf8") ?? "";

describe("the export of custom projects", () => {
  it("leaves out the agency's internal notes, the assignee, staff suggestions and draft quotes", async () => {
    const org = await createOrg({ name: "Project Export Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const staff = await createUser({ platformRole: "agency_staff", name: "Sam Staffer" });

    await withSystem(async (db) => {
      const req = (
        await db.query<{ id: string }>(
          `insert into client_project_requests (org_id, created_by, title, summary, assigned_to, internal_notes, suggested_service_ids, status)
           values ($1, $2, 'Booking portal', 'A CLIENT-VISIBLE-SUMMARY', $3, 'INTERNAL-NOTE-TOP-SECRET-REQUEST', array[gen_random_uuid()], 'quote_sent') returning id`,
          [org.id, owner.id, staff.id],
        )
      ).rows[0].id;
      await db.query(
        `insert into project_quotes (request_id, org_id, version, status, project_name, scope, internal_notes, prepared_by, sent_by, sent_at, content_hash)
         values ($1, $2, 1, 'sent', 'Booking portal', 'A CLIENT-VISIBLE-SCOPE', 'INTERNAL-NOTE-TOP-SECRET-QUOTE', $3, $3, now(), 'hash-1')`,
        [req, org.id, staff.id],
      );
      await db.query(
        `insert into project_quotes (request_id, org_id, version, status, project_name, scope, internal_notes, prepared_by)
         values ($1, $2, 2, 'draft', 'Booking portal v2', 'A DRAFT-SCOPE-NOT-YET-THE-CLIENTS', 'INTERNAL-NOTE-DRAFT', $3)`,
        [req, org.id, staff.id],
      );
    });

    const out = await buildExport(org.id);
    const requests = fileText(out.bytes, "projects/requests.json");
    const quotes = fileText(out.bytes, "projects/quotes.json");
    const all = readZip(out.bytes).filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");

    expect(requests).toContain("A CLIENT-VISIBLE-SUMMARY");
    expect(quotes).toContain("A CLIENT-VISIBLE-SCOPE");

    expect(all).not.toContain("INTERNAL-NOTE-TOP-SECRET-REQUEST");
    expect(all).not.toContain("INTERNAL-NOTE-TOP-SECRET-QUOTE");
    expect(all).not.toContain("INTERNAL-NOTE-DRAFT");
    expect(all).not.toContain("DRAFT-SCOPE-NOT-YET-THE-CLIENTS");
    for (const column of ["internal_notes", "assigned_to", "suggested_service_ids", "prepared_by", "sent_by", "content_hash"]) {
      expect(requests, `requests.json mentions ${column}`).not.toContain(column);
      expect(quotes, `quotes.json mentions ${column}`).not.toContain(column);
    }
    expect(requests).not.toContain(staff.id);
    expect(quotes).not.toContain(staff.id);
  });
});

describe("the export of change requests, prerequisites, the project's conversation and surveys", () => {
  it("holds what the client could read and the whole history of each change, and nothing the team wrote for itself", async () => {
    const org = await createOrg({ name: "Change Export Co" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const staff = await createUser({ platformRole: "agency_staff", name: "Sam Staffer" });
    const hash = "c".repeat(64);

    await withSystem(async (db) => {
      const project = (await db.query<{ id: string }>("insert into client_project_requests (org_id, created_by, title, status) values ($1, $2, 'Booking portal', 'approved') returning id", [org.id, owner.id])).rows[0].id;
      await db.query("insert into client_projects (request_id, org_id, agreed_price_cents, currency, warranty_days, revisions_included) values ($1, $2, 90000, 'USD', 30, 2)", [project, org.id]);
      // One change that was quoted and accepted, one that was declined: both stay in the export.
      const accepted = (await db.query<{ id: string }>("insert into project_change_orders (org_id, request_id, title, description, requested_by, idempotency_key, internal_notes) values ($1, $2, 'CLIENT-VISIBLE-CHANGE', 'Add a second calendar', $3, 'SECRET-RETRY-KEY-1', 'INTERNAL-NOTE-CHANGE-ORDER') returning id", [org.id, project, owner.id])).rows[0].id;
      await db.query("update project_change_orders set status = 'under_review', classification = 'out_of_scope' where id = $1", [accepted]);
      await db.query("update project_change_orders set status = 'quoted', quote_version = 1, quoted_by = $2, quoted_at = now(), additional_cents = 25000, currency = 'USD', terms_text = 'CLIENT-VISIBLE-TERMS', content_hash = $3 where id = $1", [accepted, staff.id, hash]);
      await db.query("insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement, ip_hash) values ($1, $2, 1, 'accepted', $3, $4, 'I accept this change and its price.', 'IP-HASH-SECRET')", [accepted, org.id, owner.id, hash]);
      await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [accepted]);
      await db.query("insert into project_scope_amendments (org_id, request_id, change_order_id, added_scope, added_cents, currency, agreed_by) values ($1, $2, $3, 'CLIENT-VISIBLE-ADDED-SCOPE', 25000, 'USD', $4)", [org.id, project, accepted, owner.id]);
      const declined = (await db.query<{ id: string }>("insert into project_change_orders (org_id, request_id, title, description, requested_by) values ($1, $2, 'DECLINED-CHANGE-KEPT', 'Rebuild everything', $3) returning id", [org.id, project, owner.id])).rows[0].id;
      await db.query("update project_change_orders set status = 'declined' where id = $1", [declined]);
      await db.query(`insert into project_prerequisites (request_id, org_id, kind, label, status, evidence_note, satisfied_by, satisfied_at, created_by)
        values ($1, $2, 'deposit', 'CLIENT-VISIBLE-PREREQUISITE', 'satisfied', 'INTERNAL-EVIDENCE-NOTE', $3, now(), $3)`, [project, org.id, staff.id]);
      await db.query("insert into project_prerequisites (request_id, org_id, kind, label, status, waived_reason, waived_by, waived_at) values ($1, $2, 'access', 'Waived item', 'waived', 'INTERNAL-WAIVER-REASON', $3, now())", [project, org.id, staff.id]);
      await db.query("insert into project_updates (request_id, org_id, author_id, kind, body, visibility) values ($1, $2, $3, 'progress', 'CLIENT-VISIBLE-UPDATE', 'client'), ($1, $2, $3, 'progress', 'INTERNAL-UPDATE-NOT-THE-CLIENTS', 'internal')", [project, org.id, staff.id]);
      await db.query("insert into project_messages (request_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', 'CLIENT-VISIBLE-MESSAGE', false), ($1, $2, $3, 'agency', 'INTERNAL-MESSAGE-NOT-THE-CLIENTS', true)", [project, org.id, staff.id]);
      const ticket = (await db.query<{ id: string }>("insert into support_tickets (org_id, created_by, subject, status, resolved_at) values ($1, $2, 'A resolved request', 'resolved', now()) returning id", [org.id, owner.id])).rows[0].id;
      await db.query("insert into support_surveys (org_id, kind, ticket_id, requested_for_user_id, status, rating, comment, answered_by, answered_at) values ($1, 'ticket_resolution', $2, $3, 'answered', 4, 'CLIENT-SURVEY-COMMENT', $3, now())", [org.id, ticket, owner.id]);
      // Team-only records: the classification, the triage record and a mention are never the client's.
      const change = (await db.query<{ id: string }>("insert into support_tickets (org_id, created_by, subject, category, request_type) values ($1, $2, 'A change', 'change_other', 'change') returning id", [org.id, owner.id])).rows[0].id;
      await db.query("insert into support_ticket_change (ticket_id, org_id, target_kind, classification, classified_by, classified_at, resolution_note) values ($1, $2, 'other', 'covered', $3, now(), 'INTERNAL-CLASSIFICATION-NOTE')", [change, org.id, staff.id]);
      await db.query("insert into support_ticket_ai_triage (ticket_id, org_id, context_summary) values ($1, $2, 'INTERNAL-TRIAGE-SUMMARY')", [change, org.id]);
    });

    const out = await buildExport(org.id);
    const file = (name: string) => fileText(out.bytes, name);
    const all = readZip(out.bytes).filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");

    expect(file("projects/change-requests.json")).toContain("CLIENT-VISIBLE-CHANGE");
    expect(file("projects/change-requests.json")).toContain("CLIENT-VISIBLE-TERMS");
    expect(file("projects/change-requests.json")).toContain("DECLINED-CHANGE-KEPT");
    expect(file("projects/change-request-answers.json")).toContain("I accept this change and its price.");
    expect(file("projects/added-scope.json")).toContain("CLIENT-VISIBLE-ADDED-SCOPE");
    expect(file("projects/prerequisites.json")).toContain("CLIENT-VISIBLE-PREREQUISITE");
    expect(file("projects/updates.json")).toContain("CLIENT-VISIBLE-UPDATE");
    expect(file("projects/messages.json")).toContain("CLIENT-VISIBLE-MESSAGE");
    expect(file("support/surveys.json")).toContain("CLIENT-SURVEY-COMMENT");
    expect(file("projects/projects.json")).toContain("warranty_days");

    for (const secret of [
      "INTERNAL-NOTE-CHANGE-ORDER", "SECRET-RETRY-KEY-1", "IP-HASH-SECRET", "INTERNAL-EVIDENCE-NOTE", "INTERNAL-WAIVER-REASON", "INTERNAL-UPDATE-NOT-THE-CLIENTS",
      "INTERNAL-MESSAGE-NOT-THE-CLIENTS", "INTERNAL-CLASSIFICATION-NOTE", "INTERNAL-TRIAGE-SUMMARY",
    ]) expect(all, secret).not.toContain(secret);
    for (const column of ["internal_notes", "idempotency_key", "quoted_by", "applied_by"]) expect(file("projects/change-requests.json"), `change-requests.json mentions ${column}`).not.toContain(column);
    for (const column of ["ip_hash"]) expect(file("projects/change-request-answers.json")).not.toContain(column);
    for (const column of ["evidence_note", "waived_reason", "satisfied_by", "waived_by", "source_id"]) expect(file("projects/prerequisites.json"), `prerequisites.json mentions ${column}`).not.toContain(column);
    // No team member's id travels with the feed, the conversation or the change history.
    for (const name of ["projects/change-requests.json", "projects/prerequisites.json", "projects/updates.json", "projects/messages.json"]) expect(file(name), name).not.toContain(staff.id);
    // The team's own records have no file at all.
    expect(readZip(out.bytes).map((f) => f.name).filter((n) => /classif|triage|mention/i.test(n))).toEqual([]);
  });
});

describe("every column the export holds of a project or support table is one the client may read", () => {
  it("is true for each table with column-level grants, and each picked column exists", async () => {
    const specs = EXPORT_TABLES.filter((s) => /^(projects|support)\//.test(s.file));
    expect(specs.length).toBeGreaterThanOrEqual(10);
    await withSystem(async (db) => {
      for (const spec of specs) {
        const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [spec.table])).rows.map((r) => r.column_name);
        expect(columns.length, `${spec.table} exists`).toBeGreaterThan(0);
        for (const picked of spec.pick ?? []) expect(columns, `${spec.file} picks ${picked}`).toContain(picked);
        const wholeTable = (await db.query<{ ok: boolean }>("select has_table_privilege('iaq_app_user', $1, 'select') as ok", [`public.${spec.table}`])).rows[0].ok;
        if (wholeTable) continue;
        const exported = (spec.pick ?? columns).filter((c) => !(spec.omit ?? []).includes(c));
        for (const column of exported) {
          const granted = (await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', $1, $2, 'select') as ok", [`public.${spec.table}`, column])).rows[0].ok;
          expect(granted, `${spec.file} exports ${spec.table}.${column}, which the client cannot read in the portal`).toBe(true);
        }
      }
    });
  });
});
