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
});
