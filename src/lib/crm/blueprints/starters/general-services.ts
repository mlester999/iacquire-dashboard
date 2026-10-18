// General Service Businesses starter: a simple sales pipeline, consultations, site visits and video calls, contact and quote request
// forms and a customer feedback survey, with lead, quote, reminder, review and follow-up drafts for any business that sells a service.
// Original iAcquire content; no customer data, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, anyOf, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg,
  pipeline, report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const salesLead = memberSlot("sales-lead", "Sales lead", "Follows up new leads and sends quotes.");
const scheduler = memberSlot("scheduler", "Scheduler", "Takes consultations, site visits and video calls.");

// Folders
const fSource = folder("tag", "source", "Source");
const fInterest = folder("tag", "interest", "Interest");
const fStatus = folder("tag", "status", "Status");
const fLists = folder("smart_list", "daily-follow-up", "Daily follow-up");
const fLeadMsgs = folder("template", "leads", "Leads and quotes");
const fCustomerMsgs = folder("template", "customers", "Customers");
const fFlows = folder("workflow", "follow-up", "Follow-up");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "appointments", "Appointments");
const fReports = folder("report", "business", "Business reports");

// Tags
const tWebsite = tag("website-lead", "Website lead", COLOR.blue, fSource);
const tReferral = tag("referral", "Referral", COLOR.violet, fSource);
const tSocial = tag("social-media", "Social media", COLOR.pink, fSource);
const tWalkIn = tag("walk-in", "Walk-in or phone call", COLOR.slate, fSource);
const tHot = tag("hot-lead", "Hot lead", COLOR.red, fInterest);
const tPrice = tag("price-shopper", "Comparing prices", COLOR.amber, fInterest);
const tRepeat = tag("repeat-customer", "Repeat customer", COLOR.green, fInterest);
const tNew = tag("new-lead", "New lead", COLOR.orange, fStatus, "Added by the website forms; starts the new lead follow-up draft.");
const tQuoteSent = tag("quote-sent", "Quote sent", COLOR.cyan, fStatus, "Add when a quote goes out; starts the quote follow-up draft.");
const tCustomer = tag("customer", "Customer", COLOR.lime, fStatus, "Add when the work is done; starts the review request draft.");

// Fields
const interest = field("contact", "service_interest", "Service of interest", "select", { options: ["One-off service", "Ongoing service", "Consultation", "Not sure yet"], group: "Enquiry" });
const budget = field("contact", "budget", "Budget", "currency", { group: "Enquiry" });
const timeline = field("contact", "timeline", "Timeline", "select", { options: ["As soon as possible", "Within a month", "In a few months", "Just researching"], group: "Enquiry" });
const heardFrom = field("contact", "heard_from", "How they heard about us", "select", { options: ["Search engine", "Social media", "Friend or family", "Repeat customer", "Advert", "Other"], group: "Enquiry" });
const contactTime = field("contact", "best_contact_time", "Best time to contact", "select", { options: ["Morning", "Afternoon", "Evening"], group: "Enquiry" });
const details = field("contact", "job_details", "What they need", "textarea", { group: "Enquiry" });
const customerSince = field("contact", "customer_since", "Customer since", "date", { group: "Customer" });
const nextFollowUp = field("contact", "next_follow_up", "Next follow-up date", "date", { group: "Customer", help: "Set a date and the follow-up draft creates a task for the owner on that day." });
const quoteNumber = field("opportunity", "quote_number", "Quote number", "text");
const serviceDate = field("opportunity", "service_date", "Service date", "date");

// Configuration values
const vAddress = configValue("business_address", "Business address", "text", "Contact details");
const vArea = configValue("service_area", "Service area", "text", "About the business");
const vBooking = configValue("booking_link", "Online booking link", "url", "Links");
const vQuoteTerms = configValue("quote_terms", "Quote validity and terms", "text", "Quotes");

// Pipeline
const sales = pipeline("sales", "Sales", "From a new lead to won work.", true, [
  ["new-lead", "New lead", "open", 10],
  ["contacted", "Contacted", "open", 20, COLOR.cyan],
  ["appointment-set", "Appointment set", "open", 35, COLOR.blue],
  ["quote-sent", "Quote sent", "open", 55, COLOR.amber],
  ["follow-up", "Following up", "open", 65, COLOR.orange],
  ["won", "Won", "won", 100, COLOR.green],
  ["lost", "Lost", "lost", 0],
]);

