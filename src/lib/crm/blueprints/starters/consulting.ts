// Consulting starter: an engagements pipeline and renewals, discovery calls and strategy sessions, a project enquiry form, a guide request
// form and an engagement feedback survey, with enquiry, proposal and onboarding drafts for independent consultants and small firms.
// Original iAcquire content; no customer data, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const consultant = memberSlot("lead-consultant", "Lead consultant", "Holds discovery calls, writes proposals and looks after signed clients.");

// Folders
const fFit = folder("tag", "fit", "Fit");
const fSource = folder("tag", "source", "Source");
const fStage = folder("tag", "engagement", "Engagement");
const fLists = folder("smart_list", "business-development", "Business development");
const fProspectMsgs = folder("template", "prospects", "Prospects");
const fClientMsgs = folder("template", "clients", "Clients");
const fFlows = folder("workflow", "prospect-care", "Prospect care");
const fForms = folder("form", "website", "Website forms");
const fReports = folder("report", "pipeline-review", "Pipeline review");

// Tags
const tIdeal = tag("ideal-fit", "Ideal client fit", COLOR.green, fFit);
const tEarly = tag("too-early", "Too early for us", COLOR.amber, fFit, "A good prospect who isn't ready yet. Stay in touch.");
const tOutside = tag("outside-focus", "Outside our focus", COLOR.slate, fFit);
const tReferral = tag("referral", "Referral", COLOR.violet, fSource);
const tEvent = tag("event", "Met at an event or talk", COLOR.cyan, fSource);
const tGuide = tag("guide-download", "Guide requested", COLOR.blue, fSource, "Added by the guide request form; starts the guide delivery draft.");
const tEnquiry = tag("new-enquiry", "New enquiry", COLOR.red, fStage, "Added by the project enquiry form; starts the enquiry follow-up draft.");
const tProposal = tag("proposal-sent", "Proposal sent", COLOR.orange, fStage, "Add when a proposal goes out; starts the proposal follow-up draft.");
const tActive = tag("active-client", "Active client", COLOR.green, fStage);
const tAlumni = tag("alumni", "Past client", COLOR.pink, fStage, "Add when an engagement ends; starts the feedback request draft.");

// Fields
const role = field("contact", "job_title", "Role", "text", { group: "Company" });
const companySize = field("contact", "company_size", "Company size", "select", { options: ["Just me", "2 to 10 people", "11 to 50 people", "51 to 200 people", "Over 200 people"], group: "Company" });
const sector = field("contact", "industry_sector", "Industry", "text", { group: "Company" });
const website = field("contact", "company_website", "Company website", "url", { group: "Company" });
const challenge = field("contact", "main_challenge", "Main challenge", "textarea", { group: "Qualification", help: "In the prospect's own words." });
const budgetStatus = field("contact", "budget_status", "Budget", "select", { options: ["Budget approved", "Budget being agreed", "No budget yet"], group: "Qualification" });
const decisionTimeline = field("contact", "decision_timeline", "Decision timeline", "select", { options: ["This month", "This quarter", "Later this year", "No fixed date"], group: "Qualification" });
const decisionRole = field("contact", "decision_role", "Part in the decision", "select", { options: ["Decides", "Recommends", "Researching"], group: "Qualification" });
const source = field("contact", "referral_source", "How they found us", "select", { options: ["Referral", "LinkedIn", "Search engine", "Event or talk", "Podcast or article", "Other"], group: "Qualification" });
const engagementType = field("opportunity", "engagement_type", "Engagement type", "select", { options: ["Advisory retainer", "Fixed-scope project", "Workshop", "Coaching programme"] });
const contractMonths = field("opportunity", "contract_months", "Contract length (months)", "number");

// Configuration values
const vDiscovery = configValue("discovery_link", "Discovery call booking link", "url", "Links");
const vCases = configValue("case_studies_link", "Case studies page", "url", "Links");
const vGuide = configValue("guide_link", "Guide download link", "url", "Links");
const vOffice = configValue("office_address", "Office address", "text", "Contact details");
const vTerms = configValue("payment_terms", "Payment terms", "text", "Proposals");

// Pipelines
const engagements = pipeline("engagements", "Consulting engagements", "From the first enquiry to a signed engagement.", true, [
  ["enquiry", "New enquiry", "open", 10],
  ["discovery", "Discovery call held", "open", 25, COLOR.cyan],
  ["scoping", "Scoping", "open", 40, COLOR.blue],
  ["proposal", "Proposal sent", "open", 55, COLOR.amber],
  ["negotiation", "Negotiation", "open", 75, COLOR.lime],
  ["signed", "Signed", "won", 100, COLOR.green],
  ["not-proceeding", "Not proceeding", "lost", 0],
]);
const renewals = pipeline("renewals", "Renewals", "Existing clients whose engagement is coming to an end.", false, [
  ["renewal-due", "Renewal due", "open", 50],
  ["renewal-proposed", "Renewal proposed", "open", 70, COLOR.blue],
  ["renewed", "Renewed", "won", 100, COLOR.green],
  ["ended", "Ended", "lost", 0],
]);

