import type { CapabilityDefinition } from "@/lib/workforce-capabilities";
import { EVIDENCE_STATES, type EvidenceState } from "@/lib/employee-evidence";

/**
 * What kind of thing a line of the conversation, a job or an approval is. A person reading "I've set that up" cannot tell whether a language model wrote it, code read it from
 * their records, someone only prepared it, a person approved and iAcquire applied it, or something outside iAcquire confirmed it. These six words are the only ones used, and
 * each is stored with the message (chat_messages.evidence) so the answer never depends on guessing from wording:
 *
 *  - model_response   a language model wrote it. It may have been handed a verified read (`records`), but the reply itself checked and changed nothing.
 *  - record_retrieval code read records for the requester under their permissions and composed the result. No model wrote it.
 *  - proposed_change  something prepared and NOT applied: a preview, a draft, an approval request nobody has decided, a request that was rejected or has expired.
 *  - approved_write   a person approved or explicitly confirmed it and iAcquire applied it to its own data (a schedule saved paused, a draft queued). It is not proof that the
 *                     outside world changed.
 *  - completed_action an effect confirmed by a ledger outside the conversation (a calendar booking made, a message sent or delivered).
 *  - system_notice    wording the server wrote that did nothing: a refusal, a clarification, a redirect, "no preview to confirm". Never labelled as the model or as retrieval.
 *
 * Pure: no server code, so the chat bubble, the work board and the Approval Center can all import it (tests/client-bundle-safety.test.ts).
 */
export const EVIDENCE_CLASSES = ["model_response", "record_retrieval", "proposed_change", "approved_write", "completed_action", "system_notice"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** Classes a server-composed reply may carry. A reply the server wrote is never a model response. */
export type ServerEvidenceClass = Exclude<EvidenceClass, "model_response">;

/** The ledger row that proves the action and retrieval classes. */
export const EVIDENCE_LEDGER_KINDS = ["work_job", "work_report", "approval", "appointment_booking", "conversation_message", "schedule", "task"] as const;
export type EvidenceLedgerKind = (typeof EVIDENCE_LEDGER_KINDS)[number];

export type EvidenceClaims = "none_found" | "unbacked_action_claim";

export interface EvidenceMarker {
  v: 1;
  class: EvidenceClass;
  /** model_response only: the verified areas the model was handed (section id and state) and when they were read. Absent means nothing was read. */
  records?: { readAt: string; areas: Array<{ id: string; state: EvidenceState }> };
  /** Never on a model_response: the row that proves the action or the retrieval. */
  ledger?: { kind: EvidenceLedgerKind; id: string };
  /** model_response only: the result of the check for claims that an action was done (set by the claim check, never by the model). */
  claims?: EvidenceClaims;
}

/** The most areas a marker lists. With the longest area id this keeps the stored jsonb well inside the column's 2 KB limit. */
export const EVIDENCE_MAX_AREAS = 16;

const AREA_ID = /^[a-z][a-z0-9_]{0,39}$/;
const LEDGER_ID = /^[0-9A-Za-z_-]{1,64}$/;
const READ_STATES: ReadonlySet<EvidenceState> = new Set<EvidenceState>(["ready", "empty", "not_configured"]);
const KEYS = new Set(["v", "class", "records", "ledger", "claims"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const validInstant = (value: unknown): value is string => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));

/** The marker for a reply the server wrote that did nothing. The default for any reply whose caller did not say more. */
export function systemNoticeMarker(): ServerEvidenceMarker {
  return { v: 1, class: "system_notice" };
}

/** A marker that is statically not a model response: the only kind a server-composed reply may carry. */
export type ServerEvidenceMarker = EvidenceMarker & { class: ServerEvidenceClass };

/** A marker for a server-composed reply, optionally naming the ledger row that proves it. */
export function serverMarker(cls: ServerEvidenceClass, ledger?: { kind: EvidenceLedgerKind; id: string }): ServerEvidenceMarker {
  return ledger ? { v: 1, class: cls, ledger: { kind: ledger.kind, id: ledger.id } } : { v: 1, class: cls };
}

/**
 * The marker for a reply a language model wrote. `records` lists only the areas that were really read for this turn (set up and holding records, set up and empty, or checked and
 * found not set up); an area that could not be read, was not permitted or was switched off was not read and is left out. When nothing was read the marker has no `records`.
 */
export function classifyModelTurn(sections: ReadonlyArray<{ id: string; state: EvidenceState }>, readAt: string): EvidenceMarker {
  const seen = new Set<string>();
  const areas: Array<{ id: string; state: EvidenceState }> = [];
  for (const section of sections) {
    if (areas.length >= EVIDENCE_MAX_AREAS) break;
    if (!READ_STATES.has(section.state) || !AREA_ID.test(section.id) || seen.has(section.id)) continue;
    seen.add(section.id);
    areas.push({ id: section.id, state: section.state });
  }
  if (!areas.length || !validInstant(readAt)) return { v: 1, class: "model_response" };
  return { v: 1, class: "model_response", records: { readAt, areas } };
}

/** What a reviewed capability produces, by its risk: a read-only one retrieves records, anything that needs a human decision only proposes. */
export function classifyCapability(risk: CapabilityDefinition["risk"]): EvidenceClass {
  return risk === "read_only" ? "record_retrieval" : "proposed_change";
}

/** Mirrors approval_requests.kind (supabase/migrations/0108) and `ApprovalKind` in src/server/approvals/service.ts; tests/evidence-class.test.ts fails if either drifts. */
export const APPROVAL_KINDS = [
  "lead_import", "outreach", "follow_up_message", "crm_update", "campaign_activation", "knowledge_change", "tool_action", "config_change",
  "appointment_booking", "appointment_change", "standing_authorization", "workflow_activation", "workflow_action",
] as const;
export type ApprovalKindName = (typeof APPROVAL_KINDS)[number];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "changes_requested", "expired", "cancelled"] as const;
export type ApprovalStatusName = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_EXECUTION_STATUSES = ["not_started", "queued", "running", "succeeded", "failed", "blocked"] as const;
export type ApprovalExecutionName = (typeof APPROVAL_EXECUTION_STATUSES)[number];

