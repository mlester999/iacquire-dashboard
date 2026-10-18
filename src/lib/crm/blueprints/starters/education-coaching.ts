// Education & Coaching starter: enrolment and team programme pipelines, discovery calls, trial and coaching sessions, an enrolment
// enquiry, a free guide request and an end-of-programme survey, with enquiry, reminder, welcome and review drafts for tutors, coaches,
// course creators and training providers. Original iAcquire content; no customer data, learners, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const coach = memberSlot("coach", "Coach or tutor", "Takes discovery calls, trial sessions and coaching sessions.");
const admissions = memberSlot("enrolment-advisor", "Enrolment advisor", "Answers enquiries and helps people choose the right programme.");

// Folders
const fLearner = folder("tag", "learner", "Learner");
const fProgramme = folder("tag", "programme", "Programme");
const fJourney = folder("tag", "journey", "Journey");
const fLists = folder("smart_list", "enrolments", "Enrolments");
const fEnrolMsgs = folder("template", "enrolment", "Enrolment");
const fLearnerMsgs = folder("template", "learners", "Learners");
const fFlows = folder("workflow", "learner-journey", "Learner journey");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "sessions", "Sessions");
const fReports = folder("report", "programmes", "Programme reports");

// Tags
const tAdult = tag("adult-learner", "Adult learner", COLOR.blue, fLearner);
const tParent = tag("parent", "Parent or guardian", COLOR.cyan, fLearner, "Enquiring on behalf of a young learner.");
const tTeam = tag("business-team", "Business team", COLOR.slate, fLearner);
const tOneToOne = tag("one-to-one", "One-to-one coaching", COLOR.violet, fProgramme);
const tGroup = tag("group-programme", "Group programme", COLOR.lime, fProgramme);
const tCourse = tag("online-course", "Online course", COLOR.amber, fProgramme);
const tEnquiry = tag("enquiry", "Enquiry", COLOR.orange, fJourney, "Added by the enrolment enquiry form; starts the enquiry follow-up draft.");
const tGuide = tag("guide-requested", "Free guide requested", COLOR.pink, fJourney, "Added by the guide form; starts the guide delivery draft.");
const tEnrolled = tag("enrolled", "Enrolled", COLOR.green, fJourney, "Add when someone enrols; starts the welcome draft.");
const tCompleted = tag("programme-completed", "Programme completed", COLOR.red, fJourney, "Add at the end of a programme; starts the review request draft.");

// Fields
const learnerType = field("contact", "learner_type", "Who the learning is for", "select", { options: ["Myself", "My child", "My team"], group: "Enquiry" });
const ageGroup = field("contact", "learner_age_group", "Learner age group", "select", { options: ["Under 12", "12 to 17", "18 and over"], group: "Enquiry", help: "Only the age group, never a date of birth." });
const subject = field("contact", "subject_area", "Subject or goal area", "select", { options: ["Academic tutoring", "Language learning", "Career coaching", "Leadership coaching", "Creative skills"], group: "Enquiry" });
const level = field("contact", "current_level", "Current level", "select", { options: ["Beginner", "Intermediate", "Advanced"], group: "Enquiry" });
const format = field("contact", "preferred_format", "Preferred format", "select", { options: ["Online", "In person", "Either"], group: "Enquiry" });
const availability = field("contact", "availability", "Availability", "multiselect", { options: ["Weekday mornings", "Weekday afternoons", "Weekday evenings", "Weekends"], group: "Scheduling" });
const goals = field("contact", "goals", "Goals", "textarea", { group: "Enquiry", help: "What they want to be able to do by the end." });
const startDate = field("contact", "preferred_start", "Preferred start date", "date", { group: "Scheduling" });
const sessionsLeft = field("contact", "sessions_remaining", "Sessions remaining", "number", { group: "Learner" });
const programme = field("opportunity", "programme", "Programme", "select", { options: ["One-to-one sessions", "Group programme", "Online course", "Team workshop"] });
const sessionsBought = field("opportunity", "sessions_purchased", "Sessions purchased", "number");

// Configuration values
const vBooking = configValue("discovery_call_link", "Discovery call booking link", "url", "Links");
const vGuide = configValue("guide_link", "Free guide download link", "url", "Links");
const vProgrammes = configValue("programme_guide_link", "Programme guide page", "url", "Links");
const vPortal = configValue("learner_portal_link", "Learner portal link", "url", "Links");
const vRefunds = configValue("refund_policy", "Refund policy (short)", "text", "Policies");

