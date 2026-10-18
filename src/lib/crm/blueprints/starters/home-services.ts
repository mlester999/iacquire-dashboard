// Home Services starter: a jobs pipeline and maintenance plan renewals, on-site estimates and service visits, estimate and emergency
// request forms, and follow-up, reminder, review and maintenance drafts for trades such as plumbing, electrical, heating and roofing.
// Original iAcquire content; no customer data, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, anyOf, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg,
  pipeline, report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const estimator = memberSlot("estimator", "Estimator", "Visits properties to price jobs and takes video assessments.");
const coordinator = memberSlot("office-coordinator", "Office coordinator", "Books visits, chases estimates and keeps customers updated.");

// Folders
const fTrade = folder("tag", "trade", "Trade");
const fJob = folder("tag", "job-status", "Job status");
const fCustomer = folder("tag", "customer", "Customer");
const fLists = folder("smart_list", "office", "Office");
const fJobMsgs = folder("template", "estimates-jobs", "Estimates and jobs");
const fCareMsgs = folder("template", "customer-care", "Customer care");
const fFlows = folder("workflow", "job-follow-up", "Job follow-up");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "field-visits", "Field visits");
const fReports = folder("report", "operations", "Operations");

// Tags
const tPlumbing = tag("plumbing", "Plumbing", COLOR.blue, fTrade);
const tElectrical = tag("electrical", "Electrical", COLOR.amber, fTrade);
const tHvac = tag("heating-cooling", "Heating and cooling", COLOR.orange, fTrade);
const tRoofing = tag("roofing", "Roofing", COLOR.slate, fTrade);
const tRepairs = tag("general-repairs", "General repairs", COLOR.cyan, fTrade);
const tEstimateRequested = tag("estimate-requested", "Estimate requested", COLOR.violet, fJob, "Added by the estimate form; starts the request follow-up draft.");
const tEstimateSent = tag("estimate-sent", "Estimate sent", COLOR.blue, fJob, "Add when the estimate goes out; starts the estimate follow-up draft.");
const tJobDone = tag("job-completed", "Job completed", COLOR.green, fJob, "Add when the work is finished; starts the review request draft.");
const tEmergency = tag("emergency", "Emergency call-out", COLOR.red, fCustomer);
const tPlan = tag("maintenance-plan", "Maintenance plan member", COLOR.lime, fCustomer);
const tRepeat = tag("repeat-customer", "Repeat customer", COLOR.pink, fCustomer);

// Fields
const serviceNeeded = field("contact", "service_needed", "Service needed", "select", { options: ["Plumbing", "Electrical", "Heating and cooling", "Roofing", "General repairs", "Not sure"], group: "Job" });
const urgency = field("contact", "urgency", "How urgent", "select", { options: ["Emergency today", "Within a week", "Within a month", "Planning ahead"], group: "Job" });
const jobDetails = field("contact", "job_details", "Job details", "textarea", { group: "Job" });
const propertyType = field("contact", "property_type", "Property type", "select", { options: ["House", "Apartment or flat", "Commercial property"], group: "Property" });
const ownership = field("contact", "ownership", "Owner or tenant", "select", { options: ["Owner", "Tenant", "Property manager"], group: "Property", help: "Tenants usually need the owner's approval before work starts." });
const access = field("contact", "access_notes", "Access and parking notes", "textarea", { group: "Property", help: "Where to park and how to get in. Never store alarm or door codes here." });
const systemAge = field("contact", "system_age", "Age of the system or appliance", "select", { options: ["Under 5 years", "5 to 10 years", "Over 10 years", "Not sure"], group: "Property" });
const visitTime = field("contact", "preferred_visit_time", "Preferred visit time", "select", { options: ["Mornings", "Afternoons", "Any time"], group: "Job" });
const maintenanceDue = field("contact", "maintenance_due", "Next maintenance due", "date", { group: "Maintenance plan" });
const jobAddress = field("opportunity", "job_address", "Job address", "text", { help: "Where the work happens, when it isn't the contact's own address." });
const warrantyMonths = field("opportunity", "warranty_months", "Warranty (months)", "number");

// Configuration values
const vArea = configValue("service_area", "Service area", "text", "About the business");
const vLicence = configValue("licence_number", "Licence or registration number", "text", "Compliance");
const vBooking = configValue("booking_link", "Online booking link", "url", "Links");
const vWarranty = configValue("warranty_link", "Warranty terms page", "url", "Links");
const vPayment = configValue("payment_terms", "Payment terms", "text", "Quotes");

