// The staffMessagesMaintenance job and the settings it reads (migration 0096): registered and dormant, former staff closed out, retention only when chosen, files finished off,
// and the Super Admin's two switches. Embedded Postgres; files go to a temporary folder; nothing is sent to anyone.
const CRON = "staff-messages-scheduler-secret-0123456789abcdef";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({ failRemoval: false }));
vi.mock("@/server/storage/private", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/storage/private")>();
  return {
    ...actual,
    removeStoredObjectTrusted: async (...args: Parameters<typeof actual.removeStoredObjectTrusted>) => {
      if (storage.failRemoval) throw new Error("storage is down");
      return actual.removeStoredObjectTrusted(...args);
    },
  };
});

import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { createDirect, createGroup, getConversation, listConversations } from "@/server/staff-messages/conversations";
import { stageAttachment } from "@/server/staff-messages/attachments";
import { deleteMessage, listMessages, sendMessage, setReaction } from "@/server/staff-messages/messages";
import { inboxRevision } from "@/server/staff-messages/inbox";
import { runStaffMessagesMaintenance, staffMessagesMaintenance } from "@/server/staff-messages/maintenance";
import { loadStaffMessageSettings, setRetentionDays, setStaffMessagesEnabled, staffMessagesEnabled } from "@/server/staff-messages/settings";
import { resetRateLimits } from "./support/support-world";
import { count, disable, enable, freshId, pdfBytes, rows, setMessages, setRole, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

let uploads: string;
let w: World;
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-staff-maintenance-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
});
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-staff-maintenance-")) await fs.rm(uploads, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetEnvCache();
});
beforeEach(async () => {
  await resetRateLimits();
  storage.failRemoval = false;
  w = await staffWorld();
  await withSystem(async (db) => {
    await db.query("delete from staff_message_settings");
    await db.query("delete from worker_job_runs where job_name = 'staffMessagesMaintenance'");
  });
});
const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
afterEach(() => setOnly(undefined));

const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
const group = async (owner: Person, ...others: Person[]) => (await createGroup(owner, { name: `g-${freshId().slice(0, 6)}`, memberIds: others.map((o) => o.id) })).id;
const backdate = (conversationId: string, days: number) =>
  withSystem(async (db) => {
    await db.query("alter table staff_messages disable trigger staff_messages_guard");
    await db.query("update staff_messages set created_at = now() - make_interval(days => $2) where conversation_id = $1", [conversationId, days]);
    await db.query("alter table staff_messages enable trigger staff_messages_guard");
  });
const bodies = async (conversationId: string) => (await rows<{ body: string }>("select body from staff_messages where conversation_id = $1 order by seq", [conversationId])).map((r) => r.body);
const members = (id: string) => rows<{ user_id: string; role: string; left: boolean }>("select user_id, role, left_at is not null as left from staff_conversation_members where conversation_id = $1 order by joined_at, user_id", [id]);
const releaseLease = () => withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
async function runTick() {
  await releaseLease();
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  return { status: res.status, ran: ((await res.json()) as { ran: Record<string, number | string> }).ran };
}

describe("the job", () => {
  it("is registered once, hourly, with a plain label, and takes a time budget", () => {
    expect(JOBS.filter((j) => j.name === "staffMessagesMaintenance")).toHaveLength(1);
    expect(JOBS.find((j) => j.name === "staffMessagesMaintenance")?.everyMinutes).toBe(60);
    expect(JOB_LABELS.staffMessagesMaintenance.length).toBeGreaterThan(20);
    const source = JOBS.find((j) => j.name === "staffMessagesMaintenance")?.run.toString() ?? "";
    expect(source).toContain("budgetMs");
  });

  it("does nothing when the scheduler is told to run other jobs only", async () => {
    const id = await group(w.staff, w.staff2);
    await disable(w.staff2.id);
    setOnly("aiWorkRecovery");
    const r = await runTick();
    expect(r.status).toBe(200);
    expect(Object.keys(r.ran)).toEqual(["aiWorkRecovery"]);
    expect((await members(id)).filter((m) => m.left)).toHaveLength(0);
    expect((await rows("select job_name from worker_job_runs where job_name = 'staffMessagesMaintenance'")).length).toBe(0);
  });

  it("runs alone when it is named, does its work once, and holds its slot", async () => {
    const id = await group(w.staff, w.staff2);
    await disable(w.staff2.id);
    setOnly("staffMessagesMaintenance");
    const first = await runTick();
    expect(Object.keys(first.ran)).toEqual(["staffMessagesMaintenance"]);
    expect(Number(first.ran.staffMessagesMaintenance)).toBeGreaterThanOrEqual(1);
    expect((await members(id)).find((m) => m.user_id === w.staff2.id)?.left).toBe(true);
    expect((await runTick()).ran.staffMessagesMaintenance).toBe("skipped");
  });

  it("does nothing at all while staff Messages is switched off, and picks up when it is switched on", async () => {
    const id = await group(w.staff, w.staff2);
    await disable(w.staff2.id);
    await setMessages(false);
    expect(await staffMessagesMaintenance()).toEqual({ stagedRemoved: 0, filesFinished: 0, membershipsClosed: 0, messagesExpired: 0 });
    expect((await members(id)).some((m) => m.left)).toBe(false);
    await setMessages(true);
    expect((await staffMessagesMaintenance()).membershipsClosed).toBeGreaterThanOrEqual(1);
    expect((await members(id)).find((m) => m.user_id === w.staff2.id)?.left).toBe(true);
  });
});

