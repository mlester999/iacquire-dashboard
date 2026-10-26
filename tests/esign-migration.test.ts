import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { askToSign, handedOver, rows, sentForSigning, signingOrg } from "./support/proposals";
import { uid } from "./support/fixtures";

// Migration 0092: the schema, who can read it, what the database itself refuses, and a rollback that never drops a client's signing connection or the record of a signature.
// Each rollback case runs inside a transaction that is always rolled back, so the shared test database is untouched.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0092_esign.down.sql", "utf8");

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
  for (const stmt of statements(down)) await db.query(stmt);
};

/** What an operator does before the rollback is allowed to run: the requests and their history are exported and removed. The history is append-only, so that is done deliberately. */
const clearSigning = async (db: Db) => {
  await db.query("alter table signature_events disable trigger signature_events_immutable");
  await db.query("alter table proposal_decisions disable trigger proposal_decisions_append_only");
  await db.query("delete from proposal_decisions where signature_request_id is not null");
  await db.query("alter table proposal_decisions enable trigger proposal_decisions_append_only");
  await db.query("delete from signature_requests");
  await db.query("alter table signature_events enable trigger signature_events_immutable");
  await db.query("delete from esign_connections");
};

const TABLES = ["esign_connections", "signature_requests", "signature_events"];

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

  it("gives the application role select only, through the viewer's permission, and never the sealed keys or the hash of the notice address", async () => {
    const grants = await rows<{ t: string; read: boolean; write: boolean }>(
      `select t, has_any_column_privilege('iaq_app_user', format('public.%I', t), 'select') as read,
         has_any_column_privilege('iaq_app_user', format('public.%I', t), 'insert, update') or has_table_privilege('iaq_app_user', format('public.%I', t), 'delete, truncate') as write from unnest($1::text[]) t`, [TABLES],
    );
    for (const g of grants) {
      expect(g.write, `${g.t} must not be writable by the application role`).toBe(false);
      expect(g.read, g.t).toBe(true);
    }
    const policies = await rows<{ tablename: string; cmd: string; qual: string }>("select tablename, cmd, qual from pg_policies where tablename = any($1::text[])", [TABLES]);
    expect(policies.map((x) => x.tablename).sort()).toEqual([...TABLES].sort());
    for (const x of policies) {
      expect(x.cmd).toBe("SELECT");
      expect(x.qual).toContain("permitted_orgs('proposals.view'");
    }
    const cols = await rows<{ column_name: string; ok: boolean }>(
      `select column_name, has_column_privilege('iaq_app_user', 'public.esign_connections', column_name, 'select') as ok from information_schema.columns where table_schema = 'public' and table_name = 'esign_connections' order by ordinal_position`,
    );
    expect(cols.filter((c) => !c.ok).map((c) => c.column_name).sort()).toEqual(["credentials", "webhook_token_hash"]);
    expect(cols.filter((c) => c.ok).map((c) => c.column_name)).toEqual(expect.arrayContaining(["id", "org_id", "provider", "mode", "status", "status_detail"]));
  });

  it("lets a role read signing only if it holds the view permission, and a stranger nothing", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    const count = async (userId: string) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [userId]);
      await db.query("set local role iaq_app_user");
      const n = Number((await db.query<{ n: string }>("select count(*)::text as n from signature_requests")).rows[0].n);
      await db.query("reset role");
      return n;
    });
    expect(await Promise.all([p.people.owner.id, p.people.manager.id, p.people.sales.id, p.people.viewer.id].map(count))).toEqual([1, 1, 1, 1]);
    expect(await Promise.all([p.people.setter.id, p.people.support.id].map(count))).toEqual([0, 0]);
  });
});

describe("the permission", () => {
  it("is held by the owner and the manager only, in the database and in the code, and never by the agency", async () => {
    const seeded = await rows<{ role: string }>("select role from role_permissions where permission = 'proposals.connect' order by role");
    expect(seeded.map((r) => r.role)).toEqual(["admin", "owner"]);
    expect([...PERMISSION_MATRIX["proposals.connect"]].sort()).toEqual(["admin", "owner"]);
    expect(PERMISSION_MATRIX["proposals.connect"].filter((r) => r.startsWith("agency"))).toEqual([]);
  });
});

