// The agency's CRM Blueprints screens, rendered on the server with the design preview's invented sample data (no database, no sign-in,
// nothing calls a provider): the library, a Blueprint's tabs, the import center, a conversion preview, the import and application
// histories, an application with its rollback, and the pure helpers behind them. Server actions are stand-ins that are never called.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ search: "", pathname: "/admin/crm-blueprints", nodeEnv: "test" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {}, replace() {} }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/env", () => ({ env: () => ({ NODE_ENV: nav.nodeEnv }) }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-blueprints", () => Object.fromEntries([
  "createBlueprintAction", "updateBlueprintDetailsAction", "saveDraftAction", "publishBlueprintAction", "archiveBlueprintAction", "unarchiveBlueprintAction",
  "compareVersionsAction", "getVersionContentAction", "restoreVersionToDraftAction", "createLibraryFolderAction", "renameLibraryFolderAction", "deleteLibraryFolderAction",
  "installStarterAction", "previewPackageImportAction", "saveImportAction", "discardImportAction", "saveGhlTemplateSourceAction", "testGhlTemplateSourceAction",
  "removeGhlTemplateSourceAction", "runGhlImportAction", "previewCaptureAction", "captureFromClientAction", "planApplicationAction", "previewApplicationAction",
  "applyBlueprintAction", "rollbackApplicationAction", "getApplicationAction",
].map((n) => [n, stub])));

import { BlueprintLibrary, COLLECTIONS, appliedVersionFor, matchesSearch, sortBlueprints } from "@/components/crm-blueprints/library";
import { dropParams, withoutParams } from "@/components/crm-blueprints/url-params";
import { publishHref } from "@/components/crm-blueprints/apply/links";
import { BlueprintDetailView } from "@/components/crm-blueprints/detail";
import { ImportCenter, GHL_COVERAGE, GHL_SCOPE_CHOICES, decimalSize } from "@/components/crm-blueprints/import-center";
import { GHL_IMPORT_SCOPES, GHL_KIND_INFO } from "@/lib/crm/blueprints/ghl/inventory";
import { ImportDetailView, ImportsHistory } from "@/components/crm-blueprints/imports";
import { ApplicationDetailView, ApplicationsHistory } from "@/components/crm-blueprints/applications";
import { BlueprintNav } from "@/components/crm-blueprints/nav";
import { captureClosure } from "@/components/crm-blueprints/capture-dialog";
import CrmBlueprintsPreview from "@/app/dev/crm-blueprints-preview/page";
import { buildAssetIndex, assetFacts, hoursSummary } from "@/components/crm-blueprints/asset-index";
import { issueLines } from "@/components/crm-blueprints/versions-panel";
import { NO_PERMISSIONS, bpHref, slotLabel, type BlueprintUiPermissions } from "@/components/crm-blueprints/shared";
import { COMPAT_LABELS, REQUIREMENT_INFO } from "@/lib/crm/blueprints/types";
import {
  SAMPLE_APPLICATIONS, SAMPLE_APPLICATION_DETAIL, SAMPLE_BLUEPRINTS, SAMPLE_CAPTURE, SAMPLE_CLIENTS, SAMPLE_CONTENT, SAMPLE_DETAIL, SAMPLE_FOLDERS, SAMPLE_IDS,
  SAMPLE_IMPORTS, SAMPLE_IMPORT_DETAIL, SAMPLE_PACKAGE_PREVIEW, SAMPLE_ROLLBACK, SAMPLE_SOURCES, SAMPLE_STARTERS, SAMPLE_UPDATE_CANDIDATES,
} from "@/app/dev/crm-blueprints-preview/sample";

const SUPER: BlueprintUiPermissions = { design: true, publish: true, apply: true, export: true, importFile: true, importGhl: true, capture: true };
const STAFF: BlueprintUiPermissions = { design: true, publish: false, apply: false, export: true, importFile: true, importGhl: false, capture: true };

