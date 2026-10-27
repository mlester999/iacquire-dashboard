// The six AI Employees as the showroom presents them: what each one is for, a typical day, how it works with the others, what stays with a person, and one interactive SAMPLE scenario each.
//
// Honesty rules this file keeps (tests/demo-showroom.test.ts checks the ones a machine can):
//  - every scenario is labelled as simulated on the page and uses invented businesses and people; nothing is searched, sent, booked or saved;
//  - nothing states a price, a percentage, a time saved or a result;
//  - anything that reaches a customer or changes a record waits for a person ("Waiting for your approval"), because that is how the product works;
//  - which employees are configured and switched on for a client is set by that client's implementation agreement, and the page says so.
// Pure: no database, no model, nothing about the visitor except the industry's sample scenario.
import { AGENT_ROLES, AGENT_ROLE_KEYS, type AgentRoleKey, type AgentRoleMeta } from "@/lib/agents";
import type { SampleScenario } from "./industry";

export type Tone = "ok" | "warn" | "info" | "violet" | "neutral";

export interface ScenarioRow {
  label: string;
  detail?: string;
  tag?: string;
  tone?: Tone;
}

export interface ScenarioStep {
  title: string;
  narration: string;
  /** Who is acting in this step. */
  actor: AgentRoleKey;
  /** What the sample board shows after this step. Rows keep their label from step to step, so the tags visibly change. */
  rows: ScenarioRow[];
}

export interface Scenario {
  /** The button's words: the question a visitor would ask. */
  prompt: string;
  /** What the board is called. */
  board: string;
  steps: ScenarioStep[];
}

export interface EmployeeProfile {
  role: AgentRoleKey;
  meta: AgentRoleMeta;
  /** The problem it takes off your plate, in a sentence. */
  solves: string;
  typicalDay: string[];
  capabilities: string[];
  example: { input: string; output: string };
  worksWith: Array<{ role: AgentRoleKey; how: string }>;
  needsApproval: string[];
}

const meta = (role: AgentRoleKey): AgentRoleMeta => AGENT_ROLES.find((r) => r.key === role) as AgentRoleMeta;

export const SCOPE_NOTE =
  "Which of the six AI Employees are configured and switched on for your business, and what each is set up to do, is decided in your implementation agreement. The examples here show what each role is for, not a promise about your setup.";

export const OVERSIGHT_FOOTER = "Customer-facing actions wait for your approval. The AI Employees only work with your company's own data, never invent bookings, prices or results, and cannot give themselves new tools.";

