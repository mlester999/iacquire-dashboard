import crypto from "node:crypto";
import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { queueOutbound } from "@/server/messaging/send";
import { startFollowUps } from "@/server/messaging/followups";
import { setProgramEnabled } from "@/server/retention/service";
import { uploadPrivateFile } from "@/server/storage/private";
import { buildExport } from "@/server/offboarding/export";
import { createZip, readZip, safeEntryName } from "@/server/offboarding/zip";
import { cancelOffboarding, closeBilling, executeDeletion, getOffboarding, getOffboardingForOwner, planDeletion, PURGE_RETAINS, recordExport, requestOffboarding, requestOffboardingAsAgency, sendDeletionReminders, shutdownClient } from "@/server/offboarding/service";
import { JOBS } from "@/server/ops/tick";
import { agencyUser, createUser } from "./support/fixtures";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

let m: MessagingOrg;
let other: MessagingOrg;
let staff: ReturnType<typeof agencyUser>;
let unassigned: ReturnType<typeof agencyUser>;

const notes = async (userId: string, kind: string) => (await withSystem((db) => db.query<{ title: string; body: string | null }>("select title, body from notifications where user_id = $1 and kind = $2 order by created_at", [userId, kind]))).rows;
const count = async (table: string, orgId: string) => Number((await withSystem((db) => db.query<{ n: string }>(`select count(*)::text as n from "${table}" where org_id = $1`, [orgId]))).rows[0].n);
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), crypto.randomBytes(200)]);

beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Leaving Co" });
  other = await messagingOrg({ name: "Staying Co" });
  const s = await createUser({ platformRole: "agency_staff" });
  staff = agencyUser(s, "agency_staff");
  unassigned = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [m.org.id, s.id]));
  // The leaving client's world: customers, conversations, an upload, a website image, a secret that must never leave, an internal note.
  await inbound(m.org.id, { name: "Leaving Customer Alpha", body: "I would like a quote for LEAVING-CO-MARKER" });
  await inbound(other.org.id, { name: "Staying Customer Beta", body: "STAYING-CO-MARKER please" });
  await withSystem(async (db) => {
    await db.query("insert into company_knowledge (org_id, section, content, version) values ($1, 'products_services', 'We clean gutters. LEAVING-CO-KNOWLEDGE', 1), ($2, 'products_services', 'STAYING-CO-KNOWLEDGE', 1)", [m.org.id, other.org.id]);
    await db.query("insert into integration_connections (org_id, provider, label, status, config) values ($1, 'ghl', 'GHL for Leaving Co', 'connected', $2::jsonb)", [m.org.id, JSON.stringify({ note: "SECRET-CONNECTION-CONFIG-VALUE" })]);
    const t = await db.query<{ id: string }>("insert into support_tickets (org_id, subject, category, status) values ($1, 'Help please', 'general', 'open') returning id", [m.org.id]);
    await db.query("insert into support_messages (ticket_id, org_id, author_kind, body, internal) values ($1, $2, 'client', 'A message the client can see', false), ($1, $2, 'agency', 'INTERNAL-AGENCY-NOTE-DO-NOT-EXPORT', true)", [t.rows[0].id, m.org.id]);
  });
  await uploadPrivateFile({ userId: m.people.owner.id, orgId: m.org.id, bucket: "brand-assets", path: `${m.org.id}/${crypto.randomUUID()}/logo.png`, bytes: png, contentType: "image/png", filename: "logo.png" });
  await withSystem((db) => db.query("insert into website_asset_blobs (org_id, sha256, mime_type, bytes) values ($1, $2, 'image/png', $3)", [m.org.id, crypto.createHash("sha256").update(png).digest("hex"), png]));
});

