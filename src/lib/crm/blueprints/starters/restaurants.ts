// Restaurants starter: private events and catering pipelines, event planning appointments, an event enquiry form, a guest list sign-up and
// a dining feedback survey, with confirmation, reminder and guest-care drafts. Original iAcquire content; no customer data or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, SMS_STOP, TUE_SAT, all, anyOf, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg,
  pipeline, report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const eventsLead = memberSlot("events-manager", "Events manager", "Plans private events and catering orders, and meets guests for walkthroughs and tastings.");

// Folders
const fGuests = folder("tag", "guests", "Guests");
const fOccasions = folder("tag", "occasions", "Occasions");
const fEvents = folder("tag", "events", "Events and catering");
const fLists = folder("smart_list", "front-of-house", "Front of house");
const fEventMsgs = folder("template", "events", "Events and catering");
const fGuestMsgs = folder("template", "guests", "Guest messages");
const fFlows = folder("workflow", "guest-care", "Guest care");
const fForms = folder("form", "website", "Website forms");
const fReports = folder("report", "weekly-numbers", "Weekly numbers");

// Tags
const tRegular = tag("regular", "Regular guest", COLOR.green, fGuests);
const tFirstVisit = tag("first-visit", "First visit", COLOR.cyan, fGuests);
const tVip = tag("vip", "VIP guest", COLOR.violet, fGuests, "Look after them personally when they book.");
const tGuestList = tag("guest-list", "Guest list member", COLOR.lime, fGuests, "Signed up on the guest list form; starts the welcome email draft.");
const tBirthday = tag("birthday", "Birthday", COLOR.pink, fOccasions);
const tAnniversary = tag("anniversary", "Anniversary", COLOR.red, fOccasions);
const tCorporate = tag("corporate", "Corporate event", COLOR.slate, fOccasions);
const tWedding = tag("wedding", "Wedding or engagement", COLOR.amber, fOccasions);
const tEventEnquiry = tag("event-enquiry", "Event enquiry", COLOR.orange, fEvents, "Added by the event enquiry form; starts the enquiry follow-up draft.");
const tCatering = tag("catering", "Catering order", COLOR.blue, fEvents);
const tEventHeld = tag("event-held", "Event held", COLOR.green, fEvents, "Add after the event; starts the thank-you and review request draft.");

// Fields
const eventType = field("contact", "event_type", "Event type", "select", { options: ["Birthday", "Anniversary", "Corporate event", "Wedding or engagement", "Other celebration"], group: "Events" });
const guestCount = field("contact", "guest_count", "Number of guests", "number", { group: "Events" });
const eventDate = field("contact", "event_date", "Event date", "date", { group: "Events" });
const budgetPerGuest = field("contact", "budget_per_guest", "Budget per guest", "currency", { group: "Events" });
const seating = field("contact", "seating_preference", "Seating preference", "select", { options: ["Indoors", "Outdoors or terrace", "Private room", "Bar seating", "No preference"], group: "Guest profile" });
const dietary = field("contact", "dietary_needs", "Dietary needs and allergies", "textarea", { group: "Guest profile", help: "What the guest told you, so the kitchen can plan. Always confirm allergies again before service." });
const birthday = field("contact", "birthday", "Birthday", "date", { group: "Guest profile", help: "Only if the guest chose to share it." });
const visits = field("contact", "visit_frequency", "How often they visit", "select", { options: ["First visit", "Occasionally", "Monthly", "Weekly"], group: "Guest profile" });
const heardFrom = field("contact", "heard_from", "How they heard about us", "select", { options: ["Walked past", "Friend or family", "Social media", "Search or maps", "Review site", "Press or event"], group: "Guest profile" });
const menuPackage = field("opportunity", "menu_package", "Menu package", "select", { options: ["Set menu", "Sharing platters", "Buffet", "Canapes and drinks", "Custom menu"] });
const depositReceived = field("opportunity", "deposit_received", "Deposit received", "boolean", { help: "Tick once the deposit is in your account. iAcquire does not take payments." });

// Configuration values
const vAddress = configValue("restaurant_address", "Restaurant address", "text", "Contact details");
const vHours = configValue("opening_hours", "Opening hours", "text", "Contact details");
const vReservations = configValue("reservations_link", "Reservations page link", "url", "Links");
const vMenu = configValue("menu_link", "Menu page link", "url", "Links");
const vParking = configValue("parking_info", "Parking and access", "text", "Visiting");

