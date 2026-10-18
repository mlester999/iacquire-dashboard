// Beauty & Salons starter: a bridal and events pipeline, consultations, cuts, colour and patch tests, a new client booking request, a bridal
// enquiry form and a visit feedback survey, with confirmation, reminder, rebooking and review drafts for hair, nail and beauty salons.
// Original iAcquire content; no customer data, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, SMS_STOP, TUE_SAT, all, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const stylist = memberSlot("stylist", "Stylist or therapist", "Takes consultations and client appointments.");
const manager = memberSlot("salon-manager", "Salon manager", "Looks after new clients, bridal parties and the front desk.");

// Folders
const fServices = folder("tag", "services", "Services");
const fClient = folder("tag", "client", "Client");
const fLists = folder("smart_list", "front-desk", "Front desk");
const fAppointmentMsgs = folder("template", "appointments", "Appointments");
const fCareMsgs = folder("template", "client-care", "Client care");
const fFlows = folder("workflow", "client-care", "Client care");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "salon", "Salon");
const fReports = folder("report", "salon", "Salon reports");

// Tags
const tHair = tag("hair", "Hair", COLOR.violet, fServices);
const tColour = tag("colour", "Colour", COLOR.pink, fServices);
const tNails = tag("nails", "Nails", COLOR.red, fServices);
const tSkin = tag("skin", "Skin and facials", COLOR.cyan, fServices);
const tLashes = tag("lashes-brows", "Lashes and brows", COLOR.slate, fServices);
const tBridal = tag("bridal", "Bridal party", COLOR.amber, fServices, "Added by the bridal enquiry form; starts the bridal enquiry draft.");
const tNew = tag("new-client", "New client", COLOR.orange, fClient, "Added by the booking request form; starts the new client draft.");
const tRegular = tag("regular", "Regular client", COLOR.green, fClient);
const tLoyalty = tag("loyalty", "Loyalty member", COLOR.lime, fClient);
const tPatchDone = tag("patch-test-done", "Patch test on file", COLOR.blue, fClient);
const tLapsed = tag("lapsed", "Lapsed client", COLOR.slate, fClient);

// Fields
const services = field("contact", "services_interest", "Services of interest", "multiselect", { options: ["Cut and style", "Colour", "Nails", "Facials", "Lashes and brows", "Bridal"], group: "Preferences" });
const hairLength = field("contact", "hair_length", "Hair length", "select", { options: ["Short", "Medium", "Long", "Extra long"], group: "Preferences", help: "Helps the salon book enough time for colour." });
const patchTest = field("contact", "patch_test_date", "Last patch test", "date", { group: "Safety", help: "Colour and lash tint services need a recent patch test. Record the date it was done." });
const interval = field("contact", "rebook_interval", "Rebooking interval", "select", { options: ["Every 4 weeks", "Every 6 weeks", "Every 8 weeks", "Every 12 weeks"], group: "Preferences" });
const nextVisit = field("contact", "next_visit_due", "Next visit due", "date", { group: "Preferences" });
const birthday = field("contact", "birthday", "Birthday", "date", { group: "Preferences", help: "Only if the client chose to share it." });
const products = field("contact", "product_notes", "Products they like", "textarea", { group: "Preferences" });
const eventDate = field("contact", "event_date", "Wedding or event date", "date", { group: "Bridal" });
const partySize = field("contact", "party_size", "People in the party", "number", { group: "Bridal" });
const heardFrom = field("contact", "heard_from", "How they heard about us", "select", { options: ["Friend or family", "Instagram or TikTok", "Search or maps", "Walked past", "Gift card"], group: "Preferences" });
const depositReceived = field("opportunity", "deposit_received", "Deposit received", "boolean", { help: "Tick once the deposit is in your account. iAcquire does not take payments." });

// Configuration values
const vAddress = configValue("salon_address", "Salon address", "text", "Visiting");
const vParking = configValue("parking_info", "Parking and access", "text", "Visiting");
const vBooking = configValue("booking_link", "Online booking link", "url", "Links");
const vGiftCards = configValue("gift_card_link", "Gift card page", "url", "Links");
const vCancellation = configValue("cancellation_policy", "Cancellation policy (short)", "text", "Policies");

