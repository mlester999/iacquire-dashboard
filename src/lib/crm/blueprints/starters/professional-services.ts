// Professional Services starter: new matters and annual review pipelines, consultations and check-ins, a new enquiry form, a callback
// request and a client satisfaction survey, with intake, document, deadline and engagement drafts for accountants, bookkeepers, law
// firms and other advisers. Original iAcquire content; no customer data, people or business details, and no advice.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, all, anyOf, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const clientManager = memberSlot("client-manager", "Client manager", "Holds consultations and looks after engaged clients.");
const intake = memberSlot("intake-coordinator", "Intake coordinator", "Reviews new enquiries, runs the firm's intake checks and chases documents.");

// Folders
const fClientType = folder("tag", "client-type", "Client type");
const fService = folder("tag", "service", "Service");
const fStatus = folder("tag", "status", "Status");
const fLists = folder("smart_list", "client-desk", "Client desk");
const fMatterMsgs = folder("template", "new-matters", "New matters");
const fServiceMsgs = folder("template", "client-service", "Client service");
const fFlows = folder("workflow", "client-intake", "Client intake");
const fForms = folder("form", "website", "Website forms");
const fReports = folder("report", "firm", "Firm reports");

// Tags
const tIndividual = tag("individual", "Individual", COLOR.blue, fClientType);
const tBusiness = tag("small-business", "Small business", COLOR.green, fClientType);
const tNonProfit = tag("non-profit", "Non-profit", COLOR.lime, fClientType);
const tPartner = tag("referral-partner", "Referral partner", COLOR.violet, fClientType, "Another firm or adviser who introduces clients.");
const tTax = tag("tax-accounting", "Tax and accounting", COLOR.cyan, fService);
const tBookkeeping = tag("bookkeeping", "Bookkeeping", COLOR.slate, fService);
const tLegal = tag("legal", "Legal", COLOR.amber, fService);
const tAdvisory = tag("advisory", "Business advisory", COLOR.pink, fService);
const tEnquiry = tag("new-enquiry", "New enquiry", COLOR.red, fStatus, "Added by the enquiry form; starts the intake draft.");
const tCallback = tag("callback-requested", "Callback requested", COLOR.orange, fStatus);
const tDocuments = tag("documents-requested", "Documents requested", COLOR.amber, fStatus, "Add when you ask for documents; starts the document chaser draft.");
const tLetterSent = tag("engagement-letter-sent", "Engagement letter sent", COLOR.blue, fStatus, "Add when the engagement letter goes out; starts its follow-up draft.");
const tActive = tag("active-client", "Active client", COLOR.green, fStatus, "Starts the satisfaction review draft 30 days later.");

// Fields
const clientType = field("contact", "client_type", "Client type", "select", { options: ["Individual", "Sole trader", "Small business", "Non-profit"], group: "Intake" });
const serviceNeeded = field("contact", "service_needed", "Service needed", "select", { options: ["Tax and accounting", "Bookkeeping", "Legal", "Business advisory", "Other"], group: "Intake" });
const employees = field("contact", "employees", "Number of employees", "select", { options: ["None", "1 to 9", "10 to 49", "50 or more"], group: "Intake" });
const deadline = field("contact", "key_deadline", "Key deadline", "date", { group: "Intake", help: "A filing, court or contract date the client mentioned." });
const deadlineFor = field("contact", "deadline_for", "What the deadline is for", "text", { group: "Intake" });
const yearEnd = field("contact", "financial_year_end", "Financial year end", "date", { group: "Client" });
const docsReceived = field("contact", "documents_received", "Documents received", "boolean", { group: "Client" });
const checksDone = field("contact", "intake_checks_done", "Intake checks done", "boolean", { group: "Intake", help: "Tick once your firm's own intake and conflict checks are complete." });
const source = field("contact", "referral_source", "How they found us", "select", { options: ["Referral partner", "Existing client", "Search engine", "Professional directory", "Social media", "Other"], group: "Intake" });
const feeType = field("opportunity", "fee_type", "Fee arrangement", "select", { options: ["Fixed fee", "Hourly", "Monthly retainer"] });
const engagementRef = field("opportunity", "engagement_reference", "Engagement reference", "text");

