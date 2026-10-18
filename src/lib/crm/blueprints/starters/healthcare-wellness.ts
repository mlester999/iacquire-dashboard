// Healthcare & Wellness starter: new client and membership pipelines, intro calls and sessions, a new client enquiry form, a class waitlist
// and a client experience survey, with booking, reminder, review and renewal drafts for wellness clinics, therapists and studios.
//
// Deliberately administrative: no field, form or message asks for or records symptoms, diagnoses or treatment. Clinical details belong in
// the practice's own clinical records system, and the copy says so. Original iAcquire content; no customer data or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const practitioner = memberSlot("practitioner", "Practitioner", "Runs intro calls and sessions.");
const frontDesk = memberSlot("front-desk", "Front desk", "Answers enquiries, books sessions and looks after renewals.");

const NO_CLINICAL = "Keep clinical notes in your clinical records system, not in the CRM.";

// Folders
const fServices = folder("tag", "services", "Services");
const fJourney = folder("tag", "client-journey", "Client journey");
const fLists = folder("smart_list", "front-desk", "Front desk");
const fAppointmentMsgs = folder("template", "appointments", "Appointments");
const fCareMsgs = folder("template", "client-care", "Client care");
const fFlows = folder("workflow", "client-care", "Client care");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "sessions", "Sessions");
const fReports = folder("report", "practice", "Practice reports");

// Tags
const tMassage = tag("massage", "Massage therapy", COLOR.blue, fServices);
const tPhysio = tag("physiotherapy", "Physiotherapy", COLOR.cyan, fServices);
const tNutrition = tag("nutrition", "Nutrition coaching", COLOR.lime, fServices);
const tClasses = tag("classes", "Classes and workshops", COLOR.violet, fServices);
const tEnquiry = tag("new-enquiry", "New client enquiry", COLOR.orange, fJourney, "Added by the new client form; starts the enquiry follow-up draft.");
const tWaitlist = tag("class-waitlist", "Class waitlist", COLOR.amber, fJourney);
const tActive = tag("active-client", "Active client", COLOR.green, fJourney);
const tPackage = tag("package-holder", "Package holder", COLOR.pink, fJourney);
const tMember = tag("member", "Membership", COLOR.red, fJourney);
const tLapsed = tag("lapsed", "Lapsed client", COLOR.slate, fJourney);

