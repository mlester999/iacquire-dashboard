// Workspace configuration values ({{custom_values.<key>}}): per-type validation, the credential detector, the token validator and renderer
// with a workspace's values, the CRUD service (key immutability, permissions, audit, delete protection, tenant isolation), the template
// paths that render for preview and sending, and the settings screen. Synthetic workspaces only: fetch is stubbed to fail loudly, nothing
// is dispatched to a provider and no real message is sent.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/server/integrations/n8n-actions", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/integrations/n8n-actions")>();
  return { ...mod, callN8nWorkflow: vi.fn(async () => ({ status: "sent", retryable: false, detail: "n8n accepted the request (HTTP 200).", httpStatus: 200 })) };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => "/crm/settings/values",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-custom-values", () => Object.fromEntries(
  ["createCustomValueAction", "updateCustomValueAction", "deleteCustomValueAction", "getCustomValueAction"].map((n) => [n, stub]),
));
vi.mock("@/app/actions/crm-templates", () => Object.fromEntries(["previewValuesAction"].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries(["searchContactsAction", "createFolderAction"].map((n) => [n, stub])));

import { withSystem, withUser } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AppError } from "@/server/errors";
import { publishUnitRate } from "@/server/billing/service";
import { saveCredential } from "@/server/security/credentials";
import { agencyActor, memberActor, startSupportSession, type CrmActor } from "@/server/crm/actor";
import {
  createCustomValue, customValueTokenCatalog, deleteCustomValue, getCustomValue, listCustomValues, loadCustomValueDefs, updateCustomValue, type CustomValueView,
} from "@/server/crm/custom-values";
import { addTestDestination, approveTemplate, createTemplate, previewTemplate, testSendTemplate, tokenValuesFor, updateTemplate } from "@/server/crm/message-templates";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { createWorkflow, publishWorkflow, requestWorkflowApproval } from "@/server/crm/workflows/definitions";
import { startManualRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { decideApproval } from "@/server/approvals/service";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import {
  customValueKeysUsed, customValueTokenValues, describeMissing, extractTokens, renderMessage, renderTemplate, splitTokens, TEMPLATE_TOKENS, tokensUsed, validateTemplate,
  type CustomValueTokenDef,
} from "@/lib/messaging/tokens";
import { checkGroup, checkKey, checkLabel, CUSTOM_VALUE_LIMITS, keyFromLabel, normalizeCustomValue } from "@/lib/crm/custom-values";
import { detectSecret, looksLikeSecret } from "@/lib/secrets";
import { CRM_NAV, navFor } from "@/lib/crm/nav";
import { CustomValuesManager } from "@/components/crm/custom-values/custom-values-manager";
import { CustomValueTokensProvider } from "@/components/crm/custom-values/token-catalog";
import { RenderedText, TokenHighlight } from "@/components/crm/templates/parts";
import type { CrmScope } from "@/server/crm/page";
import { agencyPeople, crmOrg, type CrmOrg } from "./support/crm";
import { messagingOrg, type MessagingOrg } from "./support/messaging";

const TEST_STRIPE_KEY = `sk_live_${"x".repeat(10)}`;
const TEST_STRIPE_RESTRICTED_KEY = `rk_test_${"x".repeat(10)}`;

const expectError = async (p: Promise<unknown>, code: string, message?: RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err, "expected the call to be refused").toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (message) expect((err as AppError).message).toMatch(message);
};
const noNetwork = () => vi.stubGlobal("fetch", async () => {
  throw new Error("no network in tests");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Values: per-type validation (pure)
// ---------------------------------------------------------------------------

describe("value validation", () => {
  const ok = (type: Parameters<typeof normalizeCustomValue>[0], raw: string, code?: string) => {
    const r = normalizeCustomValue(type, raw, { defaultCallingCode: code ?? null });
    if (!r.ok) throw new Error(`${type} "${raw}" was refused: ${r.error}`);
    return r.value;
  };
  const bad = (type: Parameters<typeof normalizeCustomValue>[0], raw: string, code?: string) => {
    const r = normalizeCustomValue(type, raw, { defaultCallingCode: code ?? null });
    expect(r.ok, `${type} "${raw}" should be refused`).toBe(false);
    return r.ok ? "" : r.error;
  };

  it("allows an empty value for every type, so a required value can be filled in later", () => {
    for (const t of ["text", "url", "phone", "email", "number", "color"] as const) {
      expect(ok(t, "")).toBe("");
      expect(ok(t, "   ")).toBe("");
    }
  });

  it("text: trims, keeps line breaks, and refuses tokens, control characters and anything over the limit", () => {
    expect(ok("text", "  123 Example Street\r\nMakati  ")).toBe("123 Example Street\nMakati");
    expect(bad("text", "Hi {{contact.first_name}}")).toMatch(/can't contain \{\{ or \}\}/);
    expect(bad("text", "Bell \u0007")).toMatch(/characters that can't be sent/);
    expect(ok("text", "x".repeat(CUSTOM_VALUE_LIMITS.value))).toHaveLength(CUSTOM_VALUE_LIMITS.value);
    expect(bad("text", "x".repeat(CUSTOM_VALUE_LIMITS.value + 1))).toMatch(/at most 2,000/);
  });

  it("url: adds https:// when left out, and refuses other schemes, spaces, bare hosts and credentials", () => {
    expect(ok("url", "www.example.com/book")).toBe("https://www.example.com/book");
    expect(ok("url", "https://calendly.com/acme-dental/30min")).toBe("https://calendly.com/acme-dental/30min");
    expect(ok("url", "http://example.com")).toBe("http://example.com");
    expect(bad("url", "javascript:alert(1)")).toMatch(/start with https/);
    expect(bad("url", "ftp://files.example.com")).toMatch(/start with https/);
    expect(bad("url", "example .com")).toMatch(/spaces/);
    expect(bad("url", "https://localhost")).toMatch(/full web address/);
    expect(bad("url", "https://admin:hunter22@example.com")).toMatch(/username or password/);
  });

  it("phone: normalizes to E.164, using the workspace's calling code for local numbers", () => {
    expect(ok("phone", "+63 917 123 4567")).toBe("+639171234567");
    expect(ok("phone", "0917 123 4567", "63")).toBe("+639171234567");
    expect(bad("phone", "0917 123 4567")).toMatch(/country code/);
    expect(bad("phone", "12")).toMatch(/country code/);
  });

  it("email, number and colour", () => {
    expect(ok("email", " Hello@Example.COM ")).toBe("hello@example.com");
    expect(bad("email", "not-an-email")).toMatch(/email address/);
    expect(ok("number", "15")).toBe("15");
    expect(ok("number", "-3")).toBe("-3");
    expect(ok("number", "1,200.50")).toBe("1,200.50");
    expect(ok("number", " 1 200 ")).toBe("1200");
    for (const n of ["15 USD", "1,20", "abc", "1e400", "₱500"]) bad("number", n);
    expect(ok("color", "#ABC")).toBe("#abc");
    expect(ok("color", "1F6FEB")).toBe("#1f6feb");
    for (const c of ["blue", "#12345", "rgb(0,0,0)"]) bad("color", c);
  });

  it("keys, names and groups", () => {
    expect(keyFromLabel("Booking link")).toBe("booking_link");
    expect(keyFromLabel("  Café  Opening hours! ")).toBe("cafe_opening_hours");
    expect(keyFromLabel("2026 Promo")).toBe("value_2026_promo");
    expect(keyFromLabel("!!!")).toBe("value");
    expect(keyFromLabel("x".repeat(80))).toHaveLength(48);
    expect(checkKey("booking_link")).toEqual({ ok: true, key: "booking_link" });
    for (const k of ["Booking_link", "booking-link", "1st", "", "a".repeat(49), "custom_values.x"]) expect(checkKey(k).ok, k).toBe(false);
    expect(checkLabel("  Booking   link ")).toEqual({ ok: true, label: "Booking link" });
    expect(checkLabel("   ").ok).toBe(false);
    expect(checkLabel("x".repeat(81)).ok).toBe(false);
    expect(checkGroup("  ")).toEqual({ ok: true, group: null });
    expect(checkGroup("x".repeat(61)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Credentials are never stored as values
// ---------------------------------------------------------------------------

describe("credential detector", () => {
  const SECRETS: Array<[string, string]> = [
    [TEST_STRIPE_KEY, "provider_key"],
    [TEST_STRIPE_RESTRICTED_KEY, "provider_key"],
    ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123", "provider_key"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "provider_key"],
    ["AKIAIOSFODNN7EXAMPLE", "provider_key"],
    ["AIzaSyA1234567890abcdefghijklmnopqrstuv", "provider_key"],
    ["xoxb-1234567890-abcdefghij", "provider_key"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt"],
    ["-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----", "private_key"],
    ["https://hooks.slack.com/services/T000/B000/XXXXXXXX", "webhook_url"],
    ["Our login is https://admin:pa55word@portal.example.com", "url_credentials"],
    ["https://api.example.com/v1/feed?api_key=abcd1234efgh", "secret_parameter"],
    ["password: hunter22!", "secret_assignment"],
    ["client_secret=Zm9vYmFyYmF6", "secret_assignment"],
    ["api_key = 1234567890abcdefXYZ", "secret_assignment"],
    ["Authorization: Bearer abcdefghijklmnop1234", "secret_assignment"],
    ["x9Qm2LkP7vR4tY8wZ1nB5cD3fG6hJ0aS", "random_token"],
    ["Our token 0123456789abcdef0123456789abcdef for the account", "random_token"],
  ];
  it.each(SECRETS)("flags %s", (text, kind) => {
    expect(detectSecret(text)?.kind).toBe(kind);
    expect(looksLikeSecret(text)).toBe(true);
  });

  it("leaves ordinary business values alone", () => {
    for (const text of [
      "", "SUMMER2026", "Book a free consultation", "https://www.example.com/book/consultation-30-minutes", "https://calendly.com/acme-dental/30min?month=2026-10",
      "+639171234567", "hello@yourbusiness.com", "#1f6feb", "1,200.50", "Mon–Fri 9am–6pm, Sat 9am–1pm", "123 Example Street, Makati City 1200",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "Pneumonoultramicroscopicsilicovolcanoconiosis", "Use promo key: SUMMER2026 at checkout",
      "https://www.example.com/a-very-long-landing-page-path/with-many-segments/and-more-words-2026",
    ]) {
      expect(detectSecret(text), text).toBeNull();
    }
  });

  it("is applied to every value type, with a sentence that says where credentials belong", () => {
    const r = normalizeCustomValue("text", "Wi-Fi password: hunter22!");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(/looks like a password or secret.*Integrations/);
    expect(normalizeCustomValue("url", "https://api.example.com/feed?token=abcdefgh1234").ok).toBe(false);
    expect(normalizeCustomValue("text", "Call us about SUMMER2026").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tokens with a workspace's values (pure)
// ---------------------------------------------------------------------------

const DEFS: CustomValueTokenDef[] = [
  { key: "booking_link", label: "Booking link", required: true, value: "https://www.example.com/book", group: "Links" },
  { key: "promo_code", label: "Promo code", required: false, value: "" },
  { key: "office_address", label: "Office address", required: true, value: "" },
];

describe("configuration value tokens", () => {
  it("keeps the built-in catalog as it was: configuration values are never built-in tokens", () => {
    expect(TEMPLATE_TOKENS.map((t) => t.key)).toEqual(expect.arrayContaining(["contact.first_name", "business.name", "user.first_name", "appointment.manage_link"]));
    expect(TEMPLATE_TOKENS.some((t) => t.key.startsWith("custom_values."))).toBe(false);
    expect(tokensUsed("Hi {{contact.first_name}} {{custom_values.booking_link}}")).toEqual(["contact.first_name"]);
  });

  it("accepts {{custom_values.<key>}} only for keys the workspace has", () => {
    const good = validateTemplate("Book here: {{custom_values.booking_link}} {{ custom_values.promo_code }}", null, "sms", { customValues: DEFS });
    expect(good.ok).toBe(true);
    expect(good.customValues).toEqual(["booking_link", "promo_code"]);
    // Keys alone are enough to validate.
    expect(validateTemplate("{{custom_values.booking_link}}", null, "sms", { customValues: ["booking_link"] }).ok).toBe(true);

    const unknown = validateTemplate("Visit {{custom_values.parking_info}}", null, "sms", { customValues: DEFS });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors[0]).toMatchObject({ code: "unknown_custom_value", token: "{{custom_values.parking_info}}" });
    expect(unknown.errors[0].message).toMatch(/Configuration Values/);

    // No values given: none is accepted (the server always passes the workspace's).
    const none = validateTemplate("{{custom_values.booking_link}}", null, "sms");
    expect(none.errors[0]).toMatchObject({ code: "unknown_custom_value" });
    expect(none.errors[0].message).toMatch(/there are none yet/);
  });

  it("suggests the value someone probably meant", () => {
    const typo = validateTemplate("Book: {{custom_value.Booking-Link}}", null, "sms", { customValues: DEFS });
    expect(typo.errors[0]).toMatchObject({ code: "unknown_custom_value", suggestion: "custom_values.booking_link" });
    const bare = validateTemplate("Book: {{booking_link}}", null, "sms", { customValues: DEFS });
    expect(bare.errors[0]).toMatchObject({ code: "unknown_token", suggestion: "custom_values.booking_link" });
    expect(validateTemplate("Book: {custom_values.booking_link}", null, "sms", { customValues: DEFS }).warnings[0]).toMatchObject({ code: "single_braces" });
  });

  it("measures lengths with the value itself", () => {
    const long: CustomValueTokenDef[] = [{ key: "terms", label: "Terms", required: false, value: "x".repeat(1700) }];
    const v = validateTemplate("Terms: {{custom_values.terms}}", null, "sms", { customValues: long });
    expect(v.errors.map((e) => e.code)).toContain("sms_too_long");
    expect(v.renderedLength).toBe(1707);
  });

  it("fills values; an empty optional value renders as nothing; an empty required one is missing; never a raw token", () => {
    const filled = renderTemplate("Book: {{custom_values.booking_link}}{{custom_values.promo_code}}", {}, { customValues: DEFS });
    expect(filled).toMatchObject({ text: "Book: https://www.example.com/book", ok: true, missing: [], unknown: [] });

    const held = renderMessage({ subject: "Visit {{custom_values.office_address}}", body: "See you at {{custom_values.office_address}}." }, {}, { customValues: DEFS });
    expect(held).toMatchObject({ ok: false, missing: ["custom_values.office_address"], unknown: [] });
    expect(`${held.subject}${held.body}`).not.toMatch(/\{\{|\}\}/);
    const reason = describeMissing(held.missing, held.unknown, DEFS);
    expect(reason).toContain("your “Office address” configuration value");
    expect(reason).toContain("CRM Settings → Configuration Values");

    // A key the workspace doesn't have (deleted since) is unknown, not silently blank.
    expect(renderTemplate("{{custom_values.parking_info}}", {}, { customValues: DEFS })).toMatchObject({ ok: false, unknown: ["custom_values.parking_info"], text: "" });
  });

  it("gives the same result from the values alone (as the send paths hand them over)", () => {
    const values = customValueTokenValues(DEFS);
    expect(values).toEqual({ "custom_values.booking_link": "https://www.example.com/book", "custom_values.promo_code": "" });
    expect(renderTemplate("{{custom_values.booking_link}} {{custom_values.promo_code}}", values)).toMatchObject({ ok: true, text: "https://www.example.com/book " });
    expect(renderTemplate("{{custom_values.office_address}}", values)).toMatchObject({ ok: false, missing: ["custom_values.office_address"] });
    // A value that somehow holds braces is never expanded into a placeholder.
    const sneaky = renderTemplate("{{custom_values.booking_link}}", { "custom_values.booking_link": "{{contact.email}}" });
    expect(sneaky.text).not.toMatch(/\{\{|\}\}/);
  });

  it("finds configuration value tokens, known per workspace", () => {
    expect(customValueKeysUsed("{{custom_values.a}} {{custom_values.b}}", "{{custom_values.a}} {{custom_values.Bad-Key}}")).toEqual(["a", "b"]);
    expect(extractTokens("{{custom_values.booking_link}} {{custom_values.gone}}", DEFS).map((t) => t.known)).toEqual([true, false]);
    // Without a catalog, a well-formed token is still a token (never mistaken for text).
    expect(extractTokens("{{custom_values.gone}}").map((t) => t.known)).toEqual([true]);
    expect(splitTokens("Hi {{custom_values.gone}}!", DEFS)).toEqual([{ text: "Hi " }, { text: "{{custom_values.gone}}", token: { key: "custom_values.gone", known: false } }, { text: "!" }]);
  });
});

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Values A" });
  b = await crmOrg({ name: "Values B" });
});

const auditRows = (orgId: string) => withSystem(async (db) => (await db.query<{ action: string; actor_kind: string; actor_user_id: string | null; target_id: string; metadata: Record<string, unknown> }>(
  "select action, actor_kind, actor_user_id, target_id, metadata from audit_logs where org_id = $1 and action like 'crm.custom_value_%' order by created_at, id",
  [orgId],
)).rows);

describe("configuration values: create, read, update", () => {
  it("creates a value with a key made from its name, checked for its type", async () => {
    const owner = a.actor("owner");
    const v = await createCustomValue(owner, { label: "Booking link", type: "url", value: "www.example.com/book", group: " Links ", required: true });
    expect(v).toMatchObject({ key: "booking_link", token: "{{custom_values.booking_link}}", label: "Booking link", type: "url", typeLabel: "Web address", value: "https://www.example.com/book", group: "Links", required: true, missingRequired: false, usage: [] });
    expect(v.createdByName).toBe("Owner Person");
    // The same name again gets the next free key.
    const twin = await createCustomValue(a.actor("manager"), { label: "Booking link" });
    expect(twin).toMatchObject({ key: "booking_link_2", type: "text", value: "", required: false, missingRequired: false });
    const office = await createCustomValue(owner, { key: "office_address", label: "Office address", value: "", required: true });
    expect(office.missingRequired).toBe(true);
  });

  it("refuses bad keys, duplicates, unknown types, empty names and values that don't fit their type", async () => {
    const owner = a.actor("owner");
    await expectError(createCustomValue(owner, { key: "office_address", label: "Another office" }), "conflict", /already uses the key office_address/);
    await expectError(createCustomValue(owner, { key: "Office-Address", label: "Office" }), "invalid_input", /lower-case letter/);
    await expectError(createCustomValue(owner, { label: "Opening date", type: "date" }), "invalid_input", /Choose a type/);
    await expectError(createCustomValue(owner, { label: "   " }), "invalid_input", /Give the value a name/);
    await expectError(createCustomValue(owner, { label: "Site", type: "url", value: "javascript:alert(1)" }), "invalid_input");
    await expectError(createCustomValue(owner, { label: "Hotline", type: "phone", value: "12" }), "invalid_input");
    await expectError(createCustomValue(owner, { label: "Inbox", type: "email", value: "nope" }), "invalid_input");
    await expectError(createCustomValue(owner, { label: "Deposit", type: "number", value: "15 USD" }), "invalid_input");
    await expectError(createCustomValue(owner, { label: "Brand", type: "color", value: "blue" }), "invalid_input");
    await expectError(createCustomValue(owner, { label: "Group", group: "x".repeat(61) }), "invalid_input");
    expect((await listCustomValues(owner)).values.map((v) => v.key)).not.toContain("site");
  });

  it("refuses anything that looks like a credential, on create and on update", async () => {
    const owner = a.actor("owner");
    await expectError(createCustomValue(owner, { label: "Stripe key", value: TEST_STRIPE_KEY }), "invalid_input", /Integrations, where they are encrypted/);
    await expectError(createCustomValue(owner, { label: "Feed", type: "url", value: "https://api.example.com/feed?api_key=abcd1234efgh" }), "invalid_input", /carries a key or token/);
    const wifi = await createCustomValue(owner, { label: "Wi-Fi name", value: "Clinic Guest" });
    await expectError(updateCustomValue(owner, wifi.id, { value: "password: hunter22!" }), "invalid_input", /password or secret/);
    expect((await getCustomValue(owner, wifi.id)).value).toBe("Clinic Guest");
  });

  it("lists by group with search, and marks required values that are empty", async () => {
    const owner = a.actor("owner");
    const all = await listCustomValues(owner);
    expect(all.limit).toBe(200);
    // Values without a group first, then groups; by name inside each.
    expect(all.values.map((v) => [v.group, v.key])).toEqual([[null, "booking_link_2"], [null, "office_address"], [null, "wi_fi_name"], ["Links", "booking_link"]]);
    expect(all.values.filter((v) => v.missingRequired).map((v) => v.key)).toEqual(["office_address"]);
    expect((await listCustomValues(owner, { q: "OFFICE" })).values.map((v) => v.key)).toEqual(["office_address"]);
    expect((await listCustomValues(owner, { q: "example.com" })).values.map((v) => v.key)).toEqual(["booking_link"]);
    expect((await listCustomValues(owner, { q: "links" })).values.map((v) => v.key)).toEqual(["booking_link"]);
    // Search wildcards are literal.
    expect((await listCustomValues(owner, { q: "%" })).values).toEqual([]);
    expect((await listCustomValues(owner, { q: "_" })).values.map((v) => v.key)).toEqual(["booking_link_2", "office_address", "wi_fi_name", "booking_link"]);
  });

  it("updates name, value, group and required flag; the key never changes", async () => {
    const owner = a.actor("owner");
    const v = await createCustomValue(owner, { label: "Clinic phone", type: "phone", value: "+63 917 123 4567", group: "Contact" });
    const r = await updateCustomValue(owner, v.id, { label: "Front desk phone", value: "+63 917 765 4321", group: "", required: true, expectedUpdatedAt: v.updatedAt });
    expect(r.changed).toEqual(["label", "value", "group", "required"]);
    expect(r.value).toMatchObject({ key: "clinic_phone", label: "Front desk phone", value: "+639177654321", group: null, required: true });

    await expectError(updateCustomValue(owner, v.id, { key: "front_desk_phone" }), "invalid_input", /The key clinic_phone can't change: templates refer to it as \{\{custom_values\.clinic_phone\}\}/);
    // Sending the same key back is fine (forms often do).
    expect((await updateCustomValue(owner, v.id, { key: "clinic_phone", label: "Front desk phone" })).changed).toEqual([]);
    expect((await getCustomValue(owner, v.id)).key).toBe("clinic_phone");
    await expect(withSystem((db) => db.query("select key from crm_custom_values where id = $1", [v.id]))).resolves.toMatchObject({ rows: [{ key: "clinic_phone" }] });

    // Someone saved in between: nothing is overwritten.
    await expectError(updateCustomValue(owner, v.id, { value: "+63 917 000 0000", expectedUpdatedAt: v.updatedAt }), "conflict", /Someone changed this value/);
    expect((await getCustomValue(owner, v.id)).value).toBe("+639177654321");
  });

  it("re-checks the current value when the type changes", async () => {
    const owner = a.actor("owner");
    const v = await createCustomValue(owner, { label: "Map", value: "Second floor, Building B" });
    await expectError(updateCustomValue(owner, v.id, { type: "url" }), "invalid_input", /isn't a valid web address/);
    const r = await updateCustomValue(owner, v.id, { type: "url", value: "maps.example.com/clinic" });
    expect(r.changed).toEqual(["type", "value"]);
    expect(r.value).toMatchObject({ type: "url", value: "https://maps.example.com/clinic" });
  });

  it("refuses unknown or malformed ids", async () => {
    const owner = a.actor("owner");
    await expectError(getCustomValue(owner, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "not_found");
    await expectError(getCustomValue(owner, "not-a-uuid"), "not_found");
    await expectError(updateCustomValue(owner, "not-a-uuid", { label: "x" }), "not_found");
    await expectError(deleteCustomValue(owner, "3f2504e0-4f89-41d3-9a0c-0305e82c3301"), "not_found");
  });

  it("audits every change without recording the value itself", async () => {
    const owner = a.actor("owner");
    const v = await createCustomValue(owner, { label: "Audit me", value: "Visible to customers 123" });
    await updateCustomValue(owner, v.id, { value: "Changed wording 456" });
    // Saving nothing new records nothing.
    await updateCustomValue(owner, v.id, { label: "Audit me" });
    await deleteCustomValue(owner, v.id);
    const rows = (await auditRows(a.org.id)).filter((r) => r.target_id === v.id);
    expect(rows.map((r) => r.action)).toEqual(["crm.custom_value_created", "crm.custom_value_updated", "crm.custom_value_deleted"]);
    expect(rows.every((r) => r.actor_kind === "user" && r.actor_user_id === a.people.owner.id)).toBe(true);
    expect(rows[1].metadata).toMatchObject({ key: "audit_me", changed: ["value"], filled: true });
    expect(JSON.stringify(rows)).not.toMatch(/Visible to customers|Changed wording/);
  });
});

describe("configuration values: permissions", () => {
  it("everyone in the CRM sees them; only owners and managers change them", async () => {
    const owner = a.actor("owner");
    const v = await createCustomValue(owner, { label: "Parking", value: "Free parking at the back" });
    for (const who of ["sales", "setter", "support", "viewer"] as const) {
      const actor = a.actor(who);
      expect((await listCustomValues(actor)).values.map((x) => x.key), who).toContain("parking");
      expect((await getCustomValue(actor, v.id)).value).toBe("Free parking at the back");
      await expectError(createCustomValue(actor, { label: "Nope" }), "forbidden", /Only owners and managers/);
      await expectError(updateCustomValue(actor, v.id, { value: "Changed" }), "forbidden");
      await expectError(deleteCustomValue(actor, v.id), "forbidden");
    }
    const manager = a.actor("manager");
    expect((await updateCustomValue(manager, v.id, { value: "Free parking at the back, entrance on 2nd St." })).changed).toEqual(["value"]);
  });

  it("agency support: a read session sees them, a write session can change them (and it is audited as the agency)", async () => {
    const { superAdmin, staff } = await agencyPeople();
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [a.org.id, staff.id]));
    await startSupportSession(staff, a.org.id, { mode: "read", reason: "Checking configuration values" });
    const reader = await agencyActor(staff, a.org.id);
    expect((await listCustomValues(reader)).values.length).toBeGreaterThan(0);
    await expectError(createCustomValue(reader, { label: "From support" }), "forbidden", /read-only/);
    await startSupportSession(superAdmin, a.org.id, { mode: "write", reason: "Setting up the booking link" });
    const writer = await agencyActor(superAdmin, a.org.id);
    const v = await createCustomValue(writer, { label: "Support added", value: "Set up by iAcquire" });
    expect((await auditRows(a.org.id)).find((r) => r.target_id === v.id)).toMatchObject({ action: "crm.custom_value_created", actor_kind: "agency" });
  });

  it("the template catalog is open to anyone who works with templates or the CRM", async () => {
    const defs = await customValueTokenCatalog(a.actor("viewer"));
    expect(defs.find((d) => d.key === "booking_link")).toMatchObject({ label: "Booking link", required: true, value: "https://www.example.com/book" });
  });
});

describe("configuration values: tenant isolation", () => {
  it("never shows, changes or deletes another workspace's values", async () => {
    const mine = (await listCustomValues(a.actor("owner"))).values;
    const theirs = b.actor("owner");
    expect((await listCustomValues(theirs)).values).toEqual([]);
    const target = mine.find((v) => v.key === "booking_link")!;
    await expectError(getCustomValue(theirs, target.id), "not_found");
    await expectError(updateCustomValue(theirs, target.id, { value: "https://evil.example.com" }), "not_found");
    await expectError(deleteCustomValue(theirs, target.id), "not_found");
    expect((await getCustomValue(a.actor("owner"), target.id)).value).toBe("https://www.example.com/book");
    // The same key is free in every workspace.
    expect((await createCustomValue(theirs, { label: "Booking link", value: "https://b.example.com/book" })).key).toBe("booking_link");
    expect((await withSystem((db) => loadCustomValueDefs(db, a.org.id))).find((d) => d.key === "booking_link")?.value).toBe("https://www.example.com/book");
    expect((await withSystem((db) => loadCustomValueDefs(db, b.org.id))).find((d) => d.key === "booking_link")?.value).toBe("https://b.example.com/book");
  });

  it("row-level security: a member reads only their own workspace's values", async () => {
    const seen = await withUser(b.people.viewer.id, async (db) => (await db.query<{ org_id: string }>("select org_id from crm_custom_values")).rows);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.org_id === b.org.id)).toBe(true);
    const leak = await withUser(b.people.owner.id, async (db) => (await db.query("select 1 from crm_custom_values where org_id = $1", [a.org.id])).rows);
    expect(leak).toEqual([]);
  });

  it("a template can only use the values of its own workspace", async () => {
    const body = "Book here: {{custom_values.office_address}}";
    expect((await createTemplate(a.actor("owner"), { name: "Uses A's value", channel: "sms", body })).status).toBe("draft");
    await expectError(createTemplate(b.actor("owner"), { name: "Uses A's value", channel: "sms", body }), "invalid_input", /isn't one of this workspace's configuration values/);
  });
});

// ---------------------------------------------------------------------------
// Where values are used, and deleting them
// ---------------------------------------------------------------------------

describe("configuration values: usage and deletion", () => {
  let o: CrmOrg;
  beforeAll(async () => {
    o = await crmOrg({ name: "Values usage" });
  });

  it("shows which templates and canned replies use each key", async () => {
    const owner = o.actor("owner");
    const v = await createCustomValue(owner, { label: "Hours", value: "Mon–Fri 9am–6pm" });
    const t = await createTemplate(owner, { name: "Hours reply", channel: "email", subject: "Our hours: {{custom_values.hours}}", body: "We're open {{custom_values.hours}}." });
    const unrelated = await createTemplate(owner, { name: "Plain", channel: "sms", body: "Thanks for your message." });
    const usage = (await getCustomValue(owner, v.id)).usage;
    expect(usage).toEqual([{ kind: "template", id: t.id, name: "Hours reply", status: "draft", version: 1, blocking: false }]);
    expect(usage.some((u) => u.id === unrelated.id)).toBe(false);
  });

  it("deleting a value only drafts use asks for confirmation; afterwards they can't be saved until the token is removed", async () => {
    const owner = o.actor("owner");
    const v = await createCustomValue(owner, { label: "Old promo", value: "SPRING2026" });
    const t = await createTemplate(owner, { name: "Spring offer", channel: "sms", purpose: "marketing", body: "Use {{custom_values.old_promo}} this spring. Reply STOP to opt out." });
    await expectError(deleteCustomValue(owner, v.id), "conflict", /the draft template “Spring offer” uses \{\{custom_values\.old_promo\}\}\. Confirm the deletion/);
    expect((await getCustomValue(owner, v.id)).key).toBe("old_promo");
    expect(await deleteCustomValue(owner, v.id, { confirmUsage: true })).toEqual({ key: "old_promo", affected: 1 });
    await expectError(getCustomValue(owner, v.id), "not_found");
    await expectError(updateTemplate(owner, t.id, { name: "Spring offer (old)" }), "invalid_input", /isn't one of this workspace's configuration values/);
    expect((await updateTemplate(owner, t.id, { body: "Ask us about this spring's offer. Reply STOP to opt out." })).newVersion).toBe(true);
    // A value nothing uses is deleted straight away.
    const unused = await createCustomValue(owner, { label: "Unused" });
    expect(await deleteCustomValue(owner, unused.id)).toEqual({ key: "unused", affected: 0 });
  });

  it("refuses to delete a value an approved template uses, until the template stops using it", async () => {
    const owner = o.actor("owner");
    const v = await createCustomValue(owner, { label: "Review link", type: "url", value: "https://g.page/r/example/review", required: true });
    const t = await createTemplate(owner, { name: "Review ask", channel: "sms", body: "Thanks for visiting! Leave a review: {{custom_values.review_link}}" });
    await approveTemplate(owner, t.id, { version: 1, contentHash: t.contentHash });
    expect((await getCustomValue(owner, v.id)).usage).toEqual([{ kind: "template", id: t.id, name: "Review ask", status: "approved", version: 1, blocking: true }]);
    await expectError(deleteCustomValue(owner, v.id, { confirmUsage: true }), "conflict", /can't be deleted: the approved template “Review ask” uses \{\{custom_values\.review_link\}\}/);
    // The approved wording still renders with the value.
    expect((await previewTemplate(owner, t.id)).body).toBe("Thanks for visiting! Leave a review: https://g.page/r/example/review");
    // Once the template no longer uses it (an edit sends it back to draft), the value can go.
    await updateTemplate(owner, t.id, { body: "Thanks for visiting! We'd love a review." });
    expect((await getCustomValue(owner, v.id)).usage).toEqual([]);
    expect((await deleteCustomValue(owner, v.id)).affected).toBe(0);
  });

  it("refuses to delete a value a campaign on its way out uses, and hides campaign names from people who can't open campaigns", async () => {
    const owner = o.actor("owner");
    const v = await createCustomValue(owner, { label: "Event date", value: "Saturday 25 October" });
    const t = await createTemplate(owner, { name: "Open day", channel: "email", purpose: "marketing", subject: "Open day {{custom_values.event_date}}", body: "Join us on {{custom_values.event_date}}. Unsubscribe any time." });
    const campaignId = await withSystem(async (db) => {
      const list = await db.query<{ id: string }>("insert into crm_smart_lists (org_id, name, visibility, owner_user_id) values ($1, 'Everyone', 'team', $2) returning id", [o.org.id, o.people.owner.id]);
      const c = await db.query<{ id: string }>(
        "insert into crm_campaigns (org_id, name, channel, smart_list_id, template_id, template_version, status) values ($1, 'Open day invite', 'email', $2, $3, 1, 'awaiting_approval') returning id",
        [o.org.id, list.rows[0].id, t.id],
      );
      return c.rows[0].id;
    });
    const asOwner = (await getCustomValue(owner, v.id)).usage;
    expect(asOwner).toContainEqual({ kind: "campaign", id: campaignId, name: "Open day invite", status: "awaiting_approval", version: 1, blocking: true });
    // A sales rep sees that a campaign uses it, not which one.
    expect((await getCustomValue(o.actor("sales"), v.id)).usage.find((u) => u.kind === "campaign")).toMatchObject({ name: null, blocking: true });
    await expectError(deleteCustomValue(owner, v.id, { confirmUsage: true }), "conflict", /the campaign “Open day invite”/);
    // A cancelled campaign no longer holds it (the draft template still asks for confirmation).
    await withSystem((db) => db.query("update crm_campaigns set status = 'cancelled' where id = $1", [campaignId]));
    await expectError(deleteCustomValue(owner, v.id), "conflict", /Confirm the deletion/);
    expect((await deleteCustomValue(owner, v.id, { confirmUsage: true })).affected).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Rendering for preview and sending
// ---------------------------------------------------------------------------

describe("configuration values in previews and sends", () => {
  it("previews fill values, leave empty optional ones blank and report empty required ones", async () => {
    const o = await crmOrg({ name: "Values preview" });
    const owner = o.actor("owner");
    await createCustomValue(owner, { label: "Booking link", type: "url", value: "https://www.example.com/book", required: true });
    await createCustomValue(owner, { label: "Promo code" });
    const address = await createCustomValue(owner, { label: "Office address", required: true });
    const t = await createTemplate(owner, { name: "Visit", channel: "sms", body: "Book: {{custom_values.booking_link}}{{custom_values.promo_code}} Find us at {{custom_values.office_address}}." });
    const p = await previewTemplate(owner, t.id);
    expect(p.body).toBe("Book: https://www.example.com/book Find us at .");
    expect(p.missing).toEqual(["custom_values.office_address"]);
    expect(p.missingText).toContain("your “Office address” configuration value");
    expect(p.body).not.toMatch(/\{\{|\}\}/);

    // The send path's values carry the same rule.
    const set = await withSystem((db) => tokenValuesFor(db, o.org.id, {}));
    expect(set.customValues.map((d) => d.key)).toEqual(["booking_link", "office_address", "promo_code"]);
    expect(renderMessage({ body: "{{custom_values.office_address}}" }, set.values, { customValues: set.customValues })).toMatchObject({ ok: false, missing: ["custom_values.office_address"] });

    await updateCustomValue(owner, address.id, { value: "12 Example Street, Makati" });
    const filled = await previewTemplate(owner, t.id);
    expect(filled).toMatchObject({ body: "Book: https://www.example.com/book Find us at 12 Example Street, Makati.", missing: [], missingText: "" });
  });

  describe("test sends", () => {
    let m: MessagingOrg;
    let owner: CrmActor;
    beforeAll(async () => {
      m = await messagingOrg({ name: "Values test send" });
      owner = memberActor(m.ctx("owner"));
      await withSystem(async (db) => {
        const saved = await saveCredential(db, { orgId: m.org.id, provider: "twilio", label: "Twilio (synthetic test)", secret: JSON.stringify({ accountSid: `AC${"a1".repeat(16)}`, authToken: "0123456789abcdef0123456789abcdef" }), actorId: m.superAdmin.id });
        await db.query(
          `update messaging_channels set provider = 'twilio', provider_sender_id = $2, provider_account_id = $3, credential_id = $4, capability_test = '{"ok":true,"checks":[{"label":"Account","ok":true,"detail":"Active"}]}'::jsonb, capability_tested_at = now()
           where org_id = $1 and channel = 'sms'`,
          [m.org.id, `MG${"b2".repeat(16)}`, `AC${"a1".repeat(16)}`, saved.id],
        );
      });
      await publishUnitRate(m.superAdmin, { provider: "twilio", unitType: "sms_segment", wholesaleMicrosPerUnit: 7900 });
      await addTestDestination(owner, { channel: "sms", address: "+15555550142", confirmOwnAddress: true });
      process.env.TWILIO_WRITES_ENABLED = "true";
      resetEnvCache();
    });
    afterAll(() => {
      delete process.env.TWILIO_WRITES_ENABLED;
      resetEnvCache();
    });

    it("is refused with a clear reason while a required value is empty, and goes out filled once it isn't", async () => {
      noNetwork();
      const link = await createCustomValue(owner, { label: "Review link", type: "url", required: true });
      const t = await createTemplate(owner, { name: "Review ask", channel: "sms", body: "Thanks for visiting {{business.name}}! Leave a review: {{custom_values.review_link}}" });
      const count = () => withSystem(async (db) => Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [m.org.id])).rows[0].n));
      const before = await count();
      const refused = await testSendTemplate(owner, t.id, { destination: "+15555550142" });
      expect(refused).toMatchObject({ ok: false, reason: "missing_values" });
      expect(refused.ok ? "" : refused.detail).toBe(
        "This message needs your “Review link” configuration value, which isn't available. That value is required and empty: fill it in under CRM Settings → Configuration Values. Nothing was sent.",
      );
      expect(await count()).toBe(before);

      await updateCustomValue(owner, link.id, { value: "https://g.page/r/example/review" });
      const sent = await testSendTemplate(owner, t.id, { destination: "+15555550142" });
      expect(sent).toMatchObject({ ok: true, status: "queued" });
      if (!sent.ok) throw new Error("expected a queued test");
      const row = await withSystem(async (db) => (await db.query<{ body: string; status: string }>("select body, status from conversation_messages where id = $1", [sent.messageId])).rows[0]);
      expect(row).toEqual({ status: "queued", body: "Thanks for visiting Values test send! Leave a review: https://g.page/r/example/review" });
    });
  });

  it("an automated workflow message is held (not sent) while a required value is empty", async () => {
    noNetwork();
    const m = await messagingOrg({ provider: "twilio", name: "Values workflows" });
    const owner = memberActor(m.ctx("owner"));
    const manager = memberActor(m.ctx("manager"));
    const link = await createCustomValue(owner, { label: "Booking link", type: "url", required: true });
    const t = await createTemplate(owner, { name: "Book now", channel: "sms", body: "Hi {{contact.first_name}}, book your visit here: {{custom_values.booking_link}}" });
    const approved = await approveTemplate(owner, t.id, { version: t.currentVersion, contentHash: t.contentHash });
    const def: WorkflowDefinition = {
      trigger: { type: "manual" },
      steps: [{ key: "send", kind: "send_message", next: null, config: { templateId: t.id, contentHash: approved.contentHash, channel: "sms", sendAs: "sales_assistant", businessHoursOnly: false } } as WorkflowStep],
    };
    const { id } = await createWorkflow(manager, { name: "Booking nudge", definition: def });
    await publishWorkflow(manager, id);
    const req = await requestWorkflowApproval(manager, id, null, { activate: true });
    expect((await decideApproval(m.ctx("owner"), req.approvalId!, "approve")).outcome?.status).toBe("succeeded");

    const contactId = (await createContact(owner, { firstName: "Olga", lastName: "Reyes", phone: "+639171110042" })).id;
    await setContactConsent(owner, contactId, { channel: "sms", purpose: "service", status: "granted", evidence: "Asked to be texted at the front desk." });
    const outbound = () => withSystem(async (db) => (await db.query<{ body: string }>(
      "select m.body from conversation_messages m join conversations c on c.id = m.conversation_id where c.contact_id = $1 and m.direction = 'outbound'", [contactId])).rows);
    const stepResult = (runId: string) => withSystem(async (db) => (await db.query<{ status: string; result: Record<string, unknown> }>(
      "select status, result from crm_workflow_run_steps where run_id = $1 order by id desc limit 1", [runId])).rows[0]);

    const r1 = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    const s1 = await stepResult(r1.runId);
    expect(s1).toMatchObject({ status: "skipped", result: { outcome: "blocked", reason: "missing_values" } });
    expect(JSON.stringify(s1.result)).toContain("your “Booking link” configuration value");
    expect(await outbound()).toEqual([]);

    await updateCustomValue(owner, link.id, { value: "https://www.example.com/book" });
    const r2 = await startManualRun(owner, id, { contactId });
    await processWorkflowRuns();
    expect((await stepResult(r2.runId)).status).toBe("completed");
    const sent = await outbound();
    expect(sent).toHaveLength(1);
    // (The AI disclosure the sales assistant adds comes first.)
    expect(sent[0].body).toMatch(/Hi Olga, book your visit here: https:\/\/www\.example\.com\/book$/);
  });
});

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const scopeOf = (can: CrmScope["can"], over: Partial<CrmScope> = {}): CrmScope => ({
  base: "/crm", orgId: null, agency: false, readOnly: false, userId: null, timezone: "UTC", currency: "USD", can, ...over,
});

describe("screens", () => {
  it("is listed under CRM Settings for everyone who can open the CRM, in the portal and the agency view", () => {
    const item = CRM_NAV.find((s) => s.key === "settings")!.items.find((i) => i.path === "/settings/values");
    expect(item).toMatchObject({ label: "Configuration Values", permission: "crm.view", icon: "braces" });
    const viewer = navFor((p) => p === "crm.view", "agency");
    expect(viewer.flatMap((s) => s.items).some((i) => i.path === "/settings/values")).toBe(true);
  });

  it("lists values by group, flags required empty ones and offers changes to owners and managers", async () => {
    const values = JSON.parse(JSON.stringify((await listCustomValues(a.actor("owner"))).values)) as CustomValueView[];
    const html = renderToStaticMarkup(React.createElement(CustomValuesManager, { scope: scopeOf({ "crm.view": true, "fields.manage": true }), values, limit: 200, defaultCallingCode: null }));
    expect(html).toContain("Configuration Values");
    expect(html).toContain("New value");
    expect(html).toMatch(/1 required value is empty\./);
    expect(html).toContain("Fill in Office address");
    expect(html).toContain("Required, empty");
    expect(html).toContain("{{custom_values.booking_link}}");
    expect(html).toContain("https://www.example.com/book");
    expect(html).toMatch(/>Links </);
    expect(html).toMatch(/Used in 1/);
  });

  it("is read-only without fields.manage, and in a read-only support session", async () => {
    const values = JSON.parse(JSON.stringify((await listCustomValues(a.actor("viewer"))).values)) as CustomValueView[];
    const viewer = renderToStaticMarkup(React.createElement(CustomValuesManager, { scope: scopeOf({ "crm.view": true }), values, limit: 200, defaultCallingCode: null }));
    expect(viewer).toContain("Owners and managers change them.");
    expect(viewer).not.toContain("New value");
    expect(viewer).not.toContain("Fill in Office address");
    const support = renderToStaticMarkup(React.createElement(CustomValuesManager, { scope: scopeOf({ "crm.view": true, "fields.manage": true }, { agency: true, readOnly: true }), values, limit: 200, defaultCallingCode: null }));
    expect(support).toContain("This support session is read-only.");
    const empty = renderToStaticMarkup(React.createElement(CustomValuesManager, { scope: scopeOf({ "crm.view": true, "fields.manage": true }), values: [], limit: 200, defaultCallingCode: null }));
    expect(empty).toContain("No configuration values yet");
  });

  it("template screens highlight and preview values the workspace has, and mark the ones it doesn't", () => {
    const inProvider = (node: React.ReactElement) => renderToStaticMarkup(React.createElement(CustomValueTokensProvider as React.FC<{ values: typeof DEFS; children?: React.ReactNode }>, { values: DEFS }, node));
    const highlighted = inProvider(React.createElement(TokenHighlight, { text: "{{custom_values.booking_link}} {{custom_values.gone}}" }));
    expect(highlighted).toMatch(/bg-primary-soft[^"]*" title="Booking link">\{\{custom_values\.booking_link\}\}/);
    expect(highlighted).toMatch(/bg-danger-soft[^"]*" title="Not a token iAcquire knows">\{\{custom_values\.gone\}\}/);
    // Outside a screen that loaded them, a well-formed token isn't shown as a mistake.
    expect(renderToStaticMarkup(React.createElement(TokenHighlight, { text: "{{custom_values.gone}}" }))).toContain("bg-primary-soft");

    const rendered = inProvider(React.createElement(RenderedText, { text: "Book {{custom_values.booking_link}}{{custom_values.promo_code}} at {{custom_values.office_address}}", values: {} }));
    expect(rendered).toContain("https://www.example.com/book");
    expect(rendered).toContain("Office address missing");
    expect(rendered).not.toContain("Promo code");
    expect(rendered).not.toMatch(/\{\{/);
  });
});