describe("people who are no longer on the team", () => {
  it("are taken out of their conversations, with a history line each, and their messages keep their place", async () => {
    const g = await group(w.staff, w.staff2, w.staff3);
    const dm = (await createDirect(w.staff, w.staff3.id)).id;
    await sendMessage(w.staff3, { conversationId: g, clientMessageId: freshId(), body: "Last words" });
    await sendMessage(w.staff3, { conversationId: dm, clientMessageId: freshId(), body: "See you" });
    const before = await inboxRevision(w.staff.id);
    await disable(w.staff3.id);
    const result = await staffMessagesMaintenance();
    expect(result.membershipsClosed).toBeGreaterThanOrEqual(2);
    for (const id of [g, dm]) expect((await members(id)).find((m) => m.user_id === w.staff3.id)?.left, id).toBe(true);
    const events = await rows<{ kind: string; actor_id: string | null; subject_id: string }>("select kind, actor_id, subject_id from staff_conversation_events where conversation_id = $1 and subject_id = $2 and kind = 'member_removed'", [g, w.staff3.id]);
    expect(events).toEqual([{ kind: "member_removed", actor_id: null, subject_id: w.staff3.id }]);
    // The people still in it see the change, and the former colleague's messages are still there under no name.
    expect(await inboxRevision(w.staff.id)).toBeGreaterThan(before);
    const page = await listMessages(w.staff, g);
    expect(page.messages.map((m) => [m.body, m.author.name, m.author.former])).toEqual([["Last words", "Former team member", true]]);
    expect(JSON.stringify(page)).not.toContain(w.staff3.name);
    const rail = (await listConversations(w.staff)).find((c) => c.id === dm);
    expect(rail).toMatchObject({ name: "Former team member", peer: { former: true } });
    // The former colleague can't get back in by themselves, and doing it again changes nothing.
    expect((await refused(getConversation(w.staff3, g)))?.code).toBe("forbidden");
    expect((await staffMessagesMaintenance()).membershipsClosed).toBe(0);
  });

  it("includes someone demoted to no agency role, and hands a conversation they owned to the member who has been in it longest", async () => {
    const owner = await staffPerson("agency_manager");
    const g = await group(owner, w.staff2);
    await setRole(owner.id, "none");
    await staffMessagesMaintenance();
    const state = (await members(g)).map((m) => [m.user_id, m.role, m.left] as const).sort((a, b) => a[0].localeCompare(b[0]));
    expect(state).toEqual([[owner.id, "owner", true], [w.staff2.id, "owner", false]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it("let a returning person back into their direct messages, and into groups only when someone adds them", async () => {
    const g = await group(w.staff, w.staff3);
    const dm = (await createDirect(w.staff, w.staff3.id)).id;
    await disable(w.staff3.id);
    await staffMessagesMaintenance();
    await enable(w.staff3.id);
    expect((await members(g)).find((m) => m.user_id === w.staff3.id)?.left).toBe(true);
    expect(await createDirect(w.staff3, w.staff.id)).toEqual({ id: dm, created: false });
    expect((await members(dm)).every((m) => !m.left)).toBe(true);
  });

  it("works through a long list in batches", async () => {
    const people = await Promise.all(Array.from({ length: 5 }, () => staffPerson("agency_staff")));
    const g = await group(w.staff, ...people);
    for (const p of people) await disable(p.id);
    expect((await staffMessagesMaintenance({ batch: 2 })).membershipsClosed).toBe(2);
    expect((await staffMessagesMaintenance({ batch: 2 })).membershipsClosed).toBe(2);
    expect((await staffMessagesMaintenance({ batch: 2 })).membershipsClosed).toBe(1);
    expect((await members(g)).filter((m) => !m.left).map((m) => m.user_id)).toEqual([w.staff.id]);
  });
});

describe("retention", () => {
  // The job looks at every conversation, so what earlier tests left behind is cleared first and the counts below are each test's own.
  beforeEach(async () => {
    await withSystem((db) => db.query("delete from staff_messages"));
  });

  it("is off by default: old messages are kept for ever", async () => {
    const g = await group(w.staff, w.staff2);
    await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "Ancient" });
    await backdate(g, 4000);
    expect(await loadStaffMessageSettings()).toEqual({ retentionDays: null });
    expect((await staffMessagesMaintenance()).messagesExpired).toBe(0);
    expect(await bodies(g)).toEqual(["Ancient"]);
  });

  it("deletes messages older than the period a Super Admin chose, and keeps everything newer", async () => {
    const g = await group(w.staff, w.staff2);
    const old = (await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "Old news" })).message;
    await setReaction(w.staff2, { messageId: old.id, reaction: "heart", on: true });
    await sendMessage(w.staff2, { conversationId: g, clientMessageId: freshId(), body: "Also old" });
    await backdate(g, 400);
    await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "Fresh" });
    await setRetentionDays(w.superAdmin, 365);
    expect(await loadStaffMessageSettings()).toEqual({ retentionDays: 365 });
    const result = await staffMessagesMaintenance();
    expect(result.messagesExpired).toBe(2);
    expect(await bodies(g)).toEqual(["Fresh"]);
    expect(await count("select 1 from staff_message_reactions where message_id = $1", [old.id])).toBe(0);
    // The numbers are not reused, so the order that is left is still the database's.
    const [left] = await rows<{ seq: string }>("select m.seq::text as seq from staff_messages m where m.conversation_id = $1", [g]);
    expect(left.seq).toBe("3");
    // The record says what was done, without a word of any message.
    const audit = await rows<{ action: string; actor_kind: string; metadata: Record<string, unknown> }>("select action, actor_kind, metadata from audit_logs where action = 'staff_messages.retention_applied' order by created_at desc limit 1");
    expect(audit).toEqual([{ action: "staff_messages.retention_applied", actor_kind: "system", metadata: { deleted: 2, retentionDays: 365 } }]);
    expect(JSON.stringify(audit)).not.toContain("Old news");
    // Run again: nothing more to do.
    expect((await staffMessagesMaintenance()).messagesExpired).toBe(0);
  });

  it("keeps the message that starts a thread until its newest reply is old enough, and deletes a finished thread whole", async () => {
    const g = await group(w.staff, w.staff2);
    const root = (await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "Root" })).message;
    await sendMessage(w.staff2, { conversationId: g, clientMessageId: freshId(), body: "Old reply", threadRootId: root.id });
    await backdate(g, 400);
    await sendMessage(w.staff2, { conversationId: g, clientMessageId: freshId(), body: "New reply", threadRootId: root.id });
    await setRetentionDays(w.superAdmin, 365);
    await staffMessagesMaintenance();
    // The root has a recent reply, so it stays; the old reply goes.
    expect(await bodies(g)).toEqual(["Root", "New reply"]);
    await backdate(g, 400);
    await staffMessagesMaintenance();
    expect(await bodies(g)).toEqual([]);
  });

  it("works through a backlog in batches, within its time, and does nothing with no time left", async () => {
    const g = await group(w.staff, w.staff2);
    for (let i = 0; i < 7; i++) await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: `Old ${i}` });
    await backdate(g, 500);
    await setRetentionDays(w.superAdmin, 30);
    expect((await staffMessagesMaintenance({ budgetMs: 0 })).messagesExpired).toBe(0);
    expect(await bodies(g)).toHaveLength(7);
    expect((await staffMessagesMaintenance({ batch: 3 })).messagesExpired).toBe(7);
    expect(await bodies(g)).toEqual([]);
  });

  it("removes the stored files of the messages it deletes, and keeps a message whose file it could not remove", async () => {
    const g = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, g, { name: "old.pdf", bytes: pdfBytes("old") });
    await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "With a file", attachmentIds: [staged.id] });
    const [file] = await rows<{ storage_key: string }>("select f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [staged.id]);
    const location = path.join(uploads, "staff-messages", ...file.storage_key.split("/"));
    await backdate(g, 400);
    await setRetentionDays(w.superAdmin, 365);
    storage.failRemoval = true;
    expect((await staffMessagesMaintenance()).messagesExpired).toBe(0);
    expect(await bodies(g)).toEqual(["With a file"]);
    expect(existsSync(location)).toBe(true);
    // Access to the bytes was withdrawn all the same.
    expect((await rows<{ status: string }>("select f.status from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [staged.id]))[0].status).toBe("deleted");
    storage.failRemoval = false;
    expect((await staffMessagesMaintenance()).messagesExpired).toBe(1);
    expect(await bodies(g)).toEqual([]);
    expect(existsSync(location)).toBe(false);
    expect(await count("select 1 from staff_message_attachments where id = $1", [staged.id])).toBe(0);
  });
});

