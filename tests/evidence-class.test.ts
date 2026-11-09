// The response classes, as pure functions: every approval kind and every capability is classified, a queued draft is never "done", a damaged marker shows no chip, and the
// word "Done" belongs to completed_action alone. The kind lists are checked against the migration and the service they mirror, so adding a kind without classifying it fails here.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_EXECUTION_STATUSES,
  APPROVAL_KINDS,
  APPROVAL_STATUSES,
  EVIDENCE_CLASSES,
  EVIDENCE_LEDGER_KINDS,
  EVIDENCE_MAX_AREAS,
  classifyApproval,
  classifyBookingResult,
  classifyCapability,
  classifyModelTurn,
  evidenceChip,
  parseEvidenceMarker,
  serverMarker,
  systemNoticeMarker,
  type EvidenceMarker,
} from "@/lib/evidence-class";
import { EVIDENCE_STATES, type EvidenceState } from "@/lib/employee-evidence";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";
import { describeAction } from "@/lib/activity";
import { countDraftStatuses, draftLiveStatus, workJobEvidence, workJobStatusLabel, type WorkJobStatus } from "@/server/workforce/jobs";

const READ_AT = "2026-10-26T06:00:00.000Z";
const quotedList = (text: string) => [...text.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]);

describe("the response classes", () => {
  it("are exactly the six, in one fixed vocabulary", () => {
    expect([...EVIDENCE_CLASSES]).toEqual(["model_response", "record_retrieval", "proposed_change", "approved_write", "completed_action", "system_notice"]);
  });
});

describe("every approval kind is classified", () => {
  it("lists the same kinds as the database check, the service type and the status checks it mirrors", () => {
    const check = readFileSync("supabase/migrations/0108_workforce_appointment_changes.sql", "utf8").match(/approval_requests_kind_check check \(kind in \(([\s\S]*?)\)\);/);
    expect(check, "the kind check in 0108").not.toBeNull();
    expect([...APPROVAL_KINDS].sort()).toEqual(quotedList(check![1]).sort());

    const service = readFileSync("src/server/approvals/service.ts", "utf8").match(/export type ApprovalKind =([\s\S]*?);/);
    expect([...APPROVAL_KINDS].sort()).toEqual(quotedList(service![1]).sort());

    const base = readFileSync("supabase/migrations/0003_business.sql", "utf8");
    expect([...APPROVAL_STATUSES]).toEqual(quotedList(base.match(/check \(status in \(([^)]*)\)\)/)![1]));
    expect([...APPROVAL_EXECUTION_STATUSES]).toEqual(quotedList(base.match(/check \(execution_status in \(([^)]*)\)\)/)![1]));
  });

  it("gives every kind, status and execution state a class, and completes only what a ledger outside the conversation confirms", () => {
    for (const kind of APPROVAL_KINDS) {
      for (const status of APPROVAL_STATUSES) {
        for (const execution of APPROVAL_EXECUTION_STATUSES) {
          const result = classifyApproval({ kind, status, execution_status: execution });
          expect(EVIDENCE_CLASSES, `${kind}/${status}/${execution}`).toContain(result.class);
          expect(result.completed).toBe(result.class === "completed_action");
          // Only an approved request that ran and succeeded is ever more than a proposal.
          if (status !== "approved" || execution !== "succeeded") expect(result.class, `${kind}/${status}/${execution}`).toBe("proposed_change");
          // Only a calendar write is complete on the approval's own say-so.
          if (result.completed) expect(["appointment_booking", "appointment_change"], `${kind}`).toContain(kind);
        }
      }
    }
  });

  it.each(["appointment_booking", "appointment_change"] as const)("calls a succeeded %s completed, because its executor writes the calendar first", (kind) => {
    expect(classifyApproval({ kind, status: "approved", execution_status: "succeeded" })).toEqual({ class: "completed_action", completed: true });
    expect(classifyApproval({ kind, status: "approved", execution_status: "queued" })).toEqual({ class: "proposed_change", completed: false });
    expect(classifyApproval({ kind, status: "approved", execution_status: "blocked" })).toEqual({ class: "proposed_change", completed: false });
  });

  it("calls a succeeded booking an approved write, not completed, while its appointment still waits for the host to confirm it", () => {
    const booking = { kind: "appointment_booking", status: "approved", execution_status: "succeeded" } as const;
    expect(classifyApproval({ ...booking, appointmentStatus: "new" })).toEqual({ class: "approved_write", completed: false });
    expect(classifyApproval({ ...booking, appointmentStatus: "confirmed" })).toEqual({ class: "completed_action", completed: true });
    expect(classifyApproval({ ...booking, appointmentStatus: null })).toEqual({ class: "completed_action", completed: true });
    // A change request is not a booking: the appointment's state does not demote it.
    expect(classifyApproval({ kind: "appointment_change", status: "approved", execution_status: "succeeded", appointmentStatus: "new" })).toEqual({ class: "completed_action", completed: true });
    // And a booking that has not succeeded is still only a proposal whatever the appointment says.
    expect(classifyApproval({ ...booking, execution_status: "blocked", appointmentStatus: "confirmed" })).toEqual({ class: "proposed_change", completed: false });
  });

  it("never calls a queued follow-up message completed, however the downstream status is missing or phrased", () => {
    const queued = { kind: "follow_up_message", status: "approved", execution_status: "succeeded" } as const;
    for (const downstream of [undefined, null, "", "draft", "queued", "sending", "received", "note", "unknown"]) {
      expect(classifyApproval({ ...queued, downstream }), String(downstream)).toEqual({ class: "approved_write", completed: false });
    }
    for (const downstream of ["sent", "delivered", "read"]) {
      expect(classifyApproval({ ...queued, downstream }), downstream).toEqual({ class: "completed_action", completed: true });
    }
    // Approved and queued, then the dispatcher stopped it: it did not go out.
    for (const downstream of ["blocked", "failed"]) {
      expect(classifyApproval({ ...queued, downstream }), downstream).toEqual({ class: "proposed_change", completed: false });
    }
  });

  it("calls the other approved writes approved_write, never completed", () => {
    for (const kind of ["knowledge_change", "config_change", "crm_update", "workflow_activation", "standing_authorization", "tool_action", "workflow_action", "campaign_activation"] as const) {
      expect(classifyApproval({ kind, status: "approved", execution_status: "succeeded" }), kind).toEqual({ class: "approved_write", completed: false });
    }
  });
});

