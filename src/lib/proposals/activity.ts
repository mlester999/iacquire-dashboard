// The history of a proposal in plain sentences. Pure. Every sentence says only what the record shows: a page request is "the link was requested", never "the customer read it";
// an answer recorded by a person is "recorded by", never "signed"; and nothing here ever prints a link, a code or a session.
import { DECISION_METHOD_LABELS } from "@/lib/proposals/ack";

export interface ActivityInput {
  kind: string;
  actorKind: "user" | "ai" | "system" | "recipient" | "provider";
  actorName: string | null;
  version: number | null;
  detail: Record<string, unknown>;
}

export type ActivityTone = "neutral" | "good" | "warning" | "bad";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const flag = (v: unknown): boolean => v === true;

function who(e: ActivityInput): string {
  switch (e.actorKind) {
    case "user": return e.actorName ?? "A teammate";
    case "ai": return "The AI";
    case "recipient": return "The customer";
    case "provider": return "The signing service";
    default: return "iAcquire";
  }
}

const EFFECTS: Record<string, string> = {
  tag_on_send: "adding the tag when sent",
  stage_on_send: "moving the deal when sent",
  deal_won: "moving the deal to Won on acceptance",
  task: "creating the follow-up task",
  timeline: "recording the activity on the contact",
  notify: "sending the notifications",
  event: "starting workflows",
};
const effectName = (v: unknown): string => EFFECTS[str(v)] ?? "a follow-up step";

/** One history entry as a sentence and a tone. An unknown kind still gets an honest, neutral sentence. */
export function describeEvent(e: ActivityInput): { text: string; tone: ActivityTone } {
  const v = e.version !== null ? ` (version ${e.version})` : "";
  switch (e.kind) {
    case "created": return { text: e.detail.duplicatedFrom ? `${who(e)} started this as a copy of another proposal.` : `${who(e)} started this proposal.`, tone: "neutral" };
    case "ai_drafted": return { text: "The AI wrote a first draft. It is a draft only: a person has to read, edit and approve it before it can go anywhere.", tone: "neutral" };
    case "duplicated": return { text: `${who(e)} copied ${str(e.detail.number) || "another proposal"}.`, tone: "neutral" };
    case "edited": return { text: flag(e.detail.approvalVoided) ? `${who(e)} changed the proposal${v}. The earlier approval no longer applies.` : flag(e.detail.content) ? `${who(e)} changed the proposal${v}.` : `${who(e)} updated the notes or links.`, tone: flag(e.detail.approvalVoided) ? "warning" : "neutral" };
    case "submitted": return { text: `${who(e)} sent the proposal${v} for approval.`, tone: "neutral" };
    case "approved": return { text: `${who(e)} approved${v}.`, tone: "good" };
    case "self_approved": return { text: `${who(e)} approved it by sending it${v}, because nothing here needed a second look.`, tone: "neutral" };
    case "changes_requested": return e.actorKind === "recipient"
      ? { text: "The customer asked for changes.", tone: "warning" }
      : { text: `${who(e)} asked for changes${v}.`, tone: "warning" };
    case "rejected": return { text: `${who(e)} rejected the proposal${v}.`, tone: "bad" };
    case "sent": return { text: `${who(e)} marked${v} as sent and made the customer's link.`, tone: "good" };
    case "link_created": return { text: `${who(e)} made a link for the customer.`, tone: "neutral" };
    case "pdf_failed": return { text: "The PDF copy could not be saved. The customer can still download one made from the same version.", tone: "warning" };
    case "link_opened": return { text: "The link was requested. That can be an email scanner or a link preview, so it does not show that a person looked at the proposal.", tone: "neutral" };
    case "viewed": return { text: "The page stayed open in a browser and was used. That does not show who, or that it was read.", tone: "neutral" };
    case "code_requested": return { text: `A code was emailed to ${str(e.detail.emailMasked) || "the customer's address"}.`, tone: "neutral" };
    case "verified": return { text: `Someone entered the emailed code for ${str(e.detail.emailMasked) || "the customer's address"}. That shows control of that mailbox, not who they are.`, tone: "neutral" };
    case "accepted":
      return str(e.detail.method) === "recorded_by_staff"
        ? { text: `${who(e)} recorded that the customer accepted${v}. ${DECISION_METHOD_LABELS.recorded_by_staff}.`, tone: "good" }
        : e.actorKind === "recipient"
          ? { text: `The customer accepted${v} with a verified email address${str(e.detail.emailMasked) ? ` (${str(e.detail.emailMasked)})` : ""}. This is not an electronic signature.`, tone: "good" }
          : { text: `${who(e)} recorded an acceptance${v}.`, tone: "good" };
    case "declined":
      return str(e.detail.method) === "recorded_by_staff"
        ? { text: `${who(e)} recorded that the customer declined${v}. ${DECISION_METHOD_LABELS.recorded_by_staff}.`, tone: "bad" }
        : { text: `The customer declined${v}.`, tone: "bad" };
    case "delivered_offline": return { text: `${who(e)} noted that the approved proposal was given to the customer outside the product${v}.`, tone: "neutral" };
    case "withdrawn": return str(e.detail.reason) === "privacy_request"
      ? { text: "The proposal was withdrawn because the customer asked for their data to be erased.", tone: "warning" }
      : { text: `${who(e)} withdrew the proposal${v}. The customer's link no longer works.`, tone: "warning" };
    case "expired": return { text: "The valid-until date passed before the customer answered, so the proposal expired and the link was closed.", tone: "warning" };
    case "revised": return { text: `${who(e)} started a new version${v} from a proposal that was ${str(e.detail.was) || "sent"}. The old link was closed.`, tone: "neutral" };
    case "integrity_failed": return { text: "A saved version did not match its record, so the customer was not shown it. Contact support before sending it again.", tone: "bad" };
    case "effect_failed": return { text: `A follow-up step failed: ${effectName(e.detail.effect)}. The proposal itself was not affected.${str(e.detail.message) ? ` ${str(e.detail.message)}` : ""}`, tone: "warning" };
    case "effect_skipped": return { text: `A follow-up step was skipped: ${effectName(e.detail.effect)}.${str(e.detail.reason) ? ` ${str(e.detail.reason)}` : ""}`, tone: "neutral" };
    default: return { text: `${who(e)}: ${e.kind.replace(/_/g, " ")}${v}.`, tone: "neutral" };
  }
}
