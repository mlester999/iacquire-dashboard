// Starting points for the Automation Studio home screen: real requests the AI Automation Builder turns into a workflow in the person's own workspace.
// Each is only a sentence for the box (editable before it is sent); none is a pre-built workflow, so nothing here can promise what the workspace
// can't do. What a starter needs from the workspace (an approved message template, a pipeline, an AI employee…) is checked against the workspace
// and shown on its card, so the person knows before they start whether it can run as written.
import type { EditorOptions } from "@/components/crm/workflows/types";
import { isReviewTemplate } from "@/components/crm/reviews/model";

export type StarterNeed = "template" | "review_template" | "employee" | "pipeline" | "calendar";

export interface Starter {
  id: string;
  category: string;
  title: string;
  description: string;
  /** The words put in the box. */
  prompt: string;
  needs: StarterNeed[];
}

export const STARTER_CATEGORIES = ["Leads", "Appointments", "Follow-ups", "Sales pipeline", "Reviews & feedback", "Team"] as const;

export const STARTERS: Starter[] = [
  { id: "new-lead-welcome", category: "Leads", title: "Welcome every new lead", description: "A task for the owner the moment a lead arrives, so no one waits.", prompt: "When a new lead is added, create a high-priority task for the contact's owner to welcome them and notify the team.", needs: [] },
  { id: "form-leads", category: "Leads", title: "Sort website enquiries", description: "Tag and follow up everyone who sends one of your forms.", prompt: "When someone submits one of my forms, tag them as a website lead and create a task to call them back within a day.", needs: [] },
  { id: "qualify-lead", category: "Leads", title: "Have an AI employee qualify new leads", description: "Ask one of your AI employees to review each new lead.", prompt: "When a new lead is added, ask my CRM Manager to review the lead's details and update their lead status.", needs: ["employee"] },
  { id: "hot-lead", category: "Leads", title: "Alert me about hot leads", description: "Tell the team as soon as a lead is tagged Hot.", prompt: "When a contact is tagged Hot, notify the owners and managers and create an urgent task to contact them today.", needs: [] },
  { id: "webhook-lead", category: "Leads", title: "Add leads from another system", description: "Start from a private webhook address and create the contact.", prompt: "Start from an inbound webhook that creates a contact from the email or phone it receives, then tag them as a webhook lead and create a follow-up task.", needs: [] },
  { id: "appointment-team-reminder", category: "Appointments", title: "Remind my team before appointments", description: "A note for the team the day before each booking.", prompt: "When an appointment is booked, wait until one day before it starts, then notify the team about it.", needs: ["calendar"] },
  { id: "booking-confirmation", category: "Appointments", title: "Confirm every booking", description: "Send an approved confirmation message as soon as someone books.", prompt: "When an appointment is booked, send the contact my approved booking confirmation message.", needs: ["template", "calendar"] },
  { id: "no-show-follow-up", category: "Appointments", title: "Follow up after a no-show", description: "A task and an offer to rebook when someone misses an appointment.", prompt: "When someone is marked as a no-show, create a task to call them and send my approved message offering to rebook.", needs: ["template", "calendar"] },
  { id: "follow-up-sequence", category: "Follow-ups", title: "Follow up if they go quiet", description: "A gentle nudge after two days, then a task for a person.", prompt: "When a new lead is added, wait two days. If they haven't replied, send my approved follow-up message, wait three more days, and if they still haven't replied create a task for the owner.", needs: ["template"] },
  { id: "missed-call", category: "Follow-ups", title: "Missed-call follow-up", description: "Don't let a missed call go cold.", prompt: "When a call ends with no answer or a voicemail, create an urgent task for the contact's owner to call back and send my approved missed-call message.", needs: ["template"] },
  { id: "booked-move-stage", category: "Sales pipeline", title: "Move the deal when they book", description: "Keep the pipeline honest without anyone dragging cards.", prompt: "When an appointment is booked, move the contact's open deal to the Meeting booked stage.", needs: ["pipeline", "calendar"] },
  { id: "won-onboarding", category: "Sales pipeline", title: "Start onboarding when a deal is won", description: "A task for onboarding and a customer tag.", prompt: "When a deal is won, tag the contact as a customer and create an onboarding task for the owner.", needs: ["pipeline"] },
  { id: "stalled-deal", category: "Sales pipeline", title: "Nudge stalled deals", description: "Remind the owner when a deal sits in a stage for a week.", prompt: "When a deal moves into a stage, wait seven days. If it is still open, notify the deal's owner and create a task to follow up.", needs: ["pipeline"] },
  { id: "review-request", category: "Reviews & feedback", title: "Ask for a review after a visit", description: "A review request the day after someone attends.", prompt: "When someone is marked as having attended an appointment, wait one day and send my approved review request.", needs: ["review_template", "calendar"] },
  { id: "feedback-alert", category: "Reviews & feedback", title: "Hear about private feedback fast", description: "Tell the team the moment a customer sends feedback.", prompt: "When a customer sends private feedback, notify the owners and managers and create a task to reply.", needs: [] },
  { id: "unreplied-message", category: "Team", title: "Catch messages nobody answered", description: "Notify the team if a customer message sits unanswered for an hour.", prompt: "When a customer message comes in, wait one hour. If nobody has replied, notify the team.", needs: [] },
  { id: "weekly-review", category: "Team", title: "A weekly pipeline check-in", description: "A Monday reminder for the team to review the pipeline.", prompt: "Every Monday at 9am, notify the owners and managers to review the pipeline and follow up on open deals.", needs: [] },
];

export interface StarterReadiness {
  ready: boolean;
  /** What the workspace is missing for this starter to run as written, in words. */
  missing: string[];
}

/** Whether the workspace has what a starter needs, from the same lists the editor and the validator use. */
export function starterReadiness(starter: Pick<Starter, "needs">, o: EditorOptions): StarterReadiness {
  const missing: string[] = [];
  for (const need of starter.needs) {
    if (need === "template" && !o.templates.length) missing.push("an approved message template");
    else if (need === "review_template" && !o.templates.some(isReviewTemplate)) missing.push("an approved review request template");
    else if (need === "employee" && !o.employees.length) missing.push("an AI employee in your workspace");
    else if (need === "pipeline" && !o.pipelines.length) missing.push("a pipeline");
    else if (need === "calendar" && !o.calendars.length) missing.push("a calendar");
  }
  return { ready: missing.length === 0, missing };
}

/** Starters matching a search (title, description, category), keeping the catalogue's order. */
export function searchStarters(q: string, category: string | null): Starter[] {
  const needle = q.trim().toLowerCase();
  return STARTERS.filter((s) => (!category || s.category === category) && (!needle || `${s.title} ${s.description} ${s.category} ${s.prompt}`.toLowerCase().includes(needle)));
}