export function profiles(): EmployeeProfile[] {
  const P: Record<AgentRoleKey, Omit<EmployeeProfile, "role" | "meta">> = {
    lead_hunter: {
      solves: "Finding businesses that look like your best customers takes hours of searching and guessing. The Lead Hunter does the research and explains why each one looks like a fit.",
      typicalDay: ["Reads your ideal-customer brief and the rules you set for places, industries and must-have signals", "Researches candidates and scores how well each one fits, with the reasons written out", "Hands the best ones to your CRM for a person to review, and asks before anyone is contacted"],
      capabilities: ["Lead research against your brief", "Fit scoring with plain-language reasons", "Lead generation review: what is in the queue and what is stuck", "Hand-off of reviewed leads into the CRM"],
      example: { input: "Find independent businesses in our area that fit our ideal customer.", output: "Five candidates, each with a fit rating and one line on why. Nobody has been contacted." },
      worksWith: [
        { role: "crm_manager", how: "checks that a new lead is not already in your CRM before it is added" },
        { role: "sales_assistant", how: "passes reviewed leads on for follow-up preparation" },
      ],
      needsApproval: ["Contacting any lead", "Adding leads to your pipeline in bulk"],
    },
    operations_manager: {
      solves: "Work gets lost between tools and people. The Operations Manager keeps the AI team coordinated and tells you what only a person should decide.",
      typicalDay: ["Looks across queues, approvals, failed runs and integration problems each morning", "Lines up what each AI Employee should work on and flags anything blocked or overdue", "Writes a short summary for you with the decisions that are waiting"],
      capabilities: ["On-demand operations review", "Spots blocked or overdue work, failed runs and missing approvals", "Coordinates hand-offs between the AI Employees", "Daily and weekly operating summaries"],
      example: { input: "Summarise what needs my attention today.", output: "Three new enquiries need a first answer, one quote has gone quiet, and two drafts are waiting for your approval." },
      worksWith: [
        { role: "lead_hunter", how: "gets its research queue and what is stuck in it" },
        { role: "appointment_setter", how: "sees unanswered enquiries and appointments that need confirming" },
        { role: "performance_analyst", how: "shares what the week's numbers say needs attention" },
      ],
      needsApproval: ["Anything that contacts a customer", "Changing a price, an assignment or a setting"],
    },
    appointment_setter: {
      solves: "An enquiry that waits for a reply is an enquiry that goes elsewhere. The Appointment Setter turns interest into a booked meeting and helps when one has to move.",
      typicalDay: ["Reads new enquiries and works out what the person is asking for", "Checks your real calendar for open times and the meeting types you allow", "Prepares the reply that offers times, and records the outcome in the CRM"],
      capabilities: ["Appointment review: what is booked, due and unconfirmed", "Calendar availability check against the calendar you connect", "Missed-call review and a prepared follow-up", "Reschedule and confirmation messages"],
      example: { input: "Can we move our visit to later in the week?", output: "A reply offering Friday morning or Monday afternoon from the calendar, waiting for your approval before it is sent." },
      worksWith: [
        { role: "lead_hunter", how: "receives qualified leads to offer a meeting" },
        { role: "sales_assistant", how: "tells it a meeting is booked so a briefing can be prepared" },
      ],
      needsApproval: ["Sending any message to a customer", "Booking or moving an appointment, unless you have set it to act on its own for that kind of meeting"],
    },
    sales_assistant: {
      solves: "After the conversation comes the paperwork. The Sales Assistant prepares follow-ups, proposals and call notes, so your time goes to talking with people.",
      typicalDay: ["Reviews your pipeline and which leads deserve attention first", "Drafts the follow-up or proposal outline for the next step of each deal", "Prepares notes before a discovery call from what the CRM already holds"],
      capabilities: ["Pipeline review and lead priority review", "Follow-up and proposal drafts for you to edit", "Discovery-call notes from existing CRM records", "Nudges for deals that have gone quiet"],
      example: { input: "Draft a follow-up after today's call.", output: "A short draft that summarises what was covered and suggests the next step, waiting for you to review it." },
      worksWith: [
        { role: "appointment_setter", how: "knows when a meeting is booked and what it is about" },
        { role: "crm_manager", how: "relies on it to keep deal and contact records accurate" },
      ],
      needsApproval: ["Sending a proposal or a follow-up", "Changing a deal's value or stage"],
    },
    crm_manager: {
      solves: "A CRM full of duplicates and gaps stops being trusted. The CRM Manager keeps your customer records clean and spots what looks wrong.",
      typicalDay: ["Scans contacts, companies and deals for duplicates, missing details and unverified identities", "Suggests merges and fixes with the evidence side by side", "Keeps tags, owners and pipeline stages consistent as work moves"],
      capabilities: ["CRM quality review", "Duplicate and missing-detail detection", "Suggested merges and clean-ups", "Consistent tags, owners and stages"],
      example: { input: "Check my CRM for problems.", output: "Two contacts share a phone number and one deal has no owner. Both are listed with a suggested fix for you to confirm." },
      worksWith: [
        { role: "lead_hunter", how: "checks new leads against existing records" },
        { role: "performance_analyst", how: "gives it clean data to report on" },
      ],
      needsApproval: ["Merging or deleting records", "Changing ownership of a deal"],
    },
    performance_analyst: {
      solves: "Numbers are only useful if someone explains them. The Performance Analyst says what is working, what is not and what to look at next, in plain words.",
      typicalDay: ["Reads the week's leads, replies, appointments and deals", "Compares periods and says how each figure is defined, never inventing a benchmark", "Writes a short note on what stood out and what is worth a look"],
      capabilities: ["Performance snapshot with its period, definition and source", "Social media, receivables and reputation reviews", "Plain-language weekly notes", "Pointers to where the time is going"],
      example: { input: "How did we do this week?", output: "Most enquiries arrive by phone and after-hours replies take longest. The note says where the numbers come from and what to look at." },
      worksWith: [
        { role: "crm_manager", how: "depends on it for clean records" },
        { role: "operations_manager", how: "feeds it what the numbers say needs attention" },
      ],
      needsApproval: ["Sharing a report outside your business", "Any change it suggests: a person decides"],
    },
  };
  return AGENT_ROLE_KEYS.map((role) => ({ role, meta: meta(role), ...P[role] }));
}

