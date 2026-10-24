// The Wave 1 modules a Super Admin switches on per workspace (a row in org_features), what each one unlocks, and what it still needs before it does anything. Plain data and
// pure rules: the admin page reads it in the browser, the service reads it on the server, and a test checks every environment switch and job named here still exists.
//
// A switch only decides whether a workspace HAS the module. It never connects an account, sends a message, moves money or turns a provider on: those need the owner's own
// steps and the environment switches listed below, each its own decision.

/** The provider write switches a message to a customer waits on, one per channel. */
const CHANNEL_SWITCHES: readonly EnvSwitch[] = [
  { name: "TWILIO_WRITES_ENABLED", wantOn: true, meaning: "Text messages leave only while this provider write switch is on." },
  { name: "RESEND_WRITES_ENABLED", wantOn: true, meaning: "Email leaves only while this provider write switch is on." },
  { name: "META_WHATSAPP_WRITES_ENABLED", wantOn: true, meaning: "WhatsApp messages leave only while this provider write switch is on." },
];

export const MODULE_KEYS = ["proposals", "esign", "invoices", "reputation_surveys", "reputation_batches", "reputation_reviews", "request_changes"] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** Who has to do something before the module does anything. */
export type NeedKind = "owner" | "connection" | "approval" | "customer" | "scheduler";

export interface ModuleNeed {
  kind: NeedKind;
  text: string;
}

/** An environment switch the module's reach depends on. `wantOn` is the state in which the module can do that part of its work. */
export interface EnvSwitch {
  name: string;
  wantOn: boolean;
  meaning: string;
}

export interface ModuleInfo {
  key: ModuleKey;
  label: string;
  /** What the workspace gets the moment the switch is on. */
  unlocks: string;
  /** What switching it off does to the customers and the work, read from the gates in the code (a test ties each statement to its gate). Shown in the confirmation. */
  whenOff: string;
  needs: readonly ModuleNeed[];
  env: readonly EnvSwitch[];
  /** The scheduled jobs that work for this module (they run only when the scheduler does, and in a staged start only when named in SCHEDULER_JOBS_ONLY). */
  jobs: readonly string[];
  /** Another module that must be on first. */
  dependsOn: ModuleKey | null;
}