describe("what the database refuses", () => {
  async function world() {
    const p = await signingOrg();
    const h = await handedOver(p);
    const req = (await rows<{ id: string; connection_id: string; version_hash: string; pdf_sha256: string }>("select id, connection_id, version_hash, pdf_sha256 from signature_requests where id = $1", [h.requestId]))[0];
    return { p, h, req };
  }
  /** An insert of a request with whatever is overridden. */
  const insertRequest = (w: Awaited<ReturnType<typeof world>>, over: Record<string, unknown> = {}) => {
    const v: Record<string, unknown> = {
      org_id: w.p.org.id, proposal_id: w.h.proposal.id, proposal_version: 1, version_hash: w.req.version_hash, pdf_sha256: w.req.pdf_sha256, connection_id: w.req.connection_id, provider: "simulated", mode: "simulated",
      status: "voided", signer_name: "Maria Santos", signer_email: "maria@example.test", idempotency_key: `k-${uid()}`, ...over,
    };
    const keys = Object.keys(v);
    return { sql: `insert into signature_requests (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, params: Object.values(v) };
  };

  it("holds the shape of a connection", async () => {
    const p = await signingOrg({ connect: false });
    const org = p.org.id;
    const conn = (over: Record<string, unknown> = {}) => {
      const v: Record<string, unknown> = { org_id: org, provider: "simulated", mode: "simulated", webhook_token_hash: uid().replace(/-/g, "").padEnd(64, "a"), ...over };
      const keys = Object.keys(v);
      return { sql: `insert into esign_connections (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, params: Object.values(v) };
    };
    const results = await withSystem(async (db) => {
      const r: Record<string, string | null> = {};
      const probe = async (name: string, over: Record<string, unknown>) => { const c = conn(over); r[name] = await refused(db, c.sql, c.params); };
      await probe("provider", { provider: "docusign" });
      await probe("mode", { mode: "staging" });
      await probe("simulatedWithLiveMode", { provider: "simulated", mode: "live" });
      await probe("realWithSimulatedMode", { provider: "pandadoc", mode: "simulated" });
      await probe("status", { status: "great" });
      await probe("hash", { webhook_token_hash: "short" });
      await probe("upperHash", { webhook_token_hash: "A".repeat(64) });
      await probe("label", { label: "x".repeat(81) });
      await probe("revokedKeepsKeys", { status: "revoked", credentials: "sealed" });
      await probe("disconnectedKeepsKeys", { status: "disconnected", credentials: "sealed" });
      const first = conn({ webhook_token_hash: "b".repeat(64) });
      await db.query(first.sql, first.params);
      await probe("secondLive", {});
      await probe("sameAddress", { org_id: org, webhook_token_hash: "b".repeat(64), status: "disconnected" });
      // A connection that ended makes room for the next one.
      await db.query("update esign_connections set status = 'disconnected', credentials = null where org_id = $1", [org]);
      await probe("afterEnd", { webhook_token_hash: "c".repeat(64) });
      return r;
    });
    const { afterEnd, ...mustRefuse } = results;
    for (const [what, message] of Object.entries(mustRefuse)) expect(message, what).not.toBeNull();
    expect(results.secondLive).toMatch(/duplicate key/);
    expect(results.sameAddress).toMatch(/duplicate key/);
    expect(afterEnd, "an ended connection frees the slot").toBeNull();
  });

  it("holds the shape of a request, and keeps one live request per version of a proposal", async () => {
    const w = await world();
    const live = await rows<{ proposal_version: number }>("select proposal_version from signature_requests where id = $1 and status in ('queued', 'sending', 'sent', 'viewed', 'unknown')", [w.h.requestId]);
    expect(live).toHaveLength(1);
    const r = await withSystem(async (db) => {
      const out: Record<string, string | null> = {};
      const probe = async (name: string, over: Record<string, unknown>) => { const q = insertRequest(w, over); out[name] = await refused(db, q.sql, q.params); };
      await probe("status", { status: "signed" });
      await probe("hash", { version_hash: "short" });
      await probe("pdfHash", { pdf_sha256: "Z".repeat(64) });
      await probe("provider", { provider: "docusign" });
      await probe("mode", { mode: "test" });
      await probe("signerName", { signer_name: "   " });
      await probe("signerEmail", { signer_email: "not an email" });
      await probe("signerEmailSpaces", { signer_email: "a b@c.co" });
      await probe("version", { proposal_version: 0 });
      await probe("maxAttempts", { max_attempts: 11 });
      await probe("attempt", { attempt: -1 });
      await probe("errorKind", { last_error_kind: "oops" });
      await probe("notApplied", { not_applied_reason: "because" });
      await probe("cancelState", { cancel_state: "later" });
      await probe("completedWithoutDate", { status: "completed" });
      await probe("sentWithoutDocument", { status: "sent" });
      await probe("appliedButNotCompleted", { status: "voided", applied_at: new Date().toISOString() });
      await probe("reasonWithoutCompletion", { status: "voided", not_applied_reason: "voided" });
      await probe("appliedAndSetAside", { status: "completed", completed_at: new Date().toISOString(), applied_at: new Date().toISOString(), not_applied_reason: "voided" });
      await probe("signedFileWithoutCompletion", { status: "voided", signed_sha256: "a".repeat(64), signed_file_id: crypto.randomUUID() });
      await probe("secondLive", { status: "queued" });
      await probe("sameKey", { idempotency_key: "proposal:x:1:0" });
      const first = insertRequest(w, { idempotency_key: "proposal:x:1:0" });
      await db.query(first.sql, first.params);
      await probe("sameKey2", { idempotency_key: "proposal:x:1:0" });
      await probe("longKey", { idempotency_key: "k".repeat(161) });
      // Ended requests pile up as history without limit: the slot is for live ones.
      await probe("ended", { status: "voided", finished_at: new Date().toISOString() });
      await probe("endedAgain", { status: "failed" });
      return out;
    });
    const { ended, endedAgain, sameKey, ...mustRefuse } = r;
    for (const [what, message] of Object.entries(mustRefuse)) expect(message, what).not.toBeNull();
    expect(r.secondLive).toMatch(/signature_requests_live_idx|duplicate key/);
    expect(r.sameKey2).toMatch(/duplicate key/);
    expect(ended).toBeNull();
    expect(endedAgain).toBeNull();
    expect(sameKey).toBeNull();
  });

  it("gives a service's document to one request of one connection, and tells a request apart from a request of another workspace", async () => {
    const w = await world();
    const other = await signingOrg();
    const o = await handedOver(other);
    const oc = (await rows<{ connection_id: string; version_hash: string; pdf_sha256: string }>("select connection_id, version_hash, pdf_sha256 from signature_requests where id = $1", [o.requestId]))[0];
    const r = await withSystem(async (db) => {
      const out: Record<string, string | null> = {};
      const q = insertRequest(w, { status: "voided", provider_document_id: w.h.documentId });
      out.sameDocument = await refused(db, q.sql, q.params);
      // Another workspace's proposal named with this workspace's id, or this workspace's connection used for another's proposal: the composite keys refuse both.
      const a = insertRequest(w, { proposal_id: o.proposal.id });
      out.foreignProposal = await refused(db, a.sql, a.params);
      const b = insertRequest(w, { connection_id: oc.connection_id });
      out.foreignConnection = await refused(db, b.sql, b.params);
      const c = insertRequest(w, { org_id: other.org.id });
      out.foreignOrg = await refused(db, c.sql, c.params);
      return out;
    });
    expect(r.sameDocument).toMatch(/duplicate key/);
    for (const k of ["foreignProposal", "foreignConnection", "foreignOrg"]) expect(r[k], k).toMatch(/violates foreign key/);
  });

  it("keeps what was asked of the signer, never lets a completed request go back, and writes the facts it records only once", async () => {
    const w = await world();
    const r = await withSystem(async (db) => {
      const out: Record<string, string | null> = {};
      const id = w.h.requestId;
      for (const [name, set] of [
        ["version", "proposal_version = 2"], ["hash", `version_hash = '${"e".repeat(64)}'`], ["pdf", `pdf_sha256 = '${"e".repeat(64)}'`], ["signerName", "signer_name = 'Someone Else'"],
        ["signerEmail", "signer_email = 'else@example.test'"], ["key", "idempotency_key = 'something-else'"], ["provider", "provider = 'pandadoc', mode = 'sandbox'"],
        ["document", "provider_document_id = 'another_document_id'"],
      ] as const) out[name] = await refused(db, `update signature_requests set ${set} where id = $1`, [id]);
      await db.query("update signature_requests set status = 'completed', completed_at = now(), signed_sha256 = $2 where id = $1", [id, "a".repeat(64)]);
      out.back = await refused(db, "update signature_requests set status = 'sent' where id = $1", [id]);
      out.signedHash = await refused(db, "update signature_requests set signed_sha256 = $2 where id = $1", [id, "b".repeat(64)]);
      out.completedAt = await refused(db, "update signature_requests set completed_at = now() + interval '1 day' where id = $1", [id]);
      await db.query("update signature_requests set applied_at = now() where id = $1", [id]);
      out.appliedAt = await refused(db, "update signature_requests set applied_at = now() + interval '1 day' where id = $1", [id]);
      // What may still change on a completed request: where the signed copy is, and the bookkeeping around it.
      out.copy = await refused(db, "update signature_requests set copy_attempts = 3, last_polled_at = now() where id = $1", [id]);
      return out;
    });
    for (const [what, message] of Object.entries(r)) {
      if (what === "copy") expect(message, what).toBeNull();
      else expect(message, what).toMatch(/signature_requests: /);
    }
  });

  it("keeps the history as it was written, except for a departed client's purge, and records a delivery once", async () => {
    const w = await world();
    const r = await withSystem(async (db) => {
      const out: Record<string, string | null> = {};
      const org = w.p.org.id;
      const id = w.h.requestId;
      const ev = (kind: string, source: string, eid: string | null) => refused(db, "insert into signature_events (org_id, request_id, kind, source, provider_event_id) values ($1, $2, $3, $4, $5)", [org, id, kind, source, eid]);
      out.source = await ev("x", "carrier_pigeon", null);
      out.kind = await ev("", "system", null);
      out.longKind = await ev("k".repeat(41), "system", null);
      out.longEvent = await ev("x", "system", "e".repeat(201));
      out.emptyEvent = await ev("x", "system", "");
      await db.query("insert into signature_events (org_id, request_id, kind, source, provider_event_id) values ($1, $2, 'delivery', 'provider_webhook', 'evt-1')", [org, id]);
      out.replay = await ev("delivery", "provider_webhook", "evt-1");
      out.noEventIdTwice = await ev("note", "system", null);
      out.update = await refused(db, "update signature_events set kind = 'changed' where request_id = $1", [id]);
      out.delete = await refused(db, "delete from signature_events where request_id = $1", [id]);
      out.foreign = await refused(db, "insert into signature_events (org_id, request_id, kind, source) values ($1, $2, 'x', 'system')", [crypto.randomUUID(), id]);
      await db.query("select set_config('iaq.purge', 'on', true)");
      out.purge = await refused(db, "delete from signature_events where request_id = $1", [id]);
      await db.query("select set_config('iaq.purge', 'off', true)");
      out.afterPurge = await refused(db, "delete from signature_events where request_id = $1", [id]);
      return out;
    });
    for (const k of ["source", "kind", "longKind", "longEvent", "emptyEvent", "update", "delete", "afterPurge"]) expect(r[k], k).not.toBeNull();
    expect(r.update).toMatch(/append-only/);
    expect(r.delete).toMatch(/append-only/);
    expect(r.replay).toMatch(/duplicate key/);
    expect(r.foreign).toMatch(/violates foreign key/);
    // Several history lines without a service's event id are fine (they are ours); the purge switch lets a departed client's rows go and nothing else does.
    expect(r.noEventIdTwice).toBeNull();
    expect(r.purge).toBeNull();
  });

  it("makes a signature decision name its request, and no other decision carry one", async () => {
    const w = await world();
    const hash = w.req.version_hash;
    const insert = (cols: string, vals: string) => `insert into proposal_decisions (org_id, proposal_id, version, content_hash, ${cols}) values ($1, $2, 1, '${hash}', ${vals})`;
    const r = await withSystem(async (db) => {
      const out: Record<string, string | null> = {};
      const base = [w.p.org.id, w.h.proposal.id];
      out.signatureWithoutRequest = await refused(db, insert("decision, method", "'accepted', 'provider_signature'"), base);
      out.requestOnOtherMethod = await refused(db, insert("decision, method, recorded_by, signature_request_id", "'accepted', 'recorded_by_staff', $3, $4"), [...base, w.p.people.owner.id, w.h.requestId]);
      out.unknownRequest = await refused(db, insert("decision, method, signature_request_id", "'accepted', 'provider_signature', $3"), [...base, crypto.randomUUID()]);
      out.good = await refused(db, insert("decision, method, signature_request_id", "'accepted', 'provider_signature', $3"), [...base, w.h.requestId]);
      return out;
    });
    expect(r.signatureWithoutRequest).toMatch(/proposal_decisions_signature_method_check|violates check constraint/);
    expect(r.requestOnOtherMethod).not.toBeNull();
    expect(r.unknownRequest).toMatch(/violates foreign key/);
    expect(r.good).toBeNull();
  });

  it("refuses to delete a request that a recorded signature points at", async () => {
    const w = await world();
    await withSystem(async (db) => {
      await db.query("insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, signature_request_id) values ($1, $2, 1, $3, 'accepted', 'provider_signature', $4)", [w.p.org.id, w.h.proposal.id, w.req.version_hash, w.h.requestId]);
      await db.query("select set_config('iaq.purge', 'on', true)");
      await db.query("delete from signature_events where request_id = $1", [w.h.requestId]);
      expect(await refused(db, "delete from signature_requests where id = $1", [w.h.requestId])).toMatch(/violates foreign key/);
    });
  });
});

