import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { buildExport } from "@/server/offboarding/export";
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
