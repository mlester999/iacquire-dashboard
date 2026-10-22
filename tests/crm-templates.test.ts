// Message templates, canned replies, the token renderer and Communication Settings. Synthetic workspaces only: nothing here contacts a
// messaging provider (fetch is stubbed to fail loudly) and no message is dispatched.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { agencyActor, memberActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import {
  addTestDestination, approveTemplate, archiveCannedReply, archiveTemplate, cannedRepliesForConversation, createCannedReply, createTemplate, duplicateTemplate,
  getCommunicationSettings, getTemplate, listCannedReplies, listTemplates, listTestDestinations, listWhatsappTemplates, loadApprovedTemplate, parseCapabilityTest,
  previewTemplate, previewValues, removeTestDestination, restoreCannedReply, restoreTemplate, templateContentHash, testSendTemplate, updateCannedReply, updateTemplate,
} from "@/server/crm/message-templates";
import {
  describeMissing, extractTokens, renderMessage, renderTemplate, sampleTokenValues, smsEstimate, suggestToken, TEMPLATE_LIMITS, TEMPLATE_TOKENS, tokensUsed, validateTemplate,
} from "@/lib/messaging/tokens";
import { smsSegments } from "@/lib/messaging";
import { diffSummary, diffText } from "@/components/crm/templates/diff";
import { applySuggestion } from "@/components/crm/templates/parts";
import { TemplatesWorkspace } from "@/components/crm/templates/templates-workspace";
import { CommunicationSettings } from "@/components/crm/communications/communication-settings";
import { AgencyChannelSetup } from "@/components/crm/communications/agency-channel-setup";
import { listChannelStatus } from "@/server/messaging/channels";
import { InboxWorkspace, type InboxDetail } from "@/components/inbox/inbox-workspace";
import type { CrmScope } from "@/server/crm/page";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { messagingOrg, type MessagingOrg } from "./support/messaging";

// Screens are rendered on the server here, outside Next: router and server actions are stand-ins that are never called.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/crm/templates",
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-templates", () => Object.fromEntries([
  "getTemplateAction", "createTemplateAction", "updateTemplateAction", "approveTemplateAction", "archiveTemplateAction", "restoreTemplateAction", "duplicateTemplateAction",
  "previewTemplateAction", "previewValuesAction", "testSendTemplateAction", "createCannedReplyAction", "updateCannedReplyAction", "archiveCannedReplyAction",
  "restoreCannedReplyAction", "duplicateCannedReplyAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm-communications", () => Object.fromEntries([
  "addTestDestinationAction", "removeTestDestinationAction", "requestChannelSetupAction", "configureChannelAction", "runChannelTestAction", "setChannelOnAction", "switchChannelToGhlAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction", "createFolderAction"].map((n) => [n, stub])));
vi.mock("@/app/actions/inbox", () => Object.fromEntries([
  "addMemoryAction", "addNoteAction", "approveDraftAction", "assignConversationAction", "claimEscalationAction", "declineEscalationAction", "deleteMemoryAction", "discardDraftAction",
  "markReadAction", "resolveEscalationAction", "resumeAiAction", "sendReplyAction", "setConversationStateAction", "takeOverAction",
].map((n) => [n, stub])));

const expectError = async (p: Promise<unknown>, code: string) => {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await p.catch((e: AppError) => expect(e.code).toBe(code));
};
const messageCount = (orgId: string) => withSystem(async (db) => Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [orgId])).rows[0].n));
const contactCount = (orgId: string) => withSystem(async (db) => Number((await db.query<{ n: string }>("select count(*)::text as n from contacts where org_id = $1", [orgId])).rows[0].n));

// ---------------------------------------------------------------------------
// Tokens: catalog, validation, rendering
// ---------------------------------------------------------------------------

