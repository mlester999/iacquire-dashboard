// Two contacts become one: every record that points at the merged-away contact must follow the person, or a later privacy request for the kept contact cannot find it.
// The set of tables is checked against the database itself, so a table added by a later migration cannot be forgotten. Embedded Postgres; nothing is sent to anyone.
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { mergeContacts, MOVED_CONTACT_TABLES, redactContact } from "@/server/messaging/contacts";
import { createBatch } from "@/server/reputation/batches";
import { uid, ctxFor } from "./support/fixtures";
import { handedOver, rows, signingOrg } from "./support/proposals";
import { batchInput, reputationShop, setBatches, shopCustomer } from "./support/reputation";

const REASON = "Same person, confirmed by the team";

describe("what a merge moves", () => {
  async function twoWithAProposal() {
    const p = await signingOrg();
    const owner = p.actor("owner");
    const ctx = ctxFor(p.people.owner, p.org, "owner");
    const email = `ana-${uid()}@example.test`;
    const gone = await createContact(owner, { firstName: "Ana", lastName: "Reyes", email });
    const kept = await createContact(owner, { firstName: "Ana", lastName: "R.", email: `ana-r-${uid()}@example.test` });
    const h = await handedOver(p, { contactId: gone.id, clientEmail: email, clientName: "Ana Reyes" });
    return { p, ctx, gone: gone.id, kept: kept.id, h, email };
  }

  it("moves a proposal and its signing request to the kept contact, so the person's own page and a later privacy request find them", async () => {
    const { ctx, gone, kept, h } = await twoWithAProposal();
    expect((await rows<{ contact_id: string }>("select contact_id from proposals where id = $1", [h.proposal.id]))[0].contact_id).toBe(gone);
    expect((await rows<{ signer_contact_id: string }>("select signer_contact_id from signature_requests where id = $1", [h.requestId]))[0].signer_contact_id).toBe(gone);

    await mergeContacts(ctx, { keptId: kept, mergedId: gone, reason: REASON });
    expect((await rows<{ contact_id: string }>("select contact_id from proposals where id = $1", [h.proposal.id]))[0].contact_id).toBe(kept);
    expect((await rows<{ signer_contact_id: string }>("select signer_contact_id from signature_requests where id = $1", [h.requestId]))[0].signer_contact_id).toBe(kept);
    // What was asked of the signer did not change: the database would have refused that.
    expect((await rows<{ signer_name: string }>("select signer_name from signature_requests where id = $1", [h.requestId]))[0].signer_name).toBe("Ana Reyes");

    await redactContact(ctx, kept, "Asked to be forgotten");
    expect((await rows<{ status: string; client_name: string; client_email: string | null }>("select status, client_name, client_email from proposals where id = $1", [h.proposal.id]))[0]).toEqual({ status: "withdrawn", client_name: "", client_email: null });
    expect((await rows<{ revoked_at: Date | null; recipient_email: string | null }>("select revoked_at, recipient_email from proposal_share_links where proposal_id = $1", [h.proposal.id])).every((l) => l.revoked_at && !l.recipient_email)).toBe(true);
    expect((await rows<{ status: string }>("select status from signature_requests where id = $1", [h.requestId]))[0].status).toBe("voided");
  });

  it("still reaches a proposal that was left on the merged-away contact (a merge made before the move existed), and removes the merged-away record's name and merge snapshot", async () => {
    const { ctx, gone, kept, h } = await twoWithAProposal();
    await mergeContacts(ctx, { keptId: kept, mergedId: gone, reason: REASON });
    // The state an older merge left behind: the proposal still names the merged-away contact.
    await withSystem((db) => db.query("update proposals set contact_id = $2 where id = $1", [h.proposal.id, gone]));
    expect((await rows<{ display_name: string }>("select display_name from contacts where id = $1", [gone]))[0].display_name).toBe("Ana Reyes");
    expect(JSON.stringify((await rows<{ snapshot: unknown }>("select snapshot from contact_merges where merged_contact_id = $1", [gone]))[0].snapshot)).toContain("Ana Reyes");

    await redactContact(ctx, kept, "Asked to be forgotten");
    expect((await rows<{ status: string; client_name: string; client_email: string | null }>("select status, client_name, client_email from proposals where id = $1", [h.proposal.id]))[0]).toEqual({ status: "withdrawn", client_name: "", client_email: null });
    expect((await rows<{ status: string }>("select status from signature_requests where id = $1", [h.requestId]))[0].status).toBe("voided");
    expect((await rows<{ display_name: string; first_name: string | null }>("select display_name, first_name from contacts where id = $1", [gone]))[0]).toEqual({ display_name: "Removed contact", first_name: null });
    const snapshot = JSON.stringify((await rows<{ snapshot: unknown }>("select snapshot from contact_merges where merged_contact_id = $1", [gone]))[0].snapshot);
    expect(snapshot).not.toContain("Ana Reyes");
    expect(snapshot).toContain("identities");
  });

  it("follows a chain of merges: a contact merged into one that was itself merged into the kept contact", async () => {
    const { p, ctx, gone, kept, h } = await twoWithAProposal();
    const middle = (await createContact(p.actor("owner"), { firstName: "Ana", lastName: "Middle", email: `ana-m-${uid()}@example.test` })).id;
    await mergeContacts(ctx, { keptId: middle, mergedId: gone, reason: REASON });
    await mergeContacts(ctx, { keptId: kept, mergedId: middle, reason: REASON });
    expect((await rows<{ contact_id: string }>("select contact_id from proposals where id = $1", [h.proposal.id]))[0].contact_id).toBe(kept);
    // And an erasure of the kept contact reaches a record left on the first one.
    await withSystem((db) => db.query("update proposals set contact_id = $2 where id = $1", [h.proposal.id, gone]));
    await redactContact(ctx, kept, "Asked to be forgotten");
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [h.proposal.id]))[0].status).toBe("withdrawn");
  });

  it("moves a review batch item and an appointment request, and leaves an item the kept contact already has in the same batch where it is, so the person is asked once", async () => {
    const s = await reputationShop("Merge Items Shop");
    await setBatches(s.m.org.id, true);
    const kept = await shopCustomer(s);
    const gone = await shopCustomer(s);
    const both = await createBatch(s.owner, batchInput(s, { name: "Has both" }));
    const onlyGone = await createBatch(s.owner, batchInput(s, { name: "Has only the merged one" }));
    const put = (batch: string, contact: string, status: string) =>
      withSystem((db) => db.query("insert into review_request_batch_items (org_id, batch_id, contact_id, status) values ($1, $2, $3, $4)", [s.m.org.id, batch, contact, status]));
    await put(both.id, kept, "queued");
    await put(both.id, gone, "pending");
    await put(onlyGone.id, gone, "pending");
    await withSystem((db) => db.query(
      `insert into appointment_bookings (org_id, contact_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, status, idempotency_key)
       values ($1, $2, 'cal_merge', now() + interval '2 days', now() + interval '2 days 30 minutes', 'UTC', 'Visit', 'staff', 'needs_manual', $3)`,
      [s.m.org.id, gone, `merge-test-${crypto.randomUUID()}`],
    ));

    await mergeContacts(s.m.ctx("owner"), { keptId: kept, mergedId: gone, reason: REASON });
    const itemsOf = (batch: string) => rows<{ contact_id: string; status: string }>("select contact_id, status from review_request_batch_items where batch_id = $1 order by status", [batch]);
    expect(await itemsOf(onlyGone.id)).toEqual([{ contact_id: kept, status: "pending" }]);
    // The kept contact's own item is untouched, and the other one stays on the merged-away record, which is no longer a contact the batch can ask.
    expect(await itemsOf(both.id)).toEqual(expect.arrayContaining([{ contact_id: kept, status: "queued" }, { contact_id: gone, status: "pending" }]));
    expect((await itemsOf(both.id)).filter((i) => i.contact_id === kept)).toHaveLength(1);
    expect((await rows<{ contact_id: string }>("select contact_id from appointment_bookings where org_id = $1", [s.m.org.id])).every((b) => b.contact_id === kept)).toBe(true);
  });
});

