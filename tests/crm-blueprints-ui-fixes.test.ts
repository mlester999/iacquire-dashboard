// Regression tests for the CRM Blueprints screens, rendered on the server with the design preview's invented sample data (no database, no
// sign-in, nothing calls a provider): times in the signed-in person's own zone, the capture's industry, GoHighLevel kinds shown by name,
// who is told what about rolling back, the dry run offered to staff, the publish dialog owned by the page, the apply wizard's client list,
// decided and refused conflict decisions, what the lead assignment rules arrive as, and the new-client dialog starting over.
// Server actions are stand-ins that are never called.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "", pathname: "/admin/crm-blueprints" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-blueprints", () => Object.fromEntries([
  "createBlueprintAction", "updateBlueprintDetailsAction", "saveDraftAction", "publishBlueprintAction", "archiveBlueprintAction", "unarchiveBlueprintAction",
  "compareVersionsAction", "getVersionContentAction", "restoreVersionToDraftAction", "createLibraryFolderAction", "renameLibraryFolderAction", "deleteLibraryFolderAction",
  "installStarterAction", "previewPackageImportAction", "saveImportAction", "discardImportAction", "saveGhlTemplateSourceAction", "testGhlTemplateSourceAction",
  "removeGhlTemplateSourceAction", "runGhlImportAction", "previewCaptureAction", "captureFromClientAction", "planApplicationAction", "previewApplicationAction",
  "applyBlueprintAction", "rollbackApplicationAction", "getApplicationAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm-blueprint-editor", () => Object.fromEntries([
  "applyBlueprintToClientAction", "blueprintChangedSectionsAction", "previewBlueprintApplyAction", "clientBlueprintChecklistAction", "saveBlueprintDraftAction",
].map((n) => [n, stub])));
vi.mock("@/app/(admin)/admin/actions", () => ({ createClientAction: stub, resendInvitationAction: stub }));
vi.mock("@/app/(admin)/admin/crm-blueprint-onboarding-actions", () => ({ onboardingBlueprintChoicesAction: stub }));
// Radix renders a dialog into a portal, which server rendering leaves out. Here an open dialog renders in place, so whether it is open shows.
vi.mock("@/components/ui/overlays", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/components/ui/overlays")>();
  return {
    ...mod,
    Dialog: ({ open, title, description, children, footer }: { open: boolean; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode }) =>
      open ? React.createElement("div", { role: "dialog", "data-test-dialog": "" }, React.createElement("h2", null, title), description, children, footer) : null,
  };
});

import { BlueprintLibrary } from "@/components/crm-blueprints/library";
import { BlueprintDetailView } from "@/components/crm-blueprints/detail";
import { VersionsPanel } from "@/components/crm-blueprints/versions-panel";
import { ImportDetailView } from "@/components/crm-blueprints/imports";
import { ApplicationDetailView, ApplicationsHistory } from "@/components/crm-blueprints/applications";
import { captureIndustryFor } from "@/components/crm-blueprints/capture-dialog";
import { assetFacts, assignmentRuleArrival, buildAssetIndex } from "@/components/crm-blueprints/asset-index";
import { NO_PERMISSIONS, bpHref, sourceKindLabel, type BlueprintUiPermissions } from "@/components/crm-blueprints/shared";
import { ApplyWizard } from "@/components/crm-blueprints/apply/wizard";
import { PlanGroups } from "@/components/crm-blueprints/apply/preview";
import { ApplyResultView } from "@/components/crm-blueprints/apply/result";
import { draftNotes } from "@/components/crm/blueprints/labels";
import { clientFormDefaults, formOnOpen } from "@/components/admin/create-client";
import { GHL_KIND_INFO } from "@/lib/crm/blueprints/ghl/inventory";
import type { AssignmentRuleAsset, PlanItem } from "@/lib/crm/blueprints/types";
import type { ApplyPreview, ApplyResult, VersionView } from "@/lib/crm/blueprints/views";
import {
  SAMPLE_APPLICATIONS, SAMPLE_APPLICATION_DETAIL, SAMPLE_BLUEPRINTS, SAMPLE_CLIENTS, SAMPLE_CONTENT, SAMPLE_DETAIL, SAMPLE_FOLDERS, SAMPLE_IDS, SAMPLE_IMPORT_DETAIL,
  SAMPLE_STARTERS, SAMPLE_UPDATE_CANDIDATES,
} from "@/app/dev/crm-blueprints-preview/sample";

