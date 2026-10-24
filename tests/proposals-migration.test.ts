import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { customerFor, draftBy, proposalOrg, rows } from "./support/proposals";
import { createUser, uid } from "./support/fixtures";

// Migration 0091: the schema, who can read it, what the database itself refuses, and a rollback that never drops a client's price book, a sent document or a recorded answer.
// Each rollback case runs inside a transaction that is always rolled back, so the shared test database is untouched.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0091_proposals.down.sql", "utf8");
// 0092's tables hang off proposals, so a real rollback takes 0092 out first.
const downEsign = readFileSync("supabase/rollbacks/0092_esign.down.sql", "utf8");

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
const runDown = async (db: Db) => {
  for (const stmt of statements(downEsign)) await db.query(stmt);
  for (const stmt of statements(down)) await db.query(stmt);
};

/**
 * What an operator does before a rollback that is allowed to run: everything the guard looks at is exported and removed. The history and the recorded answers are append-only
 * by design, so clearing them means switching their triggers off, deliberately, for this one transaction.
 */
const clearAll = async (db: Db) => {
  await db.query("alter table signature_events disable trigger signature_events_immutable");
  await db.query("delete from signature_requests");
  await db.query("alter table signature_events enable trigger signature_events_immutable");
  await db.query("delete from esign_connections");
  await db.query("alter table proposal_events disable trigger proposal_events_immutable");
  await db.query("alter table proposal_decisions disable trigger proposal_decisions_append_only");
  await db.query("delete from proposals");
  await db.query("alter table proposal_events enable trigger proposal_events_immutable");
  await db.query("alter table proposal_decisions enable trigger proposal_decisions_append_only");
  for (const t of ["proposal_ai_runs", "proposal_templates", "proposal_catalog_items", "proposal_tax_rates"]) await db.query(`delete from ${t}`);
  // The messages that delivered a proposal outlive it (the delivery row only points at them), and the rollback refuses while any exists.
  await db.query("delete from conversation_messages where scope = 'delivery'");
  await db.query("delete from private_files where bucket = 'proposal-documents'");
  await db.query("delete from notifications where kind like 'proposal\\_%' or kind like 'signature\\_%'");
};

const TABLES = [
  "proposal_settings", "proposal_counters", "proposal_tax_rates", "proposal_catalog_items", "proposal_templates", "proposal_template_versions", "proposal_ai_runs", "proposals",
  "proposal_versions", "proposal_events", "proposal_share_links", "proposal_link_challenges", "proposal_link_sessions", "proposal_deliveries", "proposal_decisions",
];
const READABLE = TABLES.filter((t) => !["proposal_counters", "proposal_link_challenges", "proposal_link_sessions"].includes(t));
const KINDS = ["proposal_approval_requested", "proposal_approval_decided", "proposal_viewed", "proposal_accepted", "proposal_declined", "proposal_changes_requested", "proposal_expiring", "signature_completed", "signature_failed"];
const PERMISSIONS = ["proposals.view", "proposals.create", "proposals.discount", "proposals.approve", "proposals.send", "proposals.record_decision", "proposals.catalog", "proposals.settings"] as const;

/** Runs a statement that the database must refuse, inside a savepoint so the transaction survives; returns the message. */
async function refused(db: Db, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    await db.query("rollback to savepoint probe");
    return null;
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return String((e as Error).message);
  }
}