/** Server-rendered markup as text, without React's comment markers and with entities decoded, so assertions read like the screen. */
const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (el: React.ReactElement) => html(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeEach(() => {
  nav.search = "";
  nav.pathname = "/admin/crm-blueprints";
  nav.nodeEnv = "test";
});

describe("library", () => {
  const library = (permissions: BlueprintUiPermissions, extra: Record<string, unknown> = {}) => React.createElement(BlueprintLibrary, {
    blueprints: SAMPLE_BLUEPRINTS, folders: SAMPLE_FOLDERS, starters: SAMPLE_STARTERS, clients: SAMPLE_CLIENTS, permissions, ...extra,
  });

  it("shows the hero, metrics, every collection with its count, and a card per active Blueprint", () => {
    const t = text(library(SUPER));
    expect(t).toContain("CRM Blueprints & Snapshots");
    expect(t).toMatch(/never carries contacts, conversations, appointments, credentials or anything personal/);
    for (const label of ["In the library", "Applied to clients", "From GoHighLevel", "Partly converted"]) expect(t).toContain(label);
    for (const c of COLLECTIONS) expect(t).toContain(c.label);
    // All excludes archived; Archived holds only it.
    expect(t).toMatch(/All 4 /);
    expect(t).toMatch(/Archived 1 /);
    expect(t).toContain("Sample Plumbing Lead Engine");
    expect(t).toContain("Sample Dental Snapshot");
    expect(t).not.toContain("Old Restaurant Setup (sample)");
  });

  it("puts source, status, version, modules, compatibility and use on each card", () => {
    const t = text(library(SUPER));
    expect(t).toContain("Imported from GoHighLevel");
    expect(t).toContain("iAcquire starter");
    expect(t).toContain("Version 2");
    expect(t).toContain("Never published");
    expect(t).toContain("Unpublished changes");
    expect(t).toContain("Partly converted");
    expect(t).toContain("Setup per client");
    expect(t).toContain("Applied to 2 clients");
    expect(t).toContain("Pipelines & stages");
    expect(t).toContain("11 to rebuild or review");
  });

  it("links Edit to the editor and Apply only for a published Blueprint, and only for someone who may apply", () => {
    const sup = html(library(SUPER));
    expect(sup).toContain(`href="${bpHref.edit(SAMPLE_IDS.blueprint)}"`);
    expect(sup).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint)}"`);
    expect(sup).not.toContain(`href="${bpHref.apply(SAMPLE_IDS.draftBlueprint)}"`);
    expect(sup).toContain(`href="${bpHref.import}"`);
    const staff = html(library(STAFF));
    // Staff can't apply; they get the dry run instead, labelled as a preview.
    expect(staff).not.toContain(`aria-label="Apply ${SAMPLE_CONTENT.blueprint.name} to a client"`);
    expect(staff).toContain(`aria-label="Preview applying ${SAMPLE_CONTENT.blueprint.name} to a client"`);
    expect(staff).toContain(`href="${bpHref.edit(SAMPLE_IDS.blueprint)}"`);
    const viewer = html(library(NO_PERMISSIONS));
    expect(viewer).not.toContain("New Blueprint");
    expect(viewer).not.toContain(`/edit"`);
    expect(viewer).toContain("Your role can't add starters.");
  });

  it("lists the iAcquire starters with Add to library, or a link to the copy already in the library", () => {
    const t = html(library(SUPER));
    expect(t).toContain("iAcquire starters");
    expect(t).toContain("Add to library: Automotive Service Starter (sample)");
    expect(t).toContain(`href="${bpHref.detail(SAMPLE_IDS.starterBlueprint)}"`);
    expect(t).toMatch(/no outbound sequence is switched on/);
    // Adding a starter publishes it (super admins); staff who design start an editable draft from it instead.
    const staff = html(library(STAFF));
    expect(staff).not.toContain("Add to library: Automotive Service Starter (sample)");
    expect(staff).toContain("Start a draft from it: Automotive Service Starter (sample)");
  });

  it("restores the collection and filters from the address", () => {
    nav.search = "collection=archived";
    expect(text(library(SUPER))).toContain("Old Restaurant Setup (sample)");
    nav.search = "collection=ghl";
    const ghl = text(library(SUPER));
    expect(ghl).toContain("Sample Dental Snapshot");
    expect(ghl).not.toContain("Sample Salon Basics");
    nav.search = "q=nothing-matches-this";
    expect(text(library(SUPER))).toContain("Nothing in this view");
  });

  it("with ?client=<orgId> (the client page's Apply a Blueprint) chooses a Blueprint for that client", () => {
    const client = { ...SAMPLE_CLIENTS[0], appliedBlueprints: [{ blueprintId: SAMPLE_IDS.blueprint, name: SAMPLE_CONTENT.blueprint.name, version: 1 }] };
    const h = html(library(SUPER, { applyFor: client }));
    const t = h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(t).toContain(`Choosing a Blueprint for ${client.name}`);
    expect(t).toMatch(/nothing changes until you confirm/);
    expect(t).toContain(`Already applied: ${SAMPLE_CONTENT.blueprint.name} (version 1)`);
    // It opens on what can be applied (published), and every Apply goes to this client's preview.
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint, client.id)}"`);
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.starterBlueprint, client.id)}"`);
    expect(h).not.toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint)}"`);
    expect(t).not.toContain("Sample Salon Basics");
    expect(t).not.toContain("Sample Dental Snapshot");
    // The Blueprint the client already has offers its newer version for review; the others are applied fresh.
    expect(t).toContain(`${client.name} has version 1; version 2 is available to review`);
    expect(h).toContain(`aria-label="Review the update of ${SAMPLE_CONTENT.blueprint.name} for ${client.name}"`);
    expect(h).toContain(`aria-label="Apply Consulting Starter (sample) for ${client.name}"`);
    expect(h).toContain(`href="${bpHref.client(client.id)}"`);
    expect(h).toContain(`href="${bpHref.library}"`);
    expect(appliedVersionFor(client, SAMPLE_IDS.blueprint)).toBe(1);
    expect(appliedVersionFor(client, SAMPLE_IDS.starterBlueprint)).toBeNull();
    expect(appliedVersionFor(null, SAMPLE_IDS.blueprint)).toBeNull();

    // An explicit collection in the address still wins.
    nav.search = "collection=all";
    expect(text(library(SUPER, { applyFor: client }))).toContain("Sample Salon Basics");
    nav.search = "";

    // A GoHighLevel client can't be given a Blueprint: it says so, and there is nothing to apply.
    const ghl = SAMPLE_CLIENTS.find((c) => c.crmMode === "ghl")!;
    const g = html(library(SUPER, { applyFor: ghl }));
    expect(g).toContain("uses GoHighLevel as its CRM, so a Blueprint can't be applied to it");
    expect(g).not.toContain("/apply");
    // Someone who can't apply never gets the client mode, whatever the address says.
    const staff = text(library(STAFF, { applyFor: client }));
    expect(staff).not.toContain("Choosing a Blueprint for");
    expect(staff).toContain("Sample Salon Basics");
  });

  it("takes one-time parameters (?publish=1, ?new=1, ?capture=) out of the address when their dialog closes, keeping the rest", () => {
    expect(withoutParams("?tab=versions&publish=1", ["publish"])).toBe("tab=versions");
    expect(withoutParams("new=1&q=dental", ["new", "capture"])).toBe("q=dental");
    expect(withoutParams("publish=1", ["publish"])).toBe("");
    expect(publishHref(SAMPLE_IDS.blueprint)).toBe(`/admin/crm-blueprints/${SAMPLE_IDS.blueprint}?tab=versions&publish=1`);
    const calls: string[] = [];
    const fake = (search: string) => ({
      location: { pathname: `/admin/crm-blueprints/${SAMPLE_IDS.blueprint}`, search, hash: "#top" },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => calls.push(url) },
    });
    vi.stubGlobal("window", fake("?tab=versions&publish=1"));
    try {
      dropParams("publish");
      expect(calls).toEqual([`/admin/crm-blueprints/${SAMPLE_IDS.blueprint}?tab=versions#top`]);
      // Nothing to remove: the address isn't touched.
      vi.stubGlobal("window", fake("?tab=versions"));
      dropParams("publish");
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
    // On the server there is no address to change.
    expect(() => dropParams("publish")).not.toThrow();
  });

  it("filters, searches and sorts like the address says", () => {
    expect(matchesSearch(SAMPLE_BLUEPRINTS[0], "plumbing")).toBe(true);
    expect(matchesSearch(SAMPLE_BLUEPRINTS[0], "home services")).toBe(true);
    expect(matchesSearch(SAMPLE_BLUEPRINTS[1], "gohighlevel")).toBe(true);
    expect(matchesSearch(SAMPLE_BLUEPRINTS[0], "workflow drafts")).toBe(true);
    expect(matchesSearch(SAMPLE_BLUEPRINTS[0], "dental")).toBe(false);
    expect(sortBlueprints(SAMPLE_BLUEPRINTS, "name").map((b) => b.name)[0]).toBe("Consulting Starter (sample)");
    expect(sortBlueprints(SAMPLE_BLUEPRINTS, "applied")[0].id).toBe(SAMPLE_IDS.blueprint);
    const match = (id: string) => COLLECTIONS.filter((c) => c.match(SAMPLE_BLUEPRINTS.find((b) => b.id === id)!)).map((c) => c.id);
    expect(match(SAMPLE_IDS.ghlBlueprint)).toEqual(["all", "ghl", "drafts"]);
    expect(match(SAMPLE_IDS.blueprint)).toEqual(["all", "native", "featured", "published"]);
    expect(match(SAMPLE_IDS.archivedBlueprint)).toEqual(["archived"]);
  });
});