describe("token renderer", () => {
  it("lists every token from the brief with a label and a sample", () => {
    expect(TEMPLATE_TOKENS.map((t) => t.key)).toEqual([
      "contact.first_name", "contact.last_name", "contact.full_name", "contact.email", "contact.phone", "business.name", "business.phone", "business.email", "business.website",
      "user.first_name", "appointment.date", "appointment.time", "appointment.type", "appointment.location", "appointment.manage_link", "review.link",
    ]);
    for (const t of TEMPLATE_TOKENS) expect(t.label && t.sample && t.phrase).toBeTruthy();
  });

  it("finds tokens, known or not, with their positions", () => {
    const found = extractTokens("Hi {{ contact.first_name }}, {{foo}} and {{contact.first_name}}");
    expect(found.map((t) => [t.key, t.known])).toEqual([["contact.first_name", true], ["foo", false], ["contact.first_name", true]]);
    expect(found[0].raw).toBe("{{ contact.first_name }}");
    expect(tokensUsed("{{business.name}}", "Hi {{contact.first_name}} from {{business.name}}")).toEqual(["business.name", "contact.first_name"]);
  });

  it("fills values once and reports what is missing instead of leaving a raw placeholder", () => {
    const r = renderTemplate("Hi {{contact.first_name}}, see you {{appointment.date}} at {{business.name}}.", { "contact.first_name": "Ana", "business.name": "Acme" });
    expect(r.text).toBe("Hi Ana, see you  at Acme.");
    expect(r.missing).toEqual(["appointment.date"]);
    expect(r.ok).toBe(false);
    const full = renderTemplate("Hi {{contact.first_name}}", { "contact.first_name": "  Ana  " });
    expect(full).toMatchObject({ text: "Hi Ana", ok: true, missing: [], unknown: [] });
    // Blank values count as missing; unknown placeholders are reported separately.
    expect(renderTemplate("{{contact.last_name}}{{nope}}", { "contact.last_name": "   " })).toMatchObject({ missing: ["contact.last_name"], unknown: ["nope"], text: "" });
  });

  it("never leaves a raw {{…}} in the output, whatever the template or the values contain", () => {
    const nasty = ["{{{contact.first_name}}}", "{{{{x}}}}", "{{", "}}", "{{contact.first_name", "a {{ }} b", "{{contact.email}}}}{{", "{{1}}", "{ {contact.first_name} }"];
    const values = { "contact.first_name": "{{business.email}}", "contact.email": "}}{{", "business.email": "secret@example.com" } as const;
    for (const t of nasty) {
      const out = renderTemplate(t, values).text;
      expect(out.includes("{{"), t).toBe(false);
      expect(out.includes("}}"), t).toBe(false);
    }
    // A value is never expanded again: a contact named "{{business.email}}" does not leak the business address.
    expect(renderTemplate("{{contact.first_name}}", values).text).not.toContain("secret@example.com");
    // Random brace soup.
    for (let i = 0; i < 300; i += 1) {
      const s = Array.from({ length: 30 }, () => "{}ab. "[Math.floor(Math.random() * 6)]).join("");
      const out = renderTemplate(s, values, { missingAs: () => "{{x}}" }).text;
      expect(out.includes("{{") || out.includes("}}"), s).toBe(false);
    }
  });

  it("renders a subject on one line and explains what is missing in plain words", () => {
    const m = renderMessage({ subject: "Visit {{appointment.date}}", body: "Hi {{contact.first_name}}" }, { "appointment.date": "Tuesday\n21 October" });
    expect(m.subject).toBe("Visit Tuesday 21 October");
    expect(m.missing).toEqual(["contact.first_name"]);
    expect(describeMissing(m.missing)).toBe("This message needs the contact's first name, which isn't available.");
    expect(describeMissing(["contact.first_name", "appointment.time"], ["oops"])).toContain("the contact's first name and the appointment time, which aren't available");
  });

  it("estimates SMS segments exactly as billing counts them", () => {
    for (const text of ["Hi", "x".repeat(160), "x".repeat(161), "€".repeat(80), "€".repeat(81), "Hi 😀", "é".repeat(160), "“quoted”".repeat(20)]) {
      expect(smsEstimate(text).segments, text).toBe(smsSegments(text));
    }
    expect(smsEstimate("Hi 😀")).toMatchObject({ encoding: "UCS-2", nonGsm: ["😀"] });
    expect(smsEstimate("x".repeat(161))).toMatchObject({ encoding: "GSM-7", segments: 2, perSegment: 153 });
  });
});

describe("template validation", () => {
  it("rejects unknown tokens and suggests the one meant", () => {
    const v = validateTemplate("Hi {{first_name}} and {{contact.nickname}}", null, "sms");
    expect(v.ok).toBe(false);
    expect(v.errors.map((e) => [e.code, e.token, e.suggestion])).toEqual([["unknown_token", "{{first_name}}", "contact.first_name"], ["unknown_token", "{{contact.nickname}}", undefined]]);
    expect(suggestToken("First Name")).toBe("contact.first_name");
    expect(validateTemplate("Hi {{1}}", null, "whatsapp").errors[0].code).toBe("positional_token");
    expect(validateTemplate("Hi {{contact.first_name", null, "sms").errors[0].code).toBe("stray_braces");
    expect(validateTemplate("Hi {}", null, "sms").ok).toBe(true);
    const single = validateTemplate("Hi {contact.first_name}", null, "sms");
    expect(single.ok).toBe(true);
    expect(single.warnings[0]).toMatchObject({ code: "single_braces", suggestion: "contact.first_name" });
  });

  it("fixing a suggestion only replaces the mistyped placeholder", () => {
    const text = "Hi {contact.first_name}, yes {{contact.first_name}}";
    const issue = validateTemplate(text, null, "sms").warnings.find((w) => w.code === "single_braces")!;
    expect(applySuggestion(text, issue)).toBe("Hi {{contact.first_name}}, yes {{contact.first_name}}");
    const unknown = validateTemplate("Hi {{first_name}}!", null, "sms").errors[0];
    expect(applySuggestion("Hi {{first_name}}!", unknown)).toBe("Hi {{contact.first_name}}!");
  });

  it("applies each channel's limits and rules", () => {
    expect(validateTemplate("Body", "", "email").errors.map((e) => e.code)).toEqual(["subject_required"]);
    expect(validateTemplate("Body", "Line\nbreak", "email").errors.map((e) => e.code)).toContain("subject_multiline");
    expect(validateTemplate("Body", "{{contact.oops}}", "email").errors[0]).toMatchObject({ field: "subject", code: "unknown_token" });
    // SMS: segments are information, length over Twilio's 1,600 characters is an error, emoji are a warning, marketing needs STOP wording.
    const sms = validateTemplate("Hi {{contact.first_name}}, your visit is confirmed.", null, "sms");
    expect(sms.ok).toBe(true);
    expect(sms.info[0].code).toBe("sms_segments");
    expect(sms.sms?.segments).toBe(1);
    expect(validateTemplate("x".repeat(TEMPLATE_LIMITS.sms + 1), null, "sms").errors[0].code).toBe("sms_too_long");
    expect(validateTemplate("Great 😀", null, "sms").warnings.map((w) => w.code)).toContain("sms_unicode");
    expect(validateTemplate("Sale today!", null, "sms", { purpose: "marketing" }).warnings.map((w) => w.code)).toContain("sms_opt_out");
    expect(validateTemplate("Sale today! Reply STOP to opt out.", null, "sms", { purpose: "marketing" }).warnings.map((w) => w.code)).not.toContain("sms_opt_out");
    // WhatsApp: Meta's 4,096-character text limit (measured with sample values) and the 24-hour window note.
    expect(validateTemplate("x".repeat(4097), null, "whatsapp").errors[0].code).toBe("whatsapp_too_long");
    expect(validateTemplate("Hello", null, "whatsapp").info.map((i) => i.code)).toContain("whatsapp_window");
    expect(validateTemplate("Offer", "Deals", "email", { purpose: "marketing" }).warnings.map((w) => w.code)).toContain("email_unsubscribe");
    // Storage limit and empty bodies.
    expect(validateTemplate("", null, "sms").errors[0].code).toBe("body_required");
    expect(validateTemplate("x".repeat(5001), null, "email").errors.map((e) => e.code)).toContain("body_too_long");
    // Canned replies have no subject and may be for any channel.
    expect(validateTemplate("Thanks!", "ignored", null, { kind: "canned_reply" })).toMatchObject({ ok: true });
    expect(sampleTokenValues({ "business.name": " Acme " })["business.name"]).toBe("Acme");
  });
});