describe("every capability is classified", () => {
  it.each(CAPABILITY_KEYS)("%s", (key) => {
    const risk = WORKFORCE_CAPABILITIES[key].risk;
    const cls = classifyCapability(risk);
    expect(cls).toBe(risk === "read_only" ? "record_retrieval" : "proposed_change");
    expect(EVIDENCE_CLASSES).toContain(cls);
  });

  it("covers every risk level the definitions can carry", () => {
    expect(classifyCapability("read_only")).toBe("record_retrieval");
    expect(classifyCapability("approval_required")).toBe("proposed_change");
    expect(classifyCapability("sensitive")).toBe("proposed_change");
  });
});

describe("a booking result", () => {
  it("is completed only when the calendar booked it", () => {
    expect(classifyBookingResult("booked")).toBe("completed_action");
    expect(classifyBookingResult("awaiting_approval")).toBe("proposed_change");
    expect(classifyBookingResult("needs_manual")).toBe("proposed_change");
    expect(classifyBookingResult("unavailable")).toBe("system_notice");
    expect(classifyBookingResult("failed")).toBe("system_notice");
  });

  it("is only an approved write while the host's confirmation is pending, and a completed action once the appointment is confirmed", () => {
    // On the calendar (iAcquire saved it) but nobody has said yes: not "done".
    expect(classifyBookingResult("booked", "new")).toBe("approved_write");
    expect(classifyBookingResult("booked", "confirmed")).toBe("completed_action");
    // The appointment state means nothing for a result that is not a landed booking.
    for (const status of ["awaiting_approval", "needs_manual"] as const) {
      expect(classifyBookingResult(status, "new")).toBe("proposed_change");
      expect(classifyBookingResult(status, "confirmed")).toBe("proposed_change");
    }
    for (const status of ["unavailable", "failed"] as const) {
      expect(classifyBookingResult(status, "new")).toBe("system_notice");
      expect(classifyBookingResult(status, "confirmed")).toBe("system_notice");
    }
  });

  it("never reads 'Done, confirmed' for a booking that waits for the host", () => {
    const waiting = evidenceChip({ class: classifyBookingResult("booked", "new") });
    expect(waiting.label).not.toBe("Done, confirmed");
    expect(waiting.label).toBe("Approved and applied");
    expect(waiting.hint).toMatch(/does not prove that anything outside iAcquire changed/);
    expect(evidenceChip({ class: classifyBookingResult("booked", "confirmed") }).label).toBe("Done, confirmed");
  });
});