describe("a Blueprint's own page", () => {
  const detail = (permissions = SUPER, blueprint = SAMPLE_DETAIL) => React.createElement(BlueprintDetailView, {
    blueprint, applications: SAMPLE_APPLICATIONS, updateCandidates: SAMPLE_UPDATE_CANDIDATES, permissions,
  });

  it("opens on the overview: modules, setup requirements with their labels, provenance and readiness", () => {
    const t = text(detail());
    for (const tab of ["Overview", "Assets", "Versions", "Applications", "Details"]) expect(t).toContain(tab);
    expect(t).toContain("What's inside");
    expect(t).toContain("Setup each client completes");
    for (const key of ["calendar_hosts", "calendar_verification", "google_calendar", "template_approval", "form_rebuild", "workflow_rebuild"] as const) expect(t).toContain(REQUIREMENT_INFO[key].label);
    expect(t).toContain("Where it came from");
    expect(t).toContain("Readiness by asset");
    expect(t).toContain("1 warning");
    expect(t).toContain("Apply to client");
  });

  it("lists every asset by section, nested stages included", () => {
    nav.search = "tab=assets";
    const t = text(detail());
    expect(t).toContain("Published v2");
    for (const name of ["Jobs", "New request", "Estimates", "On-site estimate", "Request a visit", "Warranty claim", "Seasonal offer", "Weekly jobs"]) expect(t).toContain(name);
    expect(t).toContain("pipeline.jobs");
    expect(t).toContain("Name only");
  });

  it("shows the working draft, published versions and comparing them", () => {
    nav.search = "tab=versions";
    const t = text(detail());
    expect(t).toContain("Revision 7");
    expect(t).toContain("Changed since version 2.");
    expect(t).toContain("Pipelines & stages: 1 changed");
    expect(t).toContain("Compare versions");
    expect(t).toContain("Version 1");
    expect(t).toContain("Adds a video consultation");
    expect(t).toContain("stage added: Job scheduled");
    expect(t).toContain("Publish version 3");
    // Exports are plain links to the authorized route, never prefetched.
    expect(html(detail())).toContain(`href="${bpHref.exportFile(SAMPLE_IDS.blueprint, 1)}" download`);
  });

  it("hides publishing, restoring and applying from people who can't", () => {
    nav.search = "tab=versions";
    const staff = text(detail(STAFF, { ...SAMPLE_DETAIL, canPublish: false, canApply: false }));
    expect(staff).not.toContain("Publish version 3");
    expect(staff).not.toContain("Apply to client");
    expect(staff).toContain("Restore");
    const viewer = text(detail(NO_PERMISSIONS, { ...SAMPLE_DETAIL, canDesign: false, canPublish: false, canApply: false }));
    expect(viewer).not.toContain("Restore");
    expect(viewer).not.toContain("Edit draft");
  });

  it("shows where it is applied, which clients could review an update, and how to reach the apply page", () => {
    nav.search = "tab=applications";
    const h = html(detail());
    const t = text(detail());
    expect(t).toContain("Sample Plumbing Co.");
    expect(t).toContain("Clients on an earlier version");
    expect(t).toContain("v1 → v2");
    expect(t).toContain("A newer version is never pushed");
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint, SAMPLE_IDS.clientB)}"`);
    expect(h).toContain(`href="${bpHref.application(SAMPLE_IDS.clientA, SAMPLE_IDS.application)}"`);
  });

  it("keeps the technical details in their own panel", () => {
    nav.search = "tab=details";
    const t = text(detail());
    for (const label of ["Library key", "Blueprint ID", "Latest digest (sha256)", "Package format", "Draft revision", "Source"]) expect(t).toContain(label);
    expect(t).toContain(SAMPLE_CONTENT.blueprint.key);
    expect(t).toContain("iacquire.crm-blueprint");
    expect(t).toContain("b".repeat(64));
  });

  it("indexes assets with their dependencies, dependents, roles and setup", () => {
    const index = buildAssetIndex(SAMPLE_CONTENT);
    const wf = index.byId.get("workflow.new-request")!;
    expect(wf.dependsOn).toEqual(expect.arrayContaining(["tag.new-lead", "template.estimate-confirmed", "folder.workflow.follow-ups"]));
    expect(index.byId.get("tag.new-lead")!.usedBy).toContain("workflow.new-request");
    expect(index.byId.get("stage.jobs.won")!.parentId).toBe("pipeline.jobs");
    expect(index.byId.get("calendar.estimates")!.slots).toEqual(["member.technician"]);
    expect(index.byId.get("calendar.estimates")!.requirements).toEqual(expect.arrayContaining(["calendar_hosts", "calendar_verification"]));
    expect(index.byId.get("form.warranty-claim")!.placeholder).toBe(true);
    const facts = assetFacts(index.entries.get("calendar.estimates")!);
    expect(facts.find((f) => f.label === "Arrives as")?.value).toMatch(/Draft: takes no bookings/);
    expect(hoursSummary([{ weekday: 1, startMinute: 540, endMinute: 1020 }])).toBe("Mon 09:00–17:00");
    expect(slotLabel("@member.technician")).toBe("Team member: technician");
    expect(issueLines([{ severity: "error", code: "x", path: "assets.forms[0].draft", message: "m", assetId: null }, { severity: "error", code: "y", path: "blueprint.name", message: "m", assetId: null }])).toEqual(["Forms & surveys: 1 issue", "Details: 1 issue"]);
  });
});