describe("version diff", () => {
  it("marks added and removed words", () => {
    const parts = diffText("Hi there, see you Monday.", "Hi there, see you on Tuesday!");
    expect(parts.filter((p) => p.kind === "del").map((p) => p.text.trim())).toEqual(["Monday."]);
    expect(parts.filter((p) => p.kind === "add").map((p) => p.text).join("")).toContain("Tuesday!");
    expect(parts.filter((p) => p.kind !== "add").map((p) => p.text).join("")).toBe("Hi there, see you Monday.");
    expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe("Hi there, see you on Tuesday!");
    expect(diffSummary(parts).added).toBeGreaterThan(0);
    expect(diffText("same", "same")).toEqual([{ kind: "same", text: "same" }]);
    // Long texts fall back to lines and still reconstruct both sides.
    const a = Array.from({ length: 1500 }, (_, i) => `word${i}`).join(" ");
    const b = `${a} extra`;
    const big = diffText(a, b);
    expect(big.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Templates: versions, approval, permissions, isolation
// ---------------------------------------------------------------------------

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Templates A", timezone: "Asia/Manila" });
  b = await crmOrg({ name: "Templates B" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("template versions", () => {
  it("saves a frozen first version with a content hash and a key", async () => {
    const t = await createTemplate(a.actor("owner"), { name: "Visit reminder", channel: "sms", body: "Hi {{contact.first_name}}, see you {{appointment.date}}." });
    expect(t).toMatchObject({ kind: "template", status: "draft", currentVersion: 1, approvedVersion: null, key: "visit-reminder", channel: "sms", purpose: "service" });
    expect(t.contentHash).toBe(templateContentHash("sms", null, "Hi {{contact.first_name}}, see you {{appointment.date}}."));
    expect(t.tokens).toEqual(["contact.first_name", "appointment.date"]);
    // The same name gets a different key; versions can never be rewritten.
    const twin = await createTemplate(a.actor("manager"), { name: "Visit reminder", channel: "email", subject: "Your visit", body: "See you soon." });
    expect(twin.key).toBe("visit-reminder-2");
    await expect(withSystem((db) => db.query("update crm_message_template_versions set body = 'changed' where template_id = $1", [t.id]))).rejects.toThrow();
  });

  it("refuses unknown tokens, a missing subject and an empty name when saving", async () => {
    await expectError(createTemplate(a.actor("owner"), { name: "Bad", channel: "sms", body: "Hi {{first_name}}" }), "invalid_input");
    await expectError(createTemplate(a.actor("owner"), { name: "No subject", channel: "email", body: "Hello" }), "invalid_input");
    await expectError(createTemplate(a.actor("owner"), { name: "  ", channel: "sms", body: "Hello" }), "invalid_input");
    await expectError(createTemplate(a.actor("owner"), { name: "No channel", body: "Hello" }), "invalid_input");
  });

  it("records a new version only when the wording changes, and an edit after approval goes back to draft", async () => {
    const owner = a.actor("owner");
    const t = await createTemplate(owner, { name: "Quote follow-up", channel: "email", subject: "Your quote", body: "Hi {{contact.first_name}}, any questions?" });
    const renamed = await updateTemplate(owner, t.id, { name: "Quote follow-up (warm)" });
    expect(renamed).toMatchObject({ newVersion: false, unapproved: false });
    expect(renamed.template.currentVersion).toBe(1);

    const approved = await approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash });
    expect(approved).toMatchObject({ status: "approved", approvedVersion: 1, approvedByName: "Owner Person" });
    expect((await loadApprovedTemplate(await dbOnce(), a.org.id, { id: t.id }))?.body).toBe("Hi {{contact.first_name}}, any questions?");

    const edited = await updateTemplate(owner, t.id, { body: "Hi {{contact.first_name}}, any questions about the quote?", expectedVersion: 1 });
    expect(edited).toMatchObject({ newVersion: true, unapproved: true });
    expect(edited.template).toMatchObject({ status: "draft", currentVersion: 2, approvedVersion: null, approvedAt: null });
    // Nothing unapproved is ever handed to automation.
    expect(await loadApprovedTemplate(await dbOnce(), a.org.id, { id: t.id })).toBeNull();

    const detail = await getTemplate(owner, t.id);
    expect(detail.versions.map((v) => [v.version, v.body])).toEqual([[2, "Hi {{contact.first_name}}, any questions about the quote?"], [1, "Hi {{contact.first_name}}, any questions?"]]);
    expect(detail.versions[0].contentHash).not.toBe(detail.versions[1].contentHash);

    // A stale editor can't overwrite a newer version, and a stale approval binds nothing.
    await expectError(updateTemplate(owner, t.id, { body: "Old tab", expectedVersion: 1 }), "conflict");
    await expectError(approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash }), "conflict");
    await expectError(approveTemplate(owner, t.id, { version: 2, contentHash: t.contentHash }), "conflict");
    const again = await approveTemplate(a.actor("manager"), t.id, { version: 2, contentHash: detail.versions[0].contentHash });
    expect(again).toMatchObject({ status: "approved", approvedVersion: 2 });
    const bound = await loadApprovedTemplate(await dbOnce(), a.org.id, { key: again.key, contentHash: detail.versions[0].contentHash });
    expect(bound).toMatchObject({ version: 2, channel: "email", subject: "Your quote" });
    expect(await loadApprovedTemplate(await dbOnce(), a.org.id, { key: again.key, contentHash: t.contentHash })).toBeNull();

    // Changing the purpose (consent rules differ) also needs a new approval, even though the words are the same.
    const purpose = await updateTemplate(owner, t.id, { purpose: "marketing", body: "Hi {{contact.first_name}}, any questions about the quote? To unsubscribe, reply STOP." });
    expect(purpose.unapproved).toBe(true);
  });

  it("archives (withdrawing approval), restores as a draft and duplicates", async () => {
    const owner = a.actor("owner");
    const t = await createTemplate(owner, { name: "Thanks", channel: "whatsapp", body: "Thanks {{contact.first_name}}!" });
    await approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash });
    await archiveTemplate(owner, t.id);
    const archived = (await listTemplates(owner, { includeArchived: true })).find((x) => x.id === t.id)!;
    expect(archived).toMatchObject({ status: "archived", approvedVersion: null });
    expect((await listTemplates(owner)).some((x) => x.id === t.id)).toBe(false);
    await expectError(updateTemplate(owner, t.id, { body: "x" }), "conflict");
    const restored = await restoreTemplate(owner, t.id);
    expect(restored.status).toBe("draft");
    const copy = await duplicateTemplate(owner, t.id);
    expect(copy).toMatchObject({ name: "Copy of Thanks", status: "draft", currentVersion: 1, body: "Thanks {{contact.first_name}}!" });
    expect(copy.id).not.toBe(t.id);
  });

  it("links WhatsApp wording to a Meta-approved template, and only an approved one can be approved for sending", async () => {
    // A workspace whose WhatsApp sends through Meta, so Meta's templates are the usable ones; their wording is what Meta delivers.
    const w = await crmOrg({ name: "Templates WA" });
    const owner = w.actor("owner");
    await withSystem(async (db) => {
      await db.query("insert into messaging_channels (org_id, channel, provider) values ($1, 'whatsapp', 'meta_whatsapp')", [w.org.id]);
      await db.query(
        "insert into whatsapp_templates (org_id, template_id, name, status, provider, category, body) values ($1, 'wa_pending', 'order_update', 'pending', 'meta_whatsapp', 'utility', 'Your order is ready.'), ($1, 'wa_ok', 'order_ready', 'approved', 'meta_whatsapp', 'utility', 'Your order is ready.')",
        [w.org.id],
      );
    });
    await expectError(createTemplate(owner, { name: "Email link", channel: "email", subject: "S", body: "B", whatsappTemplateId: "wa_ok" }), "invalid_input");
    await expectError(createTemplate(owner, { name: "Ghost", channel: "whatsapp", body: "B", whatsappTemplateId: "missing" }), "invalid_input");
    const t = await createTemplate(owner, { name: "Order update", channel: "whatsapp", body: "Your order is ready.", whatsappTemplateId: "wa_pending" });
    await expectError(approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash }), "conflict");
    const linked = await updateTemplate(owner, t.id, { whatsappTemplateId: "wa_ok" });
    expect(linked.newVersion).toBe(false);
    expect((await approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash })).status).toBe("approved");
    // Re-pointing an approved template at another Meta template needs a new approval.
    expect((await updateTemplate(owner, t.id, { whatsappTemplateId: null })).unapproved).toBe(true);
    const synced = await listWhatsappTemplates(w.actor("viewer"));
    expect(synced.map((w) => [w.templateId, w.status, w.category])).toEqual(expect.arrayContaining([["wa_ok", "approved", "utility"], ["wa_pending", "pending", "utility"]]));
  });
});