const SUPER: BlueprintUiPermissions = { design: true, publish: true, apply: true, export: true, importFile: true, importGhl: true, capture: true };
const STAFF: BlueprintUiPermissions = { design: true, publish: false, apply: false, export: true, importFile: true, importGhl: false, capture: true };

/** Server-rendered markup as text, without React's comment markers and with entities decoded, so assertions read like the screen. */
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (el: React.ReactElement) => html(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// 20:30 UTC on Oct 17 is 04:30 on Oct 18 in Manila: a server in UTC and a browser in Manila would print different text.
const AT = "2026-10-17T20:30:00.000Z";

beforeEach(() => {
  nav.search = "";
  nav.pathname = "/admin/crm-blueprints";
});

describe("times use the signed-in person's time zone, never the server's", () => {
  const version = (v: number): VersionView => ({ id: `v${v}`, version: v, digest: "d".repeat(64), schemaVersion: 1, changeSummary: "", summaryLines: [], counts: { tags: 1 } as VersionView["counts"], publishedBy: null, publishedAt: AT });

  it("on a Blueprint's overview, details and versions", () => {
    const b = { ...SAMPLE_DETAIL, createdAt: AT, updatedAt: AT, draftUpdatedAt: AT, versions: [version(1)] };
    const el = (timeZone: string) => React.createElement(BlueprintDetailView, { blueprint: b, applications: [], updateCandidates: [], permissions: SUPER, timeZone });
    expect(text(el("Asia/Manila"))).toContain("Created Oct 18, 2026, 4:30 AM");
    expect(text(el("UTC"))).toContain("Created Oct 17, 2026, 8:30 PM");
    nav.search = "tab=details";
    const details = text(el("Asia/Manila"));
    expect(details).toContain("saved Oct 18, 2026, 4:30 AM");
    expect(details).not.toContain("Oct 17, 2026");
    nav.search = "tab=versions";
    expect(text(el("Asia/Manila"))).toContain("Oct 18, 2026");
    expect(text(el("UTC"))).toContain("Oct 17, 2026");
  });

  it("on an application, an import and the apply wizard's version choice", () => {
    const app = { ...SAMPLE_APPLICATION_DETAIL, createdAt: AT, rolledBackAt: AT, status: "partially_rolled_back" as const, canRollBack: false };
    const a = text(React.createElement(ApplicationDetailView, { application: app, canApply: true, timeZone: "Asia/Manila" }));
    expect(a).toContain("Oct 18, 2026, 4:30 AM");
    expect(a).toContain("Rolled back Oct 18, 2026, 4:30 AM");
    expect(text(React.createElement(ImportDetailView, { detail: { ...SAMPLE_IMPORT_DETAIL, createdAt: AT }, canDesign: true, timeZone: "Asia/Manila" }))).toContain("Read Oct 18, 2026, 4:30 AM");
    // The wizard opens on the options step for an eligible ?client=, where each version names the day it was published.
    const wizard = (timeZone: string) => text(React.createElement(ApplyWizard, {
      blueprint: { id: SAMPLE_IDS.blueprint, name: "Sample" }, versions: [version(1)], clients: SAMPLE_CLIENTS, updates: [], canApply: true,
      initialClientId: SAMPLE_IDS.clientA, initialVersion: null, timeZone,
    }));
    expect(wizard("Asia/Manila")).toContain("published Oct 18, 2026");
    expect(wizard("UTC")).toContain("published Oct 17, 2026");
  });
});

describe("the capture dialog starts from the client's own industry", () => {
  it("matches the label organizations.industry stores, a key, or a hand-typed label", () => {
    expect(captureIndustryFor({ industry: "Real Estate" })).toBe("real_estate");
    expect(captureIndustryFor({ industry: "  healthcare & wellness " })).toBe("healthcare_wellness");
    expect(captureIndustryFor({ industry: "home_services" })).toBe("home_services");
    expect(captureIndustryFor({ industry: "Plumbing and more" })).toBe("general_services");
    expect(captureIndustryFor({ industry: null })).toBe("general_services");
    expect(captureIndustryFor(null)).toBe("general_services");
    // The design preview's sample clients carry the label too, as production data does.
    expect(captureIndustryFor(SAMPLE_CLIENTS[0])).toBe("home_services");
  });
});

describe("an import report names the GoHighLevel parts it couldn't read", () => {
  it("by GoHighLevel's own label, also for reports saved with the raw key", () => {
    expect(sourceKindLabel("messageTemplates")).toBe(GHL_KIND_INFO.messageTemplates.label);
    expect(sourceKindLabel("customFields")).toBe(GHL_KIND_INFO.customFields.label);
    expect(sourceKindLabel("Surveys")).toBe("Surveys");
    expect(sourceKindLabel("calendar_group")).toBe("Calendar group");
    const report = { ...SAMPLE_IMPORT_DETAIL.report, unavailable: [{ sourceKind: "messageTemplates", reason: "Its endpoint needs an undocumented parameter." }] };
    const imp = text(React.createElement(ImportDetailView, { detail: { ...SAMPLE_IMPORT_DETAIL, report }, canDesign: true }));
    expect(imp).toContain(`${GHL_KIND_INFO.messageTemplates.label}: Its endpoint needs an undocumented parameter.`);
    expect(imp).not.toContain("messageTemplates:");
    const detail = text(React.createElement(BlueprintDetailView, { blueprint: { ...SAMPLE_DETAIL, importReport: report }, applications: [], updateCandidates: [], permissions: SUPER }));
    expect(detail).toContain(`${GHL_KIND_INFO.messageTemplates.label}: Its endpoint`);
    expect(detail).not.toContain("messageTemplates:");
  });
});

describe("rolling back an application", () => {
  const newest = { ...SAMPLE_APPLICATION_DETAIL, status: "applied" as const, rolledBackAt: null, canRollBack: false };

  it("tells someone who can't roll back who can, not that a later application exists", () => {
    const staff = text(React.createElement(ApplicationDetailView, { application: newest, canApply: false }));
    expect(staff).toContain("Only an agency super admin can roll back an application.");
    expect(staff).not.toContain("A later application of this Blueprint exists");
    // For a super admin, canRollBack is false only because a newer live application exists.
    const sup = text(React.createElement(ApplicationDetailView, { application: newest, canApply: true }));
    expect(sup).toContain("A later application of this Blueprint exists for this client.");
    expect(sup).not.toContain("Only an agency super admin");
  });
});

describe("staff who design reach the dry run the apply page offers them", () => {
  const library = (permissions: BlueprintUiPermissions) => React.createElement(BlueprintLibrary, {
    blueprints: SAMPLE_BLUEPRINTS, folders: SAMPLE_FOLDERS, starters: SAMPLE_STARTERS, clients: SAMPLE_CLIENTS, permissions,
  });
  const detail = (permissions: BlueprintUiPermissions, extra: Partial<typeof SAMPLE_DETAIL> = {}) => React.createElement(BlueprintDetailView, {
    blueprint: { ...SAMPLE_DETAIL, ...extra }, applications: SAMPLE_APPLICATIONS, updateCandidates: SAMPLE_UPDATE_CANDIDATES, permissions,
  });

  it("from the library, labelled as a preview, only for a published Blueprint", () => {
    const staff = html(library(STAFF));
    expect(staff).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint)}"`);
    expect(staff).toContain(`aria-label="Preview applying ${SAMPLE_CONTENT.blueprint.name} to a client"`);
    expect(staff).not.toContain(`href="${bpHref.apply(SAMPLE_IDS.draftBlueprint)}"`);
    expect(staff).not.toContain(`aria-label="Apply ${SAMPLE_CONTENT.blueprint.name} to a client"`);
    // Super admins keep Apply; someone who can't design gets neither.
    const sup = html(library(SUPER));
    expect(sup).toContain(`aria-label="Apply ${SAMPLE_CONTENT.blueprint.name} to a client"`);
    expect(sup).not.toContain("Preview applying");
    expect(html(library(NO_PERMISSIONS))).not.toContain("/apply");
  });

  it("from a Blueprint's page and its clients on an earlier version", () => {
    const staffBp = { canPublish: false, canApply: false };
    const h = html(detail(STAFF, staffBp));
    expect(h).toContain("Preview applying");
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint)}"`);
    expect(text(detail(STAFF, staffBp))).not.toContain("Apply to client");
    expect(html(detail(SUPER))).not.toContain("Preview applying");
    nav.search = "tab=applications";
    const apps = html(detail(STAFF, staffBp));
    expect(apps).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint, SAMPLE_IDS.clientB)}"`);
    expect(apps).toContain("Preview the update");
    expect(apps).toContain("A super admin reviews and applies updates.");
    expect(apps).not.toContain(">Review update<");
    // Archived: nothing is applied or previewed.
    expect(html(detail(STAFF, { ...staffBp, status: "archived" }))).not.toContain("/apply");
  });

  it("from the applications history and one application", () => {
    const h = html(React.createElement(ApplicationsHistory, { applications: SAMPLE_APPLICATIONS, canApply: false, canPreview: true }));
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint, SAMPLE_IDS.clientB)}"`);
    expect(h).toContain("Preview the update");
    expect(h).not.toContain(">Review update<");
    expect(html(React.createElement(ApplicationsHistory, { applications: SAMPLE_APPLICATIONS, canApply: false }))).not.toContain("/apply");
    const older = { ...SAMPLE_APPLICATION_DETAIL, version: 1, latestVersion: 2, status: "applied" as const };
    const one = html(React.createElement(ApplicationDetailView, { application: older, canApply: false, canPreview: true }));
    expect(one).toContain("Preview version 2");
    expect(one).toContain(`href="${bpHref.apply(older.blueprintId, older.orgId)}"`);
    expect(html(React.createElement(ApplicationDetailView, { application: older, canApply: false }))).not.toContain("/apply");
  });
});

