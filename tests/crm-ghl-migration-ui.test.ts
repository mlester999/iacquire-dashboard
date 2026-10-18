// The "Migrate from GoHighLevel" panel and the Imports & Exports page, rendered on the server: who can reach the preview, live progress,
// honest wait copy, screen-reader updates that don't chatter on every poll, the bulk dry run's button, the right run's Undo, and the
// comparison's source counts. Server actions are stand-ins that are never called; nothing here contacts GoHighLevel.
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/crm/settings/data", useSearchParams: () => new URLSearchParams() }));
vi.mock("next/cache", () => ({ revalidatePath() {} }));
const { stub } = vi.hoisted(() => ({ stub: async () => ({ ok: false, error: "not in tests" }) }));
vi.mock("@/app/actions/crm-ghl-migration", () => Object.fromEntries([
  "previewGhlMigrationAction", "ghlMigrationStateAction", "startGhlDryRunAction", "startGhlStepAction", "advanceGhlMigrationAction", "startGhlImportAction",
  "checkGhlStepAgainAction", "cancelGhlStepAction", "rollbackGhlStepAction", "ghlStepDetailAction",
].map((n) => [n, stub])));
vi.mock("@/app/actions/crm", () => Object.fromEntries([
  "advanceImportAction", "cancelImportAction", "createImportAction", "getImportAction", "rollbackImportAction", "startImportAction", "startValidationAction",
  "setPermissionOverrideAction", "updateWorkspaceSettingsAction",
].map((n) => [n, stub])));

import { saveIntegrationConnection } from "@/server/integrations/manager";
import { scopeFor, type CrmScope } from "@/server/crm/page";
import type { GhlComparisonRow, GhlMigrationState } from "@/server/crm/ghl-migration";
import type { ImportJobView } from "@/server/crm/imports";
import { GHL_MIGRATION_ENTITIES, type GhlMigrationEntity } from "@/lib/crm/ghl-migration";
import { DataView } from "@/components/crm/views/settings-views";
import { GhlMigrationPanel } from "@/components/crm/ghl-migration-panel";
import { agencyPeople, crmOrg } from "./support/crm";

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const text = (el: React.ReactElement) => html(el).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

let admin: Awaited<ReturnType<typeof agencyPeople>>["superAdmin"];
beforeAll(async () => {
  admin = (await agencyPeople()).superAdmin;
});

describe("who reaches the preview", () => {
  it("lets a role that may only view the CRM open Imports & Exports and preview the migration, without the import history", async () => {
    const c = await crmOrg({ name: "Viewer Preview Co" });
    await saveIntegrationConnection(admin, c.org.id, { provider: "ghl", label: "Synthetic GHL", environment: "development", secret: "synthetic-key-" + "k".repeat(30), config: { locationId: "synthMigLocView01", scopes: ["locations.readonly"] } });
    const viewer = c.actor("viewer");
    expect(viewer.can("crm.view")).toBe(true);
    expect(viewer.can("contacts.import")).toBe(false);
    const el = await DataView({ actor: viewer, scope: await scopeFor(viewer, "/crm") });
    const props = (el as React.ReactElement<{ jobs: unknown[]; ghlMigration: GhlMigrationState }>).props;
    expect(props.jobs).toEqual([]);
    expect(props.ghlMigration.can).toEqual({ preview: true, dryRun: false, import: false });
    const t = text(el);
    expect(t).toContain("Migrate from GoHighLevel");
    expect(t).toContain("Preview GoHighLevel");
    expect(t).toMatch(/You can preview what your GoHighLevel location holds/);
    expect(t).not.toContain("Past imports");
    expect(t).not.toContain("Import a CSV file");
    expect(t).not.toContain("Start the dry run");
    // The owner still sees the history and the CSV import.
    const owner = c.actor("owner");
    const ownerText = text(await DataView({ actor: owner, scope: await scopeFor(owner, "/crm") }));
    expect(ownerText).toContain("Past imports");
    expect(ownerText).toContain("Start the dry run");
  });
});

// ---------------------------------------------------------------------------
// The panel, from a given state
// ---------------------------------------------------------------------------