// Pipelines
const enrolments = pipeline("enrolments", "Enrolments", "From an enquiry to an enrolled learner.", true, [
  ["enquiry", "Enquiry", "open", 10],
  ["discovery", "Discovery call held", "open", 25, COLOR.cyan],
  ["trial", "Trial session", "open", 45, COLOR.violet],
  ["offer-sent", "Offer sent", "open", 60, COLOR.amber],
  ["enrolled", "Enrolled", "won", 100, COLOR.green],
  ["not-enrolling", "Not enrolling", "lost", 0],
]);
const teams = pipeline("team-programmes", "Team programmes", "Workshops and programmes for organisations.", false, [
  ["brief", "Brief received", "open", 15],
  ["proposal", "Proposal sent", "open", 45, COLOR.blue],
  ["pilot", "Pilot agreed", "open", 70, COLOR.lime],
  ["contracted", "Contracted", "won", 100, COLOR.green],
  ["declined", "Declined", "lost", 0],
]);

// Calendar (a draft until hosts, hours and the Google connection are verified in the workspace)
const sessions = calendar("coaching-sessions", "Coaching sessions", {
  description: "Discovery calls, trial sessions, coaching sessions and progress reviews.", assignment: "round_robin", color: COLOR.violet, folder: fCalendars,
  bookingIntro: "Start with a free discovery call, or book your next session.", hours: [...weekly(MON_FRI, "09:00", "20:00"), ...weekly([6], "09:00", "13:00")], hosts: [coach],
}, (t) => [
  t("discovery-call", "Free discovery call", {
    description: "Twenty minutes to talk about your goals and which programme fits.", durationMinutes: 20, minNoticeMinutes: 240, maxDaysAhead: 30,
    locationKind: "video", meetingProvider: "google_meet", color: COLOR.violet,
    questions: [ask.choice("for", "Who is the learning for?", ["Myself", "My child", "My team"]), ask.long("goal", "What would you like to achieve?")],
  }),
  t("trial-session", "Trial session", {
    description: "A full-length session so you can see how we work.", durationMinutes: 45, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 30,
    locationKind: "video", meetingProvider: "google_meet", color: COLOR.lime,
  }),
  t("coaching-session", "Coaching session", {
    description: "A regular session for enrolled learners.", durationMinutes: 60, bufferAfterMinutes: 15, minNoticeMinutes: 720, maxDaysAhead: 60, public: false,
    locationKind: "video", meetingProvider: "google_meet", color: COLOR.blue,
  }),
  t("progress-review", "Progress review", {
    description: "A short call to look back at progress and plan what's next.", durationMinutes: 30, minNoticeMinutes: 720, public: false, locationKind: "phone",
    locationDetail: "We call the number on file.", color: COLOR.amber,
  }),
]);

// Templates
const enquiryAck = msg.email("enquiry_received", "Enrolment enquiry: received", "service", fEnrolMsgs, "Thanks for your enquiry", [
  "Hi {{contact.first_name}},",
  "Thank you for getting in touch with {{business.name}}. We'll look at your goals and come back with the programme we think fits best.",
  `The quickest way to get started is a free discovery call. Choose a time here: ${cv(vBooking)}`,
  `You can also read about our programmes here: ${cv(vProgrammes)}`,
].join("\n\n"), "Enquiries");
const discoveryNudge = msg.sms("discovery_nudge", "Discovery call nudge text", "service", fEnrolMsgs,
  `Hi {{contact.first_name}}, it's {{business.name}}. Would a free 20-minute discovery call help you choose a programme? Book here: ${cv(vBooking)}`, "Enquiries");
const sessionConfirm = msg.email("session_confirmation", "Session confirmation", "service", fLearnerMsgs, "Booked: {{appointment.type}} on {{appointment.date}}", [
  "Hi {{contact.first_name}},",
  "Your {{appointment.type}} with {{business.name}} is booked for {{appointment.date}} at {{appointment.time}}.",
  "Find a quiet spot with a good connection, and have a note of anything you'd like to cover. If you need another time: {{appointment.manage_link}}",
].join("\n\n"), "Sessions");
const sessionReminder = msg.whatsapp("session_reminder", "Session reminder (WhatsApp)", "service", fLearnerMsgs,
  "Hi {{contact.first_name}}, just a reminder that your {{appointment.type}} with {{business.name}} is on {{appointment.date}} at {{appointment.time}}. Talk soon! If you need to move it: {{appointment.manage_link}}", "Sessions");
const missedSession = msg.sms("missed_session", "Missed session text", "service", fLearnerMsgs,
  "Hi {{contact.first_name}}, we missed you at your {{appointment.type}} today. Reply to this text and we'll find a new time.", "Sessions");
