import fs from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { EVENT_TRIGGER_TYPES } from "@/lib/crm/workflow/spec";
import { EXPORT_TABLES, buildExport } from "@/server/offboarding/export";
import { planDeletion, requestOffboardingAsAgency } from "@/server/offboarding/service";
import { listNotifications, unreadCount } from "@/server/notifications";
import { addMembers, createChannel, createDirect, createGroup, getConversation, joinChannel, leaveConversation, listConversations, removeMember, setArchived, setPreferences, updateConversation } from "@/server/staff-messages/conversations";
import { deleteMessage, editMessage, listMessages, sendMessage, setReaction } from "@/server/staff-messages/messages";
import { markRead } from "@/server/staff-messages/read";
import { searchMessages } from "@/server/staff-messages/search";
import { downloadAttachment, stageAttachment } from "@/server/staff-messages/attachments";
import { inboxRevision } from "@/server/staff-messages/inbox";
import { listStaffDirectory } from "@/server/staff-messages/directory";
import { mentionToken } from "@/lib/staff-messages/mentions";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { resetRateLimits } from "./support/support-world";
import { channelName, clearOverride, count, disable, enable, freshId, override, pdfBytes, rows, setMessages, setRole, splitStatements, staffPerson, staffWorld, type Person, type World } from "./support/staff-messages";

// What keeps staff Messages inside the agency team (migration 0096, section 7 of the audit): every client role and every person with no agency role reads nothing; an agency
// person who is not in a conversation reads nothing of it, the Super Admin included; a demoted, disabled or denied person loses everything at once; nothing of it reaches a client
// feed, an export, a deletion plan, the audit trail or the AI employees. Embedded Postgres; files go to a temporary folder.

const TABLES = [
  "staff_message_settings", "staff_conversations", "staff_conversation_members", "staff_messages", "staff_message_reactions", "staff_message_attachments", "staff_conversation_events",
  "staff_inbox_state",
];
const SECRET = "ZEBRA-QUARTZ-7781";
const CLIENT_ROLES = ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter"] as const;

let uploads: string;
beforeAll(async () => {
  uploads = await fs.mkdtemp(path.join(os.tmpdir(), "iacquire-staff-isolation-"));
  vi.stubEnv("UPLOAD_DIR", uploads);
  resetEnvCache();
});
afterAll(async () => {
  if (uploads && path.dirname(path.resolve(uploads)) === path.resolve(os.tmpdir()) && path.basename(uploads).startsWith("iacquire-staff-isolation-")) await fs.rm(uploads, { recursive: true, force: true });
  vi.unstubAllEnvs();
  resetEnvCache();
});

interface Scene {
  w: World;
  dm: string;
  group: string;
  open: string;
  priv: string;
  message: string;
  reply: string;
  attachment: string;
  staged: string;
}

/** Four kinds of conversation with a message, a thread, a reaction and a file in them, and a person staging a file that is not sent yet. */
async function scene(): Promise<Scene> {
  await resetRateLimits();
  const w = await staffWorld();
  const dm = (await createDirect(w.staff, w.staff2.id)).id;
  const group = (await createGroup(w.staff, { name: "Private group", memberIds: [w.staff2.id] })).id;
  const open = (await createChannel(w.manager, { name: channelName("open"), visibility: "staff" })).id;
  const priv = (await createChannel(w.manager, { name: channelName("priv"), visibility: "private", memberIds: [w.staff.id] })).id;
  await joinChannel(w.staff, open);
  await sendMessage(w.staff, { conversationId: dm, clientMessageId: freshId(), body: `Direct ${SECRET}` });
  const file = await stageAttachment(w.staff, group, { name: "plan.pdf", bytes: pdfBytes("iso") });
  const sent = await sendMessage(w.staff, { conversationId: group, clientMessageId: freshId(), body: `Group ${SECRET} ${mentionToken(w.staff2.id)}`, attachmentIds: [file.id] });
  const reply = await sendMessage(w.staff2, { conversationId: group, clientMessageId: freshId(), body: `Reply ${SECRET}`, threadRootId: sent.message.id });
  await setReaction(w.staff2, { messageId: sent.message.id, reaction: "heart", on: true });
  await sendMessage(w.staff, { conversationId: open, clientMessageId: freshId(), body: `Channel ${SECRET}` });
  await sendMessage(w.manager, { conversationId: priv, clientMessageId: freshId(), body: `Private channel ${SECRET}` });
  const staged = await stageAttachment(w.staff, dm, { name: "draft.pdf", bytes: pdfBytes("staged") });
  // The one settings row (no retention period), so every table has something in it to be kept from the people who must not see it.
  await withSystem((db) => db.query("insert into staff_message_settings (org_id) values ($1) on conflict do nothing", [w.agencyId]));
  return { w, dm, group, open, priv, message: sent.message.id, reply: reply.message.id, attachment: file.id, staged: staged.id };
}