// Calendar (a draft until hosts, hours and connections are verified in the workspace)
const appointments = calendar("appointments", "Appointments", {
  description: "Free consultations, site visits and video calls.", assignment: "round_robin", color: COLOR.blue, folder: fCalendars,
  bookingIntro: "Choose a time to talk about what you need. There's no obligation.", hours: weekly(MON_FRI, "09:00", "17:00"), hosts: [scheduler],
}, (t) => [
  t("consultation", "Free consultation", {
    description: "A phone call to understand what you need and how we can help.", durationMinutes: 30, minNoticeMinutes: 240, maxDaysAhead: 30, locationKind: "phone",
    locationDetail: "We call the number you give us.", color: COLOR.blue, questions: [ask.long("need", "What would you like to talk about?")],
  }),
  t("site-visit", "Site visit", {
    description: "We come to you to see the job and give you an accurate quote.", durationMinutes: 60, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, minNoticeMinutes: 1440,
    maxDaysAhead: 30, locationKind: "in_person", locationDetail: "At your address", requiresConfirmation: true, color: COLOR.amber,
    questions: [ask.text("address", "Where should we meet you?", true)],
  }),
  t("video-call", "Video call", {
    description: "A video call when it's easier to show us than tell us.", durationMinutes: 30, minNoticeMinutes: 240, maxDaysAhead: 30, locationKind: "video",
    meetingProvider: "google_meet", color: COLOR.cyan,
  }),
]);

// Templates
const leadAck = msg.email("new_lead_received", "New lead: thank you", "service", fLeadMsgs, "Thanks for contacting {{business.name}}", [
  "Hi {{contact.first_name}},",
  `Thank you for getting in touch. We've received your message and will contact you shortly. We work across ${cv(vArea)}.`,
  `If you'd like to choose a time to talk now, you can book a free consultation here: ${cv(vBooking)}`,
  `{{business.name}}
${cv(vAddress)}`,
].join("\n\n"), "Leads");
const leadNudge = msg.sms("new_lead_follow_up", "New lead follow-up text", "service", fLeadMsgs,
  `Hi {{contact.first_name}}, it's {{business.name}} following up on your enquiry. Is now a good time to talk? Reply here or book a time: ${cv(vBooking)}`, "Leads");
const confirm = msg.sms("appointment_confirmation", "Appointment confirmation text", "service", fCustomerMsgs,
  "Hi {{contact.first_name}}, you're all set: {{appointment.type}} with {{business.name}} on {{appointment.date}} at {{appointment.time}}. To reschedule or cancel: {{appointment.manage_link}}", "Appointments");
const reminder = msg.whatsapp("appointment_reminder", "Appointment reminder (WhatsApp)", "service", fCustomerMsgs,
  "Hi {{contact.first_name}}, a reminder of your {{appointment.type}} with {{business.name}} on {{appointment.date}} at {{appointment.time}}. Need another time? {{appointment.manage_link}}", "Appointments");
const quoteNudge = msg.email("quote_follow_up", "Quote follow-up", "service", fLeadMsgs, "Any questions about your quote?", [
  "Hi {{contact.first_name}},",
  "I wanted to check you received our quote and see if you have any questions. Happy to adjust it if your plans have changed.",
  `About our quotes: ${cv(vQuoteTerms)}`,
  "{{user.first_name}}\n{{business.name}}",
].join("\n\n"), "Quotes");
const reviewAsk = msg.sms("review_request", "Review request text", "service", fCustomerMsgs,
  "Hi {{contact.first_name}}, thank you for choosing {{business.name}}. Would you tell us how we did? It takes a minute: {{review.link}}", "Reviews");
const awayReply = msg.canned("away_reply", "Out of hours reply", fCustomerMsgs,
  "Thanks for your message. We're away from the desk right now and will reply as soon as we're back during business hours.", "Replies");