// Calendar (a draft until the host, hours and Microsoft 365 connection are verified in the workspace)
const consultations = calendar("consultations", "Consultations", {
  description: "Discovery calls for prospects, and sessions and check-ins for clients.", assignment: "single", color: COLOR.blue,
  bookingIntro: "Book a short discovery call to talk about what you're working on and whether we're the right fit.", hours: weekly(MON_FRI, "09:00", "17:00"), hosts: [consultant],
}, (t) => [
  t("discovery-call", "Discovery call", {
    description: "Thirty minutes to understand your goals and see whether we can help.", durationMinutes: 30, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 30,
    locationKind: "video", meetingProvider: "microsoft_teams", color: COLOR.blue,
    questions: [ask.long("goal", "What would you like help with?", true), ask.text("company", "Company name")],
  }),
  t("strategy-session", "Strategy session", {
    description: "A working session for signed clients.", durationMinutes: 90, bufferBeforeMinutes: 15, bufferAfterMinutes: 15, minNoticeMinutes: 2880, maxDaysAhead: 60,
    requiresConfirmation: true, public: false, locationKind: "video", meetingProvider: "microsoft_teams", color: COLOR.violet,
  }),
  t("client-check-in", "Client check-in", {
    description: "A short progress call for clients.", durationMinutes: 30, minNoticeMinutes: 240, public: false, locationKind: "phone",
    locationDetail: "We call the number on file.", color: COLOR.green,
  }),
]);

// Templates
const enquiryAck = msg.email("enquiry_received", "Project enquiry: received", "service", fProspectMsgs, "Thanks for getting in touch", [
  "Hi {{contact.first_name}},",
  "Thank you for telling us about your project. We read every enquiry ourselves and will reply with a few thoughts and next steps.",
  `If you'd like to talk sooner, choose a time for a discovery call here: ${cv(vDiscovery)}`,
  `You can also see how we've helped other organisations: ${cv(vCases)}`,
  `{{business.name}}
${cv(vOffice)}`,
].join("\n\n"), "Enquiries");
const discoveryNudge = msg.sms("discovery_nudge", "Discovery call nudge text", "service", fProspectMsgs,
  `Hi {{contact.first_name}}, it's {{business.name}}. Would a short discovery call help with what you sent us? Choose a time here: ${cv(vDiscovery)}`, "Enquiries");
const callConfirm = msg.email("call_confirmation", "Call confirmation", "service", fClientMsgs, "Confirmed: {{appointment.type}} on {{appointment.date}}", [
  "Hi {{contact.first_name}},",
  "Your {{appointment.type}} with {{business.name}} is confirmed for {{appointment.date}} at {{appointment.time}}.",
  "It helps to come with one or two outcomes you'd like from the conversation. If the time no longer works, you can change it here: {{appointment.manage_link}}",
].join("\n\n"), "Appointments");
const callReminder = msg.whatsapp("call_reminder", "Call reminder (WhatsApp)", "service", fClientMsgs,
  "Hi {{contact.first_name}}, a reminder of your {{appointment.type}} with {{business.name}} on {{appointment.date}} at {{appointment.time}}. To reschedule: {{appointment.manage_link}}", "Appointments");