/** A manager who is in none of the scene's conversations. */
const strangerManager = () => staffPerson("agency_manager");

const readable = (who: string) =>
  withUser(who, async (db: Queryable) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) out[t] = Number((await db.query<{ n: string }>(`select count(*)::text as n from ${t}`)).rows[0].n);
    return out;
  });
const refused = async (p: Promise<unknown>) => p.then(() => null, (e: Error & { code?: string }) => ({ code: e.code, message: e.message }));

describe("a person with no agency role reads nothing", () => {
  it("is true for every client role, a client user with no membership and a former agency person, in every table", async () => {
    const s = await scene();
    const client = await createOrg({ name: "A client" });
    const people: Array<[string, string]> = [];
    for (const role of CLIENT_ROLES) {
      const user = await createUser({ name: `Client ${role}` });
      await addMember(client.id, user.id, role);
      people.push([role, user.id]);
    }
    people.push(["no membership", (await createUser()).id]);
    const former = await staffPerson("agency_staff");
    await createDirect(former, s.w.staff.id);
    await setRole(former.id, "none");
    people.push(["former agency person", former.id]);
    const seen = await readable(s.w.staff.id);
    for (const t of TABLES) expect(seen[t], `the team sees ${t}`).toBeGreaterThan(0);
    for (const [label, id] of people) {
      expect(Object.values(await readable(id)).every((n) => n === 0), label).toBe(true);
    }
    // The directory and the revision answer nothing either.
    for (const [label, id] of people) {
      expect((await withUser(id, (db) => db.query("select * from app.staff_directory()"))).rows, label).toEqual([]);
      expect(await inboxRevision(id), label).toBe(0);
    }
  });

  it("cannot be read through the Data API roles at all: anon and authenticated are refused outright", async () => {
    const s = await scene();
    const jwt = async <T,>(role: "anon" | "authenticated", fn: (db: Queryable) => Promise<T>) =>
      withSystem(async (db) => {
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [role === "authenticated" ? s.w.staff.id : ""]);
        await db.query(`set local role ${role}`);
        return fn(db);
      });
    for (const role of ["anon", "authenticated"] as const) {
      for (const t of TABLES) await expect(jwt(role, (db) => db.query(`select * from ${t}`)), `${role} ${t}`).rejects.toThrow(/permission denied/);
      await expect(jwt(role, (db) => db.query("select * from app.staff_directory()")), role).rejects.toThrow(/permission denied/);
      await expect(jwt(role, (db) => db.query("insert into staff_messages (org_id, conversation_id, seq, body, client_message_id) values (gen_random_uuid(), gen_random_uuid(), 1, 'x', gen_random_uuid())")), role).rejects.toThrow(/permission denied/);
    }
  });

  it("is refused by every service, with the same answer as for a made-up id", async () => {
    const s = await scene();
    const client = await staffPerson("none");
    const asAgency: Person = { ...client, platformRole: "agency_staff" };
    for (const who of [client, asAgency]) {
      for (const call of [() => listConversations(who), () => createDirect(who, s.w.staff.id), () => listStaffDirectory(who), () => searchMessages(who, { query: "Direct" }), () => listMessages(who, s.dm)]) {
        expect((await refused(call()))?.code, who.platformRole).toBe("forbidden");
      }
    }
  });
});