// Configuration values
const vOffice = configValue("office_address", "Office address", "text", "Contact details");
const vBooking = configValue("consultation_link", "Consultation booking link", "url", "Links");
const vUpload = configValue("document_upload_link", "Secure document upload link", "url", "Links");
const vFees = configValue("fees_page_link", "Fees and terms page", "url", "Links");
const vRegulatory = configValue("regulatory_statement", "Regulatory statement", "text", "Compliance");

// Pipelines
const matters = pipeline("new-matters", "New matters", "From an enquiry to a signed engagement.", true, [
  ["enquiry", "Enquiry", "open", 10],
  ["intake-review", "Intake review", "open", 20, COLOR.cyan],
  ["consultation", "Consultation held", "open", 35, COLOR.blue],
  ["letter-sent", "Engagement letter sent", "open", 60, COLOR.amber],
  ["engaged", "Engagement signed", "won", 100, COLOR.green],
  ["not-engaged", "Not engaged", "lost", 0],
]);
const reviews = pipeline("annual-reviews", "Annual reviews", "Yearly reviews and renewals with existing clients.", false, [
  ["review-due", "Review due", "open", 50],
  ["review-booked", "Review booked", "open", 70, COLOR.blue],
  ["renewed", "Renewed", "won", 100, COLOR.green],
  ["ended", "Ended", "lost", 0],
]);

// Calendar (a draft until hosts, hours and the Microsoft 365 connection are verified in the workspace)
const consultations = calendar("consultations", "Client consultations", {
  description: "First consultations, office meetings and short check-ins.", assignment: "round_robin", color: COLOR.blue,
  bookingIntro: "Book a first consultation. Please don't send confidential documents before we've agreed to work together.", hours: weekly(MON_FRI, "09:00", "17:00"), hosts: [clientManager],
}, (t) => [
  t("initial-consultation", "Initial consultation", {
    description: "A first video call to understand what you need and how we'd help.", durationMinutes: 30, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 30,
    locationKind: "video", meetingProvider: "microsoft_teams", color: COLOR.blue,
    questions: [ask.long("matter", "Briefly, what do you need help with?", true), ask.choice("client_type", "Are you contacting us as", ["An individual", "A business", "A non-profit"])],
  }),
  t("office-meeting", "Office meeting", {
    description: "An in-person meeting at our office.", durationMinutes: 60, bufferBeforeMinutes: 15, bufferAfterMinutes: 15, minNoticeMinutes: 2880, maxDaysAhead: 45,
    locationKind: "in_person", locationDetail: "At our office", color: COLOR.violet,
  }),
  t("check-in", "Phone check-in", {
    description: "A short call for existing clients.", durationMinutes: 15, minNoticeMinutes: 240, public: false, locationKind: "phone", locationDetail: "We call the number on file.", color: COLOR.green,
  }),
]);

// Templates
const enquiryAck = msg.email("enquiry_received", "Enquiry: received", "service", fMatterMsgs, "We've received your enquiry", [
  "Hi {{contact.first_name}},",
  "Thank you for contacting {{business.name}}. We review every enquiry and will be in touch about next steps, usually after a short intake check.",
  `If you'd like to book a first consultation now, you can choose a time here: ${cv(vBooking)}. Our fees and terms are here: ${cv(vFees)}`,
  "Please don't send confidential documents until we've confirmed we can act for you.",
  `{{business.name}}\n${cv(vRegulatory)}`,
].join("\n\n"), "Enquiries");
const consultConfirm = msg.email("consultation_confirmation", "Consultation confirmation", "service", fMatterMsgs, "Your consultation on {{appointment.date}}", [
  "Hi {{contact.first_name}},",
  "Your {{appointment.type}} with {{business.name}} is confirmed for {{appointment.date}} at {{appointment.time}}.",
  "It helps to have any key dates or letters to hand so we can talk about them. If you need another time, you can change it here: {{appointment.manage_link}}",
  `Our office: ${cv(vOffice)}`,
].join("\n\n"), "Appointments");
const consultReminder = msg.sms("consultation_reminder", "Consultation reminder text", "service", fMatterMsgs,
  "Hi {{contact.first_name}}, a reminder of your {{appointment.type}} with {{business.name}} on {{appointment.date}} at {{appointment.time}}. To change it: {{appointment.manage_link}}", "Appointments");