describe("the schema is closed by default", () => {
  it("has row-level security on every table and no access for anon, authenticated, PUBLIC or the published-site role", async () => {
    const meta = await rows<{ relname: string; relrowsecurity: boolean; relacl: string | null }>("select relname, relrowsecurity, relacl::text as relacl from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES]);
    expect(meta.map((m) => m.relname).sort()).toEqual([...TABLES].sort());
    for (const m of meta) {
      expect(m.relrowsecurity, m.relname).toBe(true);
      expect(m.relacl ?? "", m.relname).not.toMatch(/(^\{|,)=/);
      for (const role of ["anon", "authenticated", "iaq_site_runtime"]) expect(m.relacl ?? "", `${m.relname} ${role}`).not.toContain(`${role}=`);
    }
    const priv = await rows<{ t: string; ok: boolean }>(
      `select t, bool_or(has_any_column_privilege(r, format('public.%I', t), 'select, insert, update, references')) as ok from unnest($1::text[]) t, unnest(array['anon', 'authenticated', 'iaq_site_runtime']) r group by t`, [TABLES],
    );
    expect(priv.filter((x) => x.ok)).toEqual([]);
  });

  it("gives the application role select only, through the viewer's permission, and nothing at all on the counter, the emailed codes and the sessions", async () => {
    const grants = await rows<{ t: string; read: boolean; write: boolean }>(
      `select t, has_any_column_privilege('iaq_app_user', format('public.%I', t), 'select') as read,
         has_any_column_privilege('iaq_app_user', format('public.%I', t), 'insert, update') or has_table_privilege('iaq_app_user', format('public.%I', t), 'delete, truncate') as write from unnest($1::text[]) t`, [TABLES],
    );
    for (const g of grants) {
      expect(g.write, `${g.t} must not be writable by the application role`).toBe(false);
      expect(g.read, g.t).toBe(READABLE.includes(g.t));
    }
    const policies = await rows<{ tablename: string; cmd: string; qual: string }>("select tablename, cmd, qual from pg_policies where tablename = any($1::text[])", [TABLES]);
    expect(policies.map((x) => x.tablename).sort()).toEqual([...READABLE].sort());
    for (const x of policies) {
      expect(x.cmd).toBe("SELECT");
      expect(x.qual).toContain("permitted_orgs('proposals.view'");
    }
    const link = await rows<{ token: boolean; email: boolean }>("select has_column_privilege('iaq_app_user', 'public.proposal_share_links', 'token_hash', 'select') as token, has_column_privilege('iaq_app_user', 'public.proposal_share_links', 'recipient_email', 'select') as email");
    expect(link[0]).toEqual({ token: false, email: true });
  });

  it("lets a role read proposals only if it holds the view permission, and a stranger or an outsider nothing", async () => {
    const p = await proposalOrg();
    await draftBy(p, "owner");
    const outsider = await createUser();
    const count = async (userId: string) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [userId]);
      await db.query("set local role iaq_app_user");
      const n = Number((await db.query<{ n: string }>("select count(*)::text as n from proposals")).rows[0].n);
      await db.query("reset role");
      return n;
    });
    expect(await Promise.all([p.people.owner.id, p.people.manager.id, p.people.sales.id, p.people.viewer.id].map(count))).toEqual([1, 1, 1, 1]);
    expect(await Promise.all([p.people.setter.id, p.people.support.id, outsider.id].map(count))).toEqual([0, 0, 0]);
  });
});