// Fields (administrative only)
const serviceInterest = field("contact", "service_interest", "Service of interest", "select", { options: ["Massage therapy", "Physiotherapy", "Nutrition coaching", "Classes and workshops", "Not sure yet"], group: "Enquiry" });
const goal = field("contact", "main_goal", "Main goal", "select", { options: ["Relaxation and stress relief", "Mobility and recovery", "Fitness and performance", "General wellbeing"], group: "Enquiry", help: NO_CLINICAL });
const preferredTimes = field("contact", "preferred_times", "Preferred times", "multiselect", { options: ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"], group: "Scheduling" });
const clientStatus = field("contact", "client_status", "New or returning", "select", { options: ["New client", "Returning client"], group: "Enquiry" });
const firstVisit = field("contact", "first_visit", "First visit", "date", { group: "Client" });
const sessionsLeft = field("contact", "sessions_left", "Sessions left on package", "number", { group: "Client" });
const renewalDate = field("contact", "membership_renewal", "Membership renewal date", "date", { group: "Client" });
const heardFrom = field("contact", "heard_from", "How they heard about us", "select", { options: ["Friend or family", "Doctor or other practitioner", "Search or maps", "Social media", "Walked past"], group: "Enquiry" });
const packageType = field("opportunity", "package_type", "Package", "select", { options: ["Single session", "5-session package", "10-session package", "Monthly membership"] });

// Configuration values
const vAddress = configValue("clinic_address", "Clinic address", "text", "Visiting");
const vParking = configValue("parking_info", "Parking and access", "text", "Visiting");
const vBooking = configValue("booking_link", "Online booking link", "url", "Links");
const vIntake = configValue("intake_form_link", "Clinical intake form link", "url", "Links");
const vCancellation = configValue("cancellation_policy", "Cancellation policy (short)", "text", "Policies");

// Pipelines
const newClients = pipeline("new-clients", "New clients", "From an enquiry to a first package or membership.", true, [
  ["enquiry", "Enquiry", "open", 10],
  ["intro-booked", "Intro session booked", "open", 30, COLOR.cyan],
  ["intro-attended", "Intro session attended", "open", 50, COLOR.blue],
  ["offer-made", "Package offered", "open", 65, COLOR.amber],
  ["purchased", "Package purchased", "won", 100, COLOR.green],
  ["not-ready", "Not ready", "lost", 0],
]);
const memberships = pipeline("memberships", "Membership renewals", "Memberships coming up for renewal.", false, [
  ["renewal-due", "Renewal due", "open", 50],
  ["renewal-offered", "Renewal offered", "open", 70, COLOR.blue],
  ["renewed", "Renewed", "won", 100, COLOR.green],
  ["cancelled", "Cancelled", "lost", 0],
]);

// Calendar (a draft until hosts, hours and connections are verified in the workspace)
const sessions = calendar("sessions", "Sessions", {
  description: "Intro calls, first sessions, follow-up sessions and online sessions.", assignment: "round_robin", color: COLOR.green, folder: fCalendars,
  bookingIntro: "Book a free intro call or your next session. Please don't include medical details when you book; your practitioner will ask what they need.",
  hours: [...weekly(MON_FRI, "08:00", "19:00"), ...weekly([6], "09:00", "14:00")], hosts: [practitioner],
}, (t) => [
  t("intro-call", "Free intro call", {
    description: "Fifteen minutes to talk about what you're looking for and which service suits you.", durationMinutes: 15, minNoticeMinutes: 120, maxDaysAhead: 21,
    locationKind: "phone", locationDetail: "We call the number you give us.", color: COLOR.lime,
  }),
  t("first-session", "First session", {
    description: "Your first full session, with time to get to know you.", durationMinutes: 60, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 45,
    locationKind: "in_person", locationDetail: "At the clinic", color: COLOR.green,
    questions: [ask.choice("heard", "How did you hear about us?", ["Friend or family", "Doctor or other practitioner", "Search or maps", "Social media", "Walked past"], false), ask.text("access", "Do you need any access arrangements?")],
    confirmationMessage: "You're booked. Your confirmation explains how to fill in the clinical intake form before you arrive.",
  }),
  t("follow-up-session", "Follow-up session", {
    description: "A session for returning clients.", durationMinutes: 45, bufferAfterMinutes: 15, minNoticeMinutes: 720, maxDaysAhead: 60,
    locationKind: "in_person", locationDetail: "At the clinic", color: COLOR.blue,
  }),
  t("online-session", "Online session", {
    description: "A session by video call.", durationMinutes: 45, minNoticeMinutes: 720, maxDaysAhead: 60, locationKind: "video", meetingProvider: "google_meet", color: COLOR.violet,
  }),
]);

// Templates
const enquiryAck = msg.email("enquiry_received", "New client enquiry: received", "service", fCareMsgs, "Thanks for your enquiry", [
  "Hi {{contact.first_name}},",
  "Thank you for getting in touch with {{business.name}}. Someone from our front desk will contact you to find a time that suits you.",
  `If you'd like to book straight away, you can choose a time here: ${cv(vBooking)}`,
  "Please don't send medical details by email or text. Your practitioner will ask what they need at your first session.",
].join("\n\n"), "Enquiries");
const introNudge = msg.sms("enquiry_follow_up", "Enquiry follow-up text", "service", fCareMsgs,
  `Hi {{contact.first_name}}, it's {{business.name}}. We'd love to help you get started. Book a free intro call here: ${cv(vBooking)} or reply to this text.`, "Enquiries");
const sessionConfirm = msg.email("session_confirmation", "Session confirmation", "service", fAppointmentMsgs, "Your {{appointment.type}} on {{appointment.date}}", [
  "Hi {{contact.first_name}},",
  "Your {{appointment.type}} with {{business.name}} is booked for {{appointment.date}} at {{appointment.time}}.",
  `Before your first visit, please fill in our clinical intake form in our secure records system: ${cv(vIntake)}`,
  `Getting here: ${cv(vAddress)}. ${cv(vParking)}`,
  `Our cancellation policy: ${cv(vCancellation)} To change your booking: {{appointment.manage_link}}`,
].join("\n\n"), "Appointments");
const sessionReminder = msg.sms("session_reminder", "Session reminder text", "service", fAppointmentMsgs,
  "Hi {{contact.first_name}}, a reminder of your {{appointment.type}} at {{business.name}} on {{appointment.date}} at {{appointment.time}}. To change it: {{appointment.manage_link}}", "Appointments");
const missedSession = msg.whatsapp("missed_session", "Missed session message (WhatsApp)", "service", fAppointmentMsgs,
  `Hi {{contact.first_name}}, we missed you at your {{appointment.type}} today. We hope everything is all right. When you're ready, you can book a new time here: ${cv(vBooking)}`, "Appointments");
const reviewAsk = msg.email("review_request", "Review request", "service", fCareMsgs, "How was your first session?", [
  "Hi {{contact.first_name}},",
  "Thank you for choosing {{business.name}}. We'd love to know how your first session went.",
  "You can share a few words here: {{review.link}}",
  "Please don't include any health details in your review.",
].join("\n\n"), "Reviews");
const renewalReminder = msg.email("membership_renewal", "Membership renewal reminder", "service", fCareMsgs, "Your membership renews soon", [
  "Hi {{contact.first_name}},",
  "Your membership with {{business.name}} is due to renew in the next two weeks.",
  "If you'd like to change your plan, pause it or ask a question, just reply to this email and our front desk will help.",
].join("\n\n"), "Memberships");
const lapsedOffer = msg.sms("welcome_back", "Welcome back text", "marketing", fCareMsgs,
  `{{business.name}}: it's been a while and we'd love to see you again. Book a session here: ${cv(vBooking)} ${SMS_STOP}`, "Offers");
const newsletter = msg.email("wellbeing_newsletter", "Wellbeing newsletter", "marketing", fCareMsgs, "This month at {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Here's what's new this month: classes with open places, workshops coming up, and a few simple ideas to look after yourself between visits.",
  `Book your next session here: ${cv(vBooking)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");

// Forms
const enquiryForm = form({
  key: "new-client-enquiry", name: "New client enquiry", purpose: "appointment_request", folder: fForms,
  title: "Start with us", intro: "Tell us what you're looking for and we'll find the right practitioner and time. Please don't include medical details in this form.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(),
    fq.choice("service_interest", "Which service interests you?", serviceInterest),
    fq.choice("main_goal", "What's your main goal?", goal, { display: "radio" }),
    fq.multi("preferred_times", "When suits you?", preferredTimes),
    fq.choice("client_status", "Have you visited us before?", clientStatus),
    fq.choice("heard_from", "How did you hear about us?", heardFrom),
    fq.long("message", "Anything else we should know?", { help: "Please leave out symptoms and medical history; your practitioner will ask in person." }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my enquiry and appointments.",
  marketing: "Email me class schedules, workshops and offers. I can unsubscribe at any time.",
  tags: [tEnquiry],
  deal: { pipeline: newClients, stage: "enquiry", name: "{{contact.full_name}} - {{answer.service_interest}}" },
  thanks: "Thank you. Our front desk will be in touch to find you a time.",
});
const waitlistForm = form({
  key: "class-waitlist", name: "Class waitlist", purpose: "newsletter", folder: fForms,
  title: "Join the class waitlist", intro: "We'll let you know when a place opens up.", submitLabel: "Join the waitlist",
  questions: [
    fq.firstName(), fq.email(), fq.phone(),
    fq.multi("preferred_times", "When could you come?", preferredTimes, { required: true }),
  ],
  consent: "I agree to be contacted by email or text message about class places.",
  tags: [tClasses, tWaitlist],
  notify: ["owner"],
  notifyContactOwner: false,
  thanks: "You're on the waitlist. We'll be in touch when a place opens.",
});
const experienceSurvey = form({
  key: "client-experience", name: "Client experience survey", kind: "survey", purpose: "survey", folder: fForms,
  title: "How was your experience?", intro: "A few quick questions about booking and your visit. Please don't include health details.", submitLabel: "Send answers",
  questions: [
    fq.email(),
    fq.pick("overall", "How would you rate your visit overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("booking", "How easy was it to book?", ["Very easy", "Easy", "Difficult"], { required: true }),
    fq.pick("welcome", "Did you feel welcome?", ["Yes", "Mostly", "No"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my answers.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you. Your answers help us look after every client better.",
});

// Workflow drafts
const enquiryFlow = workflow("enquiry_follow_up", "New client enquiry follow-up", "Acknowledges a new enquiry, asks the front desk to call, and texts a booking link if there's no reply after two days.", fFlows,
  when.tagAdded([tEnquiry]), [
    step.send("acknowledge", enquiryAck, "call"),
    step.task("call", "Call {{contact.first_name}} to book a first session", { priority: "high", due: [4, "hours"], assignee: frontDesk, linkOpportunity: true }, "two_days"),
    step.wait("two_days", 2, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", introNudge, null),
  ]);
const reminderFlow = workflow("session_reminders", "Session confirmation and reminder", "Emails a confirmation with the intake form link when a session is booked, and texts a reminder the day before.", fFlows,
  when.appointment("appointment.booked", [sessions]), [
    step.send("confirm", sessionConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", sessionReminder, null, "appointment_setter"),
  ]);
const missedFlow = workflow("missed_session", "Missed session follow-up", "Checks in kindly after a missed session and asks the front desk to offer a new time.", fFlows,
  when.appointment("appointment.no_show", [sessions]), [
    step.send("check_in", missedSession, "rebook", "appointment_setter"),
    step.task("rebook", "Offer {{contact.first_name}} a new time", { due: [1, "days"], assignee: frontDesk }, null),
  ]);
const reviewFlow = workflow("first_session_review", "Review request after the first session", "The day after a client's first attended session, asks how it went. Each client is asked once.", fFlows,
  { ...when.appointment("appointment.showed", [sessions]), reentry: "once" }, [
    step.wait("next_day", 1, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);
const renewalFlow = workflow("membership_renewal", "Membership renewal reminder", "Two weeks before a membership renews, emails the member and asks the front desk to follow up.", fFlows,
  when.fieldChanged(renewalDate), [
    step.untilField("two_weeks_before", renewalDate, 14, "days", "before", "remind"),
    step.send("remind", renewalReminder, "follow_up"),
    step.task("follow_up", "Check {{contact.first_name}} is happy to renew", { due: [3, "days"], assignee: frontDesk }, null),
  ]);
const welcomeBackFlow = workflow("welcome_back", "Welcome back (start by hand)", "Someone in the team starts it for a lapsed client who agreed to marketing texts.", fFlows,
  when.manual(), [
    step.send("invite", lapsedOffer, null),
  ]);

export const healthcareWellnessStarter = starter({
  key: "healthcare-wellness-starter",
  name: "Healthcare & Wellness starter",
  description: "New client and membership pipelines, intro calls, first, follow-up and online sessions, a new client enquiry form, a class waitlist, a client experience survey, and booking, reminder, review and renewal drafts for wellness clinics, therapists and studios. Administrative only: no clinical details.",
  industry: "healthcare_wellness",
}, [practitioner, frontDesk], {
  folders: [fServices, fJourney, fLists, fAppointmentMsgs, fCareMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tMassage, tPhysio, tNutrition, tClasses, tEnquiry, tWaitlist, tActive, tPackage, tMember, tLapsed],
  customFields: [serviceInterest, goal, preferredTimes, clientStatus, firstVisit, sessionsLeft, renewalDate, heardFrom, packageType],
  customValues: [vAddress, vParking, vBooking, vIntake, vCancellation],
  pipelines: [newClients, memberships],
  calendars: [sessions],
  smartLists: [
    smartList("unbooked-enquiries", "Enquiries without a booking", "New client enquiries with no appointment yet.", fLists, all(has.anyTag(tEnquiry), has.noAppointments()), ["phone", serviceInterest, "owner", "created_at"], { by: "created_at", dir: "asc" }),
    smartList("upcoming", "Upcoming sessions", "Clients with a session coming up.", fLists, all(has.upcomingAppointment()), ["phone", "owner", "tags"]),
    smartList("packages-low", "Packages running low", "Package holders with one session or fewer left.", fLists, all(has.anyTag(tPackage), has.field(sessionsLeft, "lte", 1)), ["phone", sessionsLeft, "last_activity_at"]),
    smartList("renewals-due", "Renewals in the next 30 days", "Members whose membership renews within a month.", fLists, all(has.field(renewalDate, "within_next_days", 30)), ["email", renewalDate, "owner"]),
    smartList("lapsed", "Clients we haven't seen in 60 days", "Former active clients with no activity for 60 days.", fLists, all(has.anyTag(tActive, tPackage, tLapsed), has.noActivityForDays(60)), ["phone", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("waitlist", "Class waitlist", "People waiting for a class place.", fLists, all(has.anyTag(tWaitlist)), ["email", preferredTimes, "created_at"], { by: "created_at", dir: "asc" }),
  ],
  assignmentRules: [assignmentRule("new-enquiries", "New client enquiries", all(has.anyTag(tEnquiry), has.unassigned()), [frontDesk])],
  forms: [enquiryForm, waitlistForm, experienceSurvey],
  messageTemplates: [enquiryAck, introNudge, sessionConfirm, sessionReminder, missedSession, reviewAsk, renewalReminder, lapsedOffer, newsletter],
  workflows: [enquiryFlow, reminderFlow, missedFlow, reviewFlow, renewalFlow, welcomeBackFlow],
  reports: [
    report("enquiries", "New client enquiries", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("sessions", "Sessions", "Booked, attended, cancelled and missed sessions in the last 30 days.", fReports, ["appointments"]),
    report("new-clients-pipeline", "New client conversion", "Enquiries that became packages or memberships.", fReports, ["pipeline", "deals"], forPipeline(newClients)),
    report("client-messages", "Client messages", "Messages sent and received, by channel, in the last 30 days.", fReports, ["messaging"]),
  ],
});
