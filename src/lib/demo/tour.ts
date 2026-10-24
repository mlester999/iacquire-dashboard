// The guided tour of the demo room: what each of the six AI Employees does, with one invented example each. This is what the demo shows whether or not the AI chat is available, so
// it is static on purpose: no database, no model, nothing about the visitor. Every example is labelled as a sample on the page, none states a price, a percentage, a time to finish
// or a result, and none uses a real business or person. The same one-line descriptions ground the chat's answers (src/server/demo/prompt.ts), so the tour and the chat cannot
// disagree about what an employee does. Pure.
import { AGENT_ROLES, AGENT_ROLE_KEYS, type AgentRoleKey, type AgentRoleMeta } from "@/lib/agents";

export interface TourLine {
  /** Who or what the line is: "Customer (sample)", "Draft for you to review". */
  label: string;
  text: string;
}

export interface TourStep {
  role: AgentRoleKey;
  meta: AgentRoleMeta;
  /** What the employee does, in one or two plain sentences. */
  does: string;
  sampleTitle: string;
  sample: TourLine[];
  /** What stays with a person in this example. */
  person: string;
}

const STEPS: Record<AgentRoleKey, { does: string; sampleTitle: string; sample: TourLine[]; person: string }> = {
  operations_manager: {
    does: "Keeps your AI team coordinated: it gathers what needs attention each day and points out what only a person should decide.",
    sampleTitle: "A morning summary",
    sample: [
      { label: "Needs a reply", text: "3 new inquiries are waiting for a first answer." },
      { label: "Follow up", text: "1 quote has gone quiet and may need a nudge." },
      { label: "Your decision", text: "2 drafts are waiting for you to approve before anything is sent." },
    ],
    person: "In this example, a person decides what gets sent and what changes.",
  },
  lead_hunter: {
    does: "Looks for businesses that fit the ideal customer you describe, and explains why each one looks like a fit.",
    sampleTitle: "A lead worth a look",
    sample: [
      { label: "Business", text: "Example Dental Clinic, an independent practice." },
      { label: "Why it fits", text: "Matches the size and location you described, and has an online booking page." },
      { label: "Status", text: "In this sample, nobody has been contacted." },
    ],
    person: "In this example, a person decides whether anyone is contacted.",
  },
  appointment_setter: {
    does: "Turns interest into booked meetings and helps when someone needs to move one.",
    sampleTitle: "A reschedule request",
    sample: [
      { label: "Customer (sample)", text: "Can we move our visit to later in the week?" },
      { label: "Appointment Setter (sample)", text: "Of course. I can offer Friday morning or Monday afternoon. Which suits you better?" },
      { label: "Status", text: "Nothing is booked in this demo." },
    ],
    person: "In this example, the business has told it which hours and meeting types to offer.",
  },
  sales_assistant: {
    does: "Prepares follow-ups, proposals and notes for discovery calls, so you spend your time talking to people.",
    sampleTitle: "A follow-up draft",
    sample: [
      { label: "Draft for you to review", text: "Hi, thanks for speaking with us today. Here is a short summary of what we covered and the suggested next step. Let me know if I missed anything." },
      { label: "Status", text: "A draft only. It is not sent in this demo." },
    ],
    person: "In this example, a person reads, edits and approves the draft before it goes anywhere.",
  },
  crm_manager: {
    does: "Keeps your customer records clean and organised, and spots records that look duplicated or incomplete.",
    sampleTitle: "A tidy-up suggestion",
    sample: [
      { label: "Possible duplicate", text: "Two contacts share the same phone number: 'J. Smith' and 'Jordan Smith'." },
      { label: "Suggestion", text: "Review them side by side and merge if they are the same person." },
      { label: "Status", text: "In this sample, nothing is merged until a person says yes." },
    ],
    person: "In this example, a person confirms the merge.",
  },
  performance_analyst: {
    does: "Explains what is working and what to improve, in plain words, from the numbers your business already has.",
    sampleTitle: "A weekly note",
    sample: [
      { label: "What stood out", text: "Most inquiries arrive by phone, and replies after hours take the longest." },
      { label: "Worth a look", text: "Review who covers evenings and weekends." },
      { label: "Status", text: "Sample figures. Nothing here is a result or a promise of one." },
    ],
    person: "In this example, a person decides what to change.",
  },
};

/** The six steps in the order of the employees everywhere else in the product. */
export const TOUR: readonly TourStep[] = AGENT_ROLE_KEYS.map((role) => {
  const meta = AGENT_ROLES.find((r) => r.key === role) as AgentRoleMeta;
  return { role, meta, ...STEPS[role] };
});

/** One line per employee for the chat's facts: "AI Lead Hunter: Looks for businesses..." */
export const employeeFacts = (): string[] => TOUR.map((s) => `${s.meta.name}: ${s.does}`);
