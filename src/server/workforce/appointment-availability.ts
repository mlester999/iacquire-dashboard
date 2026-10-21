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
import { reviewFinding, type ReviewFinding, type ReviewMetric } from "@/server/workforce/read-only-review";
import { roleMayUseCapability } from "@/lib/workforce-capabilities";
import type { AgentRoleKey } from "@/lib/agents";

/**
 * Read real calendar availability through the existing native booking service.
 *
 * The capability never holds a slot, creates a booking, contacts a host or writes an external
 * calendar. It reports the same slots the booking flow would offer, with the reason when it cannot.
 */
export async function runAppointmentAvailabilityJob(job: WorkJobRow, _context: { workerId: string; controller: AbortController }): Promise<void> {
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
        status: "blocked",
        stage: "blocked",
        failureCode: "capability_not_allowed",
        failureMessage: "This employee's role is not allowed to check calendar availability.",
      });
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "error",
        stage: "blocked",
        message: "This employee's role is not allowed to check calendar availability, so nothing was read.",
      });
    });
    return;
  }

  const now = new Date();
  const to = new Date(now.getTime() + 7 * 86_400_000);
  const availability = await nativeAvailability(job.org_id, { from: now, to, limit: 50 });

  await withSystem(async (db) => {
    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
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
    } else if (availability.slots.length === 0) {
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
      value: availability.ok ? availability.slots.length : 0,
      period: "Next 7 days",
      definition: "Distinct start times the active calendar and its hosts can accept, computed from saved working hours, buffers, notice and live bookings.",
      source: "crm_calendars, crm_availability_rules, crm_busy_blocks",
    }];

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "analyzing",
      message: "Preparing the availability result and any scheduling risk…",
      progress: { checksRun: 2, findings: findings.length, slots: availability.ok ? availability.slots.length : 0 },
    });

    for (const finding of findings) {
      await appendWorkEvent(db, {
        jobId: job.id,
        orgId: job.org_id,
        kind: "evidence",
        stage: "analyzing",
        message: finding.title,
        data: { key: finding.key, href: finding.evidenceHref },
      });
    }

    const summary = availability.ok
      ? `Calendar availability checked: ${availability.slots.length} bookable slot${availability.slots.length === 1 ? "" : "s"} in the next 7 days${availability.timeZone ? ` (${availability.timeZone})` : ""}.`
      : `Calendar availability could not be checked: ${availability.detail}`;

    await recordWorkStage(db, {
      jobId: job.id,
      orgId: job.org_id,
      stage: "preparing_results",
      message: "Availability check complete.",
    });
    const finished = await finishWorkJob(db, {
      jobId: job.id,
      orgId: job.org_id,
      status: "completed",
      stage: "completed",
      resultCount: availability.ok ? availability.slots.length : 0,
      resultSummary: summary,
      result: {
        availability: availability.ok
          ? {
              slots: availability.slots.map((slot) => ({ start: slot.start, end: slot.end })),
              timeZone: availability.timeZone,
              checkedAt: availability.checkedAt,
              slotMinutes: availability.slotMinutes,
              calendarId: availability.calendarId,
            }
          : { reason: availability.detail, reasonCode: availability.reason },
        metrics,
        findings,
        limitations: "Only bookable start times stored in this workspace were read. No slot was held, no booking was created and no external calendar was contacted.",
      },
    });
    if (!finished) throw new Error("work_finished_elsewhere");
    await appendWorkEvent(db, {
      jobId: job.id,
      orgId: job.org_id,
      kind: "notice",
      stage: "completed",
      message: summary,
      data: { slots: availability.ok ? availability.slots.length : 0 },
    });
    await publishReviewReport(db, {
      job,
      agent,
      subject: "Calendar availability",
      findings,
      metrics,
      limitations: "Only bookable start times stored in this workspace were read. No slot was held, no booking was created and no external calendar was contacted.",
      checksRun: 2,
    });
  });
}