describe("template permissions", () => {
  it("lets everyone who works the inbox read templates, and only owners and managers write and approve them", async () => {
    const owner = a.actor("owner");
    const t = await createTemplate(owner, { name: "Read only check", channel: "sms", body: "Hello" });
    for (const who of ["sales", "setter", "support", "viewer"] as const) {
      expect((await listTemplates(a.actor(who))).some((x) => x.id === t.id), who).toBe(true);
      await expectError(createTemplate(a.actor(who), { name: "Nope", channel: "sms", body: "Hello" }), "forbidden");
      await expectError(updateTemplate(a.actor(who), t.id, { body: "Changed" }), "forbidden");
      await expectError(approveTemplate(a.actor(who), t.id, { version: 1, contentHash: t.contentHash }), "forbidden");
      await expectError(archiveTemplate(a.actor(who), t.id), "forbidden");
    }
  });

  it("lets a super admin's write session prepare drafts but never approve or test-send for the client", async () => {
    const { superAdmin, staff } = await agencyPeople();
    await startSupportSession(superAdmin, a.org.id, { mode: "write", reason: "Preparing reminder templates" });
    const agency = await agencyActor(superAdmin, a.org.id);
    const t = await createTemplate(agency, { name: "Prepared by support", channel: "sms", body: "Hi {{contact.first_name}}" });
    await expectError(approveTemplate(agency, t.id, { version: 1, contentHash: t.contentHash }), "forbidden");
    await expectError(testSendTemplate(agency, t.id, { destination: "+15555550123" }), "forbidden");
    // A read-only session can look but not write.
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [a.org.id, staff.id]));
    await startSupportSession(staff, a.org.id, { mode: "read", reason: "Checking template wording" });
    const reader = await agencyActor(staff, a.org.id);
    expect((await listTemplates(reader)).some((x) => x.id === t.id)).toBe(true);
    await expectError(createTemplate(reader, { name: "No", channel: "sms", body: "x" }), "forbidden");
  });

  it("keeps each workspace's templates to itself", async () => {
    const t = await createTemplate(a.actor("owner"), { name: "Private wording", channel: "sms", body: "Only for A" });
    const other = b.actor("owner");
    expect((await listTemplates(other)).some((x) => x.id === t.id)).toBe(false);
    await expectError(getTemplate(other, t.id), "not_found");
    await expectError(updateTemplate(other, t.id, { body: "Hijack" }), "not_found");
    await expectError(approveTemplate(other, t.id, { version: 1, contentHash: t.contentHash }), "not_found");
    await expectError(archiveTemplate(other, t.id), "not_found");
    await expectError(previewTemplate(other, t.id), "not_found");
    expect(await loadApprovedTemplate(await dbOnce(), b.org.id, { id: t.id })).toBeNull();
    // A contact from another workspace can't be used to preview.
    const contactB = await withSystem(async (db) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name) values ($1, 'Bea B', 'Bea') returning id", [b.org.id])).rows[0].id);
    await expectError(previewTemplate(a.actor("owner"), t.id, { contactId: contactB }), "not_found");
    await expectError(previewValues(a.actor("owner"), { contactId: contactB }), "not_found");
  });

  it("scopes reads at the database too (row-level security)", async () => {
    const t = await createTemplate(a.actor("owner"), { name: "RLS check", channel: "sms", body: "Hello" });
    const visible = (userId: string) => withUser(userId, async (db) => ({
      templates: (await db.query("select id from crm_message_templates where id = $1", [t.id])).rows.length,
      versions: (await db.query("select id from crm_message_template_versions where template_id = $1", [t.id])).rows.length,
    }));
    expect(await visible(a.people.viewer.id)).toEqual({ templates: 1, versions: 1 });
    expect(await visible(b.people.owner.id)).toEqual({ templates: 0, versions: 0 });
    const { staff } = await agencyPeople();
    expect(await visible(staff.id)).toEqual({ templates: 0, versions: 0 });
    // The application role can only read: writes go through the service.
    await expect(withUser(a.people.owner.id, (db) => db.query("update crm_message_templates set name = 'x' where id = $1", [t.id]))).rejects.toThrow();
  });
});