// Pipelines
const jobs = pipeline("jobs", "Jobs", "From a request to a finished job.", true, [
  ["new-request", "New request", "open", 10],
  ["estimate-booked", "Estimate booked", "open", 25, COLOR.cyan],
  ["estimate-sent", "Estimate sent", "open", 45, COLOR.blue],
  ["approved", "Approved", "open", 75, COLOR.lime],
  ["scheduled", "Job scheduled", "open", 85, COLOR.amber],
  ["completed", "Completed", "won", 100, COLOR.green],
  ["lost", "Lost", "lost", 0],
]);
const plans = pipeline("maintenance-plans", "Maintenance plan renewals", "Yearly maintenance plans coming up for renewal.", false, [
  ["renewal-due", "Renewal due", "open", 40],
  ["renewal-offered", "Renewal offered", "open", 60, COLOR.blue],
  ["renewed", "Renewed", "won", 100, COLOR.green],
  ["lapsed", "Lapsed", "lost", 0],
]);

// Calendar (a draft until hosts, hours and connections are verified in the workspace)
const visitsCalendar = calendar("field-visits", "Estimates and service visits", {
  description: "On-site estimates, service visits and quick video assessments.", assignment: "round_robin", color: COLOR.blue, folder: fCalendars,
  bookingIntro: "Choose a time for us to take a look. We'll confirm the visit before we set off.",
  hours: [...weekly(MON_FRI, "08:00", "17:00"), ...weekly([6], "09:00", "13:00")], hosts: [estimator],
}, (t) => [
  t("onsite-estimate", "On-site estimate", {
    description: "We look at the job in person and send you a written estimate.", durationMinutes: 60, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, minNoticeMinutes: 1440,
    maxDaysAhead: 30, locationKind: "in_person", locationDetail: "At your property", color: COLOR.blue,
    questions: [ask.choice("service", "What do you need help with?", ["Plumbing", "Electrical", "Heating and cooling", "Roofing", "General repairs", "Not sure"]), ask.long("access", "Anything we should know about parking or access?")],
  }),
  t("service-visit", "Service visit", {
    description: "A booked repair or maintenance visit.", durationMinutes: 120, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, minNoticeMinutes: 1440, maxDaysAhead: 45,
    dailyLimit: 3, requiresConfirmation: true, locationKind: "in_person", locationDetail: "At your property", color: COLOR.amber,
    confirmationMessage: "Thanks. We'll confirm the visit and the arrival window shortly.",
  }),
  t("video-assessment", "Video assessment", {
    description: "Show us the problem on a video call. We can often tell you what's needed before anyone visits.", durationMinutes: 20, minNoticeMinutes: 120, maxDaysAhead: 14,
    locationKind: "video", meetingProvider: "google_meet", color: COLOR.cyan,
  }),
]);

// Templates
const requestAck = msg.email("estimate_request_received", "Estimate request: received", "service", fJobMsgs, "We've received your request", [
  "Hi {{contact.first_name}},",
  `Thanks for getting in touch with {{business.name}}. We've received your request and someone from the office will call you to arrange a time to take a look. We cover ${cv(vArea)}.`,
  `If you'd rather choose a time yourself, you can book online: ${cv(vBooking)}`,
  `{{business.name}}, licence ${cv(vLicence)}`,
].join("\n\n"), "Requests");
const estimateNudge = msg.sms("estimate_follow_up", "Estimate follow-up text", "service", fJobMsgs,
  "Hi {{contact.first_name}}, it's {{business.name}}. Do you have any questions about your estimate? Reply here and we'll help, or call us on {{business.phone}}.", "Estimates");
const visitConfirm = msg.sms("visit_confirmation", "Visit confirmation text", "service", fJobMsgs,
  "Hi {{contact.first_name}}, thanks for booking with {{business.name}}. Your {{appointment.type}} is on {{appointment.date}} at {{appointment.time}}. Need to change it? {{appointment.manage_link}}", "Visits");
const visitReminder = msg.whatsapp("visit_reminder", "Visit reminder (WhatsApp)", "service", fJobMsgs,
  "Hi {{contact.first_name}}, a reminder that {{business.name}} is booked for your {{appointment.type}} on {{appointment.date}} at {{appointment.time}}. Please make sure we can reach the area we're working on. Need to change it? {{appointment.manage_link}}", "Visits");
const missedVisit = msg.sms("missed_visit", "Missed visit text", "service", fJobMsgs,
  "Hi {{contact.first_name}}, we came for your {{appointment.type}} today but couldn't get in. Reply to this text and we'll find a new time that works.", "Visits");