const docsRequest = msg.email("documents_request", "Document request", "service", fServiceMsgs, "Documents we need from you", [
  "Hi {{contact.first_name}},",
  "To get started, we need a few documents from you. Your client manager will have listed them in our last conversation.",
  `Please upload them through our secure link rather than by email: ${cv(vUpload)}`,
  "If anything is hard to find, reply and let us know. We're happy to help.",
].join("\n\n"), "Documents");
const docsReminder = msg.sms("documents_reminder", "Document reminder text", "service", fServiceMsgs,
  `Hi {{contact.first_name}}, a reminder from {{business.name}} that we're still waiting for a few documents. You can upload them securely here: ${cv(vUpload)}`, "Documents");
const letterNudge = msg.email("engagement_letter_follow_up", "Engagement letter follow-up", "service", fMatterMsgs, "Following up on your engagement letter", [
  "Hi {{contact.first_name}},",
  "We sent you our engagement letter a few days ago. If you have any questions about the scope or the fees, reply to this email and we'll talk them through.",
  "Once it's signed, we'll confirm your client manager and the first steps.",
  "{{user.first_name}}\n{{business.name}}",
].join("\n\n"), "Engagements");
const deadlineReminder = msg.whatsapp("deadline_reminder", "Deadline reminder (WhatsApp)", "service", fServiceMsgs,
  `Hi {{contact.first_name}}, a reminder from {{business.name}} that a deadline we're working towards with you is coming up. If anything is still outstanding, please send it through our secure link: ${cv(vUpload)}`, "Deadlines");