describe("preview", () => {
  it("renders with a real contact of the workspace, or labelled sample values", async () => {
    const owner = a.actor("owner");
    await withSystem((db) => db.query("insert into company_profiles (org_id, contact_phone) values ($1, '+15555550100') on conflict (org_id) do update set contact_phone = excluded.contact_phone", [a.org.id]));
    const t = await createTemplate(owner, { name: "Preview me", channel: "email", subject: "Hi {{contact.first_name}}", body: "{{business.name}} ({{business.phone}}) will see you {{appointment.date}}. {{user.first_name}}" });
    const sample = await previewTemplate(owner, t.id);
    expect(sample.mode).toBe("sample");
    expect(sample.subject).toBe("Hi Maria");
    expect(sample.body).toBe("Templates A (+15555550100) will see you Tuesday, 21 October. Owner");
    expect(sample.values.find((v) => v.key === "contact.first_name")).toMatchObject({ source: "sample" });
    expect(sample.values.find((v) => v.key === "business.name")).toMatchObject({ source: "business", value: "Templates A" });

    const contactId = await withSystem(async (db) => {
      const { rows } = await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name, last_name, email) values ($1, 'Jo Cruz', 'Jo', 'Cruz', 'jo@example.com') returning id", [a.org.id]);
      return rows[0].id;
    });
    const real = await previewTemplate(owner, t.id, { contactId });
    expect(real).toMatchObject({ mode: "contact", subject: "Hi Jo", missing: ["appointment.date"], contact: { id: contactId, name: "Jo Cruz" } });
    expect(real.body).not.toContain("{{");
    expect(real.missingText).toContain("the appointment date");

    await withSystem((db) => db.query(
      `insert into appointment_refs (org_id, provider, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, location)
       values ($1, 'ghl', 'appt_tpl_1', 'cal_tpl_1', 'Site visit', 'confirmed', now() + interval '3 days', now() + interval '3 days 1 hour', $2, '12 Rizal Ave')`,
      [a.org.id, contactId],
    ));
    const withAppt = await previewValues(owner, { contactId });
    expect(withAppt.rows.find((r) => r.key === "appointment.type")).toMatchObject({ value: "Site visit", source: "appointment" });
    expect(withAppt.rows.find((r) => r.key === "appointment.location")).toMatchObject({ value: "12 Rizal Ave" });
    expect(withAppt.rows.find((r) => r.key === "appointment.manage_link")).toMatchObject({ value: null, source: "missing" });
  });
});

// ---------------------------------------------------------------------------
// Canned replies
// ---------------------------------------------------------------------------