// Pipeline
const bridal = pipeline("bridal", "Bridal and events", "Weddings, proms and other big days, from enquiry to the day itself.", true, [
  ["enquiry", "Enquiry", "open", 10],
  ["consultation", "Consultation booked", "open", 25, COLOR.cyan],
  ["trial", "Trial booked", "open", 45, COLOR.violet],
  ["quote-sent", "Quote sent", "open", 60, COLOR.blue],
  ["confirmed", "Date confirmed", "open", 85, COLOR.lime],
  ["completed", "Completed", "won", 100, COLOR.green],
  ["lost", "Not going ahead", "lost", 0],
]);

// Calendar (a draft until hosts, hours and booking rules are verified in the workspace)
const salon = calendar("salon", "Salon appointments", {
  description: "Consultations, cuts, colour and patch tests.", assignment: "round_robin", color: COLOR.pink, folder: fCalendars,
  bookingIntro: "Choose your appointment. New to colour with us? Book a patch test at least 48 hours before your colour appointment.", hours: weekly(TUE_SAT, "09:00", "18:00"), hosts: [stylist],
}, (t) => [
  t("consultation", "New client consultation", {
    description: "Fifteen minutes to talk through what you'd like before we book the full appointment.", durationMinutes: 15, minNoticeMinutes: 240, maxDaysAhead: 30,
    locationKind: "in_person", locationDetail: "At the salon", color: COLOR.orange,
  }),
  t("cut-style", "Cut and style", {
    description: "A cut, wash and finish.", durationMinutes: 60, bufferAfterMinutes: 15, minNoticeMinutes: 240, maxDaysAhead: 60, locationKind: "in_person",
    locationDetail: "At the salon", color: COLOR.violet, questions: [ask.choice("length", "How long is your hair now?", ["Short", "Medium", "Long", "Extra long"])],
  }),
  t("colour", "Colour appointment", {
    description: "Colour, highlights or toning. Needs a recent patch test.", durationMinutes: 120, bufferAfterMinutes: 15, minNoticeMinutes: 2880, maxDaysAhead: 60,
    locationKind: "in_person", locationDetail: "At the salon", color: COLOR.pink,
    questions: [ask.choice("patch", "Have you had a patch test with us in the last six months?", ["Yes", "No", "Not sure"])],
    confirmationMessage: "Thank you. If you haven't had a patch test with us recently, we'll book one at least 48 hours before your appointment.",
  }),
  t("patch-test", "Patch test", {
    description: "A quick skin test, at least 48 hours before colour or lash tint.", durationMinutes: 10, minNoticeMinutes: 120, maxDaysAhead: 30, locationKind: "in_person",
    locationDetail: "At the salon", color: COLOR.blue,
  }),
]);

// Templates
const requestAck = msg.email("booking_request_received", "New client request: received", "service", fCareMsgs, "Thanks for your booking request", [
  "Hi {{contact.first_name}},",
  "Thank you for choosing {{business.name}}. We'll be in touch to confirm a time with the right stylist for you.",
  `If you'd rather book straight away, you can choose a time here: ${cv(vBooking)}`,
  "If you're booking colour or a lash tint, we'll do a quick patch test at least 48 hours before. It keeps your skin safe.",
].join("\n\n"), "New clients");
const confirm = msg.sms("appointment_confirmation", "Appointment confirmation text", "service", fAppointmentMsgs,
  `Hi {{contact.first_name}}, you're booked in at {{business.name}} for your {{appointment.type}} on {{appointment.date}} at {{appointment.time}}. ${cv(vCancellation)} To change it: {{appointment.manage_link}}`, "Appointments");
const reminder = msg.whatsapp("appointment_reminder", "Appointment reminder (WhatsApp)", "service", fAppointmentMsgs,
  `Hi {{contact.first_name}}, we're looking forward to seeing you for your {{appointment.type}} on {{appointment.date}} at {{appointment.time}}. Parking: ${cv(vParking)}. Need to change it? {{appointment.manage_link}}`, "Appointments");
const missed = msg.sms("missed_appointment", "Missed appointment text", "service", fAppointmentMsgs,
  "Hi {{contact.first_name}}, we missed you for your {{appointment.type}} today. Reply to this text and we'll find you a new time.", "Appointments");
const rebook = msg.sms("rebook_reminder", "Time to rebook text", "service", fCareMsgs,
  `Hi {{contact.first_name}}, it's nearly time for your next visit to {{business.name}}. Book a time that suits you here: ${cv(vBooking)}`, "Rebooking");