// Pipelines
const events = pipeline("events", "Private events", "Parties, celebrations and corporate dinners, from enquiry to the night itself.", true, [
  ["enquiry", "New enquiry", "open", 10],
  ["proposal", "Menu and quote sent", "open", 30, COLOR.blue],
  ["tasting", "Tasting booked", "open", 45, COLOR.cyan],
  ["deposit", "Deposit requested", "open", 60, COLOR.amber],
  ["confirmed", "Confirmed", "open", 85, COLOR.lime],
  ["held", "Event held", "won", 100, COLOR.green],
  ["lost", "Not going ahead", "lost", 0],
]);
const catering = pipeline("catering", "Catering orders", "Food delivered or collected for offices and private parties.", false, [
  ["request", "Order request", "open", 20],
  ["quoted", "Quote sent", "open", 45, COLOR.blue],
  ["confirmed", "Confirmed", "open", 80, COLOR.lime],
  ["delivered", "Delivered", "won", 100, COLOR.green],
  ["declined", "Declined", "lost", 0],
]);

// Calendar (a draft until hosts, hours and booking rules are verified in the workspace)
const planning = calendar("event-planning", "Event planning", {
  description: "Calls, walkthroughs and tastings for private events.", assignment: "single", color: COLOR.orange,
  bookingIntro: "Planning a celebration or a team dinner? Book a time with our events manager.", hours: weekly(TUE_SAT, "10:00", "16:00"), hosts: [eventsLead],
}, (t) => [
  t("planning-call", "Event planning call", {
    description: "A short call about the date, numbers and the kind of evening you have in mind.", durationMinutes: 20, minNoticeMinutes: 240, locationKind: "phone",
    locationDetail: "We call the number you give us.", color: COLOR.orange,
    questions: [ask.text("date", "Which date are you thinking of?"), ask.choice("guests", "Roughly how many guests?", ["Under 20", "20 to 50", "50 to 100", "Over 100"])],
  }),
  t("walkthrough", "Venue walkthrough", {
    description: "See the room and talk through the layout with our events manager.", durationMinutes: 30, bufferAfterMinutes: 10, minNoticeMinutes: 1440, maxDaysAhead: 90,
    locationKind: "in_person", locationDetail: "At the restaurant. Ask for the events manager when you arrive.", color: COLOR.amber,
  }),
  t("tasting", "Menu tasting", {
    description: "Taste the dishes on your shortlist before you decide.", durationMinutes: 60, minNoticeMinutes: 2880, maxDaysAhead: 90, dailyLimit: 2, requiresConfirmation: true,
    locationKind: "in_person", locationDetail: "At the restaurant", color: COLOR.red,
    questions: [ask.long("dietary", "Any dietary needs or allergies we should plan the tasting around?")],
    confirmationMessage: "Thank you. We'll confirm your tasting once the kitchen has checked the date.",
  }),
]);

// Templates
const enquiryAck = msg.email("event_enquiry_received", "Event enquiry: received", "service", fEventMsgs, "Your event at {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Thank you for thinking of us for your event. Our events manager will look at your date and numbers and come back to you with menu ideas and a quote.",
  `While you wait, you can look through our menus here: ${cv(vMenu)}`,
  "If anyone in your party has allergies or dietary needs, just reply and let us know. We plan every event around them.",
  `{{business.name}}\n${cv(vAddress)}`,
].join("\n\n"), "Events");
const proposalNudge = msg.sms("event_proposal_follow_up", "Event quote: follow-up text", "service", fEventMsgs,
  "Hi {{contact.first_name}}, it's {{business.name}}. Did you get a chance to look at the menu and quote for your event? Reply here with any questions and we'll help.", "Events");
const tastingConfirm = msg.sms("tasting_confirmation", "Planning appointment confirmation", "service", fEventMsgs,
  `Hi {{contact.first_name}}, your {{appointment.type}} at {{business.name}} is booked for {{appointment.date}} at {{appointment.time}}. Parking: ${cv(vParking)}. To change it: {{appointment.manage_link}}`, "Appointments");
const tastingReminder = msg.whatsapp("planning_reminder", "Planning appointment reminder (WhatsApp)", "service", fEventMsgs,
  `Hi {{contact.first_name}}, a reminder that your {{appointment.type}} at {{business.name}} is on {{appointment.date}} at {{appointment.time}}. We're at ${cv(vAddress)}. Need another time? {{appointment.manage_link}}`, "Appointments");