const reviewAsk = msg.email("client_review_request", "Review request", "service", fServiceMsgs, "How are we doing?", [
  "Hi {{contact.first_name}},",
  "You've been working with {{business.name}} for a month now, and we'd value your honest feedback.",
  "If you're happy to, please leave a short review here: {{review.link}}",
].join("\n\n"), "Reviews");
const newsletter = msg.email("client_update", "Client update newsletter", "marketing", fServiceMsgs, "Changes that may affect you this quarter", [
  "Hi {{contact.first_name}},",
  "Here's a short round-up of rule changes and dates coming up this quarter that may affect you or your business. It's general information, not advice: talk to your client manager about your own situation.",
  `Book a review with us here: ${cv(vBooking)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");

// Forms
const enquiryForm = form({
  key: "new-enquiry", name: "New enquiry", purpose: "consultation", folder: fForms,
  title: "How can we help?", intro: "Tell us a little about what you need. Please don't include confidential details; we'll ask for documents through a secure link once we've agreed to work together.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(true), fq.email(), fq.phone(),
    fq.choice("client_type", "Are you contacting us as", clientType),
    fq.choice("service_needed", "Which service do you need?", serviceNeeded),
    fq.choice("employees", "Number of employees", employees),
    fq.date("key_deadline", "Is there a deadline we should know about?", { field: deadline, width: "half" }),
    fq.text("deadline_for", "What is the deadline for?", { field: deadlineFor, width: "half" }),
    fq.choice("referral_source", "How did you find us?", source),
    fq.long("summary", "Briefly, what do you need help with?", { required: true }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my enquiry.",
  marketing: "Email me the firm's occasional updates and event invitations. I can unsubscribe at any time.",
  tags: [tEnquiry],
  deal: { pipeline: matters, stage: "enquiry", name: "{{contact.full_name}} - {{answer.service_needed}}" },
  thanks: "Thank you. We'll review your enquiry and be in touch about next steps.",
});
const callbackForm = form({
  key: "callback-request", name: "Callback request", purpose: "contact", folder: fForms,
  title: "Request a call back", intro: "Leave your number and we'll call you at a time that suits you.", submitLabel: "Request a call",
  questions: [
    fq.firstName(), fq.phone(true), fq.email(false),
    fq.pick("best_time", "When is best to call?", ["Morning", "Afternoon", "Any time"], { required: true }),
    fq.text("topic", "What is it about?"),
  ],
  consent: "I agree to be contacted by phone call, text message or email about my callback request.",
  tags: [tCallback],
  thanks: "Thank you. We'll call you back.",
});
const satisfactionSurvey = form({
  key: "client-satisfaction", name: "Client satisfaction survey", kind: "survey", purpose: "survey", folder: fForms,
  title: "How are we doing?", intro: "Three quick questions. Your answers go to the firm's partners.", submitLabel: "Send answers",
  questions: [
    fq.email(),
    fq.pick("overall", "How satisfied are you with our service?", ["Very satisfied", "Satisfied", "Neutral", "Dissatisfied"], { required: true }),
    fq.pick("responsiveness", "How quickly do we respond?", ["Very quickly", "Quickly enough", "Too slowly"], { required: true }),
    fq.pick("clarity", "Do we explain things clearly?", ["Always", "Usually", "Not often"], { required: true }),
    fq.long("comments", "What could we do better?"),
  ],
  consent: "I agree to be contacted by email about my answers.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you for your feedback.",
});

// Workflow drafts
const intakeFlow = workflow("enquiry_intake", "Enquiry intake", "Acknowledges a new enquiry and asks the intake coordinator to review it and run the firm's intake checks.", fFlows,
  when.tagAdded([tEnquiry]), [
    step.send("acknowledge", enquiryAck, "review"),
    step.task("review", "Review {{contact.first_name}}'s enquiry and run your intake checks", {
      description: "Tick Intake checks done on the contact once your firm's own checks are complete.", priority: "high", due: [1, "days"], assignee: intake, linkOpportunity: true,
    }, null),
  ]);
const reminderFlow = workflow("consultation_reminders", "Consultation confirmation and reminder", "Emails a confirmation when a consultation is booked, and texts a reminder the day before.", fFlows,
  when.appointment("appointment.booked", [consultations]), [
    step.send("confirm", consultConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", consultReminder, null, "appointment_setter"),
  ]);
const docsFlow = workflow("document_chaser", "Document chaser", "Emails the secure upload link, then texts a reminder after five days if the documents haven't been ticked as received, and asks the coordinator to call after five more.", fFlows,
  when.tagAdded([tDocuments], "always"), [
    step.send("request", docsRequest, "five_days"),
    step.wait("five_days", 5, "days", "received"),
    step.ifContact("received", all(has.field(docsReceived, "is_true")), null, "remind"),
    step.send("remind", docsReminder, "five_more_days"),
    step.wait("five_more_days", 5, "days", "still_missing"),
    step.ifContact("still_missing", all(has.field(docsReceived, "is_true")), null, "call"),
    step.task("call", "Call {{contact.first_name}} about the documents we still need", { due: [1, "days"], assignee: intake }, null),
  ]);
const letterFlow = workflow("engagement_letter_follow_up", "Engagement letter follow-up", "Three days after the engagement letter goes out, emails a check-in if the client hasn't replied.", fFlows,
  when.tagAdded([tLetterSent]), [
    step.wait("three_days", 3, "days", "replied"),
    step.ifNoReply("replied", "check_in", null),
    step.send("check_in", letterNudge, null),
  ]);
const deadlineFlow = workflow("deadline_reminder", "Deadline reminder", "A week before a client's key deadline, sends a WhatsApp reminder and asks the client manager to check the work is on track.", fFlows,
  when.fieldChanged(deadline), [
    step.untilField("week_before", deadline, 7, "days", "before", "remind"),
    step.send("remind", deadlineReminder, "check"),
    step.task("check", "Check {{contact.first_name}}'s work is on track for their deadline", { priority: "high", due: [1, "days"], assignee: clientManager }, null),
  ]);
const reviewFlow = workflow("client_review", "Satisfaction review after 30 days", "Thirty days after a client becomes active, asks for a short review.", fFlows,
  when.tagAdded([tActive]), [
    step.wait("thirty_days", 30, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);

export const professionalServicesStarter = starter({
  key: "professional-services-starter",
  name: "Professional Services starter",
  description: "New matters and annual review pipelines, consultations and check-ins, a new enquiry form, a callback request, a client satisfaction survey, and intake, document, deadline and engagement drafts for accountants, bookkeepers, law firms and other advisers.",
  industry: "professional_services",
}, [clientManager, intake], {
  folders: [fClientType, fService, fStatus, fLists, fMatterMsgs, fServiceMsgs, fFlows, fForms, fReports],
  tags: [tIndividual, tBusiness, tNonProfit, tPartner, tTax, tBookkeeping, tLegal, tAdvisory, tEnquiry, tCallback, tDocuments, tLetterSent, tActive],
  customFields: [clientType, serviceNeeded, employees, deadline, deadlineFor, yearEnd, docsReceived, checksDone, source, feeType, engagementRef],
  customValues: [vOffice, vBooking, vUpload, vFees, vRegulatory],
  pipelines: [matters, reviews],
  calendars: [consultations],
  smartLists: [
    smartList("deadlines", "Deadlines in the next 14 days", "Clients with a key deadline in the next two weeks.", fLists, all(has.field(deadline, "within_next_days", 14)), ["phone", deadline, deadlineFor, "owner"], { by: "created_at", dir: "asc" }),
    smartList("waiting-documents", "Waiting for documents", "Asked for documents that haven't been ticked as received.", fLists, all(has.anyTag(tDocuments), anyOf(has.field(docsReceived, "is_false"), has.field(docsReceived, "is_empty"))), ["email", "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("letters-out", "Engagement letters out", "Matters with an engagement letter waiting to be signed.", fLists, all(has.inStages(matters, "letter-sent")), ["email", serviceNeeded, "owner"]),
    smartList("intake-outstanding", "Intake checks outstanding", "New enquiries whose intake checks aren't ticked yet.", fLists, all(has.anyTag(tEnquiry), anyOf(has.field(checksDone, "is_false"), has.field(checksDone, "is_empty"))), ["email", serviceNeeded, "created_at"]),
    smartList("callbacks", "Callback requests", "People who asked us to call them back.", fLists, all(has.anyTag(tCallback), has.status("new", "open")), ["phone", "created_at"], { by: "created_at", dir: "asc" }),
  ],
  assignmentRules: [assignmentRule("new-enquiries", "New enquiries", all(anyOf(has.anyTag(tEnquiry, tCallback)), has.unassigned()), [intake])],
  forms: [enquiryForm, callbackForm, satisfactionSurvey],
  messageTemplates: [enquiryAck, consultConfirm, consultReminder, docsRequest, docsReminder, letterNudge, deadlineReminder, reviewAsk, newsletter],
  workflows: [intakeFlow, reminderFlow, docsFlow, letterFlow, deadlineFlow, reviewFlow],
  reports: [
    report("enquiries", "New enquiries", "New contacts and enquiries by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("matters-pipeline", "New matters pipeline", "Enquiries, consultations and signed engagements.", fReports, ["pipeline", "deals"], forPipeline(matters)),
    report("consultations", "Consultations", "Booked, held and missed consultations in the last 30 days.", fReports, ["appointments"]),
    report("team-workload", "Team workload", "Open and overdue tasks per person this week.", fReports, ["workload", "followups"], { range: "7d" }),
  ],
});