const reviewAsk = msg.email("review_request", "Review request", "service", fCareMsgs, "How did we do, {{contact.first_name}}?", [
  "Hi {{contact.first_name}},",
  "Thank you for visiting {{business.name}}. We hope you love the result.",
  "Would you tell us how your visit went? It takes a minute: {{review.link}}",
].join("\n\n"), "Reviews");
const bridalAck = msg.email("bridal_enquiry_received", "Bridal enquiry: received", "service", fCareMsgs, "Your big day with {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Congratulations, and thank you for thinking of us. Our salon manager will be in touch to talk through your day, your party and a trial.",
  `We're at ${cv(vAddress)}.`,
].join("\n\n"), "Bridal");
const birthdayEmail = msg.email("birthday_treat", "Birthday treat", "marketing", fCareMsgs, "Happy birthday from {{business.name}}", [
  "Hi {{contact.first_name}},",
  `Happy birthday from all of us. Treat yourself, or let someone treat you. Our gift cards are here: ${cv(vGiftCards)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Offers");
const quietDay = msg.sms("midweek_availability", "Midweek availability text", "marketing", fCareMsgs,
  `{{business.name}}: we have appointments free midweek. Book yours here: ${cv(vBooking)} ${SMS_STOP}`, "Offers");

// Forms
const bookingForm = form({
  key: "booking-request", name: "New client booking request", purpose: "appointment_request", folder: fForms,
  title: "Book your first visit", intro: "Tell us what you'd like and we'll match you with the right stylist.", submitLabel: "Send request",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.multi("services_interest", "Which services would you like?", services, { required: true }),
    fq.choice("hair_length", "How long is your hair?", hairLength),
    fq.date("preferred_date", "Preferred date", { width: "half" }),
    fq.choice("heard_from", "How did you hear about us?", heardFrom),
    fq.long("message", "Anything we should know?"),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by text message, email or phone call about my appointment request.",
  marketing: "Email me offers, new treatments and a birthday treat. I can unsubscribe at any time.",
  tags: [tNew],
  thanks: "Thank you. We'll be in touch to confirm your appointment.",
});
const bridalForm = form({
  key: "bridal-enquiry", name: "Bridal enquiry", purpose: "consultation", folder: fForms,
  title: "Bridal and special occasions", intro: "Tell us about your day and the people you'd like us to look after.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.date("event_date", "Date of the wedding or event", { field: eventDate, required: true, width: "half" }),
    fq.number("party_size", "How many people need us?", { field: partySize, min: 1, max: 30, integer: true, width: "half" }),
    fq.multi("services_interest", "Which services?", services),
    fq.long("message", "Tell us about the look you have in mind"),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my bridal enquiry.",
  tags: [tBridal],
  deal: { pipeline: bridal, stage: "enquiry", name: "{{contact.full_name}} - bridal" },
  thanks: "Thank you, and congratulations. Our salon manager will be in touch soon.",
});
const feedbackSurvey = form({
  key: "visit-feedback", name: "Visit feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How was your visit?", intro: "Your feedback goes straight to the salon team.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("result", "How happy are you with the result?", ["Love it", "Happy", "Unsure", "Unhappy"], { required: true }),
    fq.pick("welcome", "How was your welcome and care?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("rebook", "Will you visit us again?", ["Yes", "Maybe", "No"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you for telling us.",
});

// Workflow drafts
const newClientFlow = workflow("new_client_request", "New client request follow-up", "Acknowledges a booking request and asks the salon manager to confirm the first appointment.", fFlows,
  when.tagAdded([tNew]), [
    step.send("acknowledge", requestAck, "confirm"),
    step.task("confirm", "Call {{contact.first_name}} to confirm their first appointment", { priority: "high", due: [2, "hours"], assignee: manager }, null),
  ]);
const reminderFlow = workflow("appointment_reminders", "Appointment confirmation and reminder", "Texts a confirmation with the cancellation policy, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [salon]), [
    step.send("confirm", confirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", reminder, null, "appointment_setter"),
  ]);
const missedFlow = workflow("missed_appointment", "Missed appointment follow-up", "Texts a client who missed an appointment and asks the salon manager to rebook.", fFlows,
  when.appointment("appointment.no_show", [salon]), [
    step.send("text", missed, "rebook", "appointment_setter"),
    step.task("rebook", "Rebook {{contact.first_name}}", { due: [1, "days"], assignee: manager }, null),
  ]);
const reviewFlow = workflow("first_visit_review", "Review request after a first visit", "A few hours after a client's first attended appointment, asks how it went. Each client is asked once.", fFlows,
  { ...when.appointment("appointment.showed", [salon]), reentry: "once" }, [
    step.wait("later_today", 4, "hours", "ask"),
    step.review("ask", reviewAsk),
  ]);
const rebookFlow = workflow("rebook_reminder", "Time to rebook", "Three days before a client's next visit is due, texts them a booking link.", fFlows,
  when.fieldChanged(nextVisit), [
    step.untilField("three_days_before", nextVisit, 3, "days", "before", "remind"),
    step.send("remind", rebook, null, "appointment_setter"),
  ]);
const bridalFlow = workflow("bridal_enquiry", "Bridal enquiry follow-up", "Acknowledges a bridal enquiry and asks the salon manager to book a consultation.", fFlows,
  when.tagAdded([tBridal]), [
    step.send("acknowledge", bridalAck, "consult"),
    step.task("consult", "Book a bridal consultation with {{contact.first_name}}", { priority: "high", due: [1, "days"], assignee: manager, linkOpportunity: true }, null),
  ]);

export const beautySalonStarter = starter({
  key: "beauty-salon-starter",
  name: "Beauty & Salons starter",
  description: "A bridal and events pipeline, consultations, cuts, colour and patch tests, a new client booking request, a bridal enquiry form, visit feedback, and confirmation, reminder, rebooking and review drafts for hair, nail and beauty salons.",
  industry: "beauty_salons",
}, [stylist, manager], {
  folders: [fServices, fClient, fLists, fAppointmentMsgs, fCareMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tHair, tColour, tNails, tSkin, tLashes, tBridal, tNew, tRegular, tLoyalty, tPatchDone, tLapsed],
  customFields: [services, hairLength, patchTest, interval, nextVisit, birthday, products, eventDate, partySize, heardFrom, depositReceived],
  customValues: [vAddress, vParking, vBooking, vGiftCards, vCancellation],
  pipelines: [bridal],
  calendars: [salon],
  smartLists: [
    smartList("due-this-week", "Due for a visit this week", "Clients whose next visit is due in the next seven days.", fLists, all(has.field(nextVisit, "within_next_days", 7)), ["phone", nextVisit, interval], { by: "created_at", dir: "asc" }),
    smartList("patch-test-expired", "Patch test older than six months", "Colour clients whose last patch test is more than 180 days old.", fLists, all(has.anyTag(tColour), has.field(patchTest, "more_than_days_ago", 180)), ["phone", patchTest, "last_activity_at"]),
    smartList("lapsed", "Clients we haven't seen in 90 days", "Regular and loyalty clients with no activity for 90 days.", fLists, all(has.anyTag(tRegular, tLoyalty), has.noActivityForDays(90)), ["phone", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("birthday-club", "Birthday club", "Clients who shared a birthday and agreed to marketing emails.", fLists, all(has.field(birthday, "is_not_empty"), has.marketingConsent("email")), ["email", birthday]),
    smartList("bridal-planning", "Bridal parties in planning", "Bridal enquiries that aren't confirmed yet.", fLists, all(has.inStages(bridal, "enquiry", "consultation", "trial", "quote-sent")), ["phone", eventDate, partySize, "owner"]),
  ],
  assignmentRules: [assignmentRule("new-clients", "New client requests", all(has.anyTag(tNew), has.unassigned()), [manager])],
  forms: [bookingForm, bridalForm, feedbackSurvey],
  messageTemplates: [requestAck, confirm, reminder, missed, rebook, reviewAsk, bridalAck, birthdayEmail, quietDay],
  workflows: [newClientFlow, reminderFlow, missedFlow, reviewFlow, rebookFlow, bridalFlow],
  reports: [
    report("new-clients", "New clients", "New contacts and booking requests by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("appointments", "Appointments", "Booked, attended, cancelled and missed appointments in the last 30 days.", fReports, ["appointments"]),
    report("bridal-pipeline", "Bridal and events", "Bridal enquiries, trials and confirmed dates.", fReports, ["pipeline", "deals"], forPipeline(bridal, "ytd")),
    report("client-messages", "Client messages", "Messages sent and received, by channel, in the last 30 days.", fReports, ["messaging"]),
  ],
});
