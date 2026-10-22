// Automation Studio's ready-made automations. Unlike a starter (a sentence for the builder), each template here is a real, complete workflow graph built
// from the steps the engine runs, with the few choices only the workspace can make (which tag, which approved message, which connection) asked for up front.
//
// A template never carries anything it should not: a message is only ever an approved template the person picked, a connection is only ever one of the
// workspace's own, and nothing runs until the person has tested it and the owner has approved the exact version (Automation Studio's publish flow).
// Pure: the server builds and validates a template with the workspace's real options, and the screens use the same list to show what is still missing.
import type { EditorOptions } from "@/components/crm/workflows/types";
import { isReviewTemplate } from "@/components/crm/reviews/model";
import type { MessageChannel, TriggerType, WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";

export type StudioInputKind = "tag" | "user" | "pipeline" | "stage" | "message_template" | "review_template" | "calendar" | "form" | "slack" | "http" | "employee";

export interface StudioInputSpec {
  key: string;
  label: string;
  help: string;
  kind: StudioInputKind;
  required: boolean;
}

export type StageChoice = { pipelineId: string; stageId: string };
export type MessageChoice = { templateId: string; contentHash: string; channel: MessageChannel };
export type StudioInputs = Record<string, string | StageChoice | MessageChoice | null | undefined>;

/** Everything a template needs from the server that a pure function can't make up: the secret part of an inbound webhook address. */
export interface BuildEnv {
  newNonce: () => string;
}

export const STUDIO_TEMPLATE_CATEGORIES = ["Leads", "Appointments", "Sales", "Customer care", "Team", "Other systems"] as const;
export type StudioTemplateCategory = (typeof STUDIO_TEMPLATE_CATEGORIES)[number];

/** What a template does outside iAcquire, in the words the gallery shows. */
export type StudioReach = "messages" | "slack" | "http" | "employee";
export const REACH_LABELS: Record<StudioReach, string> = { messages: "Sends approved messages to customers", slack: "Posts to Slack", http: "Calls another system", employee: "Asks an AI employee" };

export interface StudioTemplate {
  key: string;
  name: string;
  category: StudioTemplateCategory;
  description: string;
  trigger: TriggerType;
  /** The outside effects the workflow has. Any of them means an owner approves the exact version before it runs. */
  reach: StudioReach[];
  inputs: StudioInputSpec[];
  /** One sentence on what to look at before switching it on. */
  before: string;
  build: (inputs: StudioInputs, env: BuildEnv) => WorkflowDefinition;
}

const str = (v: StudioInputs[string]) => (typeof v === "string" && v ? v : null);
const stageOf = (v: StudioInputs[string]) => (v && typeof v === "object" && "stageId" in v ? (v as StageChoice) : null);
const messageOf = (v: StudioInputs[string]) => (v && typeof v === "object" && "templateId" in v ? (v as MessageChoice) : null);
const NO_MESSAGE: MessageChoice = { templateId: "", contentHash: "", channel: "sms" };

type Draft = Omit<WorkflowStep, "next">;

/** Links steps in order: each step's next is the following one. A branch or an end is left as written. */
function chain(steps: Draft[]): WorkflowStep[] {
  return steps.map((s, i) => (s.kind === "branch" || s.kind === "end" ? (s as WorkflowStep) : ({ ...s, next: steps[i + 1]?.key ?? null } as WorkflowStep)));
}

const sendStep = (key: string, name: string, m: MessageChoice, sendAs: "sales_assistant" | "appointment_setter" = "sales_assistant"): Draft => ({
  key, kind: "send_message", name, config: { templateId: m.templateId, contentHash: m.contentHash, channel: m.channel, sendAs, businessHoursOnly: true },
});
const slackStep = (key: string, name: string, connectionId: string | null, text: string): Draft => ({ key, kind: "slack_message", name, config: { connectionId: connectionId ?? "", text } });
const taskStep = (key: string, name: string, title: string, over: Record<string, unknown> = {}): Draft => ({
  key, kind: "create_task", name, config: { title, priority: "high", assignee: "contact_owner", ...over },
});
const notifyStep = (key: string, name: string, title: string, body?: string): Draft => ({
  key, kind: "notify_team", name, config: { roles: ["owner", "admin"], contactOwner: true, title, ...(body ? { body } : {}) },
});
const noReplyBranch = (key: string, name: string, yes: string): WorkflowStep => ({ key, kind: "branch", name, config: { subject: "contact", filter: { op: "and", conditions: [] }, reply: "not_replied" }, branches: { yes, no: null } }) as WorkflowStep;

const slackInput = (required: boolean, help = "The Slack channel that gets the message."): StudioInputSpec => ({ key: "slack", label: required ? "Slack connection" : "Slack connection (optional)", help, kind: "slack", required });
const httpInput = (help: string): StudioInputSpec => ({ key: "api", label: "HTTP connection", help, kind: "http", required: true });
const messageInput = (label: string, help: string, required = true): StudioInputSpec => ({ key: "message", label, help, kind: "message_template", required });

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  // ---- Leads -------------------------------------------------------------------------------------------------------------------------
  {
    key: "new-lead-slack-alert",
    name: "New lead alert in Slack",
    category: "Leads",
    description: "The moment a contact is created, post it to a Slack channel and give the owner a task to call within the hour.",
    trigger: "contact.created",
    reach: ["slack"],
    inputs: [slackInput(true)],
    before: "Check the message reads the way your team talks, then watch the first real lead arrive in Slack.",
    build: (i) => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: chain([
        slackStep("alert", "Post to Slack", str(i.slack), "New lead: {{contact.full_name}}. Open iAcquire to see their details and call them within the hour."),
        taskStep("call", "Call task", "Call {{contact.full_name}}", { dueIn: { amount: 1, unit: "hours" } }),
      ]),
    }),
  },
  {
    key: "lead-welcome-and-nudge",
    name: "Welcome message, then a nudge",
    category: "Leads",
    description: "Send an approved welcome to every new lead. If they haven't answered after two days, their owner gets a task to call.",
    trigger: "contact.created",
    reach: ["messages"],
    inputs: [messageInput("Welcome message", "An approved template for new leads.")],
    before: "Test it with a contact that has an email or a phone number, and check quiet hours suit your customers.",
    build: (i) => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: [
        { ...sendStep("welcome", "Send welcome", messageOf(i.message) ?? NO_MESSAGE), next: "wait" } as WorkflowStep,
        { key: "wait", kind: "wait", name: "Wait 2 days", config: { mode: "duration", amount: 2, unit: "days" }, next: "quiet" } as WorkflowStep,
        noReplyBranch("quiet", "No reply yet?", "call"),
        { ...taskStep("call", "Call task", "No reply from {{contact.full_name}}: give them a call", { dueIn: { amount: 4, unit: "hours" } }), next: null } as WorkflowStep,
      ],
    }),
  },
  {
    key: "speed-to-lead",
    name: "Speed to lead: escalate if untouched",
    category: "Leads",
    description: "Fifteen minutes after a lead arrives, if it is still marked New, alert the owner and managers and create an urgent task.",
    trigger: "contact.created",
    reach: [],
    inputs: [],
    before: "Make sure someone on the team changes a lead's status when they pick it up, or every lead will escalate.",
    build: () => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: [
        { key: "wait", kind: "wait", name: "Wait 15 minutes", config: { mode: "duration", amount: 15, unit: "minutes" }, next: "untouched" } as WorkflowStep,
        { key: "untouched", kind: "branch", name: "Still new?", config: { subject: "contact", filter: { op: "and", conditions: [{ field: "lead_status", op: "in", value: ["new"] }] } }, branches: { yes: "alert", no: null } } as WorkflowStep,
        { ...notifyStep("alert", "Alert the team", "Lead waiting: {{contact.full_name}}", "Nobody has picked up this lead after 15 minutes."), next: "urgent" } as WorkflowStep,
        { ...taskStep("urgent", "Urgent task", "Contact {{contact.full_name}} now", { priority: "urgent", dueIn: { amount: 15, unit: "minutes" } }), next: null } as WorkflowStep,
      ],
    }),
  },
  {
    key: "website-form-intake",
    name: "Website form: tag, task and Slack",
    category: "Leads",
    description: "When someone sends a form, tag them, give their owner a call-back task and, if you connect Slack, tell the channel.",
    trigger: "form.submitted",
    reach: ["slack"],
    inputs: [
      { key: "tag", label: "Tag for form leads", help: "Added to everyone who sends the form.", kind: "tag", required: true },
      { key: "form", label: "Only this form (optional)", help: "Leave empty to react to every form.", kind: "form", required: false },
      slackInput(false, "Posts the new enquiry to this channel."),
    ],
    before: "Submit your own form once and check the tag, the task and the Slack message.",
    build: (i) => ({
      trigger: { type: "form.submitted", ...(str(i.form) ? { filters: { formIds: [str(i.form)!] } } : {}), reentry: "always" },
      steps: chain([
        { key: "tag", kind: "add_tag", name: "Tag the lead", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
        taskStep("call", "Call-back task", "Call back {{contact.full_name}} about their enquiry", { dueIn: { amount: 1, unit: "days" } }),
        ...(str(i.slack) ? [slackStep("alert", "Post to Slack", str(i.slack), "New enquiry from {{contact.full_name}}. Open iAcquire to read it and call them back.")] : []),
      ]),
    }),
  },
  {
    key: "inbound-webhook-lead",
    name: "Leads from another system",
    category: "Leads",
    description: "Another system sends a lead to a private, signed address. iAcquire creates the contact, tags it and tells the team.",
    trigger: "inbound_webhook",
    reach: [],
    inputs: [{ key: "tag", label: "Tag for these leads", help: "Added to every contact that arrives this way.", kind: "tag", required: true }],
    before: "Open the workflow's settings for its address, give it to the other system, and send one test lead.",
    build: (i, env) => ({
      trigger: { type: "inbound_webhook", reentry: "always", inbound: { nonce: env.newNonce(), match: "email_or_phone", createContact: true } },
      steps: chain([
        { key: "tag", kind: "add_tag", name: "Tag the lead", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
        taskStep("call", "Follow-up task", "Follow up with {{contact.full_name}}", { dueIn: { amount: 1, unit: "days" } }),
        notifyStep("tell", "Tell the team", "New lead from another system: {{contact.full_name}}"),
      ]),
    }),
  },
  {
    key: "ai-lead-qualification",
    name: "AI employee reviews new leads",
    category: "Leads",
    description: "Ask one of your AI employees to review each new lead and leave a note, then give the owner a task to act on it.",
    trigger: "contact.created",
    reach: ["employee"],
    inputs: [{ key: "employee", label: "AI employee", help: "Works within its own mode and permissions; it can't do more than it already can.", kind: "employee", required: true }],
    before: "Check the employee is ready to chat, and read its first few notes before relying on them.",
    build: (i) => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: chain([
        { key: "review", kind: "ai_task", name: "AI review", config: { roleKey: (str(i.employee) ?? "crm_manager") as never, instruction: "Review this new lead's details, update the lead status if it is clear, and add an internal note with the recommended next step." } },
        taskStep("act", "Act on the review", "Read the AI review of {{contact.full_name}} and act on it", { dueIn: { amount: 4, unit: "hours" } }),
      ]),
    }),
  },

  // ---- Appointments -----------------------------------------------------------------------------------------------------------------
  {
    key: "booking-confirmation-and-reminder",
    name: "Confirm a booking and remind the day before",
    category: "Appointments",
    description: "Send an approved confirmation when someone books, then an approved reminder a day before the appointment.",
    trigger: "appointment.booked",
    reach: ["messages"],
    inputs: [
      { key: "confirmation", label: "Confirmation message", help: "Sent as soon as the appointment is booked.", kind: "message_template", required: true },
      { key: "reminder", label: "Reminder message", help: "Sent 24 hours before the appointment.", kind: "message_template", required: true },
      { key: "calendar", label: "Only this calendar (optional)", help: "Leave empty for every calendar.", kind: "calendar", required: false },
    ],
    before: "Book a test appointment for yourself and check both messages and their timing.",
    build: (i) => ({
      trigger: { type: "appointment.booked", ...(str(i.calendar) ? { filters: { calendarIds: [str(i.calendar)!] } } : {}) },
      steps: chain([
        sendStep("confirm", "Send confirmation", messageOf(i.confirmation) ?? NO_MESSAGE, "appointment_setter"),
        { key: "wait", kind: "wait", name: "Wait until 24 hours before", config: { mode: "until_date", source: "appointment_start", offset: { amount: 24, unit: "hours", direction: "before" }, ifMissing: "end" } },
        sendStep("remind", "Send reminder", messageOf(i.reminder) ?? NO_MESSAGE, "appointment_setter"),
      ]),
    }),
  },
  {
    key: "no-show-recovery",
    name: "No-show recovery",
    category: "Appointments",
    description: "When someone misses an appointment, offer to rebook with an approved message. If they stay quiet for three days, their owner gets a task.",
    trigger: "appointment.no_show",
    reach: ["messages"],
    inputs: [messageInput("Rebooking message", "An approved template that offers a new time.")],
    before: "Mark a test appointment as a no-show to see the message and the task.",
    build: (i) => ({
      trigger: { type: "appointment.no_show" },
      steps: [
        { ...sendStep("offer", "Offer to rebook", messageOf(i.message) ?? NO_MESSAGE, "appointment_setter"), next: "wait" } as WorkflowStep,
        { key: "wait", kind: "wait", name: "Wait 3 days", config: { mode: "duration", amount: 3, unit: "days" }, next: "quiet" } as WorkflowStep,
        noReplyBranch("quiet", "No reply yet?", "call"),
        { ...taskStep("call", "Call task", "Call {{contact.full_name}}: missed appointment, no reply", { dueIn: { amount: 4, unit: "hours" } }), next: null } as WorkflowStep,
      ],
    }),
  },
  {
    key: "appointment-team-brief",
    name: "Brief the team on every booking",
    category: "Appointments",
    description: "When an appointment is booked, notify the owner and managers, leave a note on the contact and, if you connect Slack, post it to the channel.",
    trigger: "appointment.booked",
    reach: ["slack"],
    inputs: [slackInput(false, "Posts each booking to this channel.")],
    before: "Book a test appointment and check what the team sees.",
    build: (i) => ({
      trigger: { type: "appointment.booked" },
      steps: chain([
        notifyStep("tell", "Notify the team", "New booking: {{contact.full_name}}", "{{appointment.type}} on {{appointment.date}} at {{appointment.time}}."),
        { key: "note", kind: "internal_note", name: "Note on the contact", config: { subject: "contact", body: "Booked {{appointment.type}} for {{appointment.date}} at {{appointment.time}}." } },
        ...(str(i.slack) ? [slackStep("post", "Post to Slack", str(i.slack), "Booked: {{contact.full_name}} · {{appointment.type}} · {{appointment.date}} {{appointment.time}}")] : []),
      ]),
    }),
  },
  {
    key: "post-visit-review-request",
    name: "Ask for a review after a visit",
    category: "Appointments",
    description: "A day after someone is marked as having attended, send your approved review request.",
    trigger: "appointment.showed",
    reach: ["messages"],
    inputs: [{ key: "review", label: "Review request message", help: "An approved service template that contains the review link.", kind: "review_template", required: true }],
    before: "Mark a test appointment as attended and check the request reads well and the link works.",
    build: (i) => {
      const m = messageOf(i.review) ?? NO_MESSAGE;
      return {
        trigger: { type: "appointment.showed" },
        steps: chain([
          { key: "wait", kind: "wait", name: "Wait 1 day", config: { mode: "duration", amount: 1, unit: "days" } },
          { key: "ask", kind: "request_review", name: "Ask for a review", config: { templateId: m.templateId, contentHash: m.contentHash, channel: m.channel, businessHoursOnly: true } },
        ]),
      };
    },
  },

  // ---- Sales ------------------------------------------------------------------------------------------------------------------------
  {
    key: "won-deal-handoff",
    name: "Won deal: hand off to onboarding",
    category: "Sales",
    description: "When a deal is won, tag the customer, create an onboarding task linked to the deal and, if you connect Slack, celebrate in the channel.",
    trigger: "opportunity.won",
    reach: ["slack"],
    inputs: [
      { key: "tag", label: "Customer tag", help: "Added to the contact when their deal is won.", kind: "tag", required: true },
      { key: "pipeline", label: "Only this pipeline (optional)", help: "Leave empty for every pipeline.", kind: "pipeline", required: false },
      slackInput(false, "Announces each win in this channel."),
    ],
    before: "Mark a test deal as won and check the task lands with the right person.",
    build: (i) => ({
      trigger: { type: "opportunity.won", ...(str(i.pipeline) ? { filters: { pipelineId: str(i.pipeline)! } } : {}) },
      steps: chain([
        { key: "tag", kind: "add_tag", name: "Tag as customer", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
        taskStep("onboard", "Onboarding task", "Start onboarding for {{contact.full_name}}", { priority: "normal", dueIn: { amount: 1, unit: "days" }, linkOpportunity: true }),
        ...(str(i.slack) ? [slackStep("win", "Announce the win", str(i.slack), "Deal won with {{contact.full_name}}. Onboarding task created.")] : []),
      ]),
    }),
  },
  {
    key: "lost-deal-win-back",
    name: "Lost deal: win-back in 30 days",
    category: "Sales",
    description: "Note why the deal was lost, wait 30 days, then send an approved win-back message.",
    trigger: "opportunity.lost",
    reach: ["messages"],
    inputs: [messageInput("Win-back message", "An approved template that reopens the conversation.")],
    before: "Check the message is one you would be happy to send a month after a lost deal.",
    build: (i) => ({
      trigger: { type: "opportunity.lost" },
      steps: chain([
        { key: "note", kind: "internal_note", name: "Note the loss", config: { subject: "opportunity", body: "Lost deal. A win-back message is scheduled for 30 days from now." } },
        { key: "wait", kind: "wait", name: "Wait 30 days", config: { mode: "duration", amount: 30, unit: "days" } },
        sendStep("winback", "Send win-back", messageOf(i.message) ?? NO_MESSAGE),
      ]),
    }),
  },
  {
    key: "stalled-deal-watch",
    name: "Stalled deal watch",
    category: "Sales",
    description: "A week after a deal enters a stage, if it is still open and still there, notify the owner and create a follow-up task.",
    trigger: "opportunity.stage_changed",
    reach: [],
    inputs: [{ key: "stage", label: "Stage to watch", help: "Deals that sit in this stage for a week are flagged.", kind: "stage", required: true }],
    before: "Start with a stage where deals should never sit for long, so the alerts mean something.",
    build: (i) => {
      const s = stageOf(i.stage);
      return {
        trigger: { type: "opportunity.stage_changed", filters: { ...(s ? { pipelineId: s.pipelineId, stageIds: [s.stageId] } : {}) }, reentry: "always" },
        steps: [
          { key: "wait", kind: "wait", name: "Wait 7 days", config: { mode: "duration", amount: 7, unit: "days" }, next: "still" } as WorkflowStep,
          { key: "still", kind: "branch", name: "Still stuck?", config: { subject: "opportunity", filter: { op: "and", conditions: [{ field: "status", op: "in", value: ["open"] }, ...(s ? [{ field: "stage", op: "in", value: [s.stageId] }] : [])] } }, branches: { yes: "tell", no: null } } as WorkflowStep,
          { ...notifyStep("tell", "Notify the owner", "A deal has been in this stage for a week", "Open the deal and decide the next step."), next: "task" } as WorkflowStep,
          { ...taskStep("task", "Follow-up task", "Follow up on the stalled deal with {{contact.full_name}}", { linkOpportunity: true, dueIn: { amount: 1, unit: "days" } }), next: null } as WorkflowStep,
        ],
      };
    },
  },
  {
    key: "vip-fast-lane",
    name: "VIP fast lane",
    category: "Sales",
    description: "When a contact is tagged, create an urgent task for their owner, alert the managers and, if you connect Slack, post to the channel.",
    trigger: "contact.tag_added",
    reach: ["slack"],
    inputs: [
      { key: "tag", label: "Tag that starts it", help: "For example VIP or Hot.", kind: "tag", required: true },
      slackInput(false, "Posts the alert in this channel."),
    ],
    before: "Add the tag to a test contact and see who is alerted.",
    build: (i) => ({
      trigger: { type: "contact.tag_added", filters: str(i.tag) ? { tagIds: [str(i.tag)!] } : {}, reentry: "not_while_active" },
      steps: chain([
        taskStep("urgent", "Urgent task", "Contact {{contact.full_name}} today", { priority: "urgent", dueIn: { amount: 2, unit: "hours" } }),
        notifyStep("tell", "Alert the team", "Priority contact: {{contact.full_name}}"),
        ...(str(i.slack) ? [slackStep("post", "Post to Slack", str(i.slack), "Priority contact tagged: {{contact.full_name}}. Open iAcquire to contact them today.")] : []),
      ]),
    }),
  },

  // ---- Customer care ---------------------------------------------------------------------------------------------------------------
  {
    key: "private-feedback-alert",
    name: "Private feedback alert",
    category: "Customer care",
    description: "When a customer sends private feedback, notify the owners and managers, create a reply task and optionally post to Slack.",
    trigger: "feedback.received",
    reach: ["slack"],
    inputs: [slackInput(false, "Posts each piece of feedback in this channel.")],
    before: "Send yourself test feedback from a review request page.",
    build: (i) => ({
      trigger: { type: "feedback.received" },
      steps: chain([
        notifyStep("tell", "Notify the team", "Private feedback from {{contact.full_name}}"),
        taskStep("reply", "Reply task", "Reply to the feedback from {{contact.full_name}}", { dueIn: { amount: 1, unit: "days" } }),
        ...(str(i.slack) ? [slackStep("post", "Post to Slack", str(i.slack), "New private feedback from {{contact.full_name}}. Open iAcquire to read it and reply.")] : []),
      ]),
    }),
  },
  {
    key: "consent-withdrawn-guard",
    name: "Consent withdrawn: protect the contact",
    category: "Customer care",
    description: "When a contact withdraws consent, tag them, leave a note and tell the team so nobody contacts them by mistake.",
    trigger: "contact.consent_changed",
    reach: [],
    inputs: [{ key: "tag", label: "Do-not-contact tag", help: "Added to a contact who withdraws consent.", kind: "tag", required: true }],
    before: "Revoke consent on a test contact to see the tag and the alert.",
    build: (i) => ({
      trigger: { type: "contact.consent_changed", filters: { consentStatus: "revoked" }, reentry: "always" },
      steps: chain([
        { key: "tag", kind: "add_tag", name: "Tag the contact", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
        { key: "note", kind: "internal_note", name: "Note on the contact", config: { subject: "contact", body: "Consent was withdrawn. Do not message this contact until it is given again." } },
        notifyStep("tell", "Tell the team", "Consent withdrawn: {{contact.full_name}}"),
      ]),
    }),
  },

  // ---- Team --------------------------------------------------------------------------------------------------------------------------
  {
    key: "weekly-pipeline-review",
    name: "Weekly pipeline review reminder",
    category: "Team",
    description: "Every Monday at 9am, post a reminder in Slack and notify the owners and managers to review the pipeline.",
    trigger: "schedule",
    reach: ["slack"],
    inputs: [slackInput(true, "Where the reminder is posted.")],
    before: "Runs by itself every Monday once switched on. Check the time zone of your workspace first.",
    build: (i) => ({
      trigger: { type: "schedule", schedule: { frequency: "weekly", time: "09:00", weekdays: [1] } },
      steps: chain([
        slackStep("post", "Post to Slack", str(i.slack), "Weekly pipeline review: go through open deals, update stages and book the follow-ups."),
        { key: "tell", kind: "notify_team", name: "Notify the team", config: { roles: ["owner", "admin"], title: "Weekly pipeline review", body: "Review open deals and follow up on anything that has gone quiet." } },
      ]),
    }),
  },

  // ---- Other systems -----------------------------------------------------------------------------------------------------------------
  {
    key: "lead-sync-http",
    name: "Send new leads to another system",
    category: "Other systems",
    description: "Post each new contact's name, email and phone to an API you've connected, then tag the contact as synced.",
    trigger: "contact.created",
    reach: ["http"],
    inputs: [
      httpInput("The system that receives the lead. The connection decides the address and the credentials."),
      { key: "tag", label: "Synced tag", help: "Added once the other system accepted the lead.", kind: "tag", required: true },
    ],
    before: "Check the path and the body match what the other system expects, then run a test for one contact.",
    build: (i) => ({
      trigger: { type: "contact.created", reentry: "once" },
      steps: chain([
        { key: "send", kind: "http_request", name: "Send to the other system", config: { connectionId: str(i.api) ?? "", method: "POST", path: "/leads", bodyType: "json", body: JSON.stringify({ name: "{{contact.full_name}}", email: "{{contact.email}}", phone: "{{contact.phone}}", source: "iacquire" }), timeoutSeconds: 15 } },
        { key: "tag", kind: "add_tag", name: "Tag as synced", config: { tagIds: str(i.tag) ? [str(i.tag)!] : [] } },
      ]),
    }),
  },
  {
    key: "booking-sync-http",
    name: "Send bookings to another system",
    category: "Other systems",
    description: "Post each booked appointment to an API you've connected (a scheduling, field-service or reporting tool).",
    trigger: "appointment.booked",
    reach: ["http"],
    inputs: [httpInput("The system that receives bookings.")],
    before: "Check the path and body, then book a test appointment.",
    build: (i) => ({
      trigger: { type: "appointment.booked" },
      steps: chain([
        { key: "send", kind: "http_request", name: "Send the booking", config: { connectionId: str(i.api) ?? "", method: "POST", path: "/appointments", bodyType: "json", body: JSON.stringify({ contact: "{{contact.full_name}}", email: "{{contact.email}}", type: "{{appointment.type}}", date: "{{appointment.date}}", time: "{{appointment.time}}", location: "{{appointment.location}}" }), timeoutSeconds: 15 } },
      ]),
    }),
  },
  {
    key: "won-deal-billing-http",
    name: "Won deal: tell the billing system",
    category: "Other systems",
    description: "When a deal is won, post the customer's details to your billing or accounting system and leave a note on the deal.",
    trigger: "opportunity.won",
    reach: ["http"],
    inputs: [httpInput("Your billing or accounting system.")],
    before: "Ask the other system what it needs, check the body, and run a test for one deal.",
    build: (i) => ({
      trigger: { type: "opportunity.won" },
      steps: chain([
        { key: "send", kind: "http_request", name: "Tell the billing system", config: { connectionId: str(i.api) ?? "", method: "POST", path: "/customers", bodyType: "json", body: JSON.stringify({ name: "{{contact.full_name}}", email: "{{contact.email}}", phone: "{{contact.phone}}", event: "deal_won" }), timeoutSeconds: 15 } },
        { key: "note", kind: "internal_note", name: "Note on the deal", config: { subject: "opportunity", body: "The billing system was told about this win." } },
      ]),
    }),
  },
];

export const studioTemplate = (key: string) => STUDIO_TEMPLATES.find((t) => t.key === key) ?? null;

export interface TemplateReadiness {
  ready: boolean;
  /** What the workspace is missing for the template to be set up, in words. */
  missing: string[];
  /** Things that don't stop setup but will make the automation wait or need a look (a connection not verified yet). */
  notes: string[];
}

/**
 * The templates that match what a person typed: every word they wrote has to appear in the template's name, description, category, what starts it, what it
 * reaches outside iAcquire, or the first thing it asks for, in any order and ignoring case and accents ("slack new lead" finds the Slack alert for a new
 * lead). An empty search matches everything. Pure, so the gallery and its test use the same rule.
 */
export function templateMatches<T extends Pick<StudioTemplate, "key" | "name" | "description" | "category" | "trigger" | "reach" | "before">>(list: readonly T[], query: string): T[] {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = norm(query).split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return [...list];
  return list.filter((t) => {
    const haystack = norm([t.key.replace(/-/g, " "), t.name, t.description, t.category, t.trigger.replace(/[._]/g, " "), t.reach.map((r) => REACH_LABELS[r]).join(" "), t.before].join(" "));
    return words.every((w) => haystack.includes(w));
  });
}

/** Whether the workspace has what a template asks for, from the same lists the editor and the validator use. */
export function templateReadiness(template: Pick<StudioTemplate, "inputs">, o: EditorOptions): TemplateReadiness {
  const missing: string[] = [];
  const notes: string[] = [];
  for (const spec of template.inputs) {
    if (!spec.required) continue;
    switch (spec.kind) {
      case "tag": if (!o.tags.length) missing.push("a tag"); break;
      case "user": if (!o.members.length) missing.push("a team member"); break;
      case "pipeline": if (!o.pipelines.length) missing.push("a pipeline"); break;
      case "stage": if (!o.pipelines.some((p) => p.stages.length)) missing.push("a pipeline with stages"); break;
      case "message_template": if (!o.templates.length) missing.push("an approved message template"); break;
      case "review_template": if (!o.templates.some(isReviewTemplate)) missing.push("an approved review request template"); break;
      case "calendar": if (!o.calendars.length) missing.push("a calendar"); break;
      case "form": if (!(o.forms ?? []).length) missing.push("a form"); break;
      case "employee": if (!o.employees.length) missing.push("an AI employee in your workspace"); break;
      case "slack": {
        const list = (o.connections ?? []).filter((c) => c.kind === "slack_webhook");
        if (!list.length) missing.push("a Slack connection");
        else if (!list.some((c) => c.status === "active")) notes.push("Your Slack connection hasn't been verified yet. The automation waits until it is.");
        break;
      }
      case "http": {
        const list = (o.connections ?? []).filter((c) => c.kind === "http");
        if (!list.length) missing.push("an HTTP connection");
        else if (!list.some((c) => c.status === "active")) notes.push("Your HTTP connection hasn't been verified yet. The automation waits until it is.");
        break;
      }
    }
  }
  return { ready: missing.length === 0, missing: [...new Set(missing)], notes };
}