export const MODULES: readonly ModuleInfo[] = [
  {
    key: "proposals",
    label: "Proposals",
    unlocks: "Proposals in the client's menu: a price book and tax rates, templates, drafts, an approval step, a private link for the customer with an emailed one-time code, and the customer's recorded answer. An AI draft is only ever a draft a person approves.",
    whenOff: "Proposals leave their menu and no new proposal can be written. A link already given to a customer stops opening: the page says it is unavailable until the module is switched on again. Proposals already written, with their history, are kept.",
    needs: [
      { kind: "owner", text: "The owner sets the approval rules in Proposals > Settings and fills in the price book and tax rates. Nothing is priced for them." },
      { kind: "owner", text: "Marking a proposal as sent contacts no one. The team then copies the customer's link and gives it over, or sends it from the Delivery tab by email, text message or WhatsApp after reading the message; that goes through the consent-gated send chain, so it needs the customer's consent on the channel and the provider's write switch (RESEND_WRITES_ENABLED, TWILIO_WRITES_ENABLED, META_WHATSAPP_WRITES_ENABLED)." },
      { kind: "customer", text: "The customer's emailed code leaves only through the email provider (EMAIL_PROVIDER, and RESEND_WRITES_ENABLED when it is resend); with capture it is stored, not sent." },
      { kind: "scheduler", text: "proposalExpiry and proposalHousekeeping close expired proposals and clear spent codes; they run only when the scheduler does." },
    ],
    env: [
      { name: "PROPOSALS_PUBLIC_DISABLED", wantOn: false, meaning: "The emergency stop for the customer's page, its PDF and the emailed codes. On, no customer can open a link." },
      { name: "RESEND_WRITES_ENABLED", wantOn: true, meaning: "Email leaves only while this provider write switch is on, and the customer's one-time code is an email." },
    ],
    jobs: ["proposalExpiry", "proposalHousekeeping"],
    dependsOn: null,
  },
  {
    key: "esign",
    label: "Electronic signing",
    unlocks: "Ask the customer to sign a sent proposal through the business's own signing account (PandaDoc is the only adapter). A proposal counts as signed only when the signing service says so.",
    whenOff: "Signing is no longer offered on a proposal and its page shows no signing step. The signing service's notices are answered \"try again later\", so a signature given while this is off is recorded only if the service delivers it again after the module is switched back on. Requests already made are kept.",
    needs: [
      { kind: "connection", text: "The owner or a manager connects the business's own signing account (a sandbox first) in Proposals > Settings. The agency never connects one for them." },
      { kind: "approval", text: "Counsel-approved acknowledgement and terms wording, and a founder decision on where signing sits in the plan, before any real use." },
      { kind: "scheduler", text: "esignSync hands requests to the signing service and reads the answers; it runs only when the scheduler does." },
    ],
    env: [
      { name: "ESIGN_WRITES_ENABLED", wantOn: true, meaning: "Without it nothing is written to a real signing service: a request through a real connection waits untouched. The simulated service reaches nothing and is refused in production." },
      { name: "PROPOSALS_PUBLIC_DISABLED", wantOn: false, meaning: "On, the signing service's notice address answers 503 for every workspace." },
    ],
    jobs: ["esignSync"],
    dependsOn: "proposals",
  },
  {
    key: "invoices",
    label: "Customer invoices and payments",
    unlocks: "Invoices the business sends its own customers: drafts, an approval, numbering, the customer's private pay page, payments and refunds recorded by hand, sending an issued invoice's link to the customer after the team has read the message, reminders, a draft invoice made from an accepted proposal, and verified revenue in the Lead Sources report. Under Settings > Customer payments the owner can connect the business's own payment account.",
    whenOff: "Invoices leave their menu and no new invoice work can be done. The customer's pay page still opens but no longer offers Pay online, reminders and the overdue check stop for this workspace, a message with an invoice's link that has not gone out yet is not sent, and the Lead Sources report stops showing verified revenue. A payment a provider reports for an invoice already issued is still recorded, because that money has arrived.",
    needs: [
      { kind: "owner", text: "The owner fills in the invoice settings (business name, number prefix, payment instructions, what happens to a deal when an invoice is paid)." },
      { kind: "connection", text: "To take payments online the owner connects the business's own PayMongo or PayPal account in test mode, sees a test payment succeed on a test invoice (a test invoice is never owed, reminded or counted as revenue), and only then confirms going live. iAcquire never holds the money." },
      { kind: "approval", text: "Reminders to customers stay off until the owner authorizes the exact wording, days and channels." },
      { kind: "owner", text: "Sending an issued invoice to the customer is a person's confirmed step on the invoice page: they read the exact message first. It goes through the consent-gated send chain, so it needs the customer's consent on the channel, the existing message dispatcher job (messagesDispatched) and the provider's write switch, and a test invoice is never sent. Making a draft invoice from an accepted proposal needs Proposals on too; it issues, sends and charges nothing." },
      { kind: "scheduler", text: "customerPaymentReconcile, invoiceOverdueSweep and invoiceReminders; they run only when the scheduler does, and the first and last are not to be named in a staged start until the founder approves that stage." },
    ],
    env: [
      { name: "CUSTOMER_PAYMENTS_WRITES_ENABLED", wantOn: true, meaning: "The master switch for any call to a real payment provider (checking a pasted key, starting a checkout, reading a payment back). Off, only the simulated provider works. A PayMongo notice is still recorded; a PayPal notice can only be checked by calling PayPal, so it is answered \"try again later\" and nothing is stored until this is on." },
      { name: "CUSTOMER_PAYMENTS_LIVE_ENABLED", wantOn: true, meaning: "Lets a connection take live money. Off, only test mode works." },
      { name: "INVOICES_PUBLIC_DISABLED", wantOn: false, meaning: "The emergency stop for the customer's pay page and its routes. On, no customer can open an invoice." },
      ...CHANNEL_SWITCHES,
    ],
    jobs: ["customerPaymentReconcile", "invoiceOverdueSweep", "invoiceReminders"],
    dependsOn: null,
  },
  {
    key: "reputation_surveys",
    label: "Satisfaction surveys",
    unlocks: "Satisfaction surveys (CSAT and NPS), the Satisfaction view, a retention program's feedback link and a survey form's answers saved as private feedback with a follow-up.",
    whenOff: "New survey requests are refused and a survey form's answers are no longer saved as private feedback. Feedback already saved is kept. Review requests are not affected.",
    needs: [
      { kind: "owner", text: "The owner chooses the follow-up time and the score that counts as low in CRM > Reviews > Settings." },
      { kind: "customer", text: "A survey request goes out through the ordinary message chain, so consent, opt-outs, quiet hours and the provider write switches all apply." },
      { kind: "scheduler", text: "feedbackSla tells the team about low feedback nobody acknowledged; it is internal and runs only when the scheduler does." },
    ],
    env: [
      { name: "REVIEWS_PUBLIC_DISABLED", wantOn: false, meaning: "The emergency stop for the customer's survey and review page. On, no customer can open one." },
      ...CHANNEL_SWITCHES,
    ],
    jobs: ["feedbackSla"],
    dependsOn: null,
  },
  {
    key: "reputation_batches",
    label: "Review request batches",
    unlocks: "An owner-approved ask to many past customers at a set pace, through the same checks as one review request.",
    whenOff: "The batch job stops: an approved or sending batch is left exactly as it is, not deleted, and asks no further customers until the module is switched on again. This switch does not recall messages the batch already queued.",
    needs: [
      { kind: "approval", text: "The owner approves each batch: the exact audience, wording, channel and pace. Any change to them stops the batch until it is approved again." },
      { kind: "customer", text: "Each customer is asked through the ordinary message chain, so consent, opt-outs, the cool-down, quiet hours and credits all apply." },
      { kind: "scheduler", text: "reviewRequestBatches does the asking. It writes to customers, so it is not to be named in a staged start until the founder approves that stage." },
    ],
    env: [
      { name: "REVIEWS_PUBLIC_DISABLED", wantOn: false, meaning: "The emergency stop for the customer's review page. On, no customer can open one." },
      ...CHANNEL_SWITCHES,
    ],
    jobs: ["reviewRequestBatches"],
    dependsOn: null,
  },
  {
    key: "reputation_reviews",
    label: "Public reviews and replies",
    unlocks: "The business's public reviews from Google and Facebook, read into CRM > Reviews > Public reviews, with reply drafts. A reply is posted only when the owner or a manager approves it and presses Post.",
    whenOff: "Reading review sites and connecting a new one stop. Reviews already read and connections already made stay visible, and nothing is deleted.",
    needs: [
      { kind: "connection", text: "The owner connects a review site: a Google Business Profile or a Facebook Page. The business's own account, the business's own consent." },
      { kind: "approval", text: "Google must have approved iAcquire's Cloud project for the Business Profile APIs, and Meta its review permissions, before a real site can be read." },
      { kind: "scheduler", text: "reviewSync reads each connected site, renewalReminders and reputationRetention tidy up; they run only when the scheduler does. Nothing posts a reply by itself." },
    ],
    env: [
      { name: "GOOGLE_BUSINESS_API_APPROVED", wantOn: true, meaning: "Google has approved the Business Profile APIs for iAcquire. Off, a Google site is not even asked." },
      { name: "GOOGLE_BUSINESS_REPLIES_ENABLED", wantOn: true, meaning: "Lets a reply be posted to Google." },
      { name: "META_REVIEWS_ENABLED", wantOn: true, meaning: "Lets a Facebook Page's reviews be read." },
      { name: "META_REVIEWS_REPLIES_ENABLED", wantOn: true, meaning: "Lets a reply be posted to Facebook." },
    ],
    jobs: ["reviewSync", "renewalReminders", "reputationRetention"],
    dependsOn: null,
  },
  {
    key: "request_changes",
    label: "Request a Change",
    unlocks: "Request a Change in the client's Requests menu, and a Change requests list on each agreed custom project, where an owner or admin can ask for a change to what was agreed. The team decides whether it is a revision the agreement includes or something outside it that needs a quote; the owner accepts or declines a quote the team wrote.",
    whenOff: "The Request a Change page leaves the menu and no new change request, or change to a project, can be made. Changes already asked for stay on the project, and a quote waiting for the owner can still be accepted, declined or withdrawn.",
    needs: [
      { kind: "approval", text: "The founder decides what the core system covers, what a managed maintenance plan covers and what is a paid change, and counsel confirms the wording of the acceptance line. Nothing is priced or promised by the system: staff write every quote." },
      { kind: "owner", text: "Which prerequisites a project needs before work starts (the written agreement, a payment a person confirms) is a separate Super Admin switch in Support settings, off until the founder decides." },
      { kind: "scheduler", text: "projectReviewOverdue tells the team when a project review passes its time; it runs only when the scheduler does." },
    ],
    env: [],
    jobs: ["projectReviewOverdue"],
    dependsOn: null,
  },
];

