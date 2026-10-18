import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { PreviewTheme } from "@/components/projects/preview-theme";
import { BlueprintNav } from "@/components/crm-blueprints/nav";
import { BlueprintLibrary } from "@/components/crm-blueprints/library";
import { BlueprintDetailView } from "@/components/crm-blueprints/detail";
import { ImportCenter } from "@/components/crm-blueprints/import-center";
import { ImportDetailView, ImportsHistory } from "@/components/crm-blueprints/imports";
import { ApplicationDetailView, ApplicationsHistory } from "@/components/crm-blueprints/applications";
import type { BlueprintUiPermissions } from "@/components/crm-blueprints/shared";
import {
  SAMPLE_APPLICATIONS, SAMPLE_APPLICATION_DETAIL, SAMPLE_BLUEPRINTS, SAMPLE_CAPTURE, SAMPLE_CLIENTS, SAMPLE_DETAIL, SAMPLE_FOLDERS, SAMPLE_IDS, SAMPLE_IMPORTS,
  SAMPLE_IMPORT_DETAIL, SAMPLE_PACKAGE_PREVIEW, SAMPLE_ROLLBACK, SAMPLE_SOURCES, SAMPLE_STARTERS, SAMPLE_UPDATE_CANDIDATES,
} from "./sample";

export const dynamic = "force-dynamic";
export const metadata = { title: "CRM Blueprints design preview" };

const VIEWS = ["library", "library-client", "capture", "detail", "import", "imports", "import-detail", "package-preview", "applications", "application", "rollback-result"] as const;
type View = (typeof VIEWS)[number];
const PATH: Record<View, string> = {
  library: "/admin/crm-blueprints", "library-client": "/admin/crm-blueprints", capture: "/admin/crm-blueprints", detail: `/admin/crm-blueprints/${SAMPLE_IDS.blueprint}`, import: "/admin/crm-blueprints/import",
  imports: "/admin/crm-blueprints/imports", "import-detail": `/admin/crm-blueprints/imports/${SAMPLE_IDS.importGhl}`, "package-preview": `/admin/crm-blueprints/imports/${SAMPLE_IDS.importFile}`,
  applications: "/admin/crm-blueprints/applications", application: `/admin/crm-blueprints/applications/x/${SAMPLE_IDS.application}`, "rollback-result": `/admin/crm-blueprints/applications/x/${SAMPLE_IDS.application}`,
};

const SUPER: BlueprintUiPermissions = { design: true, publish: true, apply: true, export: true, importFile: true, importGhl: true, capture: true };
const STAFF: BlueprintUiPermissions = { design: true, publish: false, apply: false, export: true, importFile: true, importGhl: false, capture: true };

/**
 * Development only (404 in production): the agency's CRM Blueprints screens with invented sample data and no sign-in, so every state can be
 * reviewed in a browser. Nothing is read from or written to a database; every action on these screens says "Design preview only" instead of
 * calling the server. `?view=` picks a screen (`library-client` is the library opened from a client's page, ?client=<orgId>) and `?role=staff`
 * shows what agency staff (who can't publish or apply) see.
 */
export default async function CrmBlueprintsPreview({ searchParams }: { searchParams: Promise<{ view?: string; role?: string }> }) {
  if (env().NODE_ENV === "production") notFound();
  const { view: raw, role } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(raw ?? "") ? (raw as View) : "library";
  const staff = role === "staff";
  const p = staff ? STAFF : SUPER;
  const detail = staff ? { ...SAMPLE_DETAIL, canPublish: false, canApply: false } : SAMPLE_DETAIL;
  const link = (v: View) => `?view=${v}${staff ? "&role=staff" : ""}`;
  return (
    <div className="app-backdrop min-h-dvh">
      <div className="sticky top-0 z-40 border-b border-warning/30 bg-warning-soft px-4 py-2 text-[12px] font-medium text-warning-ink">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-3 gap-y-1">
          <span>Design preview · invented sample data, not a real client · actions here do nothing</span>
          <nav aria-label="Preview screens" className="flex flex-wrap gap-x-3 gap-y-1">
            {VIEWS.map((v) => <a key={v} href={link(v)} aria-current={v === view ? "page" : undefined} className={v === view ? "underline" : "opacity-80 hover:opacity-100"}>{v}</a>)}
          </nav>
          <a href={`?view=${view}${staff ? "" : "&role=staff"}`} className="underline">{staff ? "Show as super admin" : "Show as agency staff"}</a>
          <span className="ml-auto"><PreviewTheme /></span>
        </div>
      </div>
      <main className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        <BlueprintNav pathname={PATH[view]} />
        {(view === "library" || view === "library-client" || view === "capture") && (
          <BlueprintLibrary key={view} preview blueprints={SAMPLE_BLUEPRINTS} folders={SAMPLE_FOLDERS} starters={SAMPLE_STARTERS} clients={SAMPLE_CLIENTS} permissions={p}
            captureOrgId={view === "capture" ? SAMPLE_IDS.clientA : null} samplePreview={view === "capture" ? SAMPLE_CAPTURE : null}
            applyFor={view === "library-client" ? SAMPLE_CLIENTS[0] : null} />
        )}
        {view === "detail" && <BlueprintDetailView preview blueprint={detail} applications={SAMPLE_APPLICATIONS} updateCandidates={SAMPLE_UPDATE_CANDIDATES} permissions={p} />}
        {view === "import" && <ImportCenter preview sources={staff ? [] : SAMPLE_SOURCES} canImportGhl={p.importGhl} canImportFile={p.importFile} />}
        {view === "imports" && <ImportsHistory imports={SAMPLE_IMPORTS} canImport />}
        {view === "import-detail" && <ImportDetailView preview detail={SAMPLE_IMPORT_DETAIL} canDesign={p.design} />}
        {view === "package-preview" && <ImportDetailView preview detail={SAMPLE_PACKAGE_PREVIEW} canDesign={p.design} />}
        {view === "applications" && <ApplicationsHistory applications={SAMPLE_APPLICATIONS} canApply={p.apply} />}
        {view === "application" && <ApplicationDetailView preview application={SAMPLE_APPLICATION_DETAIL} canApply={p.apply} />}
        {view === "rollback-result" && <ApplicationDetailView preview application={{ ...SAMPLE_APPLICATION_DETAIL, status: "partially_rolled_back", canRollBack: false, rolledBackAt: SAMPLE_APPLICATION_DETAIL.createdAt }} canApply={p.apply} sampleRollback={SAMPLE_ROLLBACK} />}
      </main>
    </div>
  );
}