describe("a table that names a contact cannot be forgotten", () => {
  // Every column of a public table that names a contact is either moved by a merge, or stays on purpose with the reason. A table a later migration adds fails this until
  // someone decides which, so a privacy request can never silently miss it.
  const MOVED_BY_OWN_STATEMENT = [
    "contact_identities.contact_id", "contact_memories.contact_id", "conversations.contact_id", "human_escalations.contact_id", "follow_up_plans.contact_id", "crm_contact_tags.contact_id",
    "crm_contact_companies.contact_id", "appointment_refs.contact_id", "retention_enrollments.contact_id", "signature_requests.signer_contact_id", "review_request_batch_items.contact_id",
  ];
  const STAYS: Record<string, string> = {
    "contact_consent_events.contact_id": "append-only consent history; the merge carries the effective answer to the kept contact",
    "contact_merges.kept_contact_id": "the merge history itself",
    "contact_merges.merged_contact_id": "the merge history itself",
    "crm_activities.contact_id": "history of what happened; the kept contact's timeline reads it through the merge history",
    "crm_events.contact_id": "history of what happened; read through the merge history",
    "crm_workflow_runs.contact_id": "an automation run for the merged-away record; it ends with it (a deleted contact is never messaged)",
    "follow_up_steps.contact_id": "belongs to a follow-up plan that the merge cancels",
    "lead_score_assessments.contact_id": "scored the merged-away record; the kept contact is scored on its own (a privacy request erases both)",
    "lead_score_overrides.contact_id": "a person's override on the merged-away record (a privacy request erases both)",
    "lead_score_queue.contact_id": "work waiting for the merged-away record (a privacy request erases both)",
    "lead_touches.contact_id": "attribution history (a privacy request erases both)",
    "missed_call_cases.contact_id": "case history (a privacy request erases both)",
    "web_chat_sessions.contact_id": "visit history (a privacy request erases both)",
    "web_chat_sessions.possible_match_contact_id": "a hint for staff, never a link",
    "customer_feedback.possible_contact_id": "a hint for staff on a survey answer nobody has attributed yet; it is followed through the merge history when read, and a privacy request for the kept contact passes it the merged-away ids too",
    "website_form_submissions.contact_id": "the raw submission as it arrived; not erased by a privacy request today (listed as an open question in the release notes)",
  };

  const NOT_YET_IN_EVERY_SCHEMA = new Set(["customer_feedback.possible_contact_id"]);

  it("lists every column that names a contact, and each is moved, or stays for a stated reason", async () => {
    const found = (await rows<{ t: string }>(
      `select distinct c.table_name || '.' || c.column_name as t from information_schema.columns c
       join information_schema.tables x on x.table_schema = c.table_schema and x.table_name = c.table_name and x.table_type = 'BASE TABLE'
       where c.table_schema = 'public' and c.column_name ~ '(^|_)contact_id$' and c.column_name <> 'ghl_contact_id'
       union
       select distinct (k.conrelid::regclass)::text || '.' || a.attname from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
       where k.contype = 'f' and k.confrelid = 'public.contacts'::regclass and a.attname <> 'org_id'`,
    )).map((r) => r.t.replace(/^public\./, ""));
    const decided = new Set([...MOVED_CONTACT_TABLES.map((t) => `${t}.contact_id`), ...MOVED_BY_OWN_STATEMENT, ...Object.keys(STAYS)]);
    expect(found.filter((t) => !decided.has(t)), "a table names a contact and a merge neither moves it nor stays on purpose").toEqual([]);
    // No stale entry: everything listed above is a real column (apart from one that a migration still being edited adds).
    expect([...decided].filter((t) => !found.includes(t) && !NOT_YET_IN_EVERY_SCHEMA.has(t)), "listed but not in the schema").toEqual([]);
  });
});