/** One module in one workspace, as org_features says it is. `since` and `byName` are set only while the module is on. */
export interface ModuleSwitchState {
  on: boolean;
  since: string | null;
  byName: string | null;
}

export interface ModuleRolloutRow {
  orgId: string;
  name: string;
  status: string;
  modules: Record<ModuleKey, ModuleSwitchState>;
  /** Working connections the workspace already has, so "on" is not mistaken for "ready". */
  connections: { signing: number; payments: number; reviews: number };
}

/** An environment switch as it stands now (a yes or no, never a value). `ok` is whether it is in the state the module needs for that part of its work. */
export interface EnvSwitchState {
  name: string;
  on: boolean | null;
  wantOn: boolean;
  ok: boolean;
  meaning: string;
}

export interface ModuleRolloutView {
  rows: ModuleRolloutRow[];
  /** True when there are more client workspaces than the page lists. */
  truncated: boolean;
  env: Record<ModuleKey, EnvSwitchState[]>;
}

export interface ModuleSwitchResult {
  orgId: string;
  key: ModuleKey;
  enabled: boolean;
  /** False when the workspace was already in that state: nothing was written. */
  changed: boolean;
}

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === "string" && (MODULE_KEYS as readonly string[]).includes(value);
}

export function moduleInfo(key: ModuleKey): ModuleInfo {
  return MODULES.find((m) => m.key === key) as ModuleInfo;
}

/** Why a change cannot be made right now because of another module, or null when it can. Switching something to the state it is already in is never a problem here. */
export function dependencyProblem(key: ModuleKey, enabling: boolean, on: Readonly<Record<ModuleKey, boolean>>): string | null {
  const info = moduleInfo(key);
  if (enabling && info.dependsOn && !on[info.dependsOn]) return `Switch on ${moduleInfo(info.dependsOn).label} first: ${info.label} works on it.`;
  const dependent = !enabling ? MODULES.find((m) => m.dependsOn === key && on[m.key]) : undefined;
  if (dependent) return `Switch off ${dependent.label} first: it works on ${info.label}.`;
  return null;
}