describe("the permissions", () => {
  it("are seeded for the roles the product says, and for no others", async () => {
    const seeded = await rows<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'proposals.%' order by permission, role");
    const byPermission = (perm: string) => seeded.filter((r) => r.permission === perm).map((r) => r.role).sort();
    expect(byPermission("proposals.view")).toEqual(["admin", "agency_manager", "agency_staff", "agency_super_admin", "member", "owner", "sales_rep", "viewer"]);
    expect(byPermission("proposals.create")).toEqual(["admin", "member", "owner", "sales_rep"]);
    expect(byPermission("proposals.discount")).toEqual(["admin", "owner"]);
    expect(byPermission("proposals.approve")).toEqual(["admin", "owner"]);
    expect(byPermission("proposals.send")).toEqual(["admin", "owner", "sales_rep"]);
    expect(byPermission("proposals.record_decision")).toEqual(["admin", "owner"]);
    expect(byPermission("proposals.catalog")).toEqual(["admin", "agency_manager", "agency_staff", "agency_super_admin", "owner"]);
    expect(byPermission("proposals.settings")).toEqual(["owner"]);
    for (const perm of PERMISSIONS) expect([...PERMISSION_MATRIX[perm]].sort(), perm).toEqual(byPermission(perm));
    // The agency never sends, approves or accepts for a client.
    for (const perm of ["proposals.create", "proposals.discount", "proposals.approve", "proposals.send", "proposals.record_decision", "proposals.settings"] as const) {
      expect(PERMISSION_MATRIX[perm].filter((r) => r.startsWith("agency")), perm).toEqual([]);
    }
  });

  it("gives the proposal-documents bucket, from 0090, the same people who hold the create and view permissions", async () => {
    const p = await proposalOrg();
    const truth = await withSystem(async (db) => {
      const out: Record<string, [boolean, boolean]> = {};
      for (const [who, user] of Object.entries(p.people)) {
        await db.query("select set_config('app.user_id', $1, true)", [user.id]);
        const r = async (write: boolean) => (await db.query<{ ok: boolean }>("select app.file_permission($1, 'proposal-documents', $2, 'client') as ok", [p.org.id, write])).rows[0].ok;
        out[who] = [await r(false), await r(true)];
      }
      return out;
    });
    expect(truth).toEqual({ owner: [true, true], manager: [true, true], sales: [true, true], setter: [false, false], support: [false, false], viewer: [true, false] });
  });
});

describe("the notification kinds", () => {
  it("are accepted, alongside every kind that was there before, and an unknown kind is still refused", async () => {
    const p = await proposalOrg();
    const def = (await rows<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check'"))[0].d;
    const allowed = new Set([...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]));
    for (const k of KINDS) expect(allowed.has(k), k).toBe(true);
    for (const k of ["social_post_failed", "conversation_assigned", "web_chat_lead", "support_reply", "system"]) expect(allowed.has(k), k).toBe(true);
    await withSystem(async (db) => {
      for (const k of KINDS) await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, $3, 'probe')", [p.org.id, p.people.owner.id, k]);
      expect(await refused(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'proposal_nonsense', 'probe')", [p.org.id, p.people.owner.id])).toMatch(/notifications_kind_check/);
    });
  });
});