describe("an agency person who is not in a conversation reads nothing of it, the Super Admin included", () => {
  it("sees none of its rows in any table, whatever their role", async () => {
    const s = await scene();
    const outsiders: Array<[string, Person]> = [["a staff member", s.w.staff3], ["a manager", await strangerManager()], ["the Super Admin", s.w.superAdmin]];
    for (const [label, who] of outsiders) {
      for (const [conv, name] of [[s.dm, "direct message"], [s.group, "group"]] as const) {
        const seen = await withUser(who.id, async (db) => {
          const q = async (sql: string) => Number((await db.query<{ n: string }>(sql, [conv])).rows[0].n);
          return {
            conversations: await q("select count(*)::text as n from staff_conversations where id = $1"),
            members: await q("select count(*)::text as n from staff_conversation_members where conversation_id = $1"),
            messages: await q("select count(*)::text as n from staff_messages where conversation_id = $1"),
            reactions: await q("select count(*)::text as n from staff_message_reactions where conversation_id = $1"),
            attachments: await q("select count(*)::text as n from staff_message_attachments where conversation_id = $1"),
            events: await q("select count(*)::text as n from staff_conversation_events where conversation_id = $1"),
          };
        });
        expect(Object.values(seen).every((n) => n === 0), `${label} / ${name}: ${JSON.stringify(seen)}`).toBe(true);
      }
      // A private channel they are not in is as invisible. An open channel's name and topic are listed for the whole team, never its messages or its people.
      const privSeen = await withUser(who.id, async (db) => ({
        c: (await db.query("select 1 from staff_conversations where id = $1", [s.priv])).rows.length,
        m: (await db.query("select 1 from staff_messages where conversation_id = $1", [s.priv])).rows.length,
      }));
      expect(privSeen, label).toEqual({ c: 0, m: 0 });
      const openSeen = await withUser(who.id, async (db) => ({
        c: (await db.query("select 1 from staff_conversations where id = $1", [s.open])).rows.length,
        m: (await db.query("select 1 from staff_messages where conversation_id = $1", [s.open])).rows.length,
        p: (await db.query("select 1 from staff_conversation_members where conversation_id = $1", [s.open])).rows.length,
      }));
      expect(openSeen.c, label).toBe(1);
      expect(openSeen.m + openSeen.p, label).toBe(0);
      // A file someone staged is only for them, even among the members of its conversation.
      const staged = await withUser(s.w.staff2.id, async (db) => (await db.query("select 1 from staff_message_attachments where id = $1", [s.staged])).rows.length);
      expect(staged, "a member who is not the uploader").toBe(0);
    }
  });

  it("gets the same answer from every service for a real conversation it is not in as for one that does not exist", async () => {
    const s = await scene();
    const manager = await strangerManager();
    for (const [label, who] of [["staff", s.w.staff3], ["manager", manager], ["super admin", s.w.superAdmin]] as const) {
      for (const [kind, conv, message] of [["direct message", s.dm, null], ["group", s.group, s.message], ["private channel", s.priv, null]] as const) {
        const calls: Array<[string, (id: string) => Promise<unknown>]> = [
          ["read the conversation", (id) => getConversation(who, id)],
          ["read its messages", (id) => listMessages(who, id)],
          ["send", (id) => sendMessage(who, { conversationId: id, clientMessageId: freshId(), body: "Let me in" })],
          ["mark read", (id) => markRead(who, id, 1)],
          ["set preferences", (id) => setPreferences(who, id, { muted: true })],
          ["add a member", (id) => addMembers(who, id, [s.w.staff2.id])],
          ["remove a member", (id) => removeMember(who, id, s.w.staff.id)],
          ["rename", (id) => updateConversation(who, id, { name: "Mine" })],
          ["leave", (id) => leaveConversation(who, id)],
          ["join", (id) => joinChannel(who, id)],
          ["stage a file", (id) => stageAttachment(who, id, { name: "a.pdf", bytes: pdfBytes() })],
        ];
        // A search limited to a conversation the person is not in finds nothing, exactly as for one that does not exist (it is an empty answer, not an error).
        expect((await searchMessages(who, { query: "Direct", conversationId: conv })).hits, `${label} search inside ${kind}`).toEqual([]);
        // (Archiving a channel one is not in is the one thing a manager or moderator may do; it is tested separately, below.)
        for (const [what, call] of calls) {
          const real = await refused(call(conv));
          const fake = await refused(call(freshId()));
          expect(real?.code, `${label} ${what} ${kind}`).toBe("not_found");
          expect(real, `${label} ${what} ${kind} (same words as a made-up id)`).toEqual(fake);
        }
        if (message) {
          const byMessage: Array<[string, (id: string) => Promise<unknown>]> = [
            ["edit", (id) => editMessage(who, { messageId: id, body: "Mine now" })],
            ["delete", (id) => deleteMessage(who, id)],
            ["react", (id) => setReaction(who, { messageId: id, reaction: "heart", on: true })],
          ];
          for (const [what, call] of byMessage) {
            const real = await refused(call(message));
            const fake = await refused(call(freshId()));
            expect(real, `${label} ${what} a message`).toEqual(fake);
            expect(real?.code).toBe("not_found");
          }
          const real = await refused(downloadAttachment(who, s.attachment));
          const fake = await refused(downloadAttachment(who, freshId()));
          expect(real, `${label} download`).toEqual(fake);
        }
      }
    }
    // Nothing was changed by any of it.
    expect(await count("select 1 from staff_messages where body like 'Mine now%' or body = 'Let me in'")).toBe(0);
    expect(await count("select 1 from staff_conversation_members where conversation_id = any($1::uuid[]) and user_id = any($2::uuid[])", [[s.dm, s.group, s.priv], [s.w.staff3.id, s.w.superAdmin.id]])).toBe(0);
  });

  it("never finds the text of a conversation in a search, and a direct message between two people is nobody else's", async () => {
    const s = await scene();
    for (const who of [s.w.staff3, await strangerManager(), s.w.superAdmin]) {
      expect((await searchMessages(who, { query: SECRET })).hits, who.name).toEqual([]);
    }
    const found = await searchMessages(s.w.staff, { query: SECRET });
    expect(found.hits.map((h) => h.conversationId).sort()).toEqual([s.dm, s.group, s.group, s.open, s.priv].sort());
  });

  it("lets a moderator or a manager archive a channel they are not in, and that gives them no way to read it", async () => {
    const s = await scene();
    await setArchived(s.w.superAdmin, s.priv, true);
    expect((await refused(listMessages(s.w.superAdmin, s.priv)))?.code).toBe("not_found");
    expect((await refused(getConversation(s.w.superAdmin, s.priv)))?.code).toBe("not_found");
    expect((await searchMessages(s.w.superAdmin, { query: SECRET })).hits).toEqual([]);
    await setArchived(s.w.superAdmin, s.priv, false);
    // A direct message and a group can't be archived by anyone but their owner, whatever the role.
    expect((await refused(setArchived(s.w.superAdmin, s.dm, true)))?.code).toBe("not_found");
    expect((await refused(setArchived(s.w.superAdmin, s.group, true)))?.code).toBe("not_found");
  });
});

