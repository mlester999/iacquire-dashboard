// EMULATED policies in actual local PostgreSQL. Does not contact live Supabase services.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { readPrivateFile, signPrivateFile, uploadPrivateFile, validPrivateFilePath, type PrivateBucket } from "@/server/storage/private";

let a: Awaited<ReturnType<typeof createOrg>>;
let b: Awaited<ReturnType<typeof createOrg>>;
let owner: Awaited<ReturnType<typeof createUser>>;
let other: Awaited<ReturnType<typeof createUser>>;
let staff: Awaited<ReturnType<typeof createUser>>;
let file: { id: string; storageKey: string; bucket: PrivateBucket };
let uploads: string;

async function jwt<T>(userId: string | null, fn: (db: Queryable) => Promise<T>, spoofId?: string) {
  return withSystem(async (db) => {
    await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId ?? ""]);
    await db.query("select set_config('app.user_id',$1,true)", [spoofId ?? ""]);
    await db.query(`set local role ${userId ? "authenticated" : "anon"}`);
    return fn(db);
  });
}
async function link(id: string, email: string) {
  await withSystem(async (db) => {
    await db.query("insert into auth.users(id,email) values($1,$2)", [id,email]);
    await db.query("update users set auth_user_id=$1 where id=$1", [id]);
  });
}
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-supabase-security-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
  a = await createOrg(); b = await createOrg();
  owner = await createUser(); other = await createUser(); staff = await createUser({ platformRole: "agency_staff" });
  await addMember(a.id,owner.id,"owner"); await addMember(b.id,other.id,"owner");
  for (const user of [owner,other,staff]) await link(user.id,user.email);
  file = await uploadPrivateFile({ userId: owner.id,orgId:a.id,bucket:"company-documents",path:`${a.id}/${crypto.randomUUID()}/guide.txt`,bytes:Buffer.from("Company private guide"),contentType:"text/plain" });
  await withSystem((db) => db.query("insert into storage.objects(bucket_id,name) values($1,$2)", [file.bucket,file.storageKey]));
});
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-supabase-security-")) {
    await fs.rm(uploads, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  resetEnvCache();
});
describe("Supabase policies — EMULATED", () => {
  it("RLS is enabled for every public application table", async () => {
    const result = await withSystem((db) => db.query("select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity"));
    expect(result.rows).toEqual([]);
  });
  it("the Data API cannot read app profiles, credentials or migration data", async () => {
    for (const table of ["users","organizations","chat_conversations","integration_credentials","credential_references","auth_account_migrations"]) {
      await expect(jwt(owner.id,(db) => db.query(`select * from public.${table}`))).rejects.toThrow(/permission denied/);
    }
  });
  it("no public execute remains on security-definer helpers", async () => {
    const result = await withSystem((db) => db.query("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl where n.nspname='app' and p.prosecdef and acl.grantee=0 and acl.privilege_type='EXECUTE'"));
    expect(result.rows).toEqual([]);
  });
  it("private buckets are never public", async () => {
    const result = await withSystem((db) => db.query("select public from storage.buckets where id in ('company-documents','support-attachments','project-files')"));
    expect(result.rows).toEqual([{ public:false },{ public:false },{ public:false }]);
  });
  it("JWT Storage read succeeds only in the correct tenant", async () => {
    expect((await jwt(owner.id,(db) => db.query("select name from storage.objects where name=$1", [file.storageKey]))).rows).toHaveLength(1);
    expect((await jwt(other.id,(db) => db.query("select name from storage.objects where name=$1", [file.storageKey]))).rows).toEqual([]);
    expect((await jwt(staff.id,(db) => db.query("select name from storage.objects where name=$1", [file.storageKey]))).rows).toEqual([]);
    expect((await jwt(null,(db) => db.query("select name from storage.objects where name=$1", [file.storageKey]))).rows).toEqual([]);
  });
  it("client-supplied app.user_id cannot impersonate another JWT subject", async () => {
    const identity = await jwt(other.id,(db) => db.query("select app.current_user_id() as id"),owner.id);
    expect(identity.rows).toEqual([{ id:other.id }]);
    expect((await jwt(other.id,(db) => db.query("select name from storage.objects"),owner.id)).rows).toEqual([]);
  });
  it("Storage writes and realtime broadcasts cannot be sent directly by clients", async () => {
    await expect(jwt(owner.id,(db) => db.query("insert into storage.objects(bucket_id,name) values('company-documents',$1)", [`${a.id}/${crypto.randomUUID()}`]))).rejects.toThrow(/row-level security/);
    await expect(jwt(owner.id,(db) => db.query("insert into realtime.messages(topic,extension) values($1,'broadcast')", [`setup:${a.id}`]))).rejects.toThrow(/row-level security/);
  });
  it("setup subscriptions reject cross-tenant and malformed topics", async () => {
    expect((await jwt(owner.id,(db) => db.query("select app.setup_topic_allowed($1) as allowed", [`setup:${a.id}`]))).rows).toEqual([{allowed:true}]);
    for (const topic of [`setup:${b.id}`,"setup:*","setup:invalid","global"]) {
      expect((await jwt(owner.id,(db) => db.query("select app.setup_topic_allowed($1) as allowed", [topic]))).rows).toEqual([{allowed:false}]);
    }
  });
  it("membership revocation immediately removes file and topic authorization", async () => {
    const user = await createUser(); await link(user.id,user.email); await addMember(a.id,user.id,"member");
    expect((await jwt(user.id,(db) => db.query("select name from storage.objects"))).rows).toHaveLength(1);
    await withSystem((db) => db.query("update organization_memberships set status='revoked' where org_id=$1 and user_id=$2", [a.id,user.id]));
    expect((await jwt(user.id,(db) => db.query("select name from storage.objects"))).rows).toEqual([]);
    expect((await jwt(user.id,(db) => db.query("select app.setup_topic_allowed($1) as allowed", [`setup:${a.id}`]))).rows).toEqual([{allowed:false}]);
  });
  it("application role cannot change membership, elevate roles or change setup progress", async () => {
    for (const sql of ["update users set platform_role='agency_super_admin' where id=$1", "update organization_memberships set role='owner' where user_id=$1", "update client_setup_tasks set status='completed' where org_id=$1"]) {
      await expect(withUser(owner.id,(db) => db.query(sql,[owner.id]))).rejects.toThrow(/permission denied/);
    }
  });
  it("file helper rechecks tenant permissions before issuing signed access", async () => {
    const ownInput = { userId:owner.id,orgId:a.id,bucket:file.bucket,path:file.storageKey };
    expect((await readPrivateFile(ownInput)).bytes.toString()).toBe("Company private guide");
    expect(await signPrivateFile(ownInput)).toBe(`/api/files/${file.id}`);
    await expect(signPrivateFile({ ...ownInput,userId:other.id })).rejects.toThrow(/not found/);
    await expect(uploadPrivateFile({ ...ownInput,userId:other.id,path:`${a.id}/${crypto.randomUUID()}`,bytes:Buffer.from("attack"),contentType:"text/plain" })).rejects.toThrow(/access/);
  });
  it("project internal files are visible only to authorized agency staff", async () => {
    await withSystem((db) => db.query("insert into staff_assignments(org_id,user_id) values($1,$2)", [a.id,staff.id]));
    const privateFile = await uploadPrivateFile({ userId:staff.id,orgId:a.id,bucket:"project-files",path:`${a.id}/${crypto.randomUUID()}/plan.txt`,bytes:Buffer.from("Private agency plan"),contentType:"text/plain",visibility:"internal" });
    await expect(signPrivateFile({ userId:owner.id,orgId:a.id,bucket:"project-files",path:privateFile.storageKey })).rejects.toThrow(/not found/);
    expect(await signPrivateFile({ userId:staff.id,orgId:a.id,bucket:"project-files",path:privateFile.storageKey })).toBe(`/api/files/${privateFile.id}`);
  });
  it("rejects traversal, foreign tenant prefixes and unsafe file signatures", async () => {
    expect(validPrivateFilePath(a.id,`${a.id}/${crypto.randomUUID()}/../evil`)).toBe(false);
    expect(validPrivateFilePath(a.id,`${b.id}/${crypto.randomUUID()}`)).toBe(false);
    await expect(uploadPrivateFile({ userId:owner.id,orgId:a.id,bucket:"company-documents",path:`${a.id}/${crypto.randomUUID()}`,bytes:Buffer.from("not pdf"),contentType:"application/pdf" })).rejects.toThrow(/contents/);
  });
});
