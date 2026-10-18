import { AppError } from "@/server/errors";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getCrmReport, getReportOptions } from "@/server/crm/reports/service";
import { TEAM_REPORT_PERMISSION, listSavedReports } from "@/server/crm/reports/definitions";
import { resolveReportRequest } from "@/server/crm/reports/params";
import { ReportsWorkspace } from "@/components/crm/reports/reports-workspace";
import { DEFAULT_FILTERS, visibleSections } from "@/components/crm/reports/spec";
import type { CrmReport } from "@/components/crm/reports/types";

type SP = Record<string, string | string[] | undefined>;

/**
 * CRM → Reports. Filters live in the address bar, so a link or a refresh shows the same report; `?report=<id>` opens a saved report.
 * Needs the reporting permission. An agency support session can read reports but never save or export them.
 */
export async function ReportsView({ actor, scope, searchParams = {} }: { actor: CrmActor; scope: CrmScope; searchParams?: SP }) {
  const req = await resolveReportRequest(actor, searchParams);
  const notices = [...req.notices];
  let report: CrmReport;
  try {
    report = await getCrmReport(actor, { filters: req.filters, sections: req.sections });
  } catch (err) {
    // A saved period that can no longer be used still opens the report, on the default period, and says so.
    if (!(err instanceof AppError) || err.code !== "invalid_input") throw err;
    notices.push(`${err.message} Showing the last 30 days instead.`);
    report = await getCrmReport(actor, { filters: { ...DEFAULT_FILTERS }, sections: req.sections });
  }
  const [options, saved] = await Promise.all([getReportOptions(actor), listSavedReports(actor)]);
  await auditSupportView(actor, "reports", req.active?.id);
  const member = actor.kind === "member";
  return (
    <ReportsWorkspace
      scope={scope}
      report={report}
      options={options}
      saved={saved}
      active={req.active}
      requested={req.sections}
      available={visibleSections((p) => actor.can(p))}
      notices={[...notices, ...report.notices]}
      canExport={member && actor.can("analytics.export")}
      canShare={member && actor.can(TEAM_REPORT_PERMISSION)}
      canSave={member && !scope.readOnly}
    />
  );
}