const seasonal = msg.email("seasonal_update", "Seasonal update", "marketing", fCustomerMsgs, "News from {{business.name}}", [
  "Hi {{contact.first_name}},",
  "A quick note from {{business.name}} with what's new this season and how we can help.",
  `If there's something you've been meaning to get done, book a time here: ${cv(vBooking)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");
const comeBack = msg.sms("come_back", "Come back text", "marketing", fCustomerMsgs,
  `{{business.name}}: it's been a while. If you need us again, book a time here: ${cv(vBooking)} ${SMS_STOP}`, "Newsletter");

// Forms
const contactForm = form({
  key: "contact-us", name: "Contact us", purpose: "contact", folder: fForms,
  title: "Get in touch", intro: "Tell us what you need and we'll get back to you.", submitLabel: "Send message",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(),
    fq.choice("service_interest", "What are you interested in?", interest),
    fq.choice("timeline", "When do you need it?", timeline, { display: "radio" }),
    fq.number("budget", "Budget (optional)", { field: budget, min: 0, width: "half" }),
    fq.choice("heard_from", "How did you hear about us?", heardFrom),
    fq.long("job_details", "How can we help?", { field: details, required: true }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my enquiry.",
  marketing: "Email me occasional news and offers. I can unsubscribe at any time.",
  tags: [tNew, tWebsite],
  deal: { pipeline: sales, stage: "new-lead", name: "{{contact.full_name}} - {{answer.service_interest}}", valueQuestion: "budget" },
  thanks: "Thank you. We'll be in touch soon.",
});
const quoteForm = form({
  key: "quote-request", name: "Quote request", purpose: "quote", folder: fForms,
  title: "Request a quote", intro: "Share the details and we'll send you a quote.", submitLabel: "Request a quote",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.address("Address for the work"), fq.postalCode(),
    fq.long("job_details", "Describe what you need", { field: details, required: true }),
    fq.choice("best_contact_time", "Best time to contact you", contactTime),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by phone call, email or text message about my quote.",
  tags: [tNew, tWebsite, tHot],
  deal: { pipeline: sales, stage: "new-lead", name: "{{contact.full_name}} - quote request" },
  thanks: "Thank you. We'll prepare your quote and be in touch.",
});
const feedbackSurvey = form({
  key: "customer-feedback", name: "Customer feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How did we do?", intro: "Your feedback helps us serve you better.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("overall", "How would you rate us overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("value", "Was it good value?", ["Yes", "Mostly", "No"], { required: true }),
    fq.pick("recommend", "Would you recommend us?", ["Yes", "Maybe", "No"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [tRepeat],
  notify: ["owner"],
  thanks: "Thank you for your feedback.",
});

// Workflow drafts
const leadFlow = workflow("new_lead_follow_up", "New lead follow-up", "Thanks a new lead, asks the sales lead to call within the hour, texts after a day without a reply, and creates a last-try task after three more.", fFlows,
  when.tagAdded([tNew]), [
    step.send("thank", leadAck, "call"),
    step.task("call", "Call {{contact.first_name}} about their enquiry", { priority: "urgent", due: [1, "hours"], assignee: salesLead, linkOpportunity: true }, "one_day"),
    step.wait("one_day", 1, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", leadNudge, "three_days"),
    step.wait("three_days", 3, "days", "still_quiet"),
    step.ifNoReply("still_quiet", "last_try", null),
    step.task("last_try", "Try {{contact.first_name}} one last time", { due: [1, "days"], assignee: salesLead, linkOpportunity: true }, null),
  ]);
const reminderFlow = workflow("appointment_reminders", "Appointment confirmation and reminder", "Texts a confirmation when an appointment is booked, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [appointments]), [
    step.send("confirm", confirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", reminder, null, "appointment_setter"),
  ]);
const quoteFlow = workflow("quote_follow_up", "Quote follow-up", "Three days after a quote goes out, emails a check-in if there's no reply, then asks the sales lead to call after four more.", fFlows,
  when.tagAdded([tQuoteSent], "always"), [
    step.wait("three_days", 3, "days", "replied"),
    step.ifNoReply("replied", "check_in", null),
    step.send("check_in", quoteNudge, "four_days"),
    step.wait("four_days", 4, "days", "still_quiet"),
    step.ifNoReply("still_quiet", "call", null),
    step.task("call", "Call {{contact.first_name}} about their quote", { due: [1, "days"], assignee: salesLead, linkOpportunity: true }, null),
  ]);
const reviewFlow = workflow("review_request", "Review request after the work", "Two days after a contact becomes a customer, asks how it went.", fFlows,
  when.tagAdded([tCustomer]), [
    step.wait("two_days", 2, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);
const followUpFlow = workflow("follow_up_date", "Follow-up date reminder", "On the next follow-up date set on a contact, gives the contact's owner a task.", fFlows,
  when.fieldChanged(nextFollowUp), [
    step.untilField("on_the_day", nextFollowUp, 0, "days", "before", "task"),
    step.task("task", "Follow up with {{contact.first_name}} today", { due: [8, "hours"] }, null),
  ]);
const comeBackFlow = workflow("come_back", "Come back (start by hand)", "Someone in the team starts it for a past customer who agreed to marketing texts.", fFlows,
  when.manual(), [
    step.send("invite", comeBack, null),
  ]);

export const generalServicesStarter = starter({
  key: "general-services-starter",
  name: "General Service Businesses starter",
  description: "A simple sales pipeline, free consultations, site visits and video calls, contact and quote request forms, customer feedback, and lead, quote, reminder, review and follow-up drafts for any business that sells a service.",
  industry: "general_services",
}, [salesLead, scheduler], {
  folders: [fSource, fInterest, fStatus, fLists, fLeadMsgs, fCustomerMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tWebsite, tReferral, tSocial, tWalkIn, tHot, tPrice, tRepeat, tNew, tQuoteSent, tCustomer],
  customFields: [interest, budget, timeline, heardFrom, contactTime, details, customerSince, nextFollowUp, quoteNumber, serviceDate],
  customValues: [vAddress, vArea, vBooking, vQuoteTerms],
  pipelines: [sales],
  calendars: [appointments],
  smartLists: [
    smartList("new-today", "New leads in the last day", "Leads that arrived in the last 24 hours and haven't been contacted.", fLists, all(has.createdWithinDays(1), has.status("new")), ["phone", interest, "owner", "created_at"]),
    smartList("hot", "Hot leads", "Leads tagged as hot.", fLists, all(has.anyTag(tHot), has.noTag(tCustomer)), ["phone", interest, timeline, "owner"], { by: "last_activity_at", dir: "desc" }),
    smartList("quotes-out", "Quotes awaiting a reply", "Opportunities with a quote out or being followed up.", fLists, all(has.inStages(sales, "quote-sent", "follow-up")), ["phone", "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("follow-ups", "Follow-ups due this week", "Contacts with a follow-up date in the next seven days.", fLists, all(has.field(nextFollowUp, "within_next_days", 7)), ["phone", nextFollowUp, "owner"]),
    smartList("lapsed-customers", "Customers not seen in six months", "Customers with no activity for 180 days.", fLists, all(anyOf(has.anyTag(tCustomer, tRepeat)), has.noActivityForDays(180)), ["email", customerSince, "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
  ],
  assignmentRules: [assignmentRule("website-leads", "Website leads", all(has.anyTag(tNew), has.unassigned()), [salesLead])],
  forms: [contactForm, quoteForm, feedbackSurvey],
  messageTemplates: [leadAck, leadNudge, confirm, reminder, quoteNudge, reviewAsk, awayReply, seasonal, comeBack],
  workflows: [leadFlow, reminderFlow, quoteFlow, reviewFlow, followUpFlow, comeBackFlow],
  reports: [
    report("lead-sources", "Where leads come from", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("sales-pipeline", "Sales pipeline", "Opportunities by stage, win rate and time in each stage.", fReports, ["pipeline", "deals"], forPipeline(sales)),
    report("appointments", "Appointments", "Consultations, visits and calls in the last 30 days.", fReports, ["appointments"]),
    report("team-workload", "Team workload", "Open and overdue tasks and follow-ups this week.", fReports, ["workload", "followups"], { range: "7d" }),
  ],
});