describe("the rollback", () => {
  it("removes what 0092 added and leaves proposals, their decisions and 0091 exactly where they were", async () => {
    let report: { tables: number; permission: number; fk: number; check: number; guard: number; decisions: number; proposals: number } | null = null;
    await expect(
      withSystem(async (db) => {
        await clearSigning(db);
        await runDown(db);
        const q = async <T>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows;
        report = {
          tables: (await q("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).length,
          permission: (await q("select 1 from role_permissions where permission = 'proposals.connect'")).length,
          fk: (await q("select 1 from pg_constraint where conname = 'proposal_decisions_signature_request_fkey'")).length,
          check: (await q("select 1 from pg_constraint where conname = 'proposal_decisions_signature_method_check'")).length,
          guard: (await q("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('signature_requests_guard', 'signature_events_append_only')")).length,
          decisions: (await q("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = 'proposal_decisions'")).length,
          proposals: (await q("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = 'proposals'")).length,
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({ tables: 0, permission: 0, fk: 0, check: 0, guard: 0, decisions: 1, proposals: 1 });
    // It was only rolled back in a transaction: the tables are all still there.
    expect((await rows("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).length).toBe(TABLES.length);
  });

  it("refuses while a signing request exists, and while even a disconnected connection does", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    // A request (with its history and its connection) exists: refused.
    await expect(withSystem(async (db) => {
      await runDown(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused: signing service connections or signature requests exist/);
    // Everything cleared except a connection that was disconnected: a disconnected connection is still history, so still refused.
    await expect(withSystem(async (db) => {
      await clearSigning(db);
      await db.query("insert into esign_connections (org_id, provider, mode, webhook_token_hash, status) values ($1, 'simulated', 'simulated', $2, 'disconnected')", [p.org.id, "e".repeat(64)]);
      await runDown(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused/);
    await expect(withSystem(async (db) => {
      await clearSigning(db);
      await db.query("insert into esign_connections (org_id, provider, mode, webhook_token_hash) values ($1, 'simulated', 'simulated', $2)", [p.org.id, "d".repeat(64)]);
      await runDown(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused/);
  });

  it("runs once a client has exported and cleared its signing records, including a recorded signature", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withSystem((db) => db.query(
      "insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, signature_request_id) select org_id, proposal_id, proposal_version, version_hash, 'accepted', 'provider_signature', id from signature_requests where id = $1",
      [h.requestId],
    ));
    await expect(withSystem(async (db) => {
      await runDown(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused/);
    await expect(withSystem(async (db) => {
      await clearSigning(db);
      expect((await db.query("select 1 from proposal_decisions where signature_request_id is not null")).rows).toEqual([]);
      await runDown(db);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});
