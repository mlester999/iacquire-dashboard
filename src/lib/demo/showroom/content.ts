// The showroom's navigation and shared sample data: the four guided steps, sample CRM, sample report, Automation Studio's place in the plans, the
// plan comparison and the "Why iAcquireOS?" sales page.
//
// What this file may state, and why (tests/demo-showroom.test.ts guards the machine-checkable parts):
//  - prices come from src/lib/billing.ts (setup $1,499 once; optional $299 a month) and are passed in, never typed here;
//  - Automation Studio and managed media storage belong to the OPTIONAL Managed Maintenance plan; the native CRM, AI Growth Partner, inbox, booking and website never wait on it
//    (src/lib/entitlements.ts, src/lib/automation-studio/plan.ts, docs/billing-and-entitlements.md);
//  - a core client may still connect external automation tools (n8n, Zapier, Make), webhooks and the API;
//  - nothing here is a price for a competitor, a percentage, an hour saved or a result. Comparisons are qualitative and labelled illustrative.
import type { SampleScenario } from "./industry";
import { AI_GROWTH_PARTNER_CAPABILITIES, AI_GROWTH_PARTNER_CAPABILITY_INFO } from "@/lib/ai-growth-partner";

export const DEMO_CAPABILITY_AREAS = AI_GROWTH_PARTNER_CAPABILITIES.map((key) => ({ key, ...AI_GROWTH_PARTNER_CAPABILITY_INFO[key] }));

export type ViewId = "overview" | "workforce" | "crm" | "inbox" | "automation" | "reports" | "pricing" | "why" | "summary";

export interface ViewDef {
  id: ViewId;
  label: string;
  short: string;
  /** The lucide icon's name; the component maps it. */
  icon: "layout" | "users" | "kanban" | "inbox" | "workflow" | "chart" | "tag" | "sparkles" | "flag";
  hint: string;
}

export const VIEWS: readonly ViewDef[] = [
  { id: "overview", label: "Overview", short: "Overview", icon: "layout", hint: "Your demo at a glance" },
  { id: "workforce", label: "AI Growth Partner", short: "Partner", icon: "sparkles", hint: "One employee, six integrated capabilities" },
  { id: "crm", label: "CRM & Pipeline", short: "CRM", icon: "kanban", hint: "Follow a lead to a won deal" },
  { id: "inbox", label: "Inbox & Appointments", short: "Inbox", icon: "inbox", hint: "Conversations and bookings" },
  { id: "automation", label: "Automation Studio", short: "Automations", icon: "workflow", hint: "Describe it, watch it built" },
  { id: "reports", label: "Reports & Insights", short: "Reports", icon: "chart", hint: "What is working" },
  { id: "pricing", label: "Plans & Pricing", short: "Pricing", icon: "tag", hint: "What it costs, plainly" },
  { id: "why", label: "Why iAcquireOS?", short: "Why us", icon: "sparkles", hint: "The case, with the objections" },
];

export const VIEW_IDS: readonly ViewId[] = [...VIEWS.map((v) => v.id), "summary"];
export const isViewId = (v: unknown): v is ViewId => typeof v === "string" && (VIEW_IDS as readonly string[]).includes(v);

export interface JourneyStep {
  step: 1 | 2 | 3 | 4;
  view: ViewId;
  title: string;
  short: string;
  blurb: string;
}

export const JOURNEY: readonly JourneyStep[] = [
  { step: 1, view: "workforce", title: "Meet your AI Growth Partner", short: "Growth Partner", blurb: "One employee with six connected capabilities and one shared business context." },
  { step: 2, view: "crm", title: "See your client acquisition system", short: "Client system", blurb: "A lead's whole journey through the native CRM, from first message to won deal." },
  { step: 3, view: "automation", title: "Explore automations", short: "Automations", blurb: "Describe an automation and watch it get built, safely, in a simulation." },
  { step: 4, view: "summary", title: "Your business, powered by iAcquireOS", short: "Your business", blurb: "How it all comes together, what we set up for you, and your next steps." },
];

// ---------------------------------------------------------------------------
// The sample CRM
// ---------------------------------------------------------------------------