describe("a person who loses their standing loses everything at once", () => {
  const everything = async (s: Scene, who: Person) => ({
    list: await refused(listConversations(who)),
    read: await refused(listMessages(who, s.group)),
    send: await refused(sendMessage(who, { conversationId: s.group, clientMessageId: freshId(), body: "Still here?" })),
    download: await refused(downloadAttachment(who, s.attachment)),
    search: await refused(searchMessages(who, { query: SECRET })),
    stage: await refused(stageAttachment(who, s.group, { name: "a.pdf", bytes: pdfBytes() })),
    directory: await refused(listStaffDirectory(who)),
  });
  /** The calls that did NOT end in the refusal expected. */
  const gone = (r: Awaited<ReturnType<typeof everything>>, code: string) => Object.entries(r).filter(([, v]) => v?.code !== code).map(([k]) => k);

  it("is true when demoted to no agency role: services, rows, notices, the revision and the files, with nothing deleted", async () => {
    const s = await scene();
    const who = s.w.staff2;
    // Before: every one of the seven calls works.
    expect(Object.values(await everything(s, who)).every((v) => v === null)).toBe(true);
    expect(await unreadCount(who.id)).toBeGreaterThan(0);
    await setRole(who.id, "none");
    expect(gone(await everything(s, who), "forbidden")).toEqual([]);
    expect(gone(await everything(s, { ...who, platformRole: "none" }), "forbidden")).toEqual([]);
    expect(Object.values(await readable(who.id)).every((n) => n === 0)).toBe(true);
    expect((await listNotifications(who.id, { limit: 50 })).items.filter((i) => i.kind.startsWith("staff_"))).toEqual([]);
    expect(await unreadCount(who.id)).toBe(0);
    expect(await inboxRevision(who.id)).toBe(0);
    // Nothing was deleted: back on the team, it is all there.
    await setRole(who.id, "agency_staff");
    expect((await listMessages(who, s.group)).messages.length).toBeGreaterThanOrEqual(1);
    expect((await downloadAttachment(who, s.attachment)).filename).toBe("plan.pdf");
    expect(await unreadCount(who.id)).toBeGreaterThan(0);
  });

  it("is true when the account is disabled", async () => {
    const s = await scene();
    await disable(s.w.staff2.id);
    expect(gone(await everything(s, s.w.staff2), "forbidden")).toEqual([]);
    expect(Object.values(await readable(s.w.staff2.id)).every((n) => n === 0)).toBe(true);
    expect(await unreadCount(s.w.staff2.id)).toBe(0);
    await enable(s.w.staff2.id);
    expect((await listMessages(s.w.staff2, s.group)).messages.length).toBe(1);
  });

  it("is true when denied agency.messages.use for that person alone, and comes back when the deny is lifted", async () => {
    const s = await scene();
    await override(s.w.staff2.id, "agency.messages.use", "deny");
    expect(gone(await everything(s, s.w.staff2), "forbidden")).toEqual([]);
    expect(Object.values(await readable(s.w.staff2.id)).every((n) => n === 0)).toBe(true);
    // The others in the conversation are not touched by it.
    expect((await listMessages(s.w.staff, s.group)).messages.length).toBe(1);
    await clearOverride(s.w.staff2.id, "agency.messages.use");
    expect((await listMessages(s.w.staff2, s.group)).messages.length).toBe(1);
    // A person denied the permission can't be added to anything, and an allow for a person the role excludes works the other way.
    await override(s.w.staff3.id, "agency.messages.use", "deny");
    expect((await refused(addMembers(s.w.staff, s.group, [s.w.staff3.id])))?.code).toBe("invalid_input");
  });

  it("is true for everyone when the module is switched off, and nothing is lost when it is switched on again", async () => {
    const s = await scene();
    await setMessages(false);
    for (const who of [s.w.staff, s.w.manager, s.w.superAdmin]) {
      expect(gone(await everything(s, who), "not_enabled"), who.name).toEqual([]);
      expect(Object.values(await readable(who.id)).every((n) => n === 0), who.name).toBe(true);
    }
    await setMessages(true);
    expect((await listMessages(s.w.staff, s.group)).messages.length).toBe(1);
  });

  it("is true when the session names a role the account no longer has", async () => {
    const s = await scene();
    const promoted: Person = { ...s.w.staff2, platformRole: "agency_manager" };
    expect(gone(await everything(s, promoted), "forbidden")).toEqual([]);
  });
});