const welcome = msg.email("welcome_enrolled", "Welcome after enrolling", "service", fLearnerMsgs, "Welcome to {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Welcome aboard. We're looking forward to working with you.",
  `Your learner portal is here: ${cv(vPortal)}. Your coach will be in touch to plan your first session.`,
  `For reference, our refund policy: ${cv(vRefunds)}`,
].join("\n\n"), "Enrolment");
const guideDelivery = msg.email("guide_delivery", "Free guide delivery", "service", fEnrolMsgs, "Your free guide", [
  "Hi {{contact.first_name}},",
  `Here's the guide you asked for: ${cv(vGuide)}`,
  `If you'd like help putting it into practice, book a free discovery call: ${cv(vBooking)}`,
].join("\n\n"), "Resources");
const reviewAsk = msg.email("review_request", "Review request after a programme", "service", fLearnerMsgs, "Congratulations on finishing, {{contact.first_name}}", [
  "Hi {{contact.first_name}},",
  "Congratulations on completing your programme with {{business.name}}. It's been a pleasure working with you.",
  "Would you share a few words about your experience? It helps other learners decide: {{review.link}}",
].join("\n\n"), "Reviews");
const courseNews = msg.email("new_course", "New course announcement", "marketing", fLearnerMsgs, "A new programme is open for enrolment", [
  "Hi {{contact.first_name}},",
  "We've opened enrolment for a new programme, and as someone who's learned with us we wanted you to hear first.",
  `Read the details and dates here: ${cv(vProgrammes)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");
const placesOpen = msg.sms("places_open", "Places open text", "marketing", fLearnerMsgs,
  `{{business.name}}: places are open on our next group programme. Details: ${cv(vProgrammes)} ${SMS_STOP}`, "Newsletter");

// Forms
const enquiryForm = form({
  key: "enrolment-enquiry", name: "Enrolment enquiry", purpose: "qualification", folder: fForms,
  title: "Find the right programme", intro: "Tell us about your goals. If you're enquiring for a child, please give your own name and contact details.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(),
    fq.choice("learner_type", "Who is the learning for?", learnerType, { display: "radio" }),
    fq.choice("learner_age_group", "Learner's age group", ageGroup),
    fq.choice("subject_area", "What would you like to work on?", subject),
    fq.choice("current_level", "Current level", level),
    fq.choice("preferred_format", "Online or in person?", format, { display: "radio" }),
    fq.multi("availability", "When are you available?", availability),
    fq.date("preferred_start", "When would you like to start?", { field: startDate }),
    fq.long("goals", "What would you like to achieve?", { field: goals }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my enquiry.",
  marketing: "Email me free resources and news about new programmes. I can unsubscribe at any time.",
  tags: [tEnquiry],
  deal: { pipeline: enrolments, stage: "enquiry", name: "{{contact.full_name}} - {{answer.subject_area}}" },
  thanks: "Thank you. We'll be in touch with a suggestion and a time to talk.",
});
const guideForm = form({
  key: "free-guide", name: "Free guide request", purpose: "newsletter", folder: fForms,
  title: "Get the free guide", intro: "Tell us where to send it and we'll email you the link straight away.", submitLabel: "Email me the guide",
  questions: [
    fq.firstName(), fq.email(),
    fq.choice("subject_area", "What are you working on?", subject),
    fq.choice("current_level", "Current level", level),
  ],
  consent: "I agree to be contacted by email about the guide I requested.",
  marketing: "Email me tips and programme news. I can unsubscribe at any time.",
  tags: [tGuide],
  notify: [],
  notifyContactOwner: false,
  thanks: "Thank you. Check your inbox for the guide.",
});
const programmeSurvey = form({
  key: "programme-survey", name: "End of programme survey", kind: "survey", purpose: "survey", folder: fForms,
  title: "How was your programme?", intro: "A few questions to help us improve the next one.", submitLabel: "Send answers",
  questions: [
    fq.email(),
    fq.pick("overall", "How would you rate the programme overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("goals_met", "Did you reach the goals you set?", ["Yes", "Partly", "Not yet"], { required: true }),
    fq.pick("recommend", "Would you recommend us to a friend?", ["Yes", "Maybe", "No"], { required: true }),
    fq.long("comments", "What should we change for the next group?"),
  ],
  consent: "I agree to be contacted by email about my answers.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you for helping us improve.",
});

// Workflow drafts
const enquiryFlow = workflow("enquiry_follow_up", "Enrolment enquiry follow-up", "Acknowledges a new enquiry, asks the enrolment advisor to call, and suggests a discovery call by text if there's no reply after two days.", fFlows,
  when.tagAdded([tEnquiry]), [
    step.send("acknowledge", enquiryAck, "call"),
    step.task("call", "Call {{contact.first_name}} about their goals", { priority: "high", due: [1, "days"], assignee: admissions, linkOpportunity: true }, "two_days"),
    step.wait("two_days", 2, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", discoveryNudge, null),
  ]);
const reminderFlow = workflow("session_reminders", "Session confirmation and reminder", "Emails a confirmation when a call or session is booked, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [sessions]), [
    step.send("confirm", sessionConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", sessionReminder, null, "appointment_setter"),
  ]);
const missedFlow = workflow("missed_session", "Missed session follow-up", "Texts a learner who missed a session and asks the coach to rebook.", fFlows,
  when.appointment("appointment.no_show", [sessions]), [
    step.send("text", missedSession, "rebook", "appointment_setter"),
    step.task("rebook", "Rebook {{contact.first_name}}'s session", { due: [1, "days"], assignee: coach }, null),
  ]);
const welcomeFlow = workflow("welcome_enrolled", "Welcome after enrolling", "Sends the welcome email with the learner portal link, asks the coach to plan the first session, and marks the contact as a customer.", fFlows,
  when.tagAdded([tEnrolled]), [
    step.send("welcome", welcome, "plan"),
    step.task("plan", "Plan {{contact.first_name}}'s first session", { due: [2, "days"], assignee: coach, linkOpportunity: true }, "status"),
    step.leadStatus("status", "customer", null),
  ]);
const guideFlow = workflow("guide_delivery", "Free guide delivery", "Sends the free guide's download link to everyone who asks for it.", fFlows,
  when.tagAdded([tGuide]), [
    step.send("deliver", guideDelivery, null),
  ]);
const reviewFlow = workflow("completion_review", "Review request after a programme", "Two days after a learner completes a programme, asks for a short review.", fFlows,
  when.tagAdded([tCompleted], "always"), [
    step.wait("two_days", 2, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);

export const educationCoachingStarter = starter({
  key: "education-coaching-starter",
  name: "Education & Coaching starter",
  description: "Enrolment and team programme pipelines, discovery calls, trial and coaching sessions and progress reviews, an enrolment enquiry, a free guide request, an end-of-programme survey, and enquiry, reminder, welcome and review drafts for tutors, coaches and training providers.",
  industry: "education_coaching",
}, [coach, admissions], {
  folders: [fLearner, fProgramme, fJourney, fLists, fEnrolMsgs, fLearnerMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tAdult, tParent, tTeam, tOneToOne, tGroup, tCourse, tEnquiry, tGuide, tEnrolled, tCompleted],
  customFields: [learnerType, ageGroup, subject, level, format, availability, goals, startDate, sessionsLeft, programme, sessionsBought],
  customValues: [vBooking, vGuide, vProgrammes, vPortal, vRefunds],
  pipelines: [enrolments, teams],
  calendars: [sessions],
  smartLists: [
    smartList("no-discovery-call", "Enquiries without a discovery call", "Enquiries with no appointment booked yet.", fLists, all(has.anyTag(tEnquiry), has.noAppointments()), ["phone", subject, "owner", "created_at"], { by: "created_at", dir: "asc" }),
    smartList("offers-out", "Offers waiting for an answer", "Enrolments at trial or offer stage.", fLists, all(has.inStages(enrolments, "trial", "offer-sent")), ["email", subject, "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("low-sessions", "Learners low on sessions", "Enrolled learners with two sessions or fewer left.", fLists, all(has.anyTag(tEnrolled), has.field(sessionsLeft, "lte", 2)), ["email", sessionsLeft, "owner"]),
    smartList("starting-soon", "Starting in the next 30 days", "People who want to start within a month.", fLists, all(has.field(startDate, "within_next_days", 30), has.noTag(tEnrolled)), ["phone", startDate, subject]),
    smartList("alumni", "Alumni open to news", "Past learners who agreed to marketing emails.", fLists, all(has.anyTag(tCompleted), has.marketingConsent("email")), ["email", subject, "last_activity_at"]),
  ],
  assignmentRules: [assignmentRule("enquiries", "New enrolment enquiries", all(has.anyTag(tEnquiry), has.unassigned()), [admissions])],
  forms: [enquiryForm, guideForm, programmeSurvey],
  messageTemplates: [enquiryAck, discoveryNudge, sessionConfirm, sessionReminder, missedSession, welcome, guideDelivery, reviewAsk, courseNews, placesOpen],
  workflows: [enquiryFlow, reminderFlow, missedFlow, welcomeFlow, guideFlow, reviewFlow],
  reports: [
    report("enquiries", "Enquiries and sign-ups", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("enrolments-pipeline", "Enrolments", "Enquiries that became enrolled learners.", fReports, ["pipeline", "deals"], forPipeline(enrolments)),
    report("team-programmes", "Team programmes", "Briefs, proposals and contracted programmes this year.", fReports, ["pipeline", "deals"], forPipeline(teams, "ytd")),
    report("sessions", "Calls and sessions", "Booked, held and missed sessions in the last 30 days.", fReports, ["appointments"]),
  ],
});
