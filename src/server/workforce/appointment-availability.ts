import "server-only";
import { withSystem } from "@/server/db";
import { nativeAvailability } from "@/server/calendars/native-availability";
import {
  appendWorkEvent,
  finishWorkJob,
  recordWorkStage,
  type WorkJobRow,
} from "@/server/workforce/jobs";
import { publishReviewReport } from "@/server/workforce/reports";
import { readReviewSource, reviewCount, reviewFinding, sourceLimitation, type ReviewFinding, type ReviewMetric } from "@/server/workforce/read-only-review";
import { roleMayUseCapability } from "@/lib/workforce-capabilities";
import { readableTimeZone, summarizeSlotsByDay } from "@/lib/calendars/availability-summary";
import type { AgentRoleKey } from "@/lib/agents";

/**
 * A week of start times at the finest step a type allows (5 minutes) is 2,016, so this cap is never what limits a real answer. It exists only so a broken calendar cannot fill a
 * row, and a result that reached it says "at least", never a number that looks like a total.
 */
const MAX_SLOTS = 2_500;
/** The first start times kept on the result for the card to show; the total and the per-day summary cover all of them. */
const SAMPLE_SLOTS = 100;

/**
 * Read real calendar availability through the existing native booking service.
 *
 * The capability never holds a slot, creates a booking, contacts a host or writes an external
 * calendar. It reports the same slots the booking flow would offer, with the reason when it cannot.
 * The count is the real number of bookable start times (it was once capped at 50 and reported as the total), grouped by day in the zone the hosts work in.
 */
export async function runAppointmentAvailabilityJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
  const workerId = job.lease_owner ?? "";
  const agent = await withSystem(async (db) => {
    const { rows } = await db.query<{ role_key: string; display_name: string }>(
      "select role_key, display_name from agent_instances where id = $1 and org_id = $2",
      [job.agent_instance_id, job.org_id],
    );
    return rows[0] ?? null;
  });
  if (!agent || agent.role_key !== "appointment_setter" || !roleMayUseCapability(agent.role_key as AgentRoleKey, job.capability)) {
    await withSystem(async (db) => {
      await finishWorkJob(db, {
        jobId: job.id,
        orgId: job.org_id,
        workerId,
        status: "blocked",
        stage: "blocked",
        failureCode: "capability_not_allowed",
        failureMessage: "This employee's role is not allowed to check calendar availability.",
        event: {
          kind: "error",
          stage: "blocked",
          message: "This employee's role is not allowed to check calendar availability, so nothing was read.",
        },
      });
    });
    return;
  }

  const now = new Date();
  const to = new Date(now.getTime() + 7 * 86_400_000);
  const availability = await nativeAvailability(job.org_id, { from: now, to, limit: MAX_SLOTS + 1 });
  const truncated = availability.ok && availability.slots.length > MAX_SLOTS;
  const slots = availability.ok ? availability.slots.slice(0, MAX_SLOTS) : [];
  // Read the times where the people who take the meetings work (when their calendar's hosts share one zone), not in the workspace's default zone.
  const displayTimeZone = readableTimeZone(availability.ok ? availability.hostTimeZone ?? availability.timeZone : null);
  const days = summarizeSlotsByDay(slots, displayTimeZone);

  await withSystem(async (db) => {
    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "scanning",
      message: "Checking real bookable calendar availability for the next seven days…",
    });

    const findings: ReviewFinding[] = [];
    if (!availability.ok) {
      findings.push(reviewFinding({
        key: "calendar_not_ready",
        severity: "warning",
        title: "The calendar cannot offer bookable slots",
        detail: availability.detail,
        count: 1,
        samples: [],
        evidenceHref: "/crm/calendar",
        recommendedAction: "Verify and activate a calendar with at least one host and working hours.",
        requiresApproval: false,
      }));
    } else if (slots.length === 0) {
      findings.push(reviewFinding({
        key: "no_available_slots",
        severity: "warning",
        title: "No bookable slots in the next seven days",
        detail: "The calendar is active but every candidate time is blocked by working hours, notice, buffers or existing bookings.",
        count: 1,
        samples: [],
        evidenceHref: "/crm/calendar",
        recommendedAction: "Check host working hours, exceptions and the appointment type's notice period before offering this calendar.",
        requiresApproval: false,
      }));
    }

    const metrics: ReviewMetric[] = [{
      key: "available_slots",
      label: "Bookable slots (7 days)",
      value: slots.length,
      period: "Next 7 days",
      definition: "Distinct start times the active calendar and its hosts can accept, computed from saved working hours, buffers, notice and live bookings.",
      source: "crm_calendars, crm_availability_rules, crm_busy_blocks",
    }];

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "analyzing",
      message: "Preparing the availability result and any scheduling risk…",
      progress: { checksRun: 2, findings: findings.length, slots: slots.length },
    });

    for (const finding of findings) {
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        workerId,
        kind: "evidence",
        stage: "analyzing",
        message: finding.title,
        data: { key: finding.key, href: finding.evidenceHref },
      });
    }

    // What the check looked at, so "no slots" can be told apart from "no calendar".
    const examined = [
      { label: "active calendars", count: await reviewCount(db, "select count(*)::int as count from crm_calendars where org_id = $1 and status = 'active' and archived_at is null", [job.org_id]) },
      { label: "appointment types", count: await reviewCount(db, "select count(*)::int as count from crm_appointment_types where org_id = $1 and archived_at is null", [job.org_id]) },
    ];
    const source = await readReviewSource(db, job.org_id, "calendars");
    const limitations = `Only bookable start times stored in this workspace were read. No slot was held, no booking was created and no external calendar was contacted. ${sourceLimitation(source)}`;

    const count = slots.length;
    const summary = availability.ok
      ? `Calendar availability checked: ${truncated ? "at least " : ""}${count} bookable slot${count === 1 ? "" : "s"}${days.length ? ` on ${days.length} day${days.length === 1 ? "" : "s"}` : ""} in the next 7 days (${displayTimeZone}).`
      : `Calendar availability could not be checked: ${availability.detail}`;

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      stage: "preparing_results",
      message: "Availability check complete.",
    });
    const finished = await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      workerId,
      status: "completed",
      stage: "completed",
      resultCount: slots.length,
      resultSummary: summary,
      result: {
        availability: availability.ok
          ? {
              slots: slots.slice(0, SAMPLE_SLOTS).map((slot) => ({ start: slot.start, end: slot.end })),
              total: slots.length,
              truncated,
              days,
              timeZone: availability.timeZone,
              displayTimeZone,
              hostTimeZone: availability.hostTimeZone ?? null,
              checkedAt: availability.checkedAt,
              slotMinutes: availability.slotMinutes,
              calendarId: availability.calendarId,
            }
          : { reason: availability.detail, reasonCode: availability.reason },
        metrics,
        findings,
        examined,
        source,
        limitations,
      },
      event: {
        kind: "notice",
        stage: "completed",
        message: summary,
        data: { slots: slots.length, examined, source },
      },
    });
    if (!finished) throw new Error("work_finished_elsewhere");
    await publishReviewReport(db, {
      job,
      agent,
      subject: "Calendar availability",
      findings,
      metrics,
      limitations,
      checksRun: 2,
    });
  });
}