describe("the archive format", () => {
  it("writes a valid ZIP that reads back exactly, including unicode names and incompressible data", () => {
    const noise = crypto.randomBytes(5000);
    const files = [
      { name: "README.md", data: Buffer.from("héllo wörld, 你好") },
      { name: "deep/dir/data.json", data: Buffer.from(JSON.stringify({ a: 1 }).repeat(2000)) },
      { name: "random.bin", data: noise },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    const back = readZip(createZip(files));
    expect(back.map((f) => f.name)).toEqual(files.map((f) => f.name));
    for (const [i, f] of files.entries()) expect(back[i].data.equals(f.data)).toBe(true);
  });

  it("refuses duplicate names, strips traversal, and detects corruption", () => {
    expect(() => createZip([{ name: "a.txt", data: Buffer.from("1") }, { name: "a.txt", data: Buffer.from("2") }])).toThrow(/Duplicate/);
    expect(safeEntryName("../../etc/passwd")).toBe("etc/passwd");
    expect(safeEntryName("/abs\\path/./file")).toBe("abs/path/file");
    expect(() => safeEntryName("../..")).toThrow();
    const zip = createZip([{ name: "a.txt", data: Buffer.from("hello hello hello hello") }]);
    zip[30 + "a.txt".length + 2] ^= 0xff; // damage the stored bytes, just after the file's header
    expect(() => readZip(zip)).toThrow();
  });
});

describe("asking to leave", () => {
  it("lets only the owner ask, after typing the workspace name, and changes nothing by asking", async () => {
    await expect(requestOffboarding(m.ctx("manager"), { confirmName: "Leaving Co" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(requestOffboarding(m.ctx("owner"), { confirmName: "Wrong Name" })).rejects.toMatchObject({ code: "invalid_input" });
    const v = await requestOffboarding(m.ctx("owner"), { confirmName: "leaving co", reason: "We're closing the business." });
    expect(v).toMatchObject({ status: "requested", requestedByKind: "client", reason: "We're closing the business.", retentionDays: 90 });
    await expect(requestOffboarding(m.ctx("owner"), { confirmName: "Leaving Co" })).rejects.toMatchObject({ code: "conflict" });
    // Nothing was switched off.
    expect((await withSystem((db) => db.query("select status from organizations where id = $1", [m.org.id]))).rows[0]).toMatchObject({ status: "active" });
    expect((await withSystem((db) => db.query("select 1 from automation_pauses where org_id = $1 and active", [m.org.id]))).rows).toHaveLength(0);
    expect((await notes(m.people.owner.id, "offboarding_update"))[0].body).toMatch(/Nothing has been switched off/);
    expect((await notes(m.superAdmin.id, "offboarding_update")).some((n) => n.title.includes("Leaving Co"))).toBe(true);
  });

  it("lets the owner change their mind while nothing has been shut down", async () => {
    await cancelOffboarding({ user: { id: m.people.owner.id, platformRole: "none" }, orgId: m.org.id, viaOwner: true }, "Changed my mind");
    expect((await getOffboarding(m.org.id))?.status).toBe("cancelled");
    await requestOffboarding(m.ctx("owner"), { confirmName: "Leaving Co", reason: "Closing for real." });
    expect((await getOffboardingForOwner(m.ctx("owner")))?.status).toBe("requested");
    expect(await getOffboardingForOwner(m.ctx("viewer"))).toBeNull(); // only the owner sees it
  });

  it("can also be started by a super admin, but not by staff or for a workspace that isn't a client", async () => {
    await expect(requestOffboardingAsAgency(staff, other.org.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(requestOffboardingAsAgency(m.superAdmin, crypto.randomUUID(), "x")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("taking your data with you", () => {
  it("exports a readable archive of everything the client owns, and nothing that belongs to anyone else", async () => {
    const out = await buildExport(m.org.id);
    const files = readZip(out.bytes);
    const names = files.map((f) => f.name);
    for (const must of ["README.md", "manifest.json", "DOMAINS.md", "business/organization.json", "business/knowledge.json", "customers/contacts.json", "conversations/messages.json", "billing/credit-ledger.json"]) expect(names).toContain(must);
    const text = (n: string) => files.find((f) => f.name === n)!.data.toString("utf8");
    const all = files.filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    expect(text("customers/contacts.json")).toContain("Leaving Customer Alpha");
    expect(text("conversations/messages.json")).toContain("LEAVING-CO-MARKER");
    expect(text("business/knowledge.json")).toContain("LEAVING-CO-KNOWLEDGE");
    // Another client's data is never read.
    expect(all).not.toContain("STAYING-CO-MARKER");
    expect(all).not.toContain("STAYING-CO-KNOWLEDGE");
    expect(all).not.toContain("Staying Customer Beta");
    expect(out.filename).toMatch(/^iacquire-export-leaving-co-.*\.zip$/);
  });

  it("leaves out credentials, connection settings and the agency's internal notes", async () => {
    const out = await buildExport(m.org.id);
    const files = readZip(out.bytes);
    const all = files.filter((f) => /\.(json|md)$/.test(f.name)).map((f) => f.data.toString("utf8")).join("\n");
    expect(all).not.toContain("SECRET-CONNECTION-CONFIG-VALUE");
    expect(all).not.toContain("INTERNAL-AGENCY-NOTE-DO-NOT-EXPORT");
    expect(files.some((f) => f.name.includes("integration"))).toBe(false);
    expect(all).not.toMatch(/credential_id|token_hash|verification_token|alert_phone/);
    const manifest = JSON.parse(files.find((f) => f.name === "manifest.json")!.data.toString("utf8"));
    expect(manifest.notExported.join(" ")).toMatch(/credential or secret/);
    expect(files.find((f) => f.name === "README.md")!.data.toString("utf8")).toMatch(/belong to you/);
  });

  it("includes uploaded files and website images as files, and says honestly what it could not include", async () => {
    const out = await buildExport(m.org.id);
    const files = readZip(out.bytes);
    const brand = files.filter((f) => f.name.startsWith("files/brand-assets/"));
    expect(brand).toHaveLength(1);
    expect(brand[0].data.equals(png)).toBe(true);
    expect(files.filter((f) => f.name.startsWith("website/images/"))).toHaveLength(1);
    expect(out.filesIncluded).toBe(2);
    expect(out.filesOmitted).toBe(0);
    // A file that has vanished from storage is listed, not silently dropped.
    const id = (await withSystem((db) => db.query<{ id: string; storage_key: string; bucket: string }>("select id, storage_key, bucket from private_files where org_id = $1 and bucket = 'brand-assets'", [m.org.id]))).rows[0];
    const dir = process.env.UPLOAD_DIR ?? ".data/test-uploads";
    const target = `${dir}/${id.bucket}/${id.storage_key}`;
    const saved = fs.readFileSync(target);
    fs.rmSync(target);
    try {
      const partial = await buildExport(m.org.id);
      expect(partial.filesOmitted).toBe(1);
      expect(JSON.parse(readZip(partial.bytes).find((f) => f.name === "manifest.json")!.data.toString("utf8")).filesOmitted).toHaveLength(1);
    } finally {
      fs.writeFileSync(target, saved);
    }
  });

  it("explains how to take domains away, and never holds one back", async () => {
    await withSystem(async (db) => {
      const w = await db.query<{ id: string }>("insert into websites (org_id, name, template_key, subdomain, draft_content) values ($1, 'Site', 'summit.peak', $2, '{}'::jsonb) returning id", [m.org.id, `leaving-${crypto.randomBytes(3).toString("hex")}`]);
      await db.query("insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, acquisition, registrar, is_primary) values ($1, $2, $3, 'platform', 'active', $5, 'platform', null, true), ($1, $2, $4, 'custom', 'active', $6, 'purchased', 'Namecheap', false)", [m.org.id, w.rows[0].id, `leaving-co-${crypto.randomBytes(2).toString("hex")}.sites.iacquire.com`, `leavingco-${crypto.randomBytes(2).toString("hex")}.example.com`, crypto.randomBytes(16).toString("hex"), crypto.randomBytes(16).toString("hex")]);
    });
    const guide = readZip((await buildExport(m.org.id)).bytes).find((f) => f.name === "DOMAINS.md")!.data.toString("utf8");
    expect(guide).toMatch(/Nothing here holds a domain back/);
    expect(guide).toMatch(/free address iAcquire hosts/);
    expect(guide).toMatch(/Registered through Namecheap in your name/);
    expect(guide).toMatch(/transfer authorization code/);
  });

  it("is recorded against the request and the audit trail when downloaded", async () => {
    await recordExport(m.org.id, m.people.owner.id);
    expect((await getOffboarding(m.org.id))?.exportDownloadedAt).not.toBeNull();
    expect((await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'data.exported'", [m.org.id]))).rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe("shutting down", () => {
  let queuedId: string;
  beforeAll(async () => {
    const c = await inbound(m.org.id, { name: "Queued Quinn" });
    queuedId = (await withSystem((db) => queueOutbound(db, { orgId: m.org.id, conversationId: c.conversationId, scope: "reply", actor: { kind: "ai", agentId: m.salesAgentId }, body: "This should never be sent" }))).messageId;
    await withSystem((db) => startFollowUps(db, { orgId: m.org.id, conversationId: c.conversationId }));
    await withSystem(async (db) => {
      await db.query("update agent_instances set status = 'online', last_health_ok = true, enabled = true, mode = 'autonomous' where org_id = $1 and role_key = 'crm_manager'", [m.org.id]);
    });
    await setProgramEnabled(m.ctx("owner"), "welcome", true);
    await withSystem(async (db) => {
      await db.query("insert into invitations (org_id, email, role, token_hash, invited_by, expires_at) values ($1, 'pending@example.test', 'admin', $2, $3, now() + interval '3 days')", [m.org.id, crypto.randomBytes(16).toString("hex"), m.people.owner.id]).catch(() => undefined);
    });
  });

  it("is for super admins only, and only once the request exists", async () => {
    const req = (await getOffboarding(m.org.id))!;
    await expect(shutdownClient(staff, req.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(shutdownClient(m.superAdmin, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("stops automation and everything queued, disconnects messaging and services, and removes staff but not the owner", async () => {
    const req = (await getOffboarding(m.org.id))!;
    const view = await shutdownClient(m.superAdmin, req.id, { websitePlan: "keep_until_deletion", retentionDays: 60 });
    expect(view).toMatchObject({ status: "retention", retentionDays: 60, websitePlan: "keep_until_deletion" });
    expect(new Date(view.deleteAfter!).getTime() - Date.now()).toBeGreaterThan(59 * 86_400_000);
    expect(view.creditBalanceMicros).toBeGreaterThan(0);
    // Automation: every pause is on, every employee paused, queued work cancelled.
    expect((await withSystem((db) => db.query<{ scope: string }>("select scope from automation_pauses where org_id = $1 and active order by scope", [m.org.id]))).rows.map((r) => r.scope)).toEqual(["agency", "messaging", "outbound"]);
    expect((await withSystem((db) => db.query<{ mode: string }>("select distinct mode from agent_instances where org_id = $1", [m.org.id]))).rows).toEqual([{ mode: "paused" }]);
    expect((await withSystem((db) => db.query("select status, blocked_reason from conversation_messages where id = $1", [queuedId]))).rows[0]).toMatchObject({ status: "blocked", blocked_reason: "offboarding" });
    expect((await withSystem((db) => db.query("select 1 from follow_up_plans where org_id = $1 and status = 'active'", [m.org.id]))).rows).toHaveLength(0);
    expect((await withSystem((db) => db.query("select 1 from retention_programs where org_id = $1 and enabled", [m.org.id]))).rows).toHaveLength(0);
    expect((await withSystem((db) => db.query("select 1 from messaging_channels where org_id = $1 and enabled", [m.org.id]))).rows).toHaveLength(0);
    // Access: staff gone, owner kept.
    const roles = (await withSystem((db) => db.query<{ role: string; status: string }>("select role, status from organization_memberships where org_id = $1", [m.org.id]))).rows;
    expect(roles.filter((r) => r.role === "owner").every((r) => r.status === "active")).toBe(true);
    expect(roles.filter((r) => r.role !== "owner").every((r) => r.status === "revoked")).toBe(true);
    // The connection is closed, and every step is on the record with its outcome.
    expect((await withSystem((db) => db.query("select status from integration_connections where org_id = $1 and provider = 'ghl'", [m.org.id]))).rows[0]).toMatchObject({ status: "disconnected" });
    expect(view.steps.map((s) => s.key)).toEqual(["automation", "messaging", "integrations", "access", "website"]);
    expect(view.steps.every((s) => s.ok)).toBe(true);
    // The owner is told, in plain words, that their data is theirs to download and their domains are theirs.
    const told = (await notes(m.people.owner.id, "offboarding_update")).at(-1)!;
    expect(told.body).toMatch(/download your data until/);
    expect(told.body).toMatch(/domains are yours/);
    // The website stays up under this plan.
    await expect(shutdownClient(m.superAdmin, req.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets only a super admin reverse it afterwards, leaving the owner to switch things back on", async () => {
    await expect(cancelOffboarding({ user: { id: m.people.owner.id, platformRole: "none" }, orgId: m.org.id, viaOwner: true }, "Please undo")).rejects.toMatchObject({ code: "forbidden" });
    await expect(cancelOffboarding({ user: staff, orgId: m.org.id, viaOwner: false }, "x")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps the audit trail, shows the agency every step, and hides all of it from other clients", async () => {
    expect((await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'offboarding.shutdown'", [m.org.id]))).rows).toHaveLength(1);
    const seen = async (userId: string) => (await withUser(userId, (db) => db.query<{ org_id: string }>("select distinct org_id from offboarding_events"))).rows.map((r) => r.org_id);
    expect(await seen(m.people.owner.id)).toEqual([m.org.id]);
    expect(await seen(m.people.viewer.id)).toEqual([]);
    expect(await seen(other.people.owner.id)).toEqual([]);
    expect(await seen(staff.id)).toEqual([m.org.id]);
    expect(await seen(unassigned.id)).toEqual([]);
    await expect(withUser(m.people.owner.id, (db) => db.query("delete from offboarding_events"))).rejects.toBeTruthy();
    await expect(withSystem((db) => db.query("update offboarding_events set detail = 'tampered'"))).rejects.toBeTruthy(); // the log is append-only
  });
});

describe("billing and the deletion plan", () => {
  it("requires someone to say how remaining credit and charges were settled", async () => {
    const req = (await getOffboarding(m.org.id))!;
    await expect(closeBilling(staff, req.id, "done")).rejects.toMatchObject({ code: "forbidden" });
    await expect(closeBilling(m.superAdmin, req.id, "x")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("shows exactly what would be removed and what is kept, without changing anything", async () => {
    const req = (await getOffboarding(m.org.id))!;
    const before = await count("contacts", m.org.id);
    const plan = await planDeletion(m.superAdmin, req.id);
    expect(plan.purge.some((p) => p.table === "contacts" && p.rows === before)).toBe(true);
    expect(plan.purge.some((p) => p.table === "conversation_messages")).toBe(true);
    expect(plan.retain.map((r) => r.table)).toEqual(expect.arrayContaining(["audit_logs", "credit_ledger_entries"]));
    expect(plan.purge.every((p) => !PURGE_RETAINS.has(p.table))).toBe(true);
    expect(plan.files).toBeGreaterThanOrEqual(1);
    expect(plan.totalPurgeRows).toBe(plan.purge.reduce((s, p) => s + p.rows, 0));
    expect(await count("contacts", m.org.id)).toBe(before); // planning deletes nothing
    await expect(planDeletion(staff, req.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("deleting for good", () => {
  let req: Awaited<ReturnType<typeof getOffboarding>>;
  const purge = (over: Partial<Parameters<typeof executeDeletion>[2]> = {}) => executeDeletion(m.superAdmin, req!.id, { confirmName: "Leaving Co", ...over });
  beforeAll(async () => {
    req = await getOffboarding(m.org.id);
  });
  afterAll(() => {
    delete process.env.OFFBOARDING_PURGE_ENABLED;
    resetEnvCache();
  });

  it("is switched off unless it has been deliberately enabled for this environment", async () => {
    await expect(purge()).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/switched off in this environment/) });
  });

  it("holds every guard in turn: retention period, closed billing, the client's download, and the confirmation name", async () => {
    process.env.OFFBOARDING_PURGE_ENABLED = "true";
    resetEnvCache();
    await expect(purge()).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/retention period isn't over/) });
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() - interval '1 day' where id = $1", [req!.id]));
    await expect(purge()).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/Close billing first/) });
    await closeBilling(m.superAdmin, req!.id, "Remaining $20 credit refunded through PayMongo; no further charges.");
    await withSystem((db) => db.query("update offboarding_requests set export_downloaded_at = null where id = $1", [req!.id]));
    await expect(purge()).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/hasn't downloaded their data/) });
    await expect(purge({ waiveExportReason: "short" })).rejects.toMatchObject({ code: "conflict" });
    await withSystem((db) => db.query("update offboarding_requests set export_downloaded_at = now() where id = $1", [req!.id]));
    await expect(purge({ confirmName: "Staying Co" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(executeDeletion(staff, req!.id, { confirmName: "Leaving Co" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await count("contacts", m.org.id)).toBeGreaterThan(0); // every refusal left everything in place
  });

  it("removes nothing at all if any part of it cannot be removed", async () => {
    // A table that still points at client data with no way to cascade, so the purge cannot complete.
    await withSystem(async (db) => {
      await db.query("create table zz_blocker_parent (id uuid primary key default gen_random_uuid(), org_id uuid not null references organizations(id) on delete cascade)");
      await db.query("create table zz_blocker_child (id uuid primary key default gen_random_uuid(), parent_id uuid not null references zz_blocker_parent(id))");
      const p = await db.query<{ id: string }>("insert into zz_blocker_parent (org_id) values ($1) returning id", [m.org.id]);
      await db.query("insert into zz_blocker_child (parent_id) values ($1)", [p.rows[0].id]);
    });
    const before = { contacts: await count("contacts", m.org.id), messages: await count("conversation_messages", m.org.id) };
    try {
      await expect(purge()).rejects.toMatchObject({ message: expect.stringMatching(/Nothing was deleted/) });
      expect({ contacts: await count("contacts", m.org.id), messages: await count("conversation_messages", m.org.id) }).toEqual(before);
      expect((await getOffboarding(m.org.id))?.status).toBe("retention");
      // The stored files are still there too: they are removed only after the database purge succeeds.
      const stillThere = (await withSystem((db) => db.query<{ storage_key: string; bucket: string }>("select storage_key, bucket from private_files where org_id = $1 and bucket = 'brand-assets' limit 1", [m.org.id]))).rows[0];
      expect(fs.existsSync(`${process.env.UPLOAD_DIR ?? ".data/test-uploads"}/${stillThere.bucket}/${stillThere.storage_key}`)).toBe(true);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop table zz_blocker_child");
        await db.query("drop table zz_blocker_parent");
      });
    }
  });

  it("deletes the client's data and files, keeps the money and the audit trail, and leaves other clients untouched", async () => {
    const otherBefore = { contacts: await count("contacts", other.org.id), messages: await count("conversation_messages", other.org.id), knowledge: await count("company_knowledge", other.org.id) };
    const keptBefore = { audit: await count("audit_logs", m.org.id), ledger: await count("credit_ledger_entries", m.org.id), payments: await count("payments", m.org.id) };
    const file = (await withSystem((db) => db.query<{ storage_key: string; bucket: string }>("select storage_key, bucket from private_files where org_id = $1 and bucket = 'brand-assets' limit 1", [m.org.id]))).rows[0];
    const target = `${process.env.UPLOAD_DIR ?? ".data/test-uploads"}/${file.bucket}/${file.storage_key}`;
    expect(fs.existsSync(target)).toBe(true);
    const plan = await planDeletion(m.superAdmin, req!.id);

    const result = await purge();
    expect(result.purgedRows).toBeGreaterThan(0);
    expect(result.purgedRows).toBeLessThanOrEqual(plan.totalPurgeRows); // rows that go away by cascade are counted once, under their parent
    expect(result.files).toBeGreaterThanOrEqual(1);
    expect(result.orphanedFiles).toBe(0);
    expect(fs.existsSync(target)).toBe(false);

    // Every table that carried the client's data is empty for them, immutable consent history included.
    const tables = (await withSystem((db) => db.query<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped where n.nspname = 'public' and c.relkind = 'r'"))).rows.map((r) => r.relname);
    for (const t of tables.filter((x) => !PURGE_RETAINS.has(x))) expect(await count(t, m.org.id), t).toBe(0);
    // What must survive does.
    expect(await count("audit_logs", m.org.id)).toBeGreaterThanOrEqual(keptBefore.audit);
    expect(await count("credit_ledger_entries", m.org.id)).toBe(keptBefore.ledger);
    expect(await count("payments", m.org.id)).toBe(keptBefore.payments);
    expect((await withSystem((db) => db.query("select status, website, industry from organizations where id = $1", [m.org.id]))).rows[0]).toMatchObject({ status: "archived", website: null, industry: null });
    expect((await withSystem((db) => db.query("select status from organization_memberships where org_id = $1", [m.org.id]))).rows.every((r) => (r as { status: string }).status === "revoked")).toBe(true);
    expect((await getOffboarding(m.org.id))).toMatchObject({ status: "deleted" });
    expect((await withSystem((db) => db.query("select detail from offboarding_events where request_id = $1 and kind = 'deleted'", [req!.id]))).rows[0]).toMatchObject({ detail: expect.stringMatching(/Payments, the credit ledger, usage, fees and the audit trail were kept/) });
    // The other client is exactly as it was.
    expect({ contacts: await count("contacts", other.org.id), messages: await count("conversation_messages", other.org.id), knowledge: await count("company_knowledge", other.org.id) }).toEqual(otherBefore);
    await expect(purge()).rejects.toMatchObject({ code: "conflict" }); // it can't be run twice
  });
});

describe("reminders and the scheduler", () => {
  it("reminds a departing owner before the end of retention, once per window", async () => {
    const late = await messagingOrg({ name: "Reminded Leaver" });
    const v = await requestOffboarding(late.ctx("owner"), { confirmName: "Reminded Leaver" });
    await shutdownClient(late.superAdmin, v.id, { retentionDays: 30 });
    expect(await sendDeletionReminders()).toBe(0); // 30 days out: too early
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() + interval '10 days' where id = $1", [v.id]));
    expect(await sendDeletionReminders()).toBe(1);
    expect(await sendDeletionReminders()).toBe(1); // counted again, but notified once
    expect((await notes(late.people.owner.id, "offboarding_update")).filter((n) => n.title.includes("will be deleted in"))).toHaveLength(1);
    await withSystem((db) => db.query("update offboarding_requests set delete_after = now() + interval '2 days' where id = $1", [v.id]));
    await sendDeletionReminders();
    expect((await notes(late.people.owner.id, "offboarding_update")).filter((n) => n.title.includes("will be deleted in"))).toHaveLength(2);
  });

  it("refuses to shut down anything it was not asked to, and takes the website down only when agreed", async () => {
    const quick = await messagingOrg({ name: "Unpublish Leaver" });
    await withSystem(async (db) => {
      const w = await db.query<{ id: string }>("insert into websites (org_id, name, template_key, subdomain, draft_content) values ($1, 'Site', 'summit.peak', $2, '{}'::jsonb) returning id", [quick.org.id, `unpub-${crypto.randomBytes(3).toString("hex")}`]);
      const hash = crypto.randomBytes(32).toString("hex");
      const v = await db.query<{ id: string }>("insert into website_versions (org_id, website_id, version, template_key, content, content_hash, source) values ($1, $2, 1, 'summit.peak', '{}'::jsonb, $3, 'publish') returning id", [quick.org.id, w.rows[0].id, hash]);
      const p = await db.query<{ id: string }>("insert into website_publications (org_id, website_id, number, version_id, template_key, content, content_hash, status) values ($1, $2, 1, $3, 'summit.peak', '{}'::jsonb, $4, 'live') returning id", [quick.org.id, w.rows[0].id, v.rows[0].id, hash]);
      await db.query("update websites set published_publication_id = $2 where id = $1", [w.rows[0].id, p.rows[0].id]);
    });
    const v = await requestOffboardingAsAgency(quick.superAdmin, quick.org.id, "Contract ended");
    expect(v.requestedByKind).toBe("agency");
    await shutdownClient(quick.superAdmin, v.id, { websitePlan: "unpublish_now" });
    expect((await withSystem((db) => db.query("select 1 from website_publications where org_id = $1 and status = 'live'", [quick.org.id]))).rows).toHaveLength(0);
  });

  it("runs from the scheduler", () => {
    expect(JOBS.map((j) => j.name)).toContain("offboardingReminders");
  });
});