describe("the publish dialog belongs to the Blueprint's page", () => {
  const OPEN = "Publishing freezes the working draft";

  it("opens from ?publish=1 on the Versions tab only for someone who may publish", () => {
    nav.search = "tab=versions&publish=1";
    const el = (permissions: BlueprintUiPermissions, extra: Partial<typeof SAMPLE_DETAIL> = {}, openPublish = true) =>
      React.createElement(BlueprintDetailView, { blueprint: { ...SAMPLE_DETAIL, ...extra }, applications: [], updateCandidates: [], permissions, openPublish });
    expect(text(el(SUPER))).toContain(OPEN);
    expect(text(el(SUPER, {}, false))).not.toContain(OPEN);
    expect(text(el(STAFF, { canPublish: false }))).not.toContain(OPEN);
    expect(text(el(SUPER, { status: "archived" }))).not.toContain(OPEN);
  });

  it("is never opened by the Versions tab itself, so a tab shown again keeps a closed dialog closed", () => {
    // The tab unmounts while another one is shown; when it comes back it opens the dialog only if the page says it is open.
    const panel = (publishing: boolean) => React.createElement(VersionsPanel, { blueprint: SAMPLE_DETAIL, can: { design: true, publish: true, export: true }, publishing, onPublishingChange: () => {} });
    expect(text(panel(false))).not.toContain(OPEN);
    expect(text(panel(true))).toContain(OPEN);
  });
});