describe("importing", () => {
  it("explains the four GoHighLevel methods plainly, with the snapshot link caveat", () => {
    const t = text(React.createElement(ImportCenter, { sources: SAMPLE_SOURCES, canImportGhl: true, canImportFile: true }));
    expect(t).toContain("The official API, with an authorized connection");
    expect(t).toContain("A sub-account where the snapshot is installed");
    expect(t).toContain("Structured exports");
    expect(t).toContain("Guided migration for the rest");
    expect(t).toContain("A snapshot share link is an install link, not a JSON export");
    expect(t).toContain("Smart Lists");
    expect(t).toContain("Names only");
    for (const c of GHL_COVERAGE) expect(t).toContain(c.kind);
    // A kind the reader states a limitation for is never described as converted.
    for (const c of GHL_COVERAGE) {
      const info = Object.values(GHL_KIND_INFO).find((i) => i.label === c.kind);
      if (info?.limitation) expect(c.level, c.kind).not.toBe("full");
      if (info && !info.endpoint) expect(c.level, c.kind).toBe("none");
    }
    expect(GHL_COVERAGE.find((c) => c.kind === GHL_KIND_INFO.messageTemplates.label)?.level).toBe("none");
    expect(GHL_COVERAGE.find((c) => c.kind === GHL_KIND_INFO.workflows.label)?.level).toBe("names");
    expect(decimalSize(1_000_000)).toBe("1 MB");
    expect(decimalSize(250_400)).toBe("251 KB");
  });

  it("lists sources with status and missing scopes, and asks for the token without ever showing one", () => {
    const h = html(React.createElement(ImportCenter, { sources: SAMPLE_SOURCES, canImportGhl: true, canImportFile: true }));
    const t = text(React.createElement(ImportCenter, { sources: SAMPLE_SOURCES, canImportGhl: true, canImportFile: true }));
    expect(t).toContain("Snapshot builder (sample)");
    expect(t).toContain("Connected, read-only");
    expect(t).toContain("Some scopes missing");
    expect(t).toContain("Missing read scopes: workflows.readonly, forms.readonly");
    expect(t).toContain("AbC…xYz");
    const token = /<input[^>]*id="bp-ghl-token"[^>]*>/.exec(h)?.[0] ?? "";
    expect(token).toContain('type="password"');
    expect(token).toContain('value=""');
    expect(token.toLowerCase()).toContain('autocomplete="new-password"');
    // The form offers exactly the scopes the reader uses, all read-only, camelCase ones included.
    expect(GHL_SCOPE_CHOICES.map((s) => s.scope)).toEqual([...GHL_IMPORT_SCOPES]);
    for (const s of GHL_SCOPE_CHOICES) expect(s.scope.endsWith(".readonly")).toBe(true);
    expect(GHL_SCOPE_CHOICES.map((s) => s.scope)).toContain("locations/customFields.readonly");
    for (const s of GHL_SCOPE_CHOICES) expect(h).toContain(s.scope);
    expect(t).toContain("Include custom values' contents");
    expect(t).toContain("Include placeholders");
    expect(t).toContain("Read and convert");
  });

  it("tells staff that only super admins import from GoHighLevel, and offers the package file", () => {
    // Staff land on the package file tab; the GoHighLevel tab says why it is closed to them.
    expect(text(React.createElement(ImportCenter, { sources: [], canImportGhl: false, canImportFile: true }))).toContain("Choose a package file");
    nav.search = "tab=ghl";
    const t = text(React.createElement(ImportCenter, { sources: [], canImportGhl: false, canImportFile: true }));
    expect(t).toContain("Only agency super admins can import from GoHighLevel");
    expect(t).not.toContain("Private integration token");
    nav.search = "tab=file";
    const file = text(React.createElement(ImportCenter, { sources: [], canImportGhl: false, canImportFile: true }));
    expect(file).toContain("Choose a package file");
    expect(file).toContain("Integrity: the sha256 digest must match");
    expect(file).toContain("up to 1 MB");
    expect(html(React.createElement(ImportCenter, { sources: [], canImportGhl: false, canImportFile: true }))).toContain('accept=".json,application/json"');
  });

  it("previews a conversion with every total, status chips, honest placeholders, limitations and validation", () => {
    const t = text(React.createElement(ImportDetailView, { detail: SAMPLE_IMPORT_DETAIL, canDesign: true }));
    for (const label of ["Discovered", "Fully supported", "Partially supported", "Unsupported", "Missing dependencies", "Mapping conflicts", "Needs connection", "Manual review"]) expect(t).toContain(label);
    for (const s of Object.values(COMPAT_LABELS)) expect(t).toContain(s);
    expect(t).toContain("Name only");
    expect(t).toContain("Smart Lists cannot be listed through the GoHighLevel API.");
    expect(t).toContain("The token is missing the surveys.readonly scope.");
    expect(t).toContain("looks like a GoHighLevel ID");
    expect(t).toContain("Save as Blueprint");
    expect(t).toContain("Discard");
    expect(t).toContain("Assets to keep");
    // A name-only form is never shown as converted.
    const report = SAMPLE_IMPORT_DETAIL.report.items.find((i) => i.name === "New patient intake")!;
    expect(report.status).toBe("manual_review");
  });

  it("shows a package's integrity and manifest checks, and nothing to save for someone who can't", () => {
    const t = text(React.createElement(ImportDetailView, { detail: SAMPLE_PACKAGE_PREVIEW, canDesign: false }));
    expect(t).toContain("Integrity digest matches");
    expect(t).toContain("Manifest matches the content");
    expect(t).not.toContain("Save as Blueprint");
    expect(t).toContain("can't save it as a Blueprint");
  });

  it("keeps a history of imports with their status and links", () => {
    const h = html(React.createElement(ImportsHistory, { imports: SAMPLE_IMPORTS, canImport: true }));
    const t = text(React.createElement(ImportsHistory, { imports: SAMPLE_IMPORTS, canImport: true }));
    expect(t).toContain("Awaiting review");
    expect(t).toContain("Saved as Blueprint");
    expect(t).toContain("Failed");
    expect(h).toContain(`href="${bpHref.importDetail(SAMPLE_IDS.importGhl)}"`);
    expect(h).toContain(`href="${bpHref.detail(SAMPLE_IDS.blueprint)}"`);
  });

  it("includes what a captured item needs, transitively", () => {
    expect([...captureClosure(SAMPLE_CAPTURE.candidates, ["workflow.new-request"])].sort()).toEqual(["tag.new-lead", "workflow.new-request"]);
    expect([...captureClosure(SAMPLE_CAPTURE.candidates, [])]).toEqual([]);
  });
});