describe("files of deleted messages", () => {
  it("are finished off by the job when storage was down at the time", async () => {
    const g = await group(w.staff, w.staff2);
    const staged = await stageAttachment(w.staff, g, { name: "gone.pdf", bytes: pdfBytes("gone") });
    const sent = await sendMessage(w.staff, { conversationId: g, clientMessageId: freshId(), body: "Delete me", attachmentIds: [staged.id] });
    const [file] = await rows<{ storage_key: string }>("select f.storage_key from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [staged.id]);
    const location = path.join(uploads, "staff-messages", ...file.storage_key.split("/"));
    storage.failRemoval = true;
    await deleteMessage(w.staff, sent.message.id);
    expect(existsSync(location)).toBe(true);
    expect((await rows<{ a: string; f: string }>("select a.status as a, f.status as f from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [staged.id]))[0]).toEqual({ a: "attached", f: "deleted" });
    expect((await staffMessagesMaintenance()).filesFinished).toBe(0);
    storage.failRemoval = false;
    expect((await staffMessagesMaintenance()).filesFinished).toBe(1);
    expect(existsSync(location)).toBe(false);
    expect((await rows<{ status: string }>("select status from staff_message_attachments where id = $1", [staged.id]))[0].status).toBe("removed");
  });
});

describe("the Super Admin's settings", () => {
  it("switch the module on and off, for a Super Admin only, and record who did it", async () => {
    expect(await staffMessagesEnabled()).toBe(true);
    for (const who of [w.manager, w.staff]) expect((await refused(setStaffMessagesEnabled(who, false)))?.code, who.name).toBe("forbidden");
    expect((await refused(setStaffMessagesEnabled({ id: w.superAdmin.id, platformRole: "agency_manager" }, false)))?.code).toBe("forbidden");
    await setStaffMessagesEnabled(w.superAdmin, false);
    expect(await staffMessagesEnabled()).toBe(false);
    await setStaffMessagesEnabled(w.superAdmin, true);
    expect(await staffMessagesEnabled()).toBe(true);
    const audit = await rows<{ action: string; actor_user_id: string }>("select action, actor_user_id from audit_logs where action like 'staff_messages.%abled' and actor_user_id = $1 order by created_at", [w.superAdmin.id]);
    expect(audit.map((a) => a.action)).toEqual(["staff_messages.disabled", "staff_messages.enabled"]);
    // A demoted Super Admin's old session is no use.
    await setRole(w.superAdmin.id, "agency_manager");
    expect((await refused(setStaffMessagesEnabled(w.superAdmin, false)))?.code).toBe("forbidden");
    await setRole(w.superAdmin.id, "agency_super_admin");
  });

  it("choose a retention period of 30 to 3650 days or none, for a Super Admin only", async () => {
    for (const bad of [29, 3651, 0, -5, 1.5, Number.NaN]) expect((await refused(setRetentionDays(w.superAdmin, bad)))?.code, String(bad)).toBe("invalid_input");
    for (const who of [w.manager, w.staff]) expect((await refused(setRetentionDays(who, 90)))?.code, who.name).toBe("forbidden");
    expect(await setRetentionDays(w.superAdmin, 30)).toEqual({ retentionDays: 30 });
    expect(await setRetentionDays(w.superAdmin, 3650)).toEqual({ retentionDays: 3650 });
    expect(await setRetentionDays(w.superAdmin, null)).toEqual({ retentionDays: null });
    expect(await loadStaffMessageSettings()).toEqual({ retentionDays: null });
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = 'staff_messages.retention_changed' and actor_user_id = $1 order by created_at", [w.superAdmin.id]);
    expect(audit.map((a) => a.metadata)).toEqual([{ retentionDays: 30 }, { retentionDays: 3650 }, { retentionDays: null }]);
  });

  it("also work on the tick: the entry point returns the number of things done", async () => {
    const g = await group(w.staff, w.staff2);
    await disable(w.staff2.id);
    expect(await runStaffMessagesMaintenance()).toBeGreaterThanOrEqual(1);
    expect((await members(g)).find((m) => m.user_id === w.staff2.id)?.left).toBe(true);
  });
});