describe("the apply wizard's client list", () => {
  it("stays a list of radios in a named group, each named once", () => {
    const h = html(React.createElement(ApplyWizard, {
      blueprint: { id: SAMPLE_IDS.blueprint, name: "Sample" }, versions: [], clients: SAMPLE_CLIENTS, updates: [], canApply: true, initialClientId: null, initialVersion: null,
    }));
    expect(h).toMatch(/<fieldset[^>]*><legend class="sr-only">Clients<\/legend><ul class="grid gap-2 md:grid-cols-2">/);
    expect(h).not.toContain('role="radiogroup"');
    expect(h).not.toContain("aria-describedby");
    expect((h.match(/<input type="radio"[^>]*name="ap-client"/g) ?? []).length).toBe(SAMPLE_CLIENTS.length);
  });
});

describe("conflict decisions in the dry run", () => {
  // As the dry run says it: a conflict, decided or not, can take "update" unless told otherwise; nothing else can (apply.ts finish()).
  const item = (assetId: string, action: PlanItem["action"], extra: Partial<PlanItem> = {}): PlanItem => ({
    assetId, assetType: "customField", section: "customFields", name: assetId, action, reason: "Because.", existing: { id: "x", name: assetId }, changes: [], decision: null,
    updatable: action === "conflict" || !!extra.decision, dependsOn: [], unresolved: [], ...extra,
  });
  const groups = (items: PlanItem[], decisions: Record<string, "skip" | "update" | "copy"> = {}) =>
    html(React.createElement(PlanGroups, { preview: { plan: { items } } as unknown as ApplyPreview, decisions, onDecide: () => {}, disabled: false }));
  const select = (h: string, id: string) => new RegExp(`<select[^>]*id="decide-${id.replace(/\./g, "\\.")}"[^>]*>(.*?)</select>`).exec(h)?.[1] ?? null;

  it("keeps the select on a conflict the dry run settled, showing the decision", () => {
    const h = groups([item("field.contact.a", "create", { decision: "copy" }), item("field.contact.b", "skip", { decision: "skip" })]);
    expect(select(h, "field.contact.a")).toMatch(/<option value="copy" selected="">/);
    expect(select(h, "field.contact.b")).toMatch(/<option value="skip" selected="">/);
    expect(h).toContain("Decided: add the blueprint's version alongside");
    // An item that was never a conflict has no decision to make.
    expect(select(groups([item("field.contact.c", "skip")]), "field.contact.c")).toBeNull();
  });

  it("offers replacing in place only where the record can take it, and never shows a refused replacement as chosen", () => {
    const refused = item("field.contact.service", "conflict", { updatable: false });
    const s = select(groups([refused], { "field.contact.service": "update" }), "field.contact.service")!;
    expect(s).not.toContain('value="update"');
    expect(s).toMatch(/<option value="" selected="">Decide later/);
    expect(groups([refused], { "field.contact.service": "update" })).not.toContain("The client's changes to it are overwritten.");
    // Where the dry run says the record can take it, replacing is on offer.
    expect(select(groups([item("field.contact.other", "conflict")]), "field.contact.other")).toContain('value="update"');
  });
});