describe("canned replies", () => {
  it("are created, versioned, filtered by channel, archived and restored, and never need approval", async () => {
    const owner = a.actor("owner");
    const any = await createCannedReply(owner, { name: "Opening hours", body: "Hi {{contact.first_name}}, we're open 9 to 5." });
    const smsOnly = await createCannedReply(owner, { name: "Text directions", channel: "sms", body: "We're at {{business.name}}." });
    expect(any).toMatchObject({ kind: "canned_reply", channel: null, purpose: "service", subject: null, status: "draft" });
    expect((await listCannedReplies(owner, { channel: "email" })).map((r) => r.id)).toContain(any.id);
    expect((await listCannedReplies(owner, { channel: "email" })).map((r) => r.id)).not.toContain(smsOnly.id);
    expect((await listCannedReplies(owner, { channel: "sms" })).map((r) => r.id)).toEqual(expect.arrayContaining([any.id, smsOnly.id]));
    expect((await listTemplates(owner, { kind: "template" })).some((t) => t.id === any.id)).toBe(false);

    const edited = await updateCannedReply(owner, any.id, { body: "Hi {{contact.first_name}}, we're open 9 to 6.", expectedVersion: 1 });
    expect(edited).toMatchObject({ newVersion: true, unapproved: false });
    expect(edited.template.currentVersion).toBe(2);
    await expectError(updateCannedReply(owner, any.id, { body: "{{nope}}" }), "invalid_input");
    await expectError(approveTemplate(owner, any.id, { version: 2, contentHash: edited.template.contentHash }), "invalid_input");
    await expectError(createCannedReply(a.actor("sales"), { name: "No", body: "x" }), "forbidden");

    await archiveCannedReply(owner, any.id);
    expect((await listCannedReplies(owner)).some((r) => r.id === any.id)).toBe(false);
    await restoreCannedReply(owner, any.id);
    expect((await listCannedReplies(owner)).some((r) => r.id === any.id)).toBe(true);
    // Another workspace can't touch them.
    await expectError(updateCannedReply(b.actor("owner"), any.id, { body: "x" }), "not_found");
    await expectError(archiveCannedReply(b.actor("owner"), any.id), "not_found");
    // The updater for templates refuses a canned reply id and vice versa.
    await expectError(updateTemplate(owner, any.id, { body: "x" }), "not_found");
  });

  it("are offered in the inbox with the conversation contact's details", async () => {
    const owner = a.actor("owner");
    await createCannedReply(owner, { name: "Greeting", channel: "whatsapp", body: "Hello {{contact.first_name}}!" });
    const contactId = await withSystem(async (db) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name) values ($1, 'Lea Reyes', 'Lea') returning id", [a.org.id])).rows[0].id);
    const out = await cannedRepliesForConversation(a.actor("sales"), { channel: "whatsapp", contactId });
    expect(out.replies.map((r) => r.name)).toContain("Greeting");
    expect(out.values["contact.first_name"]).toBe("Lea");
    expect(renderTemplate("Hello {{contact.first_name}}!", out.values).text).toBe("Hello Lea!");
    // Viewers can't reply, so they get none.
    expect((await cannedRepliesForConversation(a.actor("viewer"), { channel: "whatsapp", contactId })).replies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test destinations and test sends
// ---------------------------------------------------------------------------

let m: MessagingOrg;
let mOther: MessagingOrg;
let owner: CrmActor;
const TWILIO_ACCOUNT = `AC${"e5".repeat(16)}`;
const SERVICE = `MG${"f6".repeat(16)}`;

async function connectTwilio(org: MessagingOrg, sender: string) {
  await withSystem(async (db) => {
    const saved = await saveCredential(db, { orgId: org.org.id, provider: "twilio", label: "Twilio (synthetic test)", secret: JSON.stringify({ accountSid: TWILIO_ACCOUNT, authToken: "0123456789abcdef0123456789abcdef" }), actorId: org.superAdmin.id });
    await db.query(
      `update messaging_channels set provider = 'twilio', provider_sender_id = $2, provider_account_id = $3, credential_id = $4, capability_test = '{"ok":true,"checks":[{"label":"Account","ok":true,"detail":"Active"}]}'::jsonb, capability_tested_at = now()
       where org_id = $1 and channel = 'sms'`,
      [org.org.id, sender, TWILIO_ACCOUNT, saved.id],
    );
  });
}

describe("test sends", () => {
  beforeAll(async () => {
    m = await messagingOrg({ name: "Test send Co" });
    mOther = await messagingOrg({ name: "Other send Co" });
    owner = memberActor(m.ctx("owner"));
    await connectTwilio(m, SERVICE);
    await publishUnitRate(m.superAdmin, { provider: "twilio", unitType: "sms_segment", wholesaleMicrosPerUnit: 7900 });
  });
  afterAll(() => {
    delete process.env.TWILIO_WRITES_ENABLED;
    resetEnvCache();
  });
  const noNetwork = () => vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });

  it("manages approved test destinations: own addresses only, confirmed, per workspace", async () => {
    await expectError(addTestDestination(owner, { channel: "sms", address: "+15555550123", confirmOwnAddress: false }), "invalid_input");
    await expectError(addTestDestination(owner, { channel: "sms", address: "12345", confirmOwnAddress: true }), "invalid_input");
    await expectError(addTestDestination(memberActor(m.ctx("sales")), { channel: "sms", address: "+15555550123", confirmOwnAddress: true }), "forbidden");
    const d = await addTestDestination(owner, { channel: "sms", address: "+1 555 555 0123", label: "Owner phone", confirmOwnAddress: true });
    expect(d).toMatchObject({ channel: "sms", address: "+15555550123", label: "Owner phone" });
    await expectError(addTestDestination(owner, { channel: "sms", address: "+15555550123", confirmOwnAddress: true }), "conflict");
    await addTestDestination(owner, { channel: "email", address: "Owner@Example.com", confirmOwnAddress: true });
    expect((await listTestDestinations(owner)).map((x) => `${x.channel}:${x.address}`)).toEqual(["email:owner@example.com", "sms:+15555550123"]);
    expect(await listTestDestinations(memberActor(mOther.ctx("owner")))).toEqual([]);
    await removeTestDestination(owner, { channel: "email", address: "owner@example.com" });
    await expectError(removeTestDestination(memberActor(mOther.ctx("owner")), { channel: "sms", address: "+15555550123" }), "not_found");
  });

  it("refuses a destination that isn't approved, and queues nothing", async () => {
    noNetwork();
    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    const t = await createTemplate(owner, { name: "Try me", channel: "sms", body: "Hi {{contact.first_name}}, this is a test." });
    const before = [await messageCount(m.org.id), await contactCount(m.org.id)];
    const out = await testSendTemplate(owner, t.id, { destination: "+15555559999" });
    expect(out).toMatchObject({ ok: false, reason: "destination_not_approved" });
    // Another workspace's approved destination is not this one's.
    await addTestDestination(memberActor(mOther.ctx("owner")), { channel: "sms", address: "+15555558888", confirmOwnAddress: true });
    expect(await testSendTemplate(owner, t.id, { destination: "+15555558888" })).toMatchObject({ ok: false, reason: "destination_not_approved" });
    expect([await messageCount(m.org.id), await contactCount(m.org.id)]).toEqual(before);
  });

  it("reports exactly why when the kill switch is off or the channel isn't enabled, and queues nothing", async () => {
    noNetwork();
    const t = await createTemplate(owner, { name: "Switch check", channel: "sms", body: "A test." });
    const before = [await messageCount(m.org.id), await contactCount(m.org.id)];
    process.env.TWILIO_WRITES_ENABLED = "false";
    resetEnvCache();
    const off = await testSendTemplate(owner, t.id, { destination: "+15555550123" });
    expect(off).toMatchObject({ ok: false, reason: "transport_disabled" });
    expect(off.ok ? "" : off.detail).toBe("Sending through Twilio is switched off for this environment, so nothing was sent.");

    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    await withSystem((db) => db.query("update messaging_channels set enabled = false where org_id = $1 and channel = 'sms'", [m.org.id]));
    expect(await testSendTemplate(owner, t.id, { destination: "+15555550123" })).toMatchObject({ ok: false, reason: "channel_not_enabled" });
    await withSystem((db) => db.query("update messaging_channels set enabled = true where org_id = $1 and channel = 'sms'", [m.org.id]));

    // A WhatsApp template with no WhatsApp destination approved is refused the same way.
    const wa = await createTemplate(owner, { name: "WA check", channel: "whatsapp", body: "Hello" });
    expect(await testSendTemplate(owner, wa.id, { destination: "+15555550123" })).toMatchObject({ ok: false, reason: "destination_not_approved" });
    expect([await messageCount(m.org.id), await contactCount(m.org.id)]).toEqual(before);
  });

  it("refuses when a value the template needs is missing, and queues nothing", async () => {
    noNetwork();
    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    const t = await createTemplate(owner, { name: "Needs link", channel: "sms", body: "Change your booking: {{appointment.manage_link}}" });
    const contactId = await withSystem(async (db) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name) values ($1, 'No Booking', 'No') returning id", [m.org.id])).rows[0].id);
    const before = await messageCount(m.org.id);
    const out = await testSendTemplate(owner, t.id, { destination: "+15555550123", contactId });
    expect(out).toMatchObject({ ok: false, reason: "missing_values" });
    expect(out.ok ? "" : out.detail).toContain("the link to manage the appointment");
    expect(await messageCount(m.org.id)).toBe(before);
  });

  it("queues the rendered saved version through the normal outbound path, as the person, in a test thread", async () => {
    noNetwork();
    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    const t = await createTemplate(owner, { name: "Real test", channel: "sms", body: "Hi {{contact.first_name}}, from {{business.name}}." });
    // Both sends happen "in the same minute" (the at-most-once window), whatever the wall clock does in between.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 9, 16, 9, 30, 15));
    const out = await testSendTemplate(owner, t.id, { destination: "+15555550123" });
    expect(out).toMatchObject({ ok: true, status: "queued", to: "+15555550123" });
    if (!out.ok) throw new Error("expected a queued test");
    const row = await withSystem(async (db) => (await db.query<{ status: string; body: string; author_kind: string; author_user_id: string; scope: string; purpose: string }>("select status, body, author_kind, author_user_id, scope, purpose from conversation_messages where id = $1", [out.messageId])).rows[0]);
    expect(row).toMatchObject({ status: "queued", body: "Hi Maria, from Test send Co.", author_kind: "human", author_user_id: m.people.owner.id, scope: "human", purpose: "service" });
    const conv = await withSystem(async (db) => (await db.query<{ thread_key: string; owner_kind: string }>("select thread_key, owner_kind from conversations where id = $1", [out.conversationId])).rows[0]);
    expect(conv).toMatchObject({ thread_key: "test-messages", owner_kind: "human" });
    // The same version to the same destination a moment later is refused rather than sent twice.
    expect(await testSendTemplate(owner, t.id, { destination: "+15555550123" })).toMatchObject({ ok: false, reason: "duplicate" });
    clock.mockRestore();
    // Templates can't be test-sent by people without template access, nor canned replies at all.
    await expectError(testSendTemplate(memberActor(m.ctx("sales")), t.id, { destination: "+15555550123" }), "forbidden");
    const canned = await createCannedReply(owner, { name: "Canned", body: "Hello" });
    expect(await testSendTemplate(owner, canned.id, { destination: "+15555550123" })).toMatchObject({ ok: false, reason: "not_a_template" });
  });

  it("respects an opt-out on the test destination", async () => {
    noNetwork();
    process.env.TWILIO_WRITES_ENABLED = "true";
    resetEnvCache();
    await addTestDestination(owner, { channel: "sms", address: "+15555550124", confirmOwnAddress: true });
    const t = await createTemplate(owner, { name: "Opted out", channel: "sms", body: "A test." });
    await withSystem((db) => db.query("insert into suppressions (org_id, channel, address, reason, source) values ($1, 'sms', '+15555550124', 'opt_out', 'test')", [m.org.id]));
    const before = await messageCount(m.org.id);
    const out = await testSendTemplate(owner, t.id, { destination: "+15555550124" });
    expect(out).toMatchObject({ ok: false, reason: "refused" });
    expect(await messageCount(m.org.id)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Communication Settings read model
// ---------------------------------------------------------------------------

describe("communication settings", () => {
  it("shows each channel's provider, sender, last test and why it is off, with no secrets", async () => {
    const settings = await getCommunicationSettings(memberActor(m.ctx("viewer")));
    const sms = settings.find((s) => s.channel === "sms")!;
    expect(sms).toMatchObject({ provider: "twilio", providerLabel: "Twilio", enabled: true, configured: true, lastTest: { ok: true, checks: [{ label: "Account", ok: true, detail: "Active" }] } });
    expect(JSON.stringify(settings)).not.toMatch(/credential|0123456789abcdef|authToken/i);
    expect(settings.find((s) => s.channel === "email")).toMatchObject({ provider: "ghl", providerLabel: "GoHighLevel", enabled: true });
    const fresh = await getCommunicationSettings(a.actor("owner"));
    expect(fresh.every((s) => !s.enabled && s.whyOff === "Not set up yet. iAcquire connects this channel for you.")).toBe(true);
    expect(parseCapabilityTest({ ok: false, checks: [{ label: "Domain", ok: false, detail: "Not verified", secret: "x" }] })).toEqual({ ok: false, at: null, checks: [{ label: "Domain", ok: false, detail: "Not verified" }] });
    expect(parseCapabilityTest("nope")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const scopeOf = (over: Partial<CrmScope> = {}): CrmScope => ({
  base: "/crm", orgId: null, agency: false, readOnly: false, userId: "u1", timezone: "Asia/Manila", currency: "USD",
  can: { "crm.view": true, "inbox.view": true, "templates.manage": true, "contacts.view": true, "messaging.configure": true }, ...over,
});

describe("screens", () => {
  it("lists templates by channel and folder with their status, and the other tabs", async () => {
    const owner = a.actor("owner");
    const all = await listTemplates(owner, { includeArchived: true });
    const html = renderToStaticMarkup(React.createElement(TemplatesWorkspace, {
      scope: scopeOf(), templates: all.filter((t) => t.kind === "template"), cannedReplies: all.filter((t) => t.kind === "canned_reply"), whatsappTemplates: await listWhatsappTemplates(owner),
      folders: [], channels: [], destinations: [], canManage: true, canApprove: true, canTestSend: true, canConfigure: true, initialTab: "templates",
    }));
    expect(html).toContain("Message templates");
    expect(html).toContain("Quote follow-up (warm)");
    expect(html).toMatch(/Approved v\d|Draft/);
    expect(html).toContain("Canned replies");
    expect(html).toContain("WhatsApp (Meta)");
    expect(html).not.toContain("{{contact.first_name}}</textarea>");
  });

  it("renders Communication Settings without credentials and with the request-setup path", async () => {
    const channels = await getCommunicationSettings(memberActor(m.ctx("owner")));
    const html = renderToStaticMarkup(React.createElement(CommunicationSettings, {
      scope: scopeOf(), channels, destinations: await listTestDestinations(owner), openRequests: [], canConfigure: true, canRequestSetup: true, agencySetupHref: null,
    }));
    expect(html).toContain("Through Twilio");
    expect(html).toContain("Last connection test passed");
    expect(html).toContain("Approved test destinations");
    expect(html).toContain("/settings/messaging");
  });

  it("shows the agency each channel's setup with the credential's existence only, and controls for super admins only", async () => {
    const channels = await listChannelStatus(m.org.id);
    const webhooks = { email: { url: "https://portal.example.com/api/webhooks/resend", ready: false, note: "n" }, sms: { url: "https://portal.example.com/api/webhooks/twilio/inbound", ready: true, note: "n" }, whatsapp: { url: "https://portal.example.com/api/webhooks/meta-whatsapp", ready: false, note: "n" } };
    const html = renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: m.org.id, channels, webhooks, superAdmin: true, timeZone: "UTC" }));
    expect(html).toContain("Through Twilio");
    expect(html).toContain("Stored");
    expect(html).toContain("Run capability test");
    expect(html).toContain("Back to GoHighLevel");
    expect(html).toContain("/api/webhooks/twilio/inbound");
    expect(html).not.toContain("0123456789abcdef0123456789abcdef");
    expect(html).not.toMatch(/authToken|accessToken/);
    const staffView = renderToStaticMarkup(React.createElement(AgencyChannelSetup, { orgId: m.org.id, channels, webhooks, superAdmin: false, timeZone: "UTC" }));
    expect(staffView).toContain("Only agency super admins enter credentials");
    expect(staffView).not.toContain("Run capability test");
    expect(staffView).not.toContain("Edit setup");
  });

  it("shows the provider, delivery details and the canned replies picker in the inbox thread", () => {
    nav.search = "conversation=00000000-0000-4000-8000-000000000001";
    const detail: InboxDetail = {
      conversation: {
        id: "00000000-0000-4000-8000-000000000001", contactId: "c1", contactName: "Lea Reyes", channel: "sms", status: "open", ownerKind: "human", ownerName: "Owner Person", ownerUserId: "u1",
        assignedUserId: null, priority: "normal", unread: 0, lastMessageAt: new Date().toISOString(), preview: "Hi", escalation: null, aiAgent: null, aiPaused: false, archivedAt: null, resolvedAt: null, outcome: null, lastOutboundAt: null, waitingOnCustomer: false, attention: [], revision: 0, subject: null, lastInboundAt: new Date().toISOString(), whatsappWindowOpen: null,
      },
      contact: { id: "c1", name: "Lea Reyes", lifecycleStage: "lead_captured", temperature: null, source: "inbound_message", identities: [], consent: [] },
      messages: [{
        id: "m1", direction: "outbound", authorKind: "human", authorName: "Owner Person", body: "Hello", status: "failed", statusDetail: "Not delivered", blockedReason: null, scope: "human",
        createdAt: new Date().toISOString(), sentAt: new Date().toISOString(), deliveredAt: null, provider: "twilio", providerLabel: "Twilio", failureKind: null, retryOf: null, retriedBy: null,
        deliveryEvents: [{ status: "undelivered", rawStatus: "undelivered", detail: "Carrier rejected the message (30007)", at: new Date().toISOString() }],
      }],
      timeline: [], events: [], memories: [], followUp: null, escalation: null,
    };
    const html = renderToStaticMarkup(React.createElement(InboxWorkspace, {
      list: [detail.conversation], detail, escalations: [], me: { id: "u1", isOwner: true },
      perms: { reply: true, assign: true, notes: true, resume: true, respond: true, editContacts: true }, team: [], templates: [], timeZone: "UTC",
      filters: { q: "", channel: "", owner: "", unread: false }, channelProviders: { sms: "Twilio" },
      cannedReplies: [{ id: "r1", name: "Greeting", body: "Hi {{contact.first_name}}", channel: null, folderName: null }], cannedValues: { "contact.first_name": "Lea" },
    }));
    expect(html).toContain("via Twilio");
    expect(html).toContain("Delivery details");
    expect(html).toContain("Carrier rejected the message (30007)");
    expect(html).toContain("Canned replies");
    nav.search = "";
  });
});

/** A trusted connection for helpers that take a database handle (each call its own short transaction). */
async function dbOnce() {
  return {
    query: <R,>(sql: string, params?: unknown[]) => withSystem((db) => db.query<R & Record<string, unknown>>(sql, params)),
  } as unknown as Parameters<typeof loadApprovedTemplate>[0];
}