describe("nothing of it reaches a client, an export, a deletion plan or the audit trail", () => {
  it("keeps the client export to an allow-list that names no staff table, and a client's export holds nothing of the team's", async () => {
    const s = await scene();
    // (staff_profiles is the client's own team table, an older and different thing.)
    expect(EXPORT_TABLES.filter((t) => TABLES.includes(t.table))).toEqual([]);
    const client = await createOrg({ name: "Leaving client" });
    const out = await buildExport(client.id);
    expect(Object.keys(out.counts).filter((k) => k.includes("staff-message") || k.includes("staff_message"))).toEqual([]);
    expect(out.bytes.toString("latin1")).not.toContain(SECRET);
    void s;
  });

  it("plans a client's deletion without touching or naming a single staff row, and refuses to offboard the agency workspace itself", async () => {
    const s = await scene();
    const before = await Promise.all(TABLES.map((t) => count(`select 1 from ${t}`)));
    const client = await createOrg({ name: "Planned departure" });
    const request = await requestOffboardingAsAgency(s.w.superAdmin, client.id, "Testing the plan");
    const plan = await planDeletion(s.w.superAdmin, request.id);
    expect([...plan.purge, ...plan.retain].filter((p) => TABLES.includes(p.table))).toEqual([]);
    expect(await Promise.all(TABLES.map((t) => count(`select 1 from ${t}`)))).toEqual(before);
    expect((await refused(requestOffboardingAsAgency(s.w.superAdmin, s.w.agencyId, "The agency itself")))?.code).toBe("not_found");
  });

  it("writes no message text to the audit trail, a notice, the history, the outbox or a job record", async () => {
    const s = await scene();
    await editMessage(s.w.staff, { messageId: s.message, body: `Edited ${SECRET}` });
    await deleteMessage(s.w.staff2, s.reply);
    for (const t of ["audit_logs", "notifications", "staff_conversation_events", "email_outbox", "worker_job_runs", "staff_inbox_state", "rate_limit_buckets", "incidents"]) {
      expect(await count(`select 1 from ${t} x where x::text ilike $1`, [`%${SECRET}%`]), t).toBe(0);
    }
    // The messages themselves are where the text is, and only there (a deleted one has none).
    expect(await count("select 1 from staff_messages where body like $1", [`%${SECRET}%`])).toBeGreaterThanOrEqual(4);
    // The audit trail does say what was done and by whom, in ids and kinds.
    const audit = await rows<{ action: string }>("select action from audit_logs where action like 'staff_messages.%' and actor_user_id = $1", [s.w.staff.id]);
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["staff_messages.conversation_created"]));
  });

  it("is not a trigger or a tool for automation or the AI employees", () => {
    expect([...EVENT_TRIGGER_TYPES].filter((t) => /staff|message\.staff|team_message/i.test(t))).toEqual([]);
    const roots = ["src/server/aqi", "src/lib/aqi", "src/server/workforce", "src/lib/workforce", "src/server/crm/workflows", "src/lib/crm/workflow", "src/server/automation-studio", "src/server/llm"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && /staff_conversation|staff_message|staff_inbox|staff-messages/.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    for (const r of roots) {
      try {
        walk(r);
      } catch {
        // a root that does not exist in this tree
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is not read by any client-facing page or portal service, only by the staff-messages module, the migrations and the registries that name its kinds", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry).replaceAll("\\", "/");
        if (statSync(full).isDirectory()) {
          if (!full.includes("staff-messages") && !full.includes("node_modules")) walk(full);
        } else if (/\.(ts|tsx)$/.test(entry) && /\bfrom\s+staff_(conversations|messages|conversation_members|inbox_state)\b|\bjoin\s+staff_(conversations|messages)\b/.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    };
    walk("src");
    expect(hits).toEqual([]);
  });
});

describe("the files are closed to browsers", () => {
  it("are invisible to the Storage policy: a member signed in as a browser sees no object, and an object row for the file is not readable", async () => {
    const s = await scene();
    const [row] = await rows<{ storage_key: string; bucket: string }>("select f.storage_key, f.bucket from staff_message_attachments a join private_files f on f.id = a.private_file_id where a.id = $1", [s.attachment]);
    await withSystem(async (db) => {
      await db.query("insert into auth.users(id, email) values ($1, $2) on conflict do nothing", [s.w.staff.id, s.w.staff.email]);
      await db.query("update users set auth_user_id = id where id = $1", [s.w.staff.id]);
      await db.query("insert into storage.objects(bucket_id, name) values ($1, $2)", [row.bucket, row.storage_key]);
    });
    const objects = await withSystem(async (db) => {
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [s.w.staff.id]);
      await db.query("select set_config('app.user_id', '', true)");
      await db.query("set local role authenticated");
      return (await db.query("select name from storage.objects where bucket_id = 'staff-messages'")).rows;
    });
    expect(objects).toEqual([]);
    // The server's own route still gives the member the file.
    expect((await downloadAttachment(s.w.staff, s.attachment)).filename).toBe("plan.pdf");
  });
});