describe("what lead assignment rules arrive as", () => {
  const rule = (over: Partial<AssignmentRuleAsset>): Pick<AssignmentRuleAsset, "strategy" | "members" | "fallback"> => ({
    strategy: "round_robin", fallback: "unassigned", members: [{ member: "@member.closer", weight: 1, priority: 0 }], ...over,
  });

  it("says a rule is switched on when its people are mapped at apply time, as the engine does", () => {
    expect(assignmentRuleArrival(rule({})).on).toBe("if_mapped");
    expect(assignmentRuleArrival(rule({})).text).toMatch(/switched off unless every member role is mapped to someone when it's applied; then it starts assigning/);
    expect(assignmentRuleArrival(rule({ fallback: "fallback_user" })).text).toMatch(/every member role and the fallback person are mapped/);
    // A rule that only keeps existing owners, with nobody to map, is switched on as soon as it is applied.
    expect(assignmentRuleArrival(rule({ strategy: "keep_existing_owner", members: [] }))).toMatchObject({ on: "always", short: "Switched on: it needs no people" });
    expect(assignmentRuleArrival(rule({ strategy: "keep_existing_owner", members: [], fallback: "fallback_user" })).text).toMatch(/unless the fallback person is mapped/);
    expect(assignmentRuleArrival(rule({ members: [] })).on).toBe("never");
    const index = buildAssetIndex(SAMPLE_CONTENT);
    expect(assetFacts(index.entries.get("rule.new-requests")!).find((f) => f.label === "Arrives as")?.value).toBe("Switched off unless its people are mapped when it's applied");
    expect(draftNotes([{ section: "assignmentRules", label: "Lead assignment rules", count: 1 }])[0].text).toMatch(/only keeps the existing owner, with no fallback person, needs nobody/);
  });

  it("doesn't claim nothing was switched on after an apply that added rules", () => {
    const result: ApplyResult = { application: { ...SAMPLE_APPLICATIONS[0], status: "applied" }, replayed: false };
    const base = { result, clientName: "Sample Plumbing Co.", orgId: SAMPLE_IDS.clientA, onAnother: () => {} };
    const withRules = text(React.createElement(ApplyResultView, { ...base, rulesAdded: ["New requests to dispatch"] }));
    expect(withRules).toContain("Lead assignment rules added (New requests to dispatch) whose people were all mapped, or that need nobody, are switched on");
    expect(withRules).toContain("Nothing was connected or sent.");
    expect(withRules).not.toContain("sent or switched on");
    expect(text(React.createElement(ApplyResultView, base))).toContain("Nothing was connected, sent or switched on.");
  });
});

describe("the new-client dialog", () => {
  it("starts over after a client was created, however the dialog was closed, and keeps a cancelled draft", () => {
    const prefill = { name: "Acme Roofing", email: "owner@example.test", website: "https://acme.example.test" };
    expect(formOnOpen(true, prefill)).toEqual({ ...clientFormDefaults(prefill), name: "Acme Roofing", email: "owner@example.test", website: "https://acme.example.test", industry: "", setup: "blank", crmMode: "native" });
    expect(formOnOpen(true)).toMatchObject({ name: "", email: "", website: "" });
    expect(formOnOpen(false, prefill)).toBeNull();
  });
});