/** The interactive scenario for a role, using the industry's sample names. Every step is a drawing of what the work looks like; none of it happens. */
export function scenarioOf(role: AgentRoleKey, s: SampleScenario): Scenario {
  const [p1, p2, p3, p4, p5] = s.prospects;
  switch (role) {
    case "lead_hunter":
      return {
        prompt: "Show me how the Lead Hunter finds qualified prospects",
        board: "Lead research queue",
        steps: [
          { actor: "lead_hunter", title: "It reads your brief", narration: `You describe your ideal customer once. In this sample: "${s.huntBrief}"`, rows: [p1, p2, p3, p4, p5].map((label) => ({ label, tag: "Queued", tone: "neutral" as const })) },
          { actor: "lead_hunter", title: "It researches each candidate", narration: "It looks at each business against your rules, one at a time, and writes down what it found.", rows: [{ label: p1, detail: "Matches your area and size", tag: "Researching", tone: "info" }, { label: p2, detail: "Matches your area and size", tag: "Researching", tone: "info" }, { label: p3, tag: "Queued", tone: "neutral" }, { label: p4, tag: "Queued", tone: "neutral" }, { label: p5, tag: "Queued", tone: "neutral" }] },
          { actor: "lead_hunter", title: "It scores the fit and explains why", narration: "Every score comes with the reason, so you can disagree with it.", rows: [{ label: p1, detail: "Strong fit: right size, active online presence", tag: "Strong fit", tone: "ok" }, { label: p2, detail: "Possible fit: right area, smaller than your brief", tag: "Maybe", tone: "warn" }, { label: p3, detail: "Strong fit: right size, takes bookings online", tag: "Strong fit", tone: "ok" }, { label: p4, detail: "Outside the places you listed", tag: "Not a fit", tone: "neutral" }, { label: p5, detail: "Possible fit: needs a closer look", tag: "Maybe", tone: "warn" }] },
          { actor: "crm_manager", title: "The CRM Manager checks for duplicates", narration: "Before anything is added, it checks that you do not already know these businesses.", rows: [{ label: p1, detail: "New to your CRM", tag: "Ready for review", tone: "ok" }, { label: p2, detail: "Possible fit", tag: "Maybe", tone: "warn" }, { label: p3, detail: "Already in your CRM as a past enquiry", tag: "Already known", tone: "violet" }, { label: p4, tag: "Not a fit", tone: "neutral" }, { label: p5, tag: "Maybe", tone: "warn" }] },
          { actor: "operations_manager", title: "You decide who is contacted", narration: "The best leads wait in your review list. In this sample nobody has been contacted, and nothing happens until you say so.", rows: [{ label: p1, detail: "Waiting for your approval to contact", tag: "Needs your decision", tone: "violet" }, { label: p2, tag: "Maybe", tone: "warn" }, { label: p3, detail: "Update the existing record instead", tag: "Needs your decision", tone: "violet" }, { label: p4, tag: "Not a fit", tone: "neutral" }, { label: p5, tag: "Maybe", tone: "warn" }] },
        ],
      };
    case "appointment_setter":
      return {
        prompt: "Show how the Appointment Setter turns a qualified lead into a meeting",
        board: `${s.lead}: ${s.enquiry}`,
        steps: [
          { actor: "appointment_setter", title: "An enquiry arrives", narration: `${s.lead} writes in about ${s.enquiry}. The Appointment Setter reads it and works out what is being asked for.`, rows: [{ label: "Message", detail: `Hi, I'd like to know about ${s.appointment}.`, tag: "New", tone: "info" }, { label: "Calendar", detail: "Not checked yet", tag: "Waiting", tone: "neutral" }, { label: "Reply", detail: "Not written yet", tag: "Waiting", tone: "neutral" }] },
          { actor: "appointment_setter", title: "It checks your real calendar", narration: "It looks at the calendar you connected and the meeting types you allow. It does not guess times.", rows: [{ label: "Message", detail: "Read and understood", tag: "Done", tone: "ok" }, { label: "Calendar", detail: "Two open times this week for " + s.appointment, tag: "Checked", tone: "ok" }, { label: "Reply", detail: "Not written yet", tag: "Waiting", tone: "neutral" }] },
          { actor: "appointment_setter", title: "It prepares a reply", narration: "The reply offers the two times. It waits for you, because it would reach a customer.", rows: [{ label: "Message", tag: "Done", tone: "ok" }, { label: "Calendar", tag: "Checked", tone: "ok" }, { label: "Reply", detail: "Offers Friday morning or Monday afternoon", tag: "Waiting for your approval", tone: "violet" }] },
          { actor: "sales_assistant", title: "The Sales Assistant prepares a briefing", narration: "Once the meeting is confirmed, it prepares a short briefing from what the CRM already holds.", rows: [{ label: "Reply", detail: "Approved and sent (in this sample)", tag: "Sent", tone: "ok" }, { label: "Appointment", detail: `${s.appointment}, Friday morning`, tag: "Scheduled", tone: "ok" }, { label: "Briefing", detail: "A one-page summary for you", tag: "Ready", tone: "info" }] },
          { actor: "crm_manager", title: "The CRM is updated", narration: `The CRM Manager moves ${s.lead} to the next stage and records who did what.`, rows: [{ label: "Pipeline stage", detail: "Qualified to Appointment Scheduled", tag: "Updated", tone: "ok" }, { label: "Appointment", tag: "Scheduled", tone: "ok" }, { label: "Activity log", detail: "Three entries, each naming who did it", tag: "Recorded", tone: "info" }] },
        ],
      };
    case "operations_manager":
      return {
        prompt: "Show how the Operations Manager coordinates the team",
        board: "This morning's coordination",
        steps: [
          { actor: "operations_manager", title: "It looks across the whole system", narration: "Each morning it reads the queues, the approvals waiting and anything that failed overnight.", rows: [{ label: "New enquiries", detail: "3 waiting for a first reply", tag: "Needs a reply", tone: "warn" }, { label: "Quotes", detail: "1 has gone quiet", tag: "Follow up", tone: "warn" }, { label: "Drafts", detail: "2 waiting for approval", tag: "Your decision", tone: "violet" }, { label: "Failed runs", detail: "None overnight", tag: "Clear", tone: "ok" }] },
          { actor: "operations_manager", title: "It lines up the work", narration: "It points each item at the AI Employee whose job it is.", rows: [{ label: "New enquiries", detail: "Handed to the Appointment Setter", tag: "Assigned", tone: "info" }, { label: "Quotes", detail: "Handed to the Sales Assistant", tag: "Assigned", tone: "info" }, { label: "Drafts", detail: "Held for you", tag: "Your decision", tone: "violet" }, { label: "Failed runs", tag: "Clear", tone: "ok" }] },
          { actor: "appointment_setter", title: "The team gets on with it", narration: "The Appointment Setter and the Sales Assistant prepare their drafts. Nothing is sent without you.", rows: [{ label: "New enquiries", detail: "3 replies drafted", tag: "Waiting for your approval", tone: "violet" }, { label: "Quotes", detail: "A nudge drafted", tag: "Waiting for your approval", tone: "violet" }, { label: "Drafts", detail: "2 waiting, plus 4 new", tag: "Your decision", tone: "violet" }, { label: "Failed runs", tag: "Clear", tone: "ok" }] },
          { actor: "operations_manager", title: "You get one short summary", narration: "A summary tells you what was done, what is blocked and what only you can decide.", rows: [{ label: "Done", detail: "7 drafts prepared", tag: "Ready", tone: "ok" }, { label: "Blocked", detail: "Nothing", tag: "Clear", tone: "ok" }, { label: "For you", detail: "Review and approve the drafts", tag: "Your decision", tone: "violet" }] },
        ],
      };
    case "sales_assistant":
      return {
        prompt: "Show how the Sales Assistant prepares a follow-up",
        board: `${s.lead}: ${s.deal}`,
        steps: [
          { actor: "sales_assistant", title: "It reviews the pipeline", narration: `It sees ${s.lead} had ${s.appointment} and no follow-up has gone out.`, rows: [{ label: s.lead, detail: "Call held yesterday, no follow-up yet", tag: "Needs follow-up", tone: "warn" }, { label: "Other deals", detail: "Nothing urgent", tag: "OK", tone: "ok" }] },
          { actor: "sales_assistant", title: "It reads what the CRM already holds", narration: "It uses the notes and the enquiry, nothing from outside your own records.", rows: [{ label: s.lead, detail: "Enquiry, call notes and the agreed next step", tag: "Read", tone: "info" }, { label: "Draft", detail: "Not written yet", tag: "Waiting", tone: "neutral" }] },
          { actor: "sales_assistant", title: "It drafts the follow-up", narration: "A short summary of what was covered and the suggested next step, in your tone of voice.", rows: [{ label: s.lead, tag: "Needs follow-up", tone: "warn" }, { label: "Draft", detail: "Thanks for today. Here is what we covered and the suggested next step.", tag: "Draft ready", tone: "info" }] },
          { actor: "operations_manager", title: "It waits for you", narration: "It lands in your approvals. You can edit it, send it or discard it. Nothing leaves without you.", rows: [{ label: s.lead, tag: "Needs follow-up", tone: "warn" }, { label: "Draft", detail: "In your approvals", tag: "Waiting for your approval", tone: "violet" }] },
        ],
      };
    case "crm_manager":
      return {
        prompt: "Show how the CRM Manager keeps records clean",
        board: "CRM quality review",
        steps: [
          { actor: "crm_manager", title: "It scans your records", narration: "It looks through contacts, companies and deals for duplicates and gaps.", rows: [{ label: "Contacts", detail: "Scanning", tag: "Working", tone: "info" }, { label: "Companies", detail: "Scanning", tag: "Working", tone: "info" }, { label: "Deals", detail: "Scanning", tag: "Working", tone: "info" }] },
          { actor: "crm_manager", title: "It finds what looks wrong", narration: "Each finding comes with the evidence, so you can see why.", rows: [{ label: "Possible duplicate", detail: "'J. Smith' and 'Jordan Smith' share a phone number", tag: "Found", tone: "warn" }, { label: "Missing detail", detail: "A deal has no owner", tag: "Found", tone: "warn" }, { label: "Unverified identity", detail: "A contact has no verified email", tag: "Found", tone: "warn" }] },
          { actor: "crm_manager", title: "It suggests a fix for each", narration: "A suggestion for each finding: merge, assign, or verify.", rows: [{ label: "Possible duplicate", detail: "Review side by side and merge if they are the same person", tag: "Suggested", tone: "info" }, { label: "Missing detail", detail: "Suggest the deal's creator as owner", tag: "Suggested", tone: "info" }, { label: "Unverified identity", detail: "Ask the contact to confirm", tag: "Suggested", tone: "info" }] },
          { actor: "operations_manager", title: "A person says yes", narration: "Nothing is merged or changed until you approve. Once you do, the change is recorded with who approved it.", rows: [{ label: "Possible duplicate", detail: "Merge approved", tag: "Done", tone: "ok" }, { label: "Missing detail", detail: "Owner assigned", tag: "Done", tone: "ok" }, { label: "Unverified identity", detail: "Waiting for your approval to send", tag: "Waiting", tone: "violet" }] },
        ],
      };
    case "performance_analyst":
    default:
      return {
        prompt: "Show how the Performance Analyst explains the week",
        board: "Weekly note (sample figures)",
        steps: [
          { actor: "performance_analyst", title: "It gathers the week", narration: "It reads leads, replies, appointments and deals for the period, and notes where each figure comes from.", rows: [{ label: "Enquiries", detail: "From calls, forms and messages", tag: "Counted", tone: "info" }, { label: "Replies", detail: "Time to first answer", tag: "Counted", tone: "info" }, { label: "Appointments", detail: "Booked and held", tag: "Counted", tone: "info" }] },
          { actor: "performance_analyst", title: "It compares with the last period", narration: "It never invents a benchmark: it compares you with your own previous period, and says so.", rows: [{ label: "Enquiries", detail: "More by phone than any other channel", tag: "Stood out", tone: "info" }, { label: "Replies", detail: "After-hours replies take longest", tag: "Worth a look", tone: "warn" }, { label: "Appointments", detail: "Steady", tag: "No change", tone: "neutral" }] },
          { actor: "performance_analyst", title: "It writes the note", narration: "Plain words, no jargon, with the definitions underneath.", rows: [{ label: "What stood out", detail: "Most enquiries arrive by phone", tag: "In the note", tone: "info" }, { label: "Worth a look", detail: "Who covers evenings and weekends?", tag: "In the note", tone: "warn" }, { label: "Definitions", detail: "How each figure is counted", tag: "In the note", tone: "ok" }] },
          { actor: "operations_manager", title: "You decide what to change", narration: "The note suggests. It changes nothing. A person decides what is worth acting on.", rows: [{ label: "Suggestion", detail: "Review evening and weekend cover", tag: "Your decision", tone: "violet" }, { label: "Report", detail: "Kept in your portal", tag: "Saved", tone: "ok" }] },
        ],
      };
  }
}