describe("a model turn", () => {
  const sections = (states: Array<[string, EvidenceState]>) => states.map(([id, state]) => ({ id, state }));

  it("records the areas that were really read, and nothing else", () => {
    const marker = classifyModelTurn(sections([
      ["calendar", "ready"], ["appointments", "empty"], ["crm", "not_configured"], ["pipeline", "unavailable"], ["leads", "no_permission"], ["schedules", "switched_off"],
    ]), READ_AT);
    expect(marker).toEqual({ v: 1, class: "model_response", records: { readAt: READ_AT, areas: [
      { id: "calendar", state: "ready" }, { id: "appointments", state: "empty" }, { id: "crm", state: "not_configured" },
    ] } });
  });

  it("says nothing was read when no area could be", () => {
    const marker = classifyModelTurn(sections([["calendar", "unavailable"], ["leads", "no_permission"], ["schedules", "switched_off"]]), READ_AT);
    expect(marker).toEqual({ v: 1, class: "model_response" });
    expect(classifyModelTurn([], READ_AT)).toEqual({ v: 1, class: "model_response" });
  });

  it("drops an unreadable time, a duplicate area and an id that is not a section name, and stops at the cap", () => {
    expect(classifyModelTurn(sections([["calendar", "ready"]]), "yesterday")).toEqual({ v: 1, class: "model_response" });
    expect(classifyModelTurn(sections([["calendar", "ready"], ["calendar", "empty"], ["Bad Id!", "ready"], ["", "ready"]]), READ_AT).records?.areas).toEqual([{ id: "calendar", state: "ready" }]);
    const many = Array.from({ length: EVIDENCE_MAX_AREAS + 9 }, (_, i): [string, EvidenceState] => [`area_${i}`, "ready"]);
    expect(classifyModelTurn(sections(many), READ_AT).records?.areas).toHaveLength(EVIDENCE_MAX_AREAS);
  });

  it("always yields a marker its own parser accepts", () => {
    const marker = classifyModelTurn(sections([["calendar", "ready"], ["crm", "empty"]]), READ_AT);
    expect(parseEvidenceMarker(JSON.parse(JSON.stringify(marker)))).toEqual(marker);
  });

  it("stays well inside the column's 2 KB even at the cap with the longest area names", () => {
    const longest = Array.from({ length: EVIDENCE_MAX_AREAS }, (_, i): [string, EvidenceState] => [`a${String(i).padStart(2, "0")}_${"x".repeat(35)}`, "not_configured"]);
    const marker = classifyModelTurn(sections(longest), READ_AT);
    expect(marker.records?.areas).toHaveLength(EVIDENCE_MAX_AREAS);
    expect(JSON.stringify(marker).length).toBeLessThan(1700);
  });
});