/** Message states (conversation_messages.status) that prove a customer message really left iAcquire. */
const SENT_MESSAGE_STATES: ReadonlySet<string> = new Set(["sent", "delivered", "read"]);

/**
 * The class of an approval, from its own row. Nothing is ever `completed_action` because a person said yes: a queued draft is only `approved_write` until the message itself is
 * sent or delivered (`downstream`, the message's current status), and an approval nobody decided, or one that was refused, expired, blocked or failed, is still a proposal.
 * Only a booking or an appointment change, whose executor writes to the calendar before it reports success, is `completed_action` when it succeeded, and a booking whose appointment
 * still waits for the host to confirm it (`appointmentStatus` "new") is an approved write until they do.
 */
export function classifyApproval(row: {
  kind: ApprovalKindName;
  status: ApprovalStatusName;
  execution_status: ApprovalExecutionName;
  /** follow_up_message only: the current status of the drafted message, when it is known. */
  downstream?: string | null;
  /** appointment_booking only: the booked appointment's own state, when it is known. `new` means a person still has to confirm it. */
  appointmentStatus?: "new" | "confirmed" | null;
}): { class: EvidenceClass; completed: boolean } {
  const proposal = { class: "proposed_change" as const, completed: false };
  if (row.status !== "approved" || row.execution_status !== "succeeded") return proposal;
  switch (row.kind) {
    case "appointment_booking":
      // On the calendar, but the appointment type says a person confirms each booking and nobody has yet.
      if (row.appointmentStatus === "new") return { class: "approved_write", completed: false };
      return { class: "completed_action", completed: true };
    case "appointment_change":
      return { class: "completed_action", completed: true };
    case "follow_up_message":
      if (row.downstream && SENT_MESSAGE_STATES.has(row.downstream)) return { class: "completed_action", completed: true };
      // Blocked or failed after it was queued: it was approved but did not go out.
      if (row.downstream === "blocked" || row.downstream === "failed") return proposal;
      return { class: "approved_write", completed: false };
    default:
      return { class: "approved_write", completed: false };
  }
}

/**
 * The class of a chat-confirmed booking by what the calendar service returned. A booking that landed is a completed action only once nobody still has to say yes: when the appointment
 * type needs a person's confirmation the appointment is on the calendar (`approved_write`: iAcquire saved it) but not confirmed (`appointmentStatus` "new"), and it is `completed_action`
 * once the appointment is confirmed. A request waiting on a person is still a proposal.
 */
export function classifyBookingResult(status: "booked" | "awaiting_approval" | "needs_manual" | "unavailable" | "failed", appointmentStatus?: "new" | "confirmed"): ServerEvidenceClass {
  if (status === "booked") return appointmentStatus === "new" ? "approved_write" : "completed_action";
  if (status === "awaiting_approval" || status === "needs_manual") return "proposed_change";
  return "system_notice";
}

/**
 * Reads a stored or transmitted marker strictly. Anything that is not exactly the documented shape (a wrong version, an unknown class or key, a model-only field on a server
 * reply, an unreadable time) is null, and a null marker renders no chip: a legacy row and a damaged one look the same, and the interface never guesses.
 */