const SCOPE = { orgId: null, base: "/crm", can: {}, readOnly: false } as unknown as CrmScope;
let seq = 0;
function job(entity: GhlMigrationEntity, over: Partial<ImportJobView> = {}): ImportJobView {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`, entity, source: "ghl_api", fileName: `GoHighLevel: ${entity}`, status: "completed", headers: [], mapping: {}, options: { duplicates: "update" },
    totalRows: 300, summary: {}, error: null, createdAt: new Date(Date.now() - 3_600_000).toISOString(), validatedAt: null, startedAt: null, completedAt: null, createdBy: null, startedBy: null,
    switchId: null, progress: null,
    fetch: { pages: 3, requests: 5, rateLimited: 0, waitingUntil: null, waitReason: null, transientErrors: 0, lastError: null, sourceTotal: null, truncated: false, fetchedAt: null, ownersReadable: true },
    ...over,
  };
}
const none = () => Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, null])) as Record<GhlMigrationEntity, ImportJobView | null>;
function state(jobs: Partial<Record<GhlMigrationEntity, ImportJobView>>, over: Partial<GhlMigrationState> = {}): GhlMigrationState {
  const all = { ...none(), ...jobs };
  return {
    connected: true, reason: null, locationName: "Synthetic Location", switching: false, switchActive: false,
    owners: Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, "native"])) as GhlMigrationState["owners"],
    jobs: all, undo: none(), remaining: GHL_MIGRATION_ENTITIES.filter((e) => !all[e]), comparison: null, can: { preview: true, dryRun: true, import: true }, host: "https://services.leadconnectorhq.com",
    ...over,
  };
}
const panel = (s: GhlMigrationState) => React.createElement(GhlMigrationPanel, { scope: SCOPE, initial: s });
const later = new Date(Date.now() + 60_000).toISOString();

describe("the migration panel", () => {
  it("shows live progress from the server's counts while a step is checked, imported or undone", () => {
    const importing = job("contact", { status: "importing", summary: { validated: 300, create: 300 }, progress: { done: 250, total: 300 } });
    const undoing = job("opportunity", { status: "rolling_back", summary: { created: 4 }, progress: { done: 1, total: 4 } });
    const checking = job("tag", { status: "validating", progress: { done: 0, total: 0 } });
    const out = html(panel(state({ contact: importing, opportunity: undoing, tag: checking })));
    expect(out).toContain('aria-valuenow="83"');
    expect(out).toContain("250 of 300");
    expect(out).toContain('aria-valuenow="25"');
    expect(out).not.toContain('aria-valuenow="50"');
    expect(out).not.toContain('aria-valuenow="0"');
    // Before the first poll brings counts, no made-up percentage.
    expect(text(panel(state({ contact: job("contact", { status: "importing", progress: null }) })))).toContain("Starting…");
  });

  it("says honestly why a step is waiting", () => {
    const fetching = (waitReason: NonNullable<ImportJobView["fetch"]>["waitReason"], extra: Partial<NonNullable<ImportJobView["fetch"]>> = {}) =>
      text(panel(state({ contact: job("contact", { status: "fetching", totalRows: 200, fetch: { ...job("contact").fetch!, waitingUntil: later, waitReason, ...extra } }) })));
    expect(fetching("retry_after", { rateLimited: 2 })).toMatch(/GoHighLevel asked us to wait until .* GoHighLevel answered 429 2×/);
    const burst = fetching("burst");
    expect(burst).toContain("to stay under GoHighLevel's per-10-second limit");
    expect(burst).not.toContain("GoHighLevel asked us to wait");
    expect(burst).not.toContain("429");
    expect(fetching("daily")).toContain("saving the rest of today's GoHighLevel allowance");
    expect(fetching("error", { transientErrors: 2, lastError: "GoHighLevel returned 503." })).toMatch(/GoHighLevel had a passing error \(GoHighLevel returned 503\); trying again at .* \(2 in a row\)/);
  });

  it("locks migration step controls while the provider-switch wizard owns the steps", () => {
    const checked = job("tag", { status: "validated", summary: { create: 2, update: 0, skip: 0, review: 0 }, validatedAt: later });
    const out = text(panel(state({ tag: checked }, { switchActive: true, switching: true })));
    expect(out).toContain("Manage migration steps in Settings → CRM Provider");
    expect(out).toContain("this panel is read-only until the switch finishes");
    expect(out).not.toContain("Import tags");
    expect(out).not.toContain("Check again");
    expect(out).not.toContain("Cancel");
    expect(out).not.toContain("Run this step again");
    expect(out).not.toContain("Undo");
  });

  it("keeps screen-reader updates to status changes, not the counters every poll changes", () => {
    const fetching = job("contact", { status: "fetching", totalRows: 1234, fetch: { ...job("contact").fetch!, requests: 17 } });
    const done = job("tag", { status: "completed", summary: { created: 2, updated: 1, failed: 0 } });
    const out = html(panel(state({ contact: fetching, tag: done })));
    expect(out).not.toContain("aria-live");
    const status = [...out.matchAll(/<p role="status" class="sr-only">([^<]*)<\/p>/g)].map((m) => m[1]);
    expect(status).toEqual(expect.arrayContaining(["Contacts: Reading GoHighLevel", "Tags: Imported: 2 created, 1 linked, 0 failed"]));
    expect(status.join(" ")).not.toMatch(/1,234|17 requests/);
    // The counters are still on screen.
    expect(text(panel(state({ contact: fetching })))).toContain("1,234 read so far");
  });

  it("offers the bulk dry run only for steps that still need one, Stop for a running import, and Undo for the run it acts on", () => {
    const fields = job("custom_field", { status: "completed" });
    const all = Object.fromEntries(GHL_MIGRATION_ENTITIES.map((e) => [e, job(e, { status: "completed" })])) as Record<GhlMigrationEntity, ImportJobView>;
    expect(text(panel(state(all, { remaining: [] })))).not.toMatch(/Dry run the remaining|Start the dry run/);
    expect(text(panel(state({ custom_field: fields }, { remaining: ["tag", "pipeline", "company", "contact", "opportunity"] })))).toContain("Dry run the remaining 5 steps");
    expect(text(panel(state({}, { remaining: [...GHL_MIGRATION_ENTITIES] })))).toContain("Start the dry run");
    // A running import: the owner can stop it (a manager can't, so no button).
    const importing = job("tag", { status: "importing", progress: { done: 1, total: 2 } });
    expect(text(panel(state({ tag: importing })))).toContain("Stop import");
    expect(text(panel(state({ tag: importing }, { can: { preview: true, dryRun: true, import: false } })))).not.toContain("Stop import");
    // The latest run of a step was undone; an earlier run still has records to undo, so Undo acts on that one.
    const undone = job("company", { status: "rolled_back", summary: { rolledBack: 0, keptChanged: 2 } });
    const earlier = job("company", { status: "completed", summary: { created: 2 } });
    const t = text(panel(state({ company: undone }, { undo: { ...none(), company: earlier } })));
    expect(t).toContain("Undo the earlier run");
    expect(t).toMatch(/The run from .* imported records that are still here/);
    // Nothing to undo anywhere: no Undo.
    expect(html(panel(state({ company: undone })))).not.toMatch(/>Undo<\/button>|Undo the earlier run/);
    expect(html(panel(state({ company: earlier }, { undo: { ...none(), company: earlier } })))).toMatch(/>Undo<\/button>/);
  });

  it("says what kind of number GoHighLevel's count is in the comparison", () => {
    const base = (entity: GhlMigrationEntity, over: Partial<GhlComparisonRow>): GhlComparisonRow => ({
      entity, label: entity, jobId: null, status: "validated", sourceCount: null, sourceCountKind: null, staged: 0, destinationCount: 0, mapped: 0, created: 0, linked: 0, skipped: 0, failed: 0,
      needsReview: 0, planned: { create: 0, update: 0, skip: 0, review: 0, invalid: 0 }, flags: {}, unsupported: [], rolledBack: 0, truncated: false, ...over,
    });
    const comparison = {
      generatedAt: new Date().toISOString(), notMigrated: [],
      rows: [
        base("contact", { label: "Contacts", sourceCount: 7, sourceCountKind: "reported", staged: 2 }),
        base("company", { label: "Companies", sourceCount: 40, sourceCountKind: "listed", staged: 40 }),
        base("opportunity", { label: "Opportunities", sourceCount: 100, sourceCountKind: "at_least", staged: 100, status: "failed" }),
        base("tag", { label: "Tags", sourceCount: null, sourceCountKind: null, status: "fetching" }),
      ],
    };
    const t = text(panel(state({ contact: job("contact") }, { comparison })));
    expect(t).toMatch(/Contacts 7 2 /);
    expect(t).toMatch(/Companies 40 listed 40 /);
    expect(t).toMatch(/Opportunities at least 100 100 /);
    expect(t).toMatch(/Tags not reported 0 /);
    expect(t).toContain("GoHighLevel reports no total for that step");
  });
});