describe("parseEvidenceMarker", () => {
  const valid: EvidenceMarker[] = [
    { v: 1, class: "model_response" },
    { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "calendar", state: "ready" }] } },
    { v: 1, class: "model_response", claims: "unbacked_action_claim" },
    { v: 1, class: "model_response", claims: "none_found", records: { readAt: READ_AT, areas: [{ id: "crm", state: "empty" }] } },
    systemNoticeMarker(),
    serverMarker("proposed_change"),
    serverMarker("approved_write", { kind: "schedule", id: "3f2b8c1e-0000-4000-8000-000000000001" }),
    serverMarker("completed_action", { kind: "appointment_booking", id: "3f2b8c1e-0000-4000-8000-000000000002" }),
    serverMarker("record_retrieval", { kind: "work_job", id: "3f2b8c1e-0000-4000-8000-000000000003" }),
    serverMarker("record_retrieval", { kind: "work_report", id: "3f2b8c1e-0000-4000-8000-000000000004" }),
  ];

  it.each(valid.map((marker) => [JSON.stringify(marker), marker] as const))("accepts %s unchanged", (_label, marker) => {
    expect(parseEvidenceMarker(marker)).toEqual(marker);
  });

  it("accepts every class and every ledger kind", () => {
    for (const cls of EVIDENCE_CLASSES) expect(parseEvidenceMarker({ v: 1, class: cls })?.class).toBe(cls);
    for (const kind of EVIDENCE_LEDGER_KINDS) expect(parseEvidenceMarker({ v: 1, class: "approved_write", ledger: { kind, id: "abc-123" } })?.ledger).toEqual({ kind, id: "abc-123" });
    for (const state of EVIDENCE_STATES) expect(parseEvidenceMarker({ v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state }] } })).not.toBeNull();
  });

  const area = { id: "calendar", state: "ready" };
  const records = { readAt: READ_AT, areas: [area] };
  const ledger = { kind: "schedule", id: "abc" };
  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["a string", "model_response"],
    ["a number", 1],
    ["an array", [{ v: 1, class: "model_response" }]],
    ["an empty object", {}],
    ["a wrong version", { v: 2, class: "model_response" }],
    ["a missing version", { class: "model_response" }],
    ["a stringly version", { v: "1", class: "model_response" }],
    ["an unknown class", { v: 1, class: "guess" }],
    ["a missing class", { v: 1 }],
    ["a non-string class", { v: 1, class: 4 }],
    ["an unknown key", { v: 1, class: "system_notice", extra: true }],
    ["records on a server reply", { v: 1, class: "proposed_change", records }],
    ["a ledger on a model response", { v: 1, class: "model_response", ledger }],
    ["claims on a server reply", { v: 1, class: "system_notice", claims: "none_found" }],
    ["an unknown claims value", { v: 1, class: "model_response", claims: "maybe" }],
    ["records that are not an object", { v: 1, class: "model_response", records: "all" }],
    ["records without a time", { v: 1, class: "model_response", records: { areas: [area] } }],
    ["records with an unreadable time", { v: 1, class: "model_response", records: { readAt: "later", areas: [area] } }],
    ["records with no areas", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [] } }],
    ["records with too many areas", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: Array.from({ length: EVIDENCE_MAX_AREAS + 1 }, (_, i) => ({ id: `a${i}`, state: "ready" })) } }],
    ["records with an extra key", { v: 1, class: "model_response", records: { ...records, text: "the answer" } }],
    ["an area with an unknown state", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "fine" }] } }],
    ["an area id that is not a section name", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "CRM contacts", state: "ready" }] } }],
    ["an area with an extra key", { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ ...area, count: 3 }] } }],
    ["a ledger with an unknown kind", { v: 1, class: "approved_write", ledger: { kind: "guess", id: "abc" } }],
    ["a ledger with a bad id", { v: 1, class: "approved_write", ledger: { kind: "schedule", id: "has spaces" } }],
    ["a ledger with an extra key", { v: 1, class: "approved_write", ledger: { ...ledger, note: "x" } }],
  ])("rejects %s", (_label, value) => {
    expect(parseEvidenceMarker(value)).toBeNull();
  });

  it("returns a fresh object, so a caller cannot change what the parser was given", () => {
    const given = { v: 1, class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } };
    const parsed = parseEvidenceMarker(given)!;
    parsed.records!.areas.push({ id: "extra", state: "ready" });
    expect(given.records.areas).toHaveLength(1);
  });
});