export function parseEvidenceMarker(value: unknown): EvidenceMarker | null {
  if (!isRecord(value) || value.v !== 1) return null;
  if (Object.keys(value).some((key) => !KEYS.has(key))) return null;
  const cls = value.class;
  if (typeof cls !== "string" || !(EVIDENCE_CLASSES as readonly string[]).includes(cls)) return null;
  const marker: EvidenceMarker = { v: 1, class: cls as EvidenceClass };
  const model = cls === "model_response";

  if (value.records !== undefined) {
    const records = value.records;
    if (!model || !isRecord(records) || !validInstant(records.readAt) || !Array.isArray(records.areas)) return null;
    if (Object.keys(records).some((key) => key !== "readAt" && key !== "areas")) return null;
    if (!records.areas.length || records.areas.length > EVIDENCE_MAX_AREAS) return null;
    const areas: Array<{ id: string; state: EvidenceState }> = [];
    for (const area of records.areas) {
      if (!isRecord(area) || typeof area.id !== "string" || !AREA_ID.test(area.id) || typeof area.state !== "string") return null;
      if (Object.keys(area).some((key) => key !== "id" && key !== "state")) return null;
      if (!(EVIDENCE_STATES as readonly string[]).includes(area.state)) return null;
      areas.push({ id: area.id as string, state: area.state as EvidenceState });
    }
    marker.records = { readAt: records.readAt as string, areas };
  }
  if (value.ledger !== undefined) {
    const ledger = value.ledger;
    if (model || !isRecord(ledger) || typeof ledger.kind !== "string" || typeof ledger.id !== "string") return null;
    if (Object.keys(ledger).some((key) => key !== "kind" && key !== "id")) return null;
    if (!(EVIDENCE_LEDGER_KINDS as readonly string[]).includes(ledger.kind) || !LEDGER_ID.test(ledger.id)) return null;
    marker.ledger = { kind: ledger.kind as EvidenceLedgerKind, id: ledger.id as string };
  }
  if (value.claims !== undefined) {
    if (!model || (value.claims !== "none_found" && value.claims !== "unbacked_action_claim")) return null;
    marker.claims = value.claims as EvidenceClaims;
  }
  return marker;
}

export type EvidenceTone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet";

export interface EvidenceChipView {
  label: string;
  tone: EvidenceTone;
  /** One plain sentence saying what the label does and does not prove. Never uses "done" or "completed" unless the class is completed_action. */
  hint: string;
}

const CHIP: Record<EvidenceClass, { label: string; tone: EvidenceTone; hint: string }> = {
  model_response: { label: "Written by AI", tone: "neutral", hint: "A language model wrote this reply. The reply itself checked and changed nothing." },
  record_retrieval: { label: "Read from your records", tone: "primary", hint: "iAcquire read these records for you under your permissions. Nothing was changed." },
  proposed_change: { label: "Proposed, not applied", tone: "warning", hint: "This is a preview, a draft or a request. Nothing has been applied yet." },
  approved_write: { label: "Approved and applied", tone: "violet", hint: "A person approved this and iAcquire saved it in its own records. It does not prove that anything outside iAcquire changed." },
  completed_action: { label: "Done, confirmed", tone: "success", hint: "A record outside this conversation confirms the effect." },
  system_notice: { label: "System notice", tone: "neutral", hint: "Written by iAcquire itself, not by the AI model." },
};

const defaultTime = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC`;
const words = (value: string) => value.replace(/_/g, " ");

/**
 * The words for a marker's chip. `formatTime` renders the read time in the viewer's zone (the chat passes its own); the default is UTC so the pure function is deterministic.
 * A model reply that was handed verified records says when they were read and which areas, because "Written by AI" alone would hide that it was grounded.
 */
export function evidenceChip(marker: Pick<EvidenceMarker, "class" | "records" | "claims">, options?: { formatTime?: (iso: string) => string }): EvidenceChipView {
  const base = CHIP[marker.class];
  if (marker.class !== "model_response") return { ...base };
  const flagged = marker.claims === "unbacked_action_claim";
  const tone: EvidenceTone = flagged ? "warning" : base.tone;
  const caution = flagged ? " It described an action that iAcquire has no record of, so treat that wording as unconfirmed." : "";
  if (!marker.records) {
    return { label: flagged ? "Written by AI, action unconfirmed" : base.label, tone, hint: `A language model wrote this reply. No verified records were read for it.${caution}` };
  }
  const time = (options?.formatTime ?? defaultTime)(marker.records.readAt);
  const areas = marker.records.areas.map((area) => `${words(area.id)} (${words(area.state)})`).join(", ");
  return {
    label: `${flagged ? "Written by AI, action unconfirmed" : base.label}, using records read at ${time}`,
    tone,
    hint: `A language model wrote this reply from records iAcquire read at ${time}: ${areas}. The reply itself changed nothing.${caution}`,
  };
}