describe("applications", () => {
  it("lists every application with its version, an available update and links", () => {
    const h = html(React.createElement(ApplicationsHistory, { applications: SAMPLE_APPLICATIONS, canApply: true }));
    const t = text(React.createElement(ApplicationsHistory, { applications: SAMPLE_APPLICATIONS, canApply: true }));
    expect(t).toContain("Sample Heating & Air");
    expect(t).toContain("v2 available");
    expect(t).toContain("Review update");
    expect(h).toContain(`href="${bpHref.apply(SAMPLE_IDS.blueprint, SAMPLE_IDS.clientB)}"`);
    expect(text(React.createElement(ApplicationsHistory, { applications: SAMPLE_APPLICATIONS, canApply: false }))).not.toContain("Review update");
  });

  it("shows what one application did, the setup still open, and Roll back only for someone who may", () => {
    const t = text(React.createElement(ApplicationDetailView, { application: SAMPLE_APPLICATION_DETAIL, canApply: true }));
    expect(t).toContain("What happened");
    expect(t).toContain("Created as a draft: it takes no bookings");
    expect(t).toContain("Already matches");
    expect(t).toContain("Skip (keep existing)");
    expect(t).toContain("Setup still open in this workspace");
    expect(t).toContain(REQUIREMENT_INFO.calendar_hosts.label);
    expect(t).toContain("Roll back");
    expect(html(React.createElement(ApplicationDetailView, { application: SAMPLE_APPLICATION_DETAIL, canApply: true }))).toContain(`href="${bpHref.clientCrm(SAMPLE_IDS.clientA)}"`);
    expect(text(React.createElement(ApplicationDetailView, { application: SAMPLE_APPLICATION_DETAIL, canApply: false }))).not.toContain("Roll back");
    expect(text(React.createElement(ApplicationDetailView, { application: { ...SAMPLE_APPLICATION_DETAIL, canRollBack: false }, canApply: true }))).toContain("Only the newest live application");
  });

  it("reports a rollback's result with what was kept and why", () => {
    const t = text(React.createElement(ApplicationDetailView, { application: { ...SAMPLE_APPLICATION_DETAIL, canRollBack: false, status: "partially_rolled_back", rolledBackAt: SAMPLE_APPLICATION_DETAIL.createdAt }, canApply: true, sampleRollback: SAMPLE_ROLLBACK }));
    expect(t).toContain("Rollback result");
    expect(t).toContain("4 changes were undone");
    expect(t).toContain("Used on 12 contacts since it was applied.");
    expect(t).toContain("Has 3 deals.");
    expect(t).not.toContain("Roll back Sample");
  });
});