describe("the chip", () => {
  const FIXED_LABELS: Record<string, string> = {
    record_retrieval: "Read from your records",
    proposed_change: "Proposed, not applied",
    approved_write: "Approved and applied",
    completed_action: "Done, confirmed",
    system_notice: "System notice",
  };

  it("has the agreed words for each class", () => {
    expect(evidenceChip({ class: "model_response" }).label).toBe("Written by AI");
    for (const [cls, label] of Object.entries(FIXED_LABELS)) {
      expect(evidenceChip({ class: cls as EvidenceMarker["class"] }).label).toBe(label);
    }
  });

  it("uses Done or Completed only for a confirmed action, in the label and in the explanation", () => {
    const word = /\b(done|completed?)\b/i;
    for (const cls of EVIDENCE_CLASSES) {
      for (const marker of [
        { class: cls },
        { class: cls, records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" as const }] } },
        { class: cls, claims: "unbacked_action_claim" as const },
      ]) {
        const chip = evidenceChip(marker);
        const text = `${chip.label} ${chip.hint}`;
        if (cls === "completed_action") expect(text).toMatch(word);
        else expect(text, `${cls}: ${text}`).not.toMatch(word);
      }
    }
  });

  it("gives every class a tone and an explanation", () => {
    for (const cls of EVIDENCE_CLASSES) {
      const chip = evidenceChip({ class: cls });
      expect(chip.tone).toMatch(/^(neutral|primary|success|warning|danger|violet)$/);
      expect(chip.hint.length).toBeGreaterThan(20);
    }
    expect(evidenceChip({ class: "completed_action" }).tone).toBe("success");
    expect(evidenceChip({ class: "proposed_change" }).tone).toBe("warning");
  });

  it("says when the records a model was handed were read, and which, and that it was not grounded when none were", () => {
    const grounded = evidenceChip({ class: "model_response", records: { readAt: READ_AT, areas: [{ id: "booking_requests", state: "ready" }, { id: "crm", state: "empty" }] } });
    expect(grounded.label).toBe("Written by AI, using records read at 06:00 UTC");
    expect(grounded.hint).toContain("booking requests (ready)");
    expect(grounded.hint).toContain("crm (empty)");
    const formatted = evidenceChip({ class: "model_response", records: { readAt: READ_AT, areas: [{ id: "crm", state: "ready" }] } }, { formatTime: () => "2:00 PM" });
    expect(formatted.label).toBe("Written by AI, using records read at 2:00 PM");
    const bare = evidenceChip({ class: "model_response" });
    expect(bare.label).toBe("Written by AI");
    expect(bare.hint).toContain("No verified records were read");
  });

  it("warns on a model reply that described an action iAcquire has no record of", () => {
    const chip = evidenceChip({ class: "model_response", claims: "unbacked_action_claim" });
    expect(chip.tone).toBe("warning");
    expect(chip.label).toContain("unconfirmed");
    expect(evidenceChip({ class: "model_response", claims: "none_found" })).toEqual(evidenceChip({ class: "model_response" }));
  });

  it("does not change the table when a caller edits the result", () => {
    const first = evidenceChip({ class: "system_notice" });
    first.label = "tampered";
    expect(evidenceChip({ class: "system_notice" }).label).toBe("System notice");
  });
});

describe("the module is pure", () => {
  it("imports no server code, no node module and nothing from a component", () => {
    const source = readFileSync("src/lib/evidence-class.ts", "utf8");
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(["@/lib/employee-evidence", "@/lib/workforce-capabilities"]);
    expect(source).not.toMatch(/server-only|node:|@\/server|@\/components/);
  });

  it("keeps the action-claim check pure too: no import at all, so any bundle can use it", () => {
    const source = readFileSync("src/lib/action-claims.ts", "utf8");
    expect(source).not.toMatch(/(?:^|\n)\s*import\s/);
    expect(source).not.toMatch(/server-only|node:|@\/server|@\/components/);
  });
});

describe("what a job's result is, computed on read", () => {
  const job = (capability: string, status: WorkJobStatus) => ({ id: "11111111-1111-4111-8111-111111111111", capability, status });
  // `blocked` could not go out (or cannot be found); `discarded` was a person's decision and is counted in neither.
  const drafts = (waiting: number, queued: number, sent: number, blocked = 0, discarded = 0) => ({ total: waiting + queued + sent + blocked + discarded, waiting, queued, sent, blocked });

  it("classifies every capability: a read-only one retrieves, anything that needs a decision only proposes", () => {
    for (const key of CAPABILITY_KEYS) {
      const marker = workJobEvidence(job(key, "completed"));
      expect(marker, key).toMatchObject({ v: 1, ledger: { kind: "work_job" } });
      expect(marker?.class, key).toBe(classifyCapability(WORKFORCE_CAPABILITIES[key].risk));
      expect(parseEvidenceMarker(marker), key).not.toBeNull();
    }
  });

  it("gives work that has not finished no class, except a request waiting for a decision, which is a proposal", () => {
    for (const status of ["queued", "running", "blocked", "failed", "cancelled"] as const) expect(workJobEvidence(job("pipeline_review", status)), status).toBeNull();
    expect(workJobEvidence(job("pipeline_review", "waiting_for_approval"))?.class).toBe("proposed_change");
    expect(workJobEvidence(job("not_a_capability", "completed"))).toBeNull();
  });

  it.each<[string, ReturnType<typeof drafts> | null, string]>([
    ["no live information", null, "proposed_change"],
    ["a draft still waiting", drafts(1, 0, 0), "proposed_change"],
    ["one approved and one waiting", drafts(1, 1, 0), "proposed_change"],
    ["every draft blocked or discarded", drafts(0, 0, 0, 1, 1), "proposed_change"],
    ["approved and only queued", drafts(0, 2, 0), "approved_write"],
    ["some sent and some queued", drafts(0, 1, 1), "approved_write"],
    ["every approved draft sent", drafts(0, 0, 2), "completed_action"],
    ["sent, with the others discarded by a person", drafts(0, 0, 1, 0, 1), "completed_action"],
    ["sent, with another blocked after approval", drafts(0, 0, 1, 1), "approved_write"],
    ["sent, with another that cannot be found", drafts(0, 0, 3, 2), "approved_write"],
  ])("a follow-up draft job with %s is %s", (_label, counts, cls) => {
    expect(workJobEvidence(job("pipeline_followup_drafts", "completed"), counts)?.class).toBe(cls);
  });

  it("counts drafts by where each stands: unknown and blocked are 'blocked', a discarded draft is none of them", () => {
    expect(countDraftStatuses(["waiting", "approved_queued", "sent", "sent", "blocked", "unknown", "discarded"])).toEqual({ total: 7, waiting: 1, queued: 1, sent: 2, blocked: 2 });
    expect(countDraftStatuses([])).toEqual({ total: 0, waiting: 0, queued: 0, sent: 0, blocked: 0 });
  });

  it("keeps 'Completed' for work whose effect is confirmed or that only read, and never for a proposal", () => {
    const label = (cls: string | null, status: WorkJobStatus = "completed", recoveryPending = false) =>
      workJobStatusLabel({ status, recoveryPending }, cls ? ({ v: 1, class: cls } as EvidenceMarker) : null);
    expect(label("record_retrieval")).toBe("Completed");
    expect(label("completed_action")).toBe("Completed");
    expect(label("proposed_change")).toBe("Ready for review");
    expect(label("approved_write")).toBe("Approved, not yet sent");
    const partly = workJobStatusLabel({ status: "completed", recoveryPending: false }, { v: 1, class: "approved_write" } as EvidenceMarker, drafts(0, 0, 1, 2));
    expect(partly).toBe("Some drafts not sent");
    expect(workJobStatusLabel({ status: "completed", recoveryPending: false }, { v: 1, class: "approved_write" } as EvidenceMarker, drafts(0, 1, 1))).toBe("Approved, not yet sent");
    expect(label(null)).toBe("Completed");
    expect(label(null, "running")).toBe("Working");
    expect(label("record_retrieval", "running", true)).toBe("Recovery pending");
  });

  it("reads a drafted message's status as one of six words and never calls an unknown one anything else", () => {
    expect(draftLiveStatus("draft")).toBe("waiting");
    expect(draftLiveStatus("queued")).toBe("approved_queued");
    expect(draftLiveStatus("sending")).toBe("approved_queued");
    for (const status of ["sent", "delivered", "read"]) expect(draftLiveStatus(status), status).toBe("sent");
    expect(draftLiveStatus("blocked", "discarded")).toBe("discarded");
    expect(draftLiveStatus("blocked", "quiet_hours")).toBe("blocked");
    expect(draftLiveStatus("failed")).toBe("blocked");
    for (const status of ["received", "note", "", null, undefined, "something_new"]) expect(draftLiveStatus(status), String(status)).toBe("unknown");
  });
});

describe("the plain-language activity labels", () => {
  it.each<[string, RegExp]>([
    ["hermes.client_business_mcp.proposal_requested", /asked for a change to be approved/],
    ["onboarding.resubmitted_unchanged", /resubmitted company setup/],
    ["crm.calendar_verification_drifted", /no longer passes its checks/],
    ["crm.calendar_verification_recovered", /passes its checks again/],
    ["crm.booking_impact_cleared", /closed the notice/],
    ["workforce.employee_evidence_attached", /tied the records/],
    ["workforce.chat_unbacked_claim", /described an action nobody recorded/],
  ])("%s has its own sentence, not the cleaned-up action name", (action, words) => {
    const text = describeAction(action);
    expect(text).toMatch(words);
    expect(text).not.toBe(action.replace(/[._]/g, " "));
    expect(text).not.toMatch(/[._]/);
  });

  it("still falls back to a cleaned label for an action it does not know", () => {
    expect(describeAction("something.brand_new")).toBe("something brand new");
  });
});