describe("what the database refuses", () => {
  it("holds the shape of a proposal, a template, a price book entry, a link and a recorded answer", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    const sent = await draftBy(p, "sales");
    const owner = p.people.owner.id;
    const org = p.org.id;
    const results = await withSystem(async (db) => {
      const r: Record<string, string | null> = {};
      r.number = await refused(db, "update proposals set number = 'X-1' where id = $1", [draft.id]);
      r.numberTwice = await refused(db, "update proposals set number = (select number from proposals where id = $2) where id = $1", [draft.id, sent.id]);
      r.currency = await refused(db, "update proposals set currency = 'usd' where id = $1", [draft.id]);
      r.email = await refused(db, "update proposals set client_email = 'not an email' where id = $1", [draft.id]);
      r.negative = await refused(db, "update proposals set monthly_total_minor = -1 where id = $1", [draft.id]);
      r.status = await refused(db, "update proposals set status = 'archived' where id = $1", [draft.id]);
      r.origin = await refused(db, "update proposals set origin = 'robot' where id = $1", [draft.id]);
      r.docType = await refused(db, "update proposals set doc = '[]'::jsonb where id = $1", [draft.id]);
      r.signature = await refused(db, "update proposals set signature_state = 'signed' where id = $1", [draft.id]);
      await db.query("insert into proposal_templates (org_id, key, name) values ($1, 'shape', 'Shape')", [org]);
      r.templateBack = await refused(db, "update proposal_templates set approved_version = 5, status = 'approved', approved_at = now() where org_id = $1 and key = 'shape'", [org]);
      r.templateNoDate = await refused(db, "update proposal_templates set status = 'approved' where org_id = $1 and key = 'shape'", [org]);
      r.price = await refused(db, "insert into proposal_catalog_items (org_id, name, unit_price_minor, currency) values ($1, 'x', -5, 'USD')", [org]);
      r.billing = await refused(db, "insert into proposal_catalog_items (org_id, name, unit_price_minor, currency, billing) values ($1, 'x', 5, 'USD', 'weekly')", [org]);
      r.taxRate = await refused(db, "insert into proposal_tax_rates (org_id, name, rate_bps) values ($1, 'Too much', 10001)", [org]);
      r.taxName = await refused(db, "insert into proposal_tax_rates (org_id, name, rate_bps) values ($1, 'SALES TAX', 100)", [org]);
      r.token = await refused(db, "insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 1, 'short', now() + interval '1 day')", [org, draft.id]);
      r.channel = await refused(db, "insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at, delivery_channel) values ($1, $2, 1, repeat('a', 64), now() + interval '1 day', 'carrier_pigeon')", [org, draft.id]);
      await db.query("insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 1, repeat('a', 64), now() + interval '1 day')", [org, draft.id]);
      r.secondLink = await refused(db, "insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 1, repeat('b', 64), now() + interval '1 day')", [org, draft.id]);
      r.sameToken = await refused(db, "insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 2, repeat('a', 64), now() + interval '1 day')", [org, sent.id]);
      await db.query("update proposal_share_links set revoked_at = now() where proposal_id = $1", [draft.id]);
      r.linkAfterRevoke = await refused(db, "insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 1, repeat('c', 64), now() + interval '1 day')", [org, draft.id]);
      const decide = (cols: string, vals: string) => `insert into proposal_decisions (org_id, proposal_id, version, content_hash, ${cols}) values ($1, $2, 1, repeat('a', 64), ${vals})`;
      r.staffWithoutPerson = await refused(db, decide("decision, method", "'accepted', 'recorded_by_staff'"), [org, draft.id]);
      r.personWithoutStaff = await refused(db, decide("decision, method, recorded_by", "'accepted', 'verified_acknowledgement', $3"), [org, draft.id, owner]);
      r.verifiedWithoutAck = await refused(db, decide("decision, method, decided_email", "'accepted', 'verified_acknowledgement', 'a@example.test'"), [org, draft.id]);
      r.signatureDecline = await refused(db, decide("decision, method", "'declined', 'provider_signature'"), [org, draft.id]);
      r.decision = await refused(db, decide("decision, method, recorded_by", "'maybe', 'recorded_by_staff', $3"), [org, draft.id, owner]);
      return r;
    });
    const { linkAfterRevoke, ...mustRefuse } = results;
    for (const [what, message] of Object.entries(mustRefuse)) expect(message, what).not.toBeNull();
    expect(results.sameToken).toMatch(/duplicate key/);
    expect(results.secondLink).toMatch(/duplicate key/);
    expect(results.numberTwice).toMatch(/duplicate key/);
    expect(results.taxName).toMatch(/duplicate key/);
    expect(linkAfterRevoke, "a revoked link frees the version").toBeNull();
  });

  it("keeps a template version as it was saved", async () => {
    const p = await proposalOrg();
    const org = p.org.id;
    await withSystem(async (db) => {
      const t = (await db.query<{ id: string }>("insert into proposal_templates (org_id, key, name) values ($1, 'frozen', 'Frozen') returning id", [org])).rows[0].id;
      await db.query("insert into proposal_template_versions (org_id, template_id, version, doc, content_hash) values ($1, $2, 1, '{\"v\":1}'::jsonb, repeat('a', 64))", [org, t]);
      expect(await refused(db, "update proposal_template_versions set doc = '{}'::jsonb where template_id = $1", [t])).toMatch(/cannot be changed once saved/);
      expect(await refused(db, "insert into proposal_template_versions (org_id, template_id, version, doc, content_hash) values ($1, $2, 1, '{}'::jsonb, repeat('b', 64))", [org, t])).toMatch(/duplicate key/);
    });
  });
});