const guestWelcome = msg.email("guest_list_welcome", "Guest list: welcome", "service", fGuestMsgs, "You're on the {{business.name}} guest list", [
  "Hi {{contact.first_name}},",
  "Thanks for joining our guest list. We're glad to have you.",
  `Our opening hours are ${cv(vHours)}, and you can book a table any time here: ${cv(vReservations)}`,
  "If you told us your birthday, look out for a note from us around then.",
].join("\n\n"), "Guest list");
const eventThanks = msg.email("event_thank_you", "After the event: thank you and review", "service", fEventMsgs, "Thank you for celebrating with us", [
  "Hi {{contact.first_name}},",
  "Thank you for choosing {{business.name}} for your event. It was a pleasure to host you and your guests.",
  "If you have a moment, we'd love to hear how the evening went: {{review.link}}",
  "We hope to see you again soon.",
].join("\n\n"), "Events");
const birthdayNote = msg.email("birthday_invitation", "Birthday invitation", "marketing", fGuestMsgs, "Celebrate your birthday at {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Your birthday is coming up, and we'd love to help you celebrate it.",
  `Book your table here and mention it's your birthday when you arrive: ${cv(vReservations)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Guest list");
const seasonalMenu = msg.sms("seasonal_menu", "New seasonal menu text", "marketing", fGuestMsgs,
  `{{business.name}}: our new seasonal menu has arrived. Book a table: ${cv(vReservations)} ${SMS_STOP}`, "Guest list");
const allergyReply = msg.canned("allergy_information", "Allergy information reply", fGuestMsgs,
  "Thank you for asking. Our team can talk you through the ingredients in every dish. Please tell your server about any allergies when you order and we'll check each dish with the kitchen.", "Guest questions");

// Forms
const eventForm = form({
  key: "private-event", name: "Private event enquiry", purpose: "inquiry", folder: fForms,
  title: "Plan your event with us", intro: "Tell us a little about your celebration and our events manager will be in touch with menu ideas and a quote.", submitLabel: "Send enquiry",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.choice("event_type", "What are you celebrating?", eventType),
    fq.date("event_date", "Preferred date", { field: eventDate, required: true, width: "half" }),
    fq.number("guest_count", "Number of guests", { field: guestCount, min: 1, max: 500, integer: true, required: true, width: "half" }),
    fq.number("budget_per_guest", "Budget per guest (optional)", { field: budgetPerGuest, min: 0, width: "half" }),
    fq.choice("seating", "Where would you like to sit?", seating),
    fq.long("dietary", "Dietary needs or allergies in your group", { field: dietary }),
    fq.long("details", "Anything else we should know?"),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my event enquiry.",
  marketing: "Email me news about special menus and events. I can unsubscribe at any time.",
  tags: [tEventEnquiry],
  deal: { pipeline: events, stage: "enquiry", name: "{{contact.full_name}} - {{answer.event_type}}" },
  thanks: "Thank you. Our events manager will be in touch about your date soon.",
});
const guestListForm = form({
  key: "guest-list", name: "Join our guest list", purpose: "newsletter", folder: fForms,
  title: "Join our guest list", intro: "Be first to hear about new menus, events and the occasional treat.", submitLabel: "Join the list",
  questions: [
    fq.firstName(), fq.email(),
    fq.date("birthday", "Your birthday (optional)", { field: birthday, help: "We'll only use it to say happy birthday." }),
    fq.choice("heard_from", "How did you hear about us?", heardFrom),
  ],
  consent: "I agree to be contacted by email about my guest list membership.",
  marketing: "Email me new menus, events and offers. I can unsubscribe at any time.",
  tags: [tGuestList],
  notify: ["owner"],
  notifyContactOwner: false,
  thanks: "You're on the list. Welcome!",
});
const feedbackSurvey = form({
  key: "dining-feedback", name: "Dining feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How was your visit?", intro: "Your feedback goes straight to our team.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("overall", "Overall, how was your visit?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("food", "How was the food?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("service", "How was the service?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you. We read every response.",
});

// Workflow drafts
const enquiryFlow = workflow("event_enquiry_follow_up", "Event enquiry follow-up", "Acknowledges a new event enquiry, asks the events manager for a menu and quote, and checks in by text if there's no reply after three days.", fFlows,
  when.tagAdded([tEventEnquiry]), [
    step.send("acknowledge", enquiryAck, "quote_task"),
    step.task("quote_task", "Send {{contact.first_name}} menu ideas and a quote", { priority: "high", due: [1, "days"], assignee: eventsLead, linkOpportunity: true }, "wait_three_days"),
    step.wait("wait_three_days", 3, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", proposalNudge, null),
  ]);
const reminderFlow = workflow("planning_reminders", "Planning appointment confirmation and reminder", "Texts a confirmation for planning calls, walkthroughs and tastings, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [planning]), [
    step.send("confirm", tastingConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", tastingReminder, null, "appointment_setter"),
  ]);
const welcomeFlow = workflow("guest_list_welcome", "Guest list welcome", "Sends the welcome email when someone joins the guest list.", fFlows,
  when.tagAdded([tGuestList]), [
    step.send("welcome", guestWelcome, null),
  ]);
const confirmedFlow = workflow("event_confirmed", "Event confirmed: brief the kitchen", "When an event is confirmed, asks the events manager to send final numbers and dietary needs to the kitchen.", fFlows,
  when.stageReached(events, "confirmed"), [
    step.task("kitchen_brief", "Send final numbers, menu and dietary needs to the kitchen", {
      description: "Confirm allergies with the host again a few days before the event.", priority: "high", due: [2, "days"], assignee: eventsLead, linkOpportunity: true,
    }, "tell_team"),
    step.notify("tell_team", "A private event is confirmed", { body: "Check the date, numbers and menu in the deal." }, null),
  ]);
const thanksFlow = workflow("after_event_thanks", "After the event: thank you and review", "The day after an event is marked as held, thanks the host and asks how it went.", fFlows,
  when.tagAdded([tEventHeld]), [
    step.wait("next_day", 1, "days", "thank"),
    step.review("thank", eventThanks),
  ]);
const birthdayFlow = workflow("birthday_invitation", "Birthday invitation (start by hand)", "Someone in the team starts it for a guest list member with a birthday coming up who agreed to marketing emails.", fFlows,
  when.manual(), [
    step.send("invite", birthdayNote, null),
  ]);

export const restaurantStarter = starter({
  key: "restaurant-starter",
  name: "Restaurants starter",
  description: "Private events and catering pipelines, event planning calls, walkthroughs and tastings, an event enquiry form, a guest list sign-up, dining feedback, and guest-care drafts for a restaurant, bar or café.",
  industry: "restaurants",
}, [eventsLead], {
  folders: [fGuests, fOccasions, fEvents, fLists, fEventMsgs, fGuestMsgs, fFlows, fForms, fReports],
  tags: [tRegular, tFirstVisit, tVip, tGuestList, tBirthday, tAnniversary, tCorporate, tWedding, tEventEnquiry, tCatering, tEventHeld],
  customFields: [eventType, guestCount, eventDate, budgetPerGuest, seating, dietary, birthday, visits, heardFrom, menuPackage, depositReceived],
  customValues: [vAddress, vHours, vReservations, vMenu, vParking],
  pipelines: [events, catering],
  calendars: [planning],
  smartLists: [
    smartList("events-in-planning", "Events in planning", "Event enquiries that are still being planned.", fLists, all(has.inStages(events, "enquiry", "proposal", "tasting", "deposit")), ["phone", eventDate, guestCount, "owner"], { by: "created_at", dir: "asc" }),
    smartList("enquiries-waiting", "Event enquiries waiting on a reply", "We replied last and haven't heard back in three days.", fLists, all(has.anyTag(tEventEnquiry), has.noReplyForDays(3)), ["phone", eventDate, "last_activity_at"]),
    smartList("regulars", "Regulars and VIPs", "Guests to recognise when they book.", fLists, all(has.anyTag(tRegular, tVip)), ["phone", seating, "last_activity_at"], { by: "last_activity_at", dir: "desc" }),
    smartList("birthday-club", "Birthday club", "Guest list members who shared a birthday and agreed to marketing emails.", fLists, all(has.field(birthday, "is_not_empty"), has.marketingConsent("email")), ["email", birthday]),
    smartList("win-back", "Guests we haven't seen in 90 days", "Guest list members with no activity for 90 days who agreed to marketing emails.", fLists, all(has.anyTag(tGuestList), has.noActivityForDays(90), has.marketingConsent("email")), ["email", visits, "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("corporate", "Corporate and catering contacts", "Companies that book events or order catering.", fLists, anyOf(has.anyTag(tCorporate, tCatering)), ["phone", "company", "owner"]),
  ],
  assignmentRules: [assignmentRule("event-enquiries", "Event enquiries", all(has.anyTag(tEventEnquiry), has.unassigned()), [eventsLead])],
  forms: [eventForm, guestListForm, feedbackSurvey],
  messageTemplates: [enquiryAck, proposalNudge, tastingConfirm, tastingReminder, guestWelcome, eventThanks, birthdayNote, seasonalMenu, allergyReply],
  workflows: [enquiryFlow, reminderFlow, welcomeFlow, confirmedFlow, thanksFlow, birthdayFlow],
  reports: [
    report("guest-sign-ups", "Guest sign-ups and enquiries", "New contacts and form submissions this month.", fReports, ["leads"], { range: "mtd" }),
    report("events-pipeline", "Private events pipeline", "Events in planning, confirmed and held.", fReports, ["pipeline", "deals"], forPipeline(events)),
    report("catering-pipeline", "Catering orders", "Catering quotes and confirmed orders.", fReports, ["pipeline", "deals"], forPipeline(catering)),
    report("guest-messages", "Guest messages", "Messages sent and received, by channel, in the last 30 days.", fReports, ["messaging"]),
  ],
});