const reviewAsk = msg.email("job_review_request", "Review request after a job", "service", fCareMsgs, "How did we do, {{contact.first_name}}?", [
  "Hi {{contact.first_name}},",
  "Thank you for choosing {{business.name}}. We hope everything is working as it should.",
  "Would you tell us how the job went? It only takes a minute: {{review.link}}",
  `Your work is covered by our warranty. You'll find the terms here: ${cv(vWarranty)}`,
].join("\n\n"), "Reviews");
const maintenanceReminder = msg.email("maintenance_due", "Maintenance visit due", "service", fCareMsgs, "Your maintenance visit is due soon", [
  "Hi {{contact.first_name}},",
  "Your yearly maintenance visit with {{business.name}} is due in the next couple of weeks. Regular checks keep your system safe and help it last longer.",
  `Choose a time that suits you here: ${cv(vBooking)}`,
].join("\n\n"), "Maintenance");
const seasonalCheck = msg.sms("seasonal_check", "Seasonal check text", "marketing", fCareMsgs,
  `{{business.name}}: book a seasonal check of your heating or cooling before the weather turns: ${cv(vBooking)} ${SMS_STOP}`, "Offers");
const referralEmail = msg.email("referral_invite", "Referral invitation", "marketing", fCareMsgs, "Know someone who needs a hand?", [
  "Hi {{contact.first_name}},",
  "Most of our work comes from customers recommending us to friends and neighbours, and we're grateful for every one.",
  "If you know someone who needs a tradesperson they can trust, just forward this email or reply with how we can help.",
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Offers");
const pricingReply = msg.canned("pricing_question", "Pricing question reply", fJobMsgs,
  `Thanks for asking. Every job is a little different, so we price it after a quick look, on site or on a video call. ${cv(vPayment)}`, "Questions");

// Forms
const estimateForm = form({
  key: "estimate-request", name: "Estimate request", purpose: "quote", folder: fForms,
  title: "Request an estimate", intro: "Tell us about the job and we'll arrange a time to take a look.", submitLabel: "Request my estimate",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.address("Property address"), fq.postalCode(),
    fq.choice("service_needed", "What do you need help with?", serviceNeeded),
    fq.choice("urgency", "How urgent is it?", urgency, { display: "radio" }),
    fq.choice("property_type", "Property type", propertyType),
    fq.choice("ownership", "Do you own the property?", ownership),
    fq.long("job_details", "Describe the job", { field: jobDetails, required: true }),
    fq.choice("visit_time", "When suits you best for a visit?", visitTime),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by phone call, email or text message about my estimate request.",
  tags: [tEstimateRequested],
  deal: { pipeline: jobs, stage: "new-request", name: "{{contact.full_name}} - {{answer.service_needed}}" },
  thanks: "Thank you. We'll call you soon to arrange a time.",
});
const emergencyForm = form({
  key: "emergency-call-out", name: "Emergency call-out request", purpose: "contact", folder: fForms,
  title: "Need help urgently?", intro: "Send us the details and we'll call you back as soon as we can. If anyone is in danger, call the emergency services first.", submitLabel: "Request a call back",
  questions: [
    fq.firstName(), fq.phone(true), fq.email(false),
    fq.address("Address of the emergency"),
    fq.choice("service_needed", "What kind of emergency?", serviceNeeded),
    fq.long("job_details", "What's happening?", { field: jobDetails, required: true }),
  ],
  consent: "I agree to be contacted by phone call, text message or email about this call-out request.",
  tags: [tEmergency],
  deal: { pipeline: jobs, stage: "new-request", name: "{{contact.first_name}} - emergency call-out" },
  thanks: "Thank you. We've alerted the team and will call you back as soon as we can.",
});
const jobSurvey = form({
  key: "job-feedback", name: "Job feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How did we do?", intro: "A few quick questions about your recent job.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("rating", "How would you rate the job overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("on_time", "Did we arrive when we said we would?", ["Yes", "A little late", "Very late"], { required: true }),
    fq.pick("tidy", "Did we leave the work area clean and tidy?", ["Yes", "Mostly", "No"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [tRepeat],
  notify: ["owner"],
  thanks: "Thank you for helping us improve.",
});

// Workflow drafts
const requestFlow = workflow("estimate_request_follow_up", "Estimate request follow-up", "Acknowledges a new request and asks the office to book the estimate visit.", fFlows,
  when.tagAdded([tEstimateRequested]), [
    step.send("acknowledge", requestAck, "book_visit"),
    step.task("book_visit", "Book an estimate visit with {{contact.first_name}}", { priority: "high", due: [2, "hours"], assignee: coordinator, linkOpportunity: true }, null),
  ]);
const estimateFlow = workflow("estimate_follow_up", "Estimate follow-up", "Three days after an estimate goes out, checks in by text if the customer hasn't replied, then asks the office to call.", fFlows,
  when.tagAdded([tEstimateSent]), [
    step.wait("three_days", 3, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", estimateNudge, "four_days"),
    step.wait("four_days", 4, "days", "still_quiet"),
    step.ifNoReply("still_quiet", "call", null),
    step.task("call", "Call {{contact.first_name}} about their estimate", { due: [1, "days"], assignee: coordinator, linkOpportunity: true }, null),
  ]);
const reminderFlow = workflow("visit_reminders", "Visit confirmation and reminder", "Texts a confirmation when a visit is booked and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [visitsCalendar]), [
    step.send("confirm", visitConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", visitReminder, null, "appointment_setter"),
  ]);
const missedFlow = workflow("missed_visit", "Missed visit follow-up", "When nobody was in for a visit, texts the customer and asks the office to rebook.", fFlows,
  when.appointment("appointment.no_show", [visitsCalendar]), [
    step.send("text", missedVisit, "rebook", "appointment_setter"),
    step.task("rebook", "Rebook {{contact.first_name}}'s visit", { due: [1, "days"], assignee: coordinator }, null),
  ]);
const reviewFlow = workflow("job_review", "Review request after a job", "The day after a job is marked complete, asks the customer how it went.", fFlows,
  when.tagAdded([tJobDone]), [
    step.wait("next_day", 1, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);
const maintenanceFlow = workflow("maintenance_reminder", "Maintenance due reminder", "Two weeks before a contact's next maintenance date, emails a booking reminder and asks the office to schedule the visit.", fFlows,
  when.fieldChanged(maintenanceDue), [
    step.untilField("two_weeks_before", maintenanceDue, 14, "days", "before", "remind"),
    step.send("remind", maintenanceReminder, "schedule"),
    step.task("schedule", "Schedule {{contact.first_name}}'s maintenance visit", { due: [3, "days"], assignee: coordinator }, null),
  ]);

export const homeServicesStarter = starter({
  key: "home-services-starter",
  name: "Home Services starter",
  description: "A jobs pipeline and maintenance plan renewals, on-site estimates, service visits and video assessments, estimate and emergency request forms, and follow-up, reminder, review and maintenance drafts for plumbing, electrical, heating, roofing and repair businesses.",
  industry: "home_services",
}, [estimator, coordinator], {
  folders: [fTrade, fJob, fCustomer, fLists, fJobMsgs, fCareMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tPlumbing, tElectrical, tHvac, tRoofing, tRepairs, tEstimateRequested, tEstimateSent, tJobDone, tEmergency, tPlan, tRepeat],
  customFields: [serviceNeeded, urgency, jobDetails, propertyType, ownership, access, systemAge, visitTime, maintenanceDue, jobAddress, warrantyMonths],
  customValues: [vArea, vLicence, vBooking, vWarranty, vPayment],
  pipelines: [jobs, plans],
  calendars: [visitsCalendar],
  smartLists: [
    smartList("open-estimates", "Estimates waiting for a decision", "Estimates sent and not yet approved.", fLists, all(has.inStages(jobs, "estimate-sent")), ["phone", serviceNeeded, "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("emergencies", "Emergency requests this week", "Emergency call-out requests from the last seven days.", fLists, all(has.anyTag(tEmergency), has.createdWithinDays(7)), ["phone", jobDetails, "owner", "created_at"]),
    smartList("maintenance-due", "Maintenance due in 30 days", "Plan members whose next visit is due within a month.", fLists, all(has.field(maintenanceDue, "within_next_days", 30)), ["phone", maintenanceDue, "owner"]),
    smartList("unassigned", "New requests nobody owns yet", "New contacts without an owner.", fLists, all(has.unassigned(), has.status("new")), ["phone", serviceNeeded, urgency, "created_at"]),
    smartList("past-customers", "Past customers open to offers", "Repeat customers and plan members who agreed to marketing texts.", fLists, all(anyOf(has.anyTag(tRepeat, tPlan, tJobDone)), has.marketingConsent("sms")), ["phone", "city", "last_activity_at"]),
  ],
  assignmentRules: [assignmentRule("estimate-requests", "New estimate requests", all(has.anyTag(tEstimateRequested), has.unassigned()), [estimator])],
  forms: [estimateForm, emergencyForm, jobSurvey],
  messageTemplates: [requestAck, estimateNudge, visitConfirm, visitReminder, missedVisit, reviewAsk, maintenanceReminder, seasonalCheck, referralEmail, pricingReply],
  workflows: [requestFlow, estimateFlow, reminderFlow, missedFlow, reviewFlow, maintenanceFlow],
  reports: [
    report("lead-sources", "Where requests come from", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("jobs-pipeline", "Jobs pipeline", "Requests, estimates and completed jobs, with win rate and time in each stage.", fReports, ["pipeline", "deals"], forPipeline(jobs)),
    report("visits", "Estimates and visits", "Booked, completed and missed visits in the last 30 days.", fReports, ["appointments"]),
    report("office-workload", "Office workload", "Open and overdue tasks per person this week.", fReports, ["workload"], { range: "7d" }),
  ],
});