describe("the deliveries", () => {
  it("accept the delivery message scope, keep every scope that was there, and refuse one that is not", async () => {
    const p = await proposalOrg();
    const c = await customerFor(p);
    const def = (await rows<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'conversation_messages_scope_check'"))[0].d;
    const scopes = [...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
    expect(scopes).toEqual(expect.arrayContaining(["reply", "followup", "human", "reminder", "retention", "billing", "delivery"]));
    await withSystem(async (db) => {
      const conv = (await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key) values ($1, $2, 'email', 'scope-probe') returning id", [p.org.id, c.contactId])).rows[0].id;
      const insert = (scope: string) => `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'system', 'x', 'queued', '${scope}')`;
      expect(await refused(db, insert("delivery"), [p.org.id, conv])).toBeNull();
      expect(await refused(db, insert("deliveries"), [p.org.id, conv])).toMatch(/conversation_messages_scope_check/);
    });
  });

  it("hold the shape of a delivery: its channel, its fingerprint, its pair of stop columns, and a message of its own workspace and of the delivery scope", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const c = await customerFor(p);
    const oc = await customerFor(other);
    const draft = await draftBy(p, "sales");
    const second = await draftBy(p, "sales");
    const org = p.org.id;
    const results = await withSystem(async (db) => {
      const link = async (proposalId: string, version = 1) =>
        (await db.query<{ id: string }>("insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, $3, md5($4::text) || md5($4::text || 't'), now() + interval '1 day') returning id", [org, proposalId, version, uid()])).rows[0].id;
      const message = async (orgId: string, contactId: string, scope: string, thread: string) => {
        const conv = (await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key) values ($1, $2, 'email', $3) returning id", [orgId, contactId, thread])).rows[0].id;
        return (await db.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'system', 'x', 'queued', $3) returning id", [orgId, conv, scope])).rows[0].id;
      };
      const l1 = await link(draft.id);
      const l2 = await link(second.id);
      const good = await message(org, c.contactId, "delivery", `d-${uid()}`);
      const insert = `insert into proposal_deliveries (org_id, proposal_id, version, link_id, channel, message_id, wording_version, wording_hash, address_mask) values ($1, $2, 1, $3, $4, $5, 'draft-test', $6, $7)`;
      const hash = "a".repeat(64);
      const r: Record<string, string | null> = {};
      r.channel = await refused(db, insert, [org, draft.id, l1, "carrier_pigeon", good, hash, null]);
      r.hash = await refused(db, insert, [org, draft.id, l1, "email", good, "not-a-hash", null]);
      r.mask = await refused(db, insert, [org, draft.id, l1, "email", good, hash, "x".repeat(81)]);
      r.wording = await refused(db, "insert into proposal_deliveries (org_id, proposal_id, version, link_id, channel, wording_version, wording_hash) values ($1, $2, 1, $3, 'email', '', $4)", [org, draft.id, l1, hash]);
      r.version = await refused(db, insert.replace("$2, 1, $3", "$2, 0, $3"), [org, draft.id, l1, "email", good, hash, null]);
      // The link must be of this proposal and this version.
      r.otherProposalsLink = await refused(db, insert, [org, draft.id, l2, "email", good, hash, null]);
      r.otherVersion = await refused(db, insert.replace("$2, 1, $3", "$2, 2, $3"), [org, draft.id, l1, "email", good, hash, null]);
      r.otherOrgsProposal = await refused(db, insert, [other.org.id, draft.id, l1, "email", good, hash, null]);
      // The message must be a delivery message of the same workspace.
      const plain = await message(org, c.contactId, "reply", `r-${uid()}`);
      const foreign = await message(other.org.id, oc.contactId, "delivery", `f-${uid()}`);
      r.notDelivery = await refused(db, insert, [org, draft.id, l1, "email", plain, hash, null]);
      r.foreign = await refused(db, insert, [org, draft.id, l1, "email", foreign, hash, null]);
      r.noMessage = await refused(db, insert, [org, draft.id, l1, "email", "00000000-0000-4000-8000-000000000000", hash, null]);
      // A reason goes with the time a delivery was stopped, and the time with the reason.
      await db.query(insert, [org, draft.id, l1, "email", good, hash, "a***@example.test"]);
      r.reasonAlone = await refused(db, "update proposal_deliveries set withdrawn_reason = 'proposal_withdrawn' where proposal_id = $1", [draft.id]);
      r.timeAlone = await refused(db, "update proposal_deliveries set withdrawn_at = now() where proposal_id = $1", [draft.id]);
      r.longReason = await refused(db, "update proposal_deliveries set withdrawn_at = now(), withdrawn_reason = $2 where proposal_id = $1", [draft.id, "x".repeat(41)]);
      r.pair = await refused(db, "update proposal_deliveries set withdrawn_at = now(), withdrawn_reason = 'proposal_withdrawn' where proposal_id = $1", [draft.id]);
      // One delivery per message.
      r.sameMessage = await refused(db, insert, [org, second.id, l2, "email", good, hash, null]);
      // Moving a delivery to another message goes through the same guard.
      r.moved = await refused(db, "update proposal_deliveries set message_id = $2 where proposal_id = $1", [draft.id, plain]);
      return r;
    });
    const { pair, ...mustRefuse } = results;
    for (const [what, message] of Object.entries(mustRefuse)) expect(message, what).not.toBeNull();
    expect(results.sameMessage).toMatch(/duplicate key/);
    expect(results.notDelivery).toMatch(/must point at a delivery message of its own workspace/);
    expect(results.foreign).toMatch(/must point at a delivery message of its own workspace/);
    expect(results.moved).toMatch(/must point at a delivery message of its own workspace/);
    expect(pair, "a reason and a time together are fine").toBeNull();
  });

  it("are deleted with their proposal, and their message stays for the send chain's own record", async () => {
    const p = await proposalOrg();
    const c = await customerFor(p);
    const draft = await draftBy(p, "sales");
    const messageId = await withSystem(async (db) => {
      const link = (await db.query<{ id: string }>("insert into proposal_share_links (org_id, proposal_id, version, token_hash, expires_at) values ($1, $2, 1, md5($3::text) || md5($3::text || 't'), now() + interval '1 day') returning id", [p.org.id, draft.id, uid()])).rows[0].id;
      const conv = (await db.query<{ id: string }>("insert into conversations (org_id, contact_id, channel, thread_key) values ($1, $2, 'email', $3) returning id", [p.org.id, c.contactId, `d-${uid()}`])).rows[0].id;
      const m = (await db.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'system', 'x {{proposal.link}}', 'queued', 'delivery') returning id", [p.org.id, conv])).rows[0].id;
      await db.query("insert into proposal_deliveries (org_id, proposal_id, version, link_id, channel, message_id, wording_version, wording_hash) values ($1, $2, 1, $3, 'email', $4, 'draft-test', repeat('a', 64))", [p.org.id, draft.id, link, m]);
      return m;
    });
    expect(await rows("select 1 from proposal_deliveries where proposal_id = $1", [draft.id])).toHaveLength(1);
    await withSystem(async (db) => {
      await db.query("alter table proposal_events disable trigger proposal_events_immutable");
      await db.query("delete from proposals where id = $1", [draft.id]);
      await db.query("alter table proposal_events enable trigger proposal_events_immutable");
    });
    expect(await rows("select 1 from proposal_deliveries where proposal_id = $1", [draft.id])).toHaveLength(0);
    expect(await rows("select 1 from conversation_messages where id = $1", [messageId])).toHaveLength(1);
  });
});

describe("the rollback", () => {
  it("removes what 0091 added and leaves 0090's bucket and its file rule exactly where they were", async () => {
    let report: { tables: number; permissions: number; kinds: string[]; bucket: number; rule: boolean; stillThere: boolean } | null = null;
    await expect(
      withSystem(async (db) => {
        await clearAll(db);
        await runDown(db);
        const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows;
        const def = (await q<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check'"))[0].d;
        report = {
          tables: (await q("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).length,
          permissions: (await q("select 1 from role_permissions where permission like 'proposals.%'")).length,
          kinds: KINDS.filter((k) => def.includes(`'${k}'`)),
          bucket: (await q("select 1 from storage.buckets where id = 'proposal-documents'")).length,
          rule: String((await q<{ s: string }>("select prosrc as s from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'file_permission'"))[0].s).includes("proposal-documents"),
          stillThere: (await q("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('proposal_versions_frozen', 'proposal_decisions_append_only')")).length > 0,
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ tables: 0, permissions: 0, kinds: [], bucket: 1, rule: true, stillThere: false });
    // It was only rolled back in a transaction: the tables are all still there.
    expect((await rows("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).length).toBe(TABLES.length);
  });

  it("refuses while a proposal, a price book entry, a tax rate, a template, an AI run, a stored proposal document or a proposal notification exists", async () => {
    const p = await proposalOrg();
    // Each case starts from a database the rollback would accept, then adds one thing it must not drop.
    const cases: Array<[string, string, unknown[]]> = [
      ["a proposal", "insert into proposals (org_id, number, title, currency) values ($1, 'P-9001', 'Probe', 'USD')", [p.org.id]],
      ["a price book entry", "insert into proposal_catalog_items (org_id, name, unit_price_minor, currency) values ($1, 'Probe', 1, 'USD')", [p.org.id]],
      ["a tax rate", "insert into proposal_tax_rates (org_id, name, rate_bps) values ($1, 'Probe', 100)", [p.org.id]],
      ["a template", "insert into proposal_templates (org_id, key, name) values ($1, 'probe', 'Probe')", [p.org.id]],
      ["an AI run", "insert into proposal_ai_runs (org_id, status) values ($1, 'succeeded')", [p.org.id]],
      ["a stored document", "insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'proposal-documents', $2, 'p.pdf', 'application/pdf', 10, 'ready')", [p.org.id, `${p.org.id}/${uid()}/p.pdf`]],
      ["a notification", "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'proposal_accepted', 'Probe')", [p.org.id, p.people.owner.id]],
    ];
    // A message that carried a customer's link outlives its proposal in the send chain, so it is looked at on its own.
    const customer = await customerFor(p);
    cases.push(["a message that delivered a proposal", "with c as (insert into conversations (org_id, contact_id, channel, thread_key) values ($1, $2, 'email', 'proposal:probe') returning id) insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) select $1, id, 'outbound', 'system', 'x {{proposal.link}}', 'queued', 'delivery' from c", [p.org.id, customer.contactId]]);
    for (const [what, sql, params] of cases) {
      await expect(
        withSystem(async (db) => {
          await clearAll(db);
          await db.query(sql, params);
          await runDown(db);
          throw new Done();
        }),
        what,
      ).rejects.toThrow(/Rollback refused/);
    }
  });

  it("takes the delivery scope out of the message scopes and leaves every other scope as it was", async () => {
    let after: string[] = [];
    let before: string[] = [];
    await expect(
      withSystem(async (db) => {
        const scopes = async () => {
          const d = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'conversation_messages_scope_check'")).rows[0].d;
          return [...d.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
        };
        before = await scopes();
        await clearAll(db);
        await runDown(db);
        after = await scopes();
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(before).toContain("delivery");
    expect(after).not.toContain("delivery");
    expect(after).toEqual(before.filter((s) => s !== "delivery"));
    expect(after).toEqual(expect.arrayContaining(["reply", "followup", "human", "reminder", "retention", "billing"]));
  });

  it("runs once a client has exported and cleared its proposals, the append-only history included", async () => {
    const p = await proposalOrg();
    await draftBy(p, "owner");
    // With the history still in place the rollback refuses (the proposal is what it looks at); after the export and clear-out it runs.
    await expect(withSystem(async (db) => {
      await db.query("delete from proposal_catalog_items");
      await db.query("delete from proposal_tax_rates");
      await runDown(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused/);
    await expect(withSystem(async (db) => {
      await clearAll(db);
      await runDown(db);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});