describe("the optional Realtime policy (applied by hand only after a live-project test), emulated here", () => {
  it("lets a person subscribe to their own topic while they are allowed, and to nobody else's", async () => {
    const s = await scene();
    const script = readFileSync("supabase/optional/staff-messages-realtime.sql", "utf8");
    const people = [s.w.staff, s.w.staff2, s.w.superAdmin];
    const client = await staffPerson("none");
    await withSystem(async (db) => {
      for (const p of [...people, client]) {
        await db.query("insert into auth.users(id, email) values ($1, $2) on conflict do nothing", [p.id, p.email]);
        await db.query("update users set auth_user_id = id where id = $1", [p.id]);
      }
    });
    const subscribe = async (who: { id: string }, topic: string, extension = "broadcast", prepare?: (db: Queryable) => Promise<void>) => {
      let seen = 0;
      await withSystem(async (db) => {
        for (const stmt of splitStatements(script)) await db.query(stmt);
        await db.query("delete from realtime.messages");
        await db.query("insert into realtime.messages (topic, extension, payload) values ($1, $2, '{\"revision\": 1}'::jsonb)", [topic, extension]);
        if (prepare) await prepare(db);
        await db.query("select set_config('request.jwt.claim.sub', $1, true)", [who.id]);
        await db.query("select set_config('app.user_id', '', true)");
        await db.query("select set_config('realtime.topic', $1, true)", [topic]);
        await db.query("set local role authenticated");
        seen = (await db.query("select 1 from realtime.messages")).rows.length;
        await db.query("reset role");
        throw new Error("rolled back");
      }).catch((e) => {
        if (String(e.message) !== "rolled back") throw e;
      });
      return seen;
    };
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`)).toBe(1);
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff2.id}`)).toBe(0);
    expect(await subscribe(s.w.superAdmin, `staffmsg:${s.w.staff.id}`)).toBe(0);
    expect(await subscribe(s.w.superAdmin, `staffmsg:${s.w.superAdmin.id}`)).toBe(1);
    expect(await subscribe(s.w.staff, `staffmsg:*`)).toBe(0);
    expect(await subscribe(s.w.staff, `setup:${s.w.staff.id}`)).toBe(0);
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`, "postgres_changes")).toBe(0);
    expect(await subscribe(client, `staffmsg:${client.id}`)).toBe(0);
    // Disabled, denied, demoted: the next check says no.
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`, "broadcast", async (db) => void (await db.query("update users set status = 'disabled' where id = $1", [s.w.staff.id])))).toBe(0);
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`, "broadcast", async (db) => void (await db.query("insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.messages.use', 'deny')", [s.w.staff.id])))).toBe(0);
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`, "broadcast", async (db) => void (await db.query("update users set platform_role = 'none' where id = $1", [s.w.staff.id])))).toBe(0);
    expect(await subscribe(s.w.staff, `staffmsg:${s.w.staff.id}`, "broadcast", async (db) => void (await db.query("delete from org_features where feature = 'staff_messages'")))).toBe(0);
  });

  it("can't be published to by a browser, is left out of the migrations, and is removed by its own down script", async () => {
    const s = await scene();
    const script = readFileSync("supabase/optional/staff-messages-realtime.sql", "utf8");
    await withSystem(async (db) => {
      await db.query("insert into auth.users(id, email) values ($1, $2) on conflict do nothing", [s.w.staff.id, s.w.staff.email]);
      await db.query("update users set auth_user_id = id where id = $1", [s.w.staff.id]);
      for (const stmt of splitStatements(script)) await db.query(stmt);
      await db.query("select set_config('request.jwt.claim.sub', $1, true)", [s.w.staff.id]);
      await db.query("set local role authenticated");
      await db.query("savepoint publish");
      await expect(db.query("insert into realtime.messages (topic, extension) values ($1, 'broadcast')", [`staffmsg:${s.w.staff.id}`])).rejects.toThrow(/row-level security/);
      await db.query("rollback to savepoint publish");
      await db.query("reset role");
      for (const stmt of splitStatements(readFileSync("supabase/optional/staff-messages-realtime.down.sql", "utf8"))) await db.query(stmt);
      const left = await db.query("select 1 from pg_policies where policyname = 'iaq_staffmsg_realtime_read' union all select 1 from pg_proc where proname = 'staff_topic_allowed'");
      expect(left.rows).toEqual([]);
      throw new Error("rolled back");
    }).catch((e) => {
      if (String(e.message) !== "rolled back") throw e;
    });
    expect(readdirSync("supabase/migrations").filter((f) => /realtime/i.test(f))).toEqual([]);
    // The migration creates no Realtime policy and grants nothing to a browser role.
    const sql = readFileSync("supabase/migrations/0096_staff_messages.sql", "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/create\s+policy[^;]*realtime\.messages/i);
    expect(sql).not.toMatch(/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });
});