export const PIPELINE_STAGES = ["New Lead", "Qualified", "Appointment Scheduled", "Proposal", "Won"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface SampleDeal {
  id: string;
  name: string;
  about: string;
  stage: PipelineStage;
  /** Whether this is the lead the visitor can move along. */
  followed?: boolean;
}

export function sampleDeals(s: SampleScenario): SampleDeal[] {
  return [
    { id: "d1", name: s.lead, about: `${s.enquiry} (the lead you can move)`, stage: "New Lead", followed: true },
    { id: "d2", name: "Pat W.", about: `Asked about ${s.deal}`, stage: "New Lead" },
    { id: "d3", name: "Robin E.", about: "Referred by an existing customer", stage: "Qualified" },
    { id: "d4", name: "Lee N.", about: `Booked ${s.appointment}`, stage: "Appointment Scheduled" },
    { id: "d5", name: "Cam D.", about: `Proposal for ${s.deal}`, stage: "Proposal" },
    { id: "d6", name: "Ari F.", about: `Closed: ${s.deal}`, stage: "Won" },
  ];
}

/** What the one AI Growth Partner does at each sample pipeline stage, using one of its internal capabilities. */
export const STAGE_STORY: Record<PipelineStage, { capability: string; what: string }> = {
  "New Lead": { capability: "CRM & Pipeline Management", what: "The enquiry is captured from a form, a call or a message. The Growth Partner checks for a possible duplicate before preparing the record." },
  Qualified: { capability: "Lead Discovery & Qualification", what: "The Growth Partner checks the lead against your approved ideal-customer rules and records why it may fit. A person reviews the result." },
  "Appointment Scheduled": { capability: "Calendar & Appointment Management", what: "The Growth Partner checks connected availability and prepares an appointment request. Nothing is confirmed or sent until the required approval." },
  Proposal: { capability: "Sales & Outreach", what: "After the meeting, the Growth Partner prepares a follow-up and proposal outline from approved notes. You review, edit and send it." },
  Won: { capability: "Performance & Analytics", what: "The win is counted with the source recorded in the CRM, so you can see which channels bring customers." },
};

// ---------------------------------------------------------------------------
// Sample report
// ---------------------------------------------------------------------------

export const REPORT_WEEKS = ["Wk 1", "Wk 2", "Wk 3", "Wk 4", "Wk 5", "Wk 6"] as const;
/** Invented, rounded sample figures with no unit claims. They exist so the charts have shape; the page says they are samples. */
export const REPORT_SERIES = {
  enquiries: [14, 18, 16, 22, 21, 26],
  booked: [5, 6, 6, 9, 9, 11],
  won: [1, 2, 2, 3, 3, 4],
} as const;
export const REPORT_SOURCES = [
  { label: "Phone", share: 38 },
  { label: "Website form", share: 27 },
  { label: "Referral", share: 20 },
  { label: "Messages", share: 15 },
] as const;

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const CORE_INCLUDES = [
  "Your agreed system, configured, verified and activated by the iAcquire team",
  "The native CRM: contacts, pipelines, deals, a unified inbox, calendars and tasks",
  "One AI Growth Partner, configured to your approved scope, with human approval on customer-facing actions",
  "Use it through your own iAcquire portal, with no mandatory platform subscription",
  "Connect external automation tools such as n8n, Zapier or Make through supported APIs and webhooks",
];

export const MAINTENANCE_INCLUDES_FALLBACK = [
  "Monitoring of your connected integrations and AI Growth Partner health, with alerts to our team",
  "Troubleshooting when an integration, workflow or AI Growth Partner stops working as configured",
  "Reasonable configuration adjustments as your business changes, and AI optimization",
];

export const STUDIO_INCLUDES = [
  "Automation Studio: describe an automation in plain words and watch it get built on a visual canvas",
  "Auto Mode (chat and canvas) and Manual Mode (a full editor), testing before anything goes live, and approval controls",
  "Managed media storage for social posts, within fair use",
];

export const PLAN_NOT_INCLUDED = [
  "New automations, AI agents, websites, funnels or software beyond the plan: quoted separately",
  "Third-party platform subscriptions and any usage or API costs",
];

export const USAGE_NOTE =
  "Usage-based costs, such as AI model calls and messaging, are separate and shown in your portal. Third-party subscriptions are billed by those providers.";

// ---------------------------------------------------------------------------
// "Why iAcquireOS?"
// ---------------------------------------------------------------------------

export interface WhyBlock {
  id: string;
  title: string;
  lead: string;
  points: string[];
}

export const WHY_BLOCKS: readonly WhyBlock[] = [
  {
    id: "follow-up",
    title: "Most enquiries are won or lost in the follow-up",
    lead: "A business can do excellent work and still lose people in the gaps: an enquiry that waited a day, a quote nobody chased, a call nobody logged.",
    points: ["A first reply that comes quickly tells a customer you are paying attention", "A follow-up that actually happens beats one you meant to send", "A pipeline that is up to date shows you where people are getting stuck"],
  },
  {
    id: "growth-partner",
    title: "One AI Growth Partner coordinates the work",
    lead: "One employee brings six capabilities together: finding and qualifying leads, preparing outreach, coordinating appointments, managing CRM work, handling operations and explaining results.",
    points: ["It prepares work; a person approves actions that require approval", "Its available tools follow your workspace permissions and approved scope", "Its work is recorded with the evidence and approvals"],
  },
  {
    id: "connected",
    title: "One connected CRM and AI Growth Partner",
    lead: "Contacts, pipelines, the inbox, calendars, tasks, approvals and reports live in one place, and the Growth Partner works with the same authorized records.",
    points: ["No copying records between systems", "One log of activity across people and the Growth Partner", "One portal for your team to work in"],
  },
  {
    id: "done-for-you",
    title: "Done-for-you implementation",
    lead: "You do not wire it up yourself. The iAcquire team configures the CRM and AI Growth Partner around your business, tests it and activates it with you.",
    points: ["A short questionnaire about your business, services and customers", "One Growth Partner configured from your submitted information, then verified", "A written scope before work starts, and activation only once it is checked"],
  },
  {
    id: "ownership",
    title: "Flexibility and control",
    lead: "The core system is yours to use without a mandatory monthly subscription, and it is built to work with the tools you already use.",
    points: ["Connect external automation tools such as n8n, Zapier or Make through supported APIs and webhooks", "The CRM, Growth Partner, inbox and booking never wait on the optional monthly plan", "Human approval and control stay with you"],
  },
];

export interface DiyRow {
  topic: string;
  diy: string;
  iacquire: string;
}

/** Qualitative only: no competitor prices, no hours, no percentages. The page labels it illustrative. */
export const DIY_ROWS: readonly DiyRow[] = [
  { topic: "Getting started", diy: "Choose and sign up for a CRM, a booking tool, a messaging provider, an automation platform and an AI model, then connect them", iacquire: "One implementation: the iAcquire team sets up the CRM and your AI Growth Partner together" },
  { topic: "Making the pieces talk", diy: "Every connection is something you build, test and keep working when either side changes", iacquire: "The pieces are built to work as one system, in one portal" },
  { topic: "Keeping the AI safe", diy: "You write the prompts, the limits and the approval steps, and notice when they drift", iacquire: "Approvals, role limits and an activity log are part of the system" },
  { topic: "When something breaks", diy: "You find out when a customer does, then trace which tool failed", iacquire: "Optional Managed Maintenance: monitoring with alerts to our team, and troubleshooting" },
  { topic: "Cost structure", diy: "Several subscriptions plus your own time, each billed separately", iacquire: "A one-time implementation, an optional monthly plan, and usage costs shown in your portal" },
];

export interface Faq {
  q: string;
  a: string;
}

export function faqs(setup: string, monthly: string): Faq[] {
  return [
    { q: "Do I have to pay a monthly fee to use the system?", a: `No. The implementation (${setup}, paid once) gives you the system you agreed. The Managed Maintenance plan (${monthly} a month) is optional and is never needed to use the core system.` },
    { q: "Will the AI Growth Partner message my customers on its own?", a: "No. Anything that reaches a customer waits for the required approval, and every approval is recorded." },
    { q: "Is this demo using my real business data?", a: "No. Everything you see here is sample data, labelled as such. Nothing in this demo is searched, sent, booked or saved about a real business." },
    { q: "What is Automation Studio, and do I need it?", a: "It is a builder where you describe an automation in plain words and watch it take shape. It is part of the optional Managed Maintenance plan. Without it you can still connect external automation tools through APIs and webhooks." },
    { q: "What do AI usage and messaging cost?", a: "Usage-based costs such as AI model calls and messaging are separate from the implementation and the plan, and are shown in your portal." },
    { q: "What happens after I ask for a consultation?", a: "The iAcquire team sees your request and talks to you about your business. Pressing the button does not book anything or charge anything." },
    { q: "How long does setup take?", a: "A written scope and timeline are confirmed before work starts, because it depends on what you need configured." },
  ];
}

export const NEXT_STEPS = [
  { title: "Talk to us", body: "A short conversation about your business, your customers and what you want the AI Growth Partner to do." },
  { title: "Agree the scope", body: "You receive a written scope and the price before any work starts." },
  { title: "We configure and verify", body: "The iAcquire team sets up your CRM and AI Growth Partner, then checks them with you." },
  { title: "You activate and run it", body: "Once it is verified, it is live in your portal, with your approvals in charge." },
] as const;

export const IMPLEMENTATION_SETS = [
  "Your pipeline stages, contact fields and forms",
  "Your AI Growth Partner: its six capability areas, priorities, tone of voice and approval rules",
  "Your calendar and the meeting types it may offer",
  "Your connected channels and integrations, where supported",
  "A test of the whole path before activation",
];
