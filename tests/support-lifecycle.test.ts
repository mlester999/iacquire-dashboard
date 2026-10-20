import { describe, expect, it } from "vitest";
import {
  ALL_CATEGORIES, CATEGORIES_BY_TYPE, CLIENT_VISIBLE_EVENTS, EVENT_KINDS, EVENT_NOTIFICATION_KIND, FEEDBACK_STAGES, FEEDBACK_STAGE_STATUS, STATUS_TRANSITIONS, SUPPORT_EVENTS,
  TICKET_STATUSES, canTransition, clientCanReopen, clientProgressSentence, isCategoryForType, isReopen, statusLabelForClient, statusLabelForAgency,
} from "@/lib/support/lifecycle";
import { attachmentProblem, cleanLine, cleanText, describeDiagnostics, likePattern, mimeForFilename, safeFilename, sanitizeDiagnostics, summarizeUserAgent } from "@/lib/support/content";
import { withSystem } from "@/server/db";
import { createOrg, createUser } from "./support/fixtures";

describe("support lifecycle", () => {
  it("never lets a request go back to new, and only finished requests reopen", () => {
    for (const from of TICKET_STATUSES) expect(canTransition(from, "new"), `${from} -> new`).toBe(from === "new");
    expect(canTransition("resolved", "open")).toBe(true);
    expect(canTransition("closed", "open")).toBe(true);
    expect(canTransition("closed", "resolved")).toBe(false);
    expect(canTransition("resolved", "in_progress")).toBe(false);
    expect(isReopen("resolved", "open")).toBe(true);
    expect(isReopen("open", "in_progress")).toBe(false);
  });

  it("gives clients and the team their own wording for the same status", () => {
    expect(statusLabelForClient("waiting_for_client")).toBe("Waiting for you");
    expect(statusLabelForAgency("waiting_for_client")).toBe("Waiting on client");
    expect(statusLabelForClient("new")).toBe("Received");
    expect(statusLabelForClient("open", "feedback", "under_review")).toBe("Under review");
    expect(statusLabelForClient("closed", "feedback", "not_planned")).toBe("Not planned");
  });

  it("keeps feedback stages and statuses in step", () => {
    expect(FEEDBACK_STAGES.map((s) => FEEDBACK_STAGE_STATUS[s])).toEqual(["new", "open", "in_progress", "resolved", "closed"]);
  });

  it("does not claim work that has not happened", () => {
    expect(clientProgressSentence({ status: "new", type: "support", stage: null, assigned: false, hasAgencyReply: false })).toMatch(/hasn't picked it up/);
    expect(clientProgressSentence({ status: "open", type: "support", stage: null, assigned: false, hasAgencyReply: false })).toMatch(/Waiting for an iAcquire team member/);
    expect(clientProgressSentence({ status: "in_progress", type: "support", stage: null, assigned: true, hasAgencyReply: true })).toMatch(/working on this/);
    expect(clientProgressSentence({ status: "open", type: "feedback", stage: "planned", assigned: false, hasAgencyReply: false })).toMatch(/not a delivery date/);
  });

  it("limits reopening to resolved requests inside the configured window", () => {
    const now = new Date("2026-10-20T00:00:00Z");
    expect(clientCanReopen({ status: "resolved", resolvedAt: "2026-10-10T00:00:00Z", windowDays: 14, now })).toBe(true);
    expect(clientCanReopen({ status: "resolved", resolvedAt: "2026-09-01T00:00:00Z", windowDays: 14, now })).toBe(false);
    expect(clientCanReopen({ status: "resolved", resolvedAt: "2026-10-19T00:00:00Z", windowDays: 0, now })).toBe(false);
    expect(clientCanReopen({ status: "closed", resolvedAt: "2026-10-19T00:00:00Z", windowDays: 14, now })).toBe(false);
  });

  it("offers each request type only its own categories", () => {
    expect(isCategoryForType("support", "billing")).toBe(true);
    expect(isCategoryForType("support", "feature_suggestion")).toBe(false);
    expect(isCategoryForType("issue", "feature_not_working")).toBe(true);
    expect(isCategoryForType("feedback", "positive_feedback")).toBe(true);
    expect(isCategoryForType("feedback", "crm")).toBe(false);
    for (const list of Object.values(CATEGORIES_BY_TYPE)) for (const c of list) expect(ALL_CATEGORIES).toContain(c);
  });

  it("shows a client only timeline events written for them", () => {
    for (const kind of ["priority_changed", "escalated", "note", "sla_alert", "ai_assist", "linked", "merged"]) expect(CLIENT_VISIBLE_EVENTS as readonly string[]).not.toContain(kind);
    for (const kind of CLIENT_VISIBLE_EVENTS) expect(EVENT_KINDS).toContain(kind);
  });

  it("delivers every event as a notification kind the database accepts", async () => {
    const kinds = [...new Set(Object.values(EVENT_NOTIFICATION_KIND))];
    expect(Object.keys(EVENT_NOTIFICATION_KIND).sort()).toEqual([...SUPPORT_EVENTS].sort());
    const user = await createUser();
    for (const kind of kinds) {
      await expect(withSystem((db) => db.query("insert into notifications (user_id, kind, title) values ($1, $2, 'x')", [user.id, kind])), kind).resolves.toBeTruthy();
    }
  });
});

describe("support lifecycle in the database", () => {
  it("enforces exactly the same status transitions as the code", async () => {
    const org = await createOrg();
    const user = await createUser();
    for (const from of TICKET_STATUSES) {
      for (const to of TICKET_STATUSES) {
        const t = await withSystem(async (db) => (await db.query<{ id: string }>(
          "insert into support_tickets (org_id, created_by, subject, status) values ($1, $2, $3, $4) returning id", [org.id, user.id, `${from} to ${to}`, from],
        )).rows[0]);
        const allowed = canTransition(from, to);
        const attempt = withSystem((db) => db.query("update support_tickets set status = $2 where id = $1", [t.id, to]));
        if (allowed) await expect(attempt, `${from} -> ${to}`).resolves.toBeTruthy();
        else await expect(attempt, `${from} -> ${to}`).rejects.toThrow(/invalid_support_status_transition/);
      }
    }
    // The table the code uses is the one the test just walked.
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...TICKET_STATUSES].sort());
  });

  it("never lets a request change workspace, reference or type", async () => {
    const a = await createOrg();
    const b = await createOrg();
    const user = await createUser();
    const t = await withSystem(async (db) => (await db.query<{ id: string }>("insert into support_tickets (org_id, created_by, subject) values ($1, $2, 'Move me') returning id", [a.id, user.id])).rows[0]);
    await expect(withSystem((db) => db.query("update support_tickets set org_id = $2 where id = $1", [t.id, b.id]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("update support_tickets set ref = 'IAQ-9' where id = $1", [t.id]))).rejects.toThrow(/immutable/);
    await expect(withSystem((db) => db.query("update support_tickets set request_type = 'issue' where id = $1", [t.id]))).rejects.toThrow(/immutable/);
  });

  it("only lets feedback carry a feedback stage", async () => {
    const org = await createOrg();
    const user = await createUser();
    await expect(withSystem((db) => db.query("insert into support_tickets (org_id, created_by, subject, request_type, feedback_stage) values ($1, $2, 'x y z', 'support', 'received')", [org.id, user.id]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("insert into support_tickets (org_id, created_by, subject, request_type) values ($1, $2, 'x y z', 'feedback')", [org.id, user.id]))).rejects.toThrow();
    await expect(withSystem((db) => db.query("insert into support_tickets (org_id, created_by, subject, request_type, category, feedback_stage) values ($1, $2, 'x y z', 'feedback', 'improvement', 'received')", [org.id, user.id]))).resolves.toBeTruthy();
  });
});

describe("text and technical details", () => {
  it("removes control and direction-spoofing characters but keeps real text", () => {
    expect(cleanText("Hello\u202Eevil\u0000 world\r\n\r\n\r\n\r\n\r\nBye  \n", 100)).toBe("Helloevil world\n\n\nBye");
    expect(cleanLine("one\n two\t three", 100)).toBe("one two three");
    expect(cleanText("a".repeat(50), 10)).toHaveLength(10);
    expect(cleanText("<script>alert(1)</script>", 100)).toBe("<script>alert(1)</script>");
  });

  it("escapes search wildcards", () => {
    expect(likePattern("100%_off\\")).toBe("%100\\%\\_off\\\\%");
  });

  it("keeps only allow-listed technical details", () => {
    const d = sanitizeDiagnostics({
      page: "/crm/contacts?token=abc#frag",
      browser: "Chrome 129",
      os: "Windows",
      appVersion: "1.4.2",
      references: ["err_abc123", "has spaces", "x"],
      capturedAt: "2026-10-19T10:00:00Z",
      timezone: "America/New_York",
      screen: "1440x900",
      language: "en-US",
      authorization: "Bearer secret",
      cookie: "session=1",
      apiKey: "sk-live-abcdefghijklmnop",
      password: "hunter2",
      body: { contact: "Jane" },
    });
    expect(d).toEqual({
      page: "/crm/contacts", browser: "Chrome 129", os: "Windows", appVersion: "1.4.2", references: ["err_abc123"], capturedAt: "2026-10-19T10:00:00.000Z",
      timezone: "America/New_York", screen: "1440x900", language: "en-US",
    });
    expect(JSON.stringify(d)).not.toMatch(/secret|session|sk-live|hunter2|Jane|token/);
    expect(sanitizeDiagnostics({ page: "https://evil.example/x", browser: "<img src=x onerror=1>" })).toBeNull();
    expect(sanitizeDiagnostics("string")).toBeNull();
    expect(describeDiagnostics(d!).map((r) => r.label)).toContain("Page you were on");
  });

  it("summarises a browser without guessing", () => {
    expect(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36")).toEqual({ browser: "Chrome 129", os: "Windows" });
    expect(summarizeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15")).toEqual({ browser: "Safari 17", os: "macOS" });
    expect(summarizeUserAgent("curl/8.0")).toEqual({ browser: undefined, os: undefined });
  });

  it("accepts business files and refuses executables and markup", () => {
    expect(mimeForFilename("scan.PDF")).toBe("application/pdf");
    expect(mimeForFilename("shot.webp")).toBe("image/webp");
    for (const bad of ["run.exe", "page.html", "image.svg", "macro.docm", "archive.zip", "noextension", "script.js"]) expect(mimeForFilename(bad), bad).toBeNull();
    expect(attachmentProblem({ name: "a.png", size: 11 * 1024 * 1024 }, { maxMb: 10 })).toMatch(/10 MB/);
    expect(attachmentProblem({ name: "a.png", size: 0 }, { maxMb: 10 })).toMatch(/empty/);
    expect(attachmentProblem({ name: "a.png", size: 1024 }, { maxMb: 10 })).toBeNull();
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\temp\\report final.pdf")).toBe("report final.pdf");
    expect(safeFilename("  ..hidden\u202Etxt.exe ")).toBe("hiddentxt.exe");
    expect(safeFilename("")).toBe("attachment");
  });
});