const proposalNudge = msg.email("proposal_follow_up", "Proposal follow-up", "service", fProspectMsgs, "Any questions about our proposal?", [
  "Hi {{contact.first_name}},",
  "I wanted to check that our proposal reached you and see whether anything needs clarifying. Happy to adjust the scope or timing so it fits how your team works.",
  `For reference, our payment terms are: ${cv(vTerms)}`,
  "{{user.first_name}}\n{{business.name}}",
].join("\n\n"), "Proposals");
const guideDelivery = msg.email("guide_delivery", "Guide delivery", "service", fProspectMsgs, "Here's the guide you asked for", [
  "Hi {{contact.first_name}},",
  `Thanks for your interest. You can download the guide here: ${cv(vGuide)}`,
  `If any of it raises questions about your own situation, reply to this email or book a discovery call: ${cv(vDiscovery)}`,
].join("\n\n"), "Resources");
const feedbackAsk = msg.email("engagement_review", "Feedback request after an engagement", "service", fClientMsgs, "Would you share a few words about working with us?", [
  "Hi {{contact.first_name}},",
  "Thank you for working with {{business.name}}. Feedback from clients is how we get better, and how other organisations decide whether to work with us.",
  "If you're happy to, you can leave a short review here: {{review.link}}",
].join("\n\n"), "Reviews");
const newsletter = msg.email("insights_newsletter", "Insights newsletter", "marketing", fClientMsgs, "Ideas for the quarter ahead", [
  "Hi {{contact.first_name}},",
  "Here are a few ideas we've been discussing with clients this quarter, and the questions we'd ask before acting on them.",
  `Read more of our work here: ${cv(vCases)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");
const briefingInvite = msg.sms("briefing_invite", "Briefing invitation text", "marketing", fClientMsgs,
  `{{business.name}}: we're running a short online briefing for business leaders soon. Reply YES and we'll send you the details. ${SMS_STOP}`, "Events");

// Forms
const enquiryForm = form({
  key: "project-enquiry", name: "Project enquiry", purpose: "consultation", folder: fForms,
  title: "Tell us about your project", intro: "A few questions so our first conversation is useful.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(true), fq.email(), fq.phone(),
    fq.text("job_title", "Your role", { field: role, width: "half" }),
    fq.choice("company_size", "Company size", companySize),
    fq.long("main_challenge", "What would you like help with?", { field: challenge, required: true }),
    fq.choice("decision_timeline", "When do you hope to decide?", decisionTimeline, { display: "radio" }),
    fq.choice("budget_status", "Is there a budget for this?", budgetStatus),
    fq.choice("referral_source", "How did you find us?", source),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my enquiry.",
  marketing: "Email me occasional articles and invitations to events. I can unsubscribe at any time.",
  tags: [tEnquiry],
  deal: { pipeline: engagements, stage: "enquiry", name: "{{contact.full_name}} - consulting enquiry" },
  thanks: "Thank you. We'll read your enquiry and reply within a few working days.",
});
const guideForm = form({
  key: "guide-request", name: "Guide request", purpose: "newsletter", folder: fForms,
  title: "Get the guide", intro: "Enter your details and we'll email you the download link.", submitLabel: "Email me the guide",
  questions: [
    fq.firstName(), fq.email(),
    fq.text("job_title", "Your role", { field: role }),
    fq.choice("company_size", "Company size", companySize),
  ],
  consent: "I agree to be contacted by email about the guide I asked for.",
  marketing: "Email me occasional articles and invitations to events. I can unsubscribe at any time.",
  tags: [tGuide],
  notify: [],
  notifyContactOwner: false,
  thanks: "Thank you. The guide is on its way to your inbox.",
});
const feedbackSurvey = form({
  key: "engagement-feedback", name: "Engagement feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How did our work together go?", intro: "Your answers help us improve. They go only to our team.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("rating", "How would you rate the engagement overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("expectations", "Did it deliver what you expected?", ["Fully", "Mostly", "Partly", "Not really"], { required: true }),
    fq.pick("again", "Would you work with us again?", ["Yes", "Maybe", "No"], { required: true }),
    fq.long("comments", "What should we keep doing, or do differently?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you for your time and your honesty.",
});

// Workflow drafts
const enquiryFlow = workflow("enquiry_follow_up", "Project enquiry follow-up", "Acknowledges a new enquiry, asks the consultant to review it, and suggests a discovery call by text if there's no reply after two days.", fFlows,
  when.tagAdded([tEnquiry]), [
    step.send("acknowledge", enquiryAck, "review"),
    step.task("review", "Review {{contact.first_name}}'s enquiry and reply with next steps", { priority: "high", due: [1, "days"], assignee: consultant, linkOpportunity: true }, "two_days"),
    step.wait("two_days", 2, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", discoveryNudge, null),
  ]);
const callFlow = workflow("call_reminders", "Call confirmation and reminder", "Emails a confirmation when a call or session is booked, and a WhatsApp reminder two hours before.", fFlows,
  when.appointment("appointment.booked", [consultations]), [
    step.send("confirm", callConfirm, "two_hours_before", "appointment_setter"),
    step.beforeAppointment("two_hours_before", 2, "hours", "remind"),
    step.send("remind", callReminder, null, "appointment_setter"),
  ]);
const proposalFlow = workflow("proposal_follow_up", "Proposal follow-up", "Four days after a proposal goes out, emails a check-in if the prospect hasn't replied, then asks the consultant to call.", fFlows,
  when.tagAdded([tProposal]), [
    step.wait("four_days", 4, "days", "replied"),
    step.ifNoReply("replied", "check_in", null),
    step.send("check_in", proposalNudge, "five_days"),
    step.wait("five_days", 5, "days", "still_quiet"),
    step.ifNoReply("still_quiet", "call", null),
    step.task("call", "Call {{contact.first_name}} about the proposal", { due: [1, "days"], assignee: consultant, linkOpportunity: true }, null),
  ]);
const guideFlow = workflow("guide_delivery", "Guide delivery", "Emails the download link when someone requests the guide.", fFlows,
  when.tagAdded([tGuide]), [
    step.send("deliver", guideDelivery, null),
  ]);
const signedFlow = workflow("engagement_signed", "Engagement signed: kick-off", "When an engagement is signed, asks the consultant to send the welcome pack and book the kick-off, and tells the team.", fFlows,
  when.dealWon(engagements), [
    step.task("kick_off", "Send the welcome pack and book the kick-off session", { priority: "high", due: [1, "days"], assignee: consultant, linkOpportunity: true }, "tell_team"),
    step.notify("tell_team", "New engagement signed", { body: "The welcome pack and kick-off are next." }, null),
  ]);
const feedbackFlow = workflow("alumni_feedback", "Feedback request after an engagement", "Two days after a client is marked as a past client, asks for a short review.", fFlows,
  when.tagAdded([tAlumni]), [
    step.wait("two_days", 2, "days", "ask"),
    step.review("ask", feedbackAsk),
  ]);

export const consultingStarter = starter({
  key: "consulting-starter",
  name: "Consulting starter",
  description: "An engagements pipeline and renewals, discovery calls, strategy sessions and client check-ins, project enquiry and guide request forms, engagement feedback, and enquiry, proposal and kick-off drafts for consultants and advisory firms.",
  industry: "consulting",
}, [consultant], {
  folders: [fFit, fSource, fStage, fLists, fProspectMsgs, fClientMsgs, fFlows, fForms, fReports],
  tags: [tIdeal, tEarly, tOutside, tReferral, tEvent, tGuide, tEnquiry, tProposal, tActive, tAlumni],
  customFields: [role, companySize, sector, website, challenge, budgetStatus, decisionTimeline, decisionRole, source, engagementType, contractMonths],
  customValues: [vDiscovery, vCases, vGuide, vOffice, vTerms],
  pipelines: [engagements, renewals],
  calendars: [consultations],
  smartLists: [
    smartList("awaiting-decision", "Proposals awaiting a decision", "Engagements at proposal or negotiation.", fLists, all(has.inStages(engagements, "proposal", "negotiation")), ["email", companySize, "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("deciding-soon", "Deciding this quarter", "Prospects who expect to decide this month or this quarter.", fLists, all(has.choice(decisionTimeline, "This month", "This quarter"), has.noTag(tActive, tOutside)), ["email", decisionTimeline, budgetStatus, "owner"]),
    smartList("new-enquiries", "New enquiries this week", "Enquiries from the last seven days.", fLists, all(has.anyTag(tEnquiry), has.createdWithinDays(7)), ["email", challenge, "created_at"]),
    smartList("quiet-clients", "Clients to check in with", "Active clients with no activity for 30 days.", fLists, all(has.anyTag(tActive), has.noActivityForDays(30)), ["email", "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("nurture", "Not ready yet, open to news", "Good prospects who aren't ready, and who agreed to marketing emails.", fLists, all(has.anyTag(tEarly, tGuide), has.marketingConsent("email")), ["email", companySize, "created_at"]),
  ],
  assignmentRules: [assignmentRule("inbound-enquiries", "Inbound enquiries", all(has.anyTag(tEnquiry), has.unassigned()), [consultant])],
  forms: [enquiryForm, guideForm, feedbackSurvey],
  messageTemplates: [enquiryAck, discoveryNudge, callConfirm, callReminder, proposalNudge, guideDelivery, feedbackAsk, newsletter, briefingInvite],
  workflows: [enquiryFlow, callFlow, proposalFlow, guideFlow, signedFlow, feedbackFlow],
  reports: [
    report("lead-sources", "Where enquiries come from", "New contacts and form submissions by source this quarter.", fReports, ["leads"], { range: "qtd" }),
    report("engagements-pipeline", "Engagements pipeline", "Open opportunities by stage, win rate and time in each stage.", fReports, ["pipeline", "deals"], forPipeline(engagements)),
    report("renewals", "Renewals this year", "Renewals proposed, won and lost.", fReports, ["pipeline", "deals"], forPipeline(renewals, "ytd")),
    report("calls", "Discovery calls and sessions", "Calls booked, held and missed in the last 30 days.", fReports, ["appointments"]),
  ],
});