describe("section navigation", () => {
  it("marks exactly one tab as the current page, with a Blueprint's pages under the Library", () => {
    const current = (path: string) => [...html(React.createElement(BlueprintNav, { pathname: path })).matchAll(/<a[^>]*aria-current="page"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    expect(current("/admin/crm-blueprints")).toEqual(["Library"]);
    expect(current(`/admin/crm-blueprints/${SAMPLE_IDS.blueprint}/edit`)).toEqual(["Library"]);
    expect(current("/admin/crm-blueprints/import")).toEqual(["Import"]);
    expect(current(`/admin/crm-blueprints/imports/${SAMPLE_IDS.importGhl}`)).toEqual(["Import history"]);
    expect(current("/admin/crm-blueprints/applications")).toEqual(["Applications"]);
    nav.pathname = "/admin/crm-blueprints/applications";
    expect([...html(React.createElement(BlueprintNav)).matchAll(/aria-current="page"/g)].length).toBe(1);
  });
});

describe("the design preview", () => {
  const VIEWS = ["library", "library-client", "capture", "detail", "import", "imports", "import-detail", "package-preview", "applications", "application", "rollback-result"];

  it("renders every screen with labelled sample data, for super admins and staff", async () => {
    for (const role of [undefined, "staff"]) {
      for (const view of VIEWS) {
        const t = text(await CrmBlueprintsPreview({ searchParams: Promise.resolve({ view, role }) }));
        expect(t, `${view} ${role ?? "super"}`).toContain("Design preview · invented sample data, not a real client · actions here do nothing");
      }
    }
    expect(text(await CrmBlueprintsPreview({ searchParams: Promise.resolve({ view: "nonsense" }) }))).toContain("CRM Blueprints & Snapshots");
    expect(text(await CrmBlueprintsPreview({ searchParams: Promise.resolve({ view: "library-client" }) }))).toContain("Choosing a Blueprint for Sample Plumbing Co.");
    expect(text(await CrmBlueprintsPreview({ searchParams: Promise.resolve({ view: "library-client", role: "staff" }) }))).not.toContain("Choosing a Blueprint for");
  });

  it("is not served in production", async () => {
    nav.nodeEnv = "production";
    await expect(CrmBlueprintsPreview({ searchParams: Promise.resolve({ view: "library" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
