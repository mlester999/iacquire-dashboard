import "server-only";
import type { CrmActor } from "@/server/crm/actor";
import { getSavedReport } from "@/server/crm/reports/definitions";
import { REPORT_SECTIONS, parseReportParams, todayIn, type ReportFilters, type ReportSection } from "@/components/crm/reports/spec";
import type { SavedReportView } from "@/components/crm/reports/types";

type SP = Record<string, string | string[] | undefined>;
const FILTER_PARAMS = ["range", "from", "to", "member", "source", "pipeline", "campaign", "channel", "sections"];

export interface ReportRequest {
  filters: ReportFilters;
  /** Null: every section. */
  sections: ReportSection[] | null;
  /** The saved report named in the address, when this person can open it. */
  active: SavedReportView | null;
  notices: string[];
}

/**
 * What a reports address asks for. `report=<id>` opens a saved report with its own filters, unless the address also carries filters, which
 * then win (that is how a saved report is adjusted before its changes are saved). Anything unusable is dropped with a notice.
 */
export async function resolveReportRequest(actor: CrmActor, sp: SP, now: Date = new Date()): Promise<ReportRequest> {
  const parsed = parseReportParams(sp, todayIn(actor.timezone || "UTC", now));
  const notices: string[] = parsed.notice ? [parsed.notice] : [];
  let filters = parsed.filters;
  let sections = parsed.sections;
  let active: SavedReportView | null = null;
  if (parsed.savedId) {
    active = await getSavedReport(actor, parsed.savedId);
    if (!active) notices.push("That saved report isn't available any more (it was archived, or it is someone else's private report).");
    else if (!FILTER_PARAMS.some((k) => sp[k] !== undefined)) {
      filters = active.config.filters;
      sections = active.config.sections.length === REPORT_SECTIONS.length ? null : active.config.sections;
    }
  }
  return { filters, sections, active, notices };
}
