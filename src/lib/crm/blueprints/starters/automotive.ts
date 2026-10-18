// Automotive Services starter: a repair jobs pipeline, workshop drop-offs, diagnostics and tyre fitting, service booking and repair quote
// forms, and drop-off, collection, review and service-due drafts for independent garages, tyre centres and body shops.
// Original iAcquire content; no customer data, vehicles, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_FRI, SMS_STOP, all, ask, assignmentRule, calendar, configValue, cv, field, folder, form, forPipeline, fq, has, memberSlot, msg, pipeline,
  report, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const advisor = memberSlot("service-advisor", "Service advisor", "Books vehicles in, sends quotes and keeps customers updated.");

// Folders
const fWork = folder("tag", "work-type", "Work type");
const fCustomer = folder("tag", "customer", "Customer");
const fJob = folder("tag", "job", "Job progress");
const fLists = folder("smart_list", "service-desk", "Service desk");
const fWorkshopMsgs = folder("template", "workshop", "Workshop updates");
const fCareMsgs = folder("template", "customer-care", "Customer care");
const fFlows = folder("workflow", "workshop", "Workshop");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "workshop", "Workshop");
const fReports = folder("report", "workshop", "Workshop reports");

// Tags
const tServicing = tag("servicing", "Servicing", COLOR.blue, fWork);
const tBrakes = tag("brakes", "Brakes", COLOR.red, fWork);
const tTyres = tag("tyres", "Tyres", COLOR.slate, fWork);
const tDiagnostics = tag("diagnostics", "Diagnostics", COLOR.amber, fWork);
const tBodywork = tag("bodywork", "Bodywork", COLOR.violet, fWork);
const tFleet = tag("fleet", "Fleet customer", COLOR.cyan, fCustomer, "A business with several vehicles on account.");
const tCourtesy = tag("courtesy-car", "Needs a courtesy car", COLOR.lime, fCustomer);
const tRequest = tag("booking-request", "Online booking request", COLOR.orange, fJob, "Added by the website forms; starts the booking follow-up draft.");
const tReady = tag("vehicle-ready", "Vehicle ready", COLOR.green, fJob, "Add when the work is done; texts the customer that the vehicle is ready.");
const tCollected = tag("collected", "Vehicle collected", COLOR.pink, fJob, "Add at collection; starts the review request draft.");

// Fields
const make = field("contact", "vehicle_make", "Vehicle make", "text", { group: "Vehicle", help: "The customer's main vehicle." });
const model = field("contact", "vehicle_model", "Vehicle model", "text", { group: "Vehicle" });
const year = field("contact", "vehicle_year", "Vehicle year", "number", { group: "Vehicle" });
const plate = field("contact", "registration", "Registration or plate", "text", { group: "Vehicle" });
const mileage = field("contact", "mileage", "Mileage at last visit", "number", { group: "Vehicle", help: "Miles or kilometres, the way your workshop records them." });
const fuel = field("contact", "fuel_type", "Fuel type", "select", { options: ["Petrol or gasoline", "Diesel", "Hybrid", "Electric"], group: "Vehicle" });
const serviceNeeded = field("contact", "service_needed", "Work needed", "select", { options: ["Routine service", "Brakes", "Tyres", "Warning light or fault", "Bodywork", "Other"], group: "Visit" });
const serviceDue = field("contact", "next_service_due", "Next service due", "date", { group: "Reminders" });
const inspectionDue = field("contact", "inspection_due", "Roadworthiness inspection due", "date", { group: "Reminders", help: "The date of the vehicle's next legally required inspection, where one applies." });
const quoteRef = field("opportunity", "quote_reference", "Quote reference", "text");
const partsOrdered = field("opportunity", "parts_ordered", "Parts ordered", "boolean");

// Configuration values
const vAddress = configValue("workshop_address", "Workshop address", "text", "Visiting");
const vHours = configValue("opening_hours", "Opening hours", "text", "Visiting");
const vBooking = configValue("booking_link", "Online booking link", "url", "Links");
const vDropOff = configValue("drop_off_instructions", "Drop-off and key return instructions", "text", "Visiting");
const vWarranty = configValue("warranty_terms", "Workmanship warranty (short)", "text", "Policies");

// Pipeline
const repairs = pipeline("repairs", "Repair jobs", "From a booking request to a collected, paid job.", true, [
  ["request", "Booking request", "open", 10],
  ["inspection", "Inspection booked", "open", 25, COLOR.cyan],
  ["quote-sent", "Quote sent", "open", 45, COLOR.blue],
  ["approved", "Approved", "open", 70, COLOR.lime],
  ["in-workshop", "In the workshop", "open", 80, COLOR.amber],
  ["ready", "Ready to collect", "open", 95, COLOR.green],
  ["collected", "Collected and paid", "won", 100, COLOR.green],
  ["declined", "Declined", "lost", 0],
]);

// Calendar (a draft until hosts, hours and booking rules are verified in the workspace)
const workshop = calendar("workshop", "Workshop bookings", {
  description: "Drop-offs for servicing and repairs, diagnostic checks and tyre fitting.", assignment: "round_robin", color: COLOR.blue, folder: fCalendars,
  bookingIntro: "Choose a time to bring your vehicle in. We'll confirm the booking and call you before any work beyond the quote.",
  hours: [...weekly(MON_FRI, "08:00", "17:30"), ...weekly([6], "08:00", "12:00")], hosts: [advisor],
}, (t) => [
  t("drop-off", "Drop-off for service or repair", {
    description: "Leave your vehicle with us for the day.", durationMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 45, dailyLimit: 6,
    locationKind: "in_person", locationDetail: "At the workshop reception", color: COLOR.blue,
    questions: [ask.text("plate", "Registration or plate number", true), ask.text("mileage", "Approximate mileage"), ask.choice("courtesy", "Do you need a courtesy car?", ["Yes", "No"])],
  }),
  t("diagnostic", "Diagnostic check", {
    description: "We find out what's causing a warning light, noise or fault and quote before any repair.", durationMinutes: 60, bufferAfterMinutes: 15, minNoticeMinutes: 720,
    maxDaysAhead: 30, locationKind: "in_person", locationDetail: "At the workshop", color: COLOR.amber,
    questions: [ask.long("symptoms", "What is the vehicle doing, and when?", true)],
  }),
  t("tyres", "Tyre fitting", {
    description: "Fitting and balancing while you wait.", durationMinutes: 45, minNoticeMinutes: 240, maxDaysAhead: 30, locationKind: "in_person", locationDetail: "At the workshop",
    color: COLOR.slate, questions: [ask.text("size", "Tyre size, if you know it")],
  }),
]);

// Templates
const requestAck = msg.email("booking_request_received", "Booking request: received", "service", fWorkshopMsgs, "We've received your booking request", [
  "Hi {{contact.first_name}},",
  "Thanks for choosing {{business.name}}. A service advisor will be in touch to confirm a drop-off time and what we'll check.",
  `Our opening hours are ${cv(vHours)}. You'll find us at ${cv(vAddress)}.`,
  `Our workmanship warranty: ${cv(vWarranty)}`,
].join("\n\n"), "Bookings");
const dropOffConfirm = msg.sms("drop_off_confirmation", "Drop-off confirmation text", "service", fWorkshopMsgs,
  `Hi {{contact.first_name}}, your {{appointment.type}} at {{business.name}} is booked for {{appointment.date}} at {{appointment.time}}. ${cv(vDropOff)} To change it: {{appointment.manage_link}}`, "Bookings");
const dropOffReminder = msg.whatsapp("drop_off_reminder", "Drop-off reminder (WhatsApp)", "service", fWorkshopMsgs,
  `Hi {{contact.first_name}}, a reminder that we're expecting your vehicle at {{business.name}} on {{appointment.date}} at {{appointment.time}}. We're at ${cv(vAddress)}. Need another time? {{appointment.manage_link}}`, "Bookings");
const quoteReady = msg.sms("quote_ready", "Quote ready text", "service", fWorkshopMsgs,
  "Hi {{contact.first_name}}, the quote for your vehicle is ready. Reply to this text or call us on {{business.phone}} to go through it. We won't start any work until you approve it.", "Quotes");
const vehicleReady = msg.sms("vehicle_ready", "Vehicle ready text", "service", fWorkshopMsgs,
  `Hi {{contact.first_name}}, good news: your vehicle is ready to collect from {{business.name}}. We're open ${cv(vHours)}.`, "Collection");
const serviceDueEmail = msg.email("service_due", "Service due reminder", "service", fCareMsgs, "Your vehicle's service is due soon", [
  "Hi {{contact.first_name}},",
  "Our records show your vehicle's next service is due in the next couple of weeks. Regular servicing keeps it safe, reliable and protects its value.",
  `Book a drop-off time that suits you here: ${cv(vBooking)}`,
].join("\n\n"), "Reminders");
const reviewAsk = msg.sms("review_request", "Review request text", "service", fCareMsgs,
  "Hi {{contact.first_name}}, thanks for choosing {{business.name}}. How did we do? It takes a minute: {{review.link}}", "Reviews");
const winterCheck = msg.email("winter_check", "Winter check offer", "marketing", fCareMsgs, "Is your vehicle ready for winter?", [
  "Hi {{contact.first_name}},",
  "Cold weather is hard on batteries, tyres and wipers. Our winter check looks at all three, plus lights and fluids, so you're not caught out on a cold morning.",
  `Book your check here: ${cv(vBooking)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Offers");
const tyreOffer = msg.sms("tyre_check", "Tyre check text", "marketing", fCareMsgs,
  `{{business.name}}: is it time to check your tyres? Book a tread and pressure check here: ${cv(vBooking)} ${SMS_STOP}`, "Offers");

// Forms
const serviceForm = form({
  key: "service-booking", name: "Service booking request", purpose: "appointment_request", folder: fForms,
  title: "Book your vehicle in", intro: "Tell us about your vehicle and the work you need, and we'll confirm a drop-off time.", submitLabel: "Request a booking",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.text("vehicle_make", "Make", { field: make, required: true, width: "half" }),
    fq.text("vehicle_model", "Model", { field: model, required: true, width: "half" }),
    fq.number("vehicle_year", "Year", { field: year, min: 1950, max: 2100, integer: true, width: "half" }),
    fq.number("mileage", "Approximate mileage", { field: mileage, min: 0, integer: true, width: "half" }),
    fq.text("registration", "Registration or plate", { field: plate }),
    fq.choice("fuel_type", "Fuel type", fuel),
    fq.choice("service_needed", "What does it need?", serviceNeeded),
    fq.long("details", "Anything else we should know?"),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by phone call, email or text message about my vehicle and this booking.",
  tags: [tRequest],
  deal: { pipeline: repairs, stage: "request", name: "{{contact.full_name}} - {{answer.vehicle_make}} {{answer.vehicle_model}}" },
  thanks: "Thank you. A service advisor will be in touch to confirm your booking.",
});
const quoteForm = form({
  key: "repair-quote", name: "Repair quote request", purpose: "quote", folder: fForms,
  title: "Get a repair quote", intro: "Describe the problem and we'll tell you what we'd check and roughly what it could cost.", submitLabel: "Request a quote",
  questions: [
    fq.firstName(), fq.email(), fq.phone(true),
    fq.text("vehicle_make", "Make", { field: make, required: true, width: "half" }),
    fq.text("vehicle_model", "Model", { field: model, required: true, width: "half" }),
    fq.choice("service_needed", "What kind of work?", serviceNeeded),
    fq.long("problem", "Describe the problem", { required: true }),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my quote.",
  tags: [tRequest],
  deal: { pipeline: repairs, stage: "request", name: "{{contact.first_name}} - quote for {{answer.vehicle_make}}" },
  thanks: "Thank you. We'll be in touch about your quote.",
});
const feedbackSurvey = form({
  key: "service-feedback", name: "Service feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How was your visit?", intro: "Three quick questions about your vehicle's visit.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("overall", "How would you rate the visit overall?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("explained", "Did we explain the work clearly?", ["Yes", "Partly", "No"], { required: true }),
    fq.pick("on_time", "Was your vehicle ready when we said it would be?", ["Yes", "A little late", "No"], { required: true }),
    fq.long("comments", "Anything we could do better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [],
  notify: ["owner"],
  thanks: "Thank you for helping us improve.",
});

// Workflow drafts
const requestFlow = workflow("booking_request_follow_up", "Booking request follow-up", "Acknowledges an online booking or quote request and asks a service advisor to confirm a time.", fFlows,
  when.tagAdded([tRequest]), [
    step.send("acknowledge", requestAck, "confirm_time"),
    step.task("confirm_time", "Confirm a drop-off time with {{contact.first_name}}", { priority: "high", due: [2, "hours"], assignee: advisor, linkOpportunity: true }, null),
  ]);
const reminderFlow = workflow("drop_off_reminders", "Drop-off confirmation and reminder", "Texts a confirmation with drop-off instructions when a booking is made, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [workshop]), [
    step.send("confirm", dropOffConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", dropOffReminder, null, "appointment_setter"),
  ]);
const readyFlow = workflow("vehicle_ready", "Vehicle ready to collect", "Texts the customer as soon as their vehicle is tagged as ready.", fFlows,
  when.tagAdded([tReady], "always"), [
    step.send("tell_customer", vehicleReady, null),
  ]);
const reviewFlow = workflow("collection_review", "Review request after collection", "The day after collection, asks the customer how the visit went.", fFlows,
  when.tagAdded([tCollected], "always"), [
    step.wait("next_day", 1, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);
const serviceDueFlow = workflow("service_due_reminder", "Service due reminder", "Two weeks before a vehicle's next service date, emails a booking reminder, then asks the advisor to call if there's no reply within a week.", fFlows,
  when.fieldChanged(serviceDue), [
    step.untilField("two_weeks_before", serviceDue, 14, "days", "before", "remind"),
    step.send("remind", serviceDueEmail, "one_week"),
    step.wait("one_week", 7, "days", "replied"),
    step.ifNoReply("replied", "call", null),
    step.task("call", "Call {{contact.first_name}} to book their service", { due: [2, "days"], assignee: advisor }, null),
  ]);
const inspectionFlow = workflow("inspection_due_reminder", "Inspection due reminder", "Three weeks before a vehicle's inspection date, asks the advisor to remind the customer personally.", fFlows,
  when.fieldChanged(inspectionDue), [
    step.untilField("three_weeks_before", inspectionDue, 21, "days", "before", "remind"),
    step.task("remind", "Remind {{contact.first_name}} that their vehicle inspection is due", { due: [2, "days"], assignee: advisor }, null),
  ]);

export const automotiveStarter = starter({
  key: "automotive-starter",
  name: "Automotive Services starter",
  description: "A repair jobs pipeline, workshop drop-offs, diagnostic checks and tyre fitting, service booking and repair quote forms, service feedback, and drop-off, collection, review, service-due and inspection drafts for garages, tyre centres and body shops.",
  industry: "automotive",
}, [advisor], {
  folders: [fWork, fCustomer, fJob, fLists, fWorkshopMsgs, fCareMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tServicing, tBrakes, tTyres, tDiagnostics, tBodywork, tFleet, tCourtesy, tRequest, tReady, tCollected],
  customFields: [make, model, year, plate, mileage, fuel, serviceNeeded, serviceDue, inspectionDue, quoteRef, partsOrdered],
  customValues: [vAddress, vHours, vBooking, vDropOff, vWarranty],
  pipelines: [repairs],
  calendars: [workshop],
  smartLists: [
    smartList("service-due", "Service due in 30 days", "Vehicles whose next service is due within a month.", fLists, all(has.field(serviceDue, "within_next_days", 30)), ["phone", make, model, serviceDue], { by: "created_at", dir: "asc" }),
    smartList("inspection-due", "Inspection due in 30 days", "Vehicles whose inspection is due within a month.", fLists, all(has.field(inspectionDue, "within_next_days", 30)), ["phone", make, plate, inspectionDue]),
    smartList("awaiting-approval", "Quotes awaiting approval", "Jobs with a quote sent and no answer yet.", fLists, all(has.inStages(repairs, "quote-sent")), ["phone", make, "owner", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("ready-to-collect", "Ready to collect", "Vehicles that are finished and waiting for their owner.", fLists, all(has.inStages(repairs, "ready")), ["phone", make, model]),
    smartList("fleet", "Fleet customers", "Businesses with several vehicles on account.", fLists, all(has.anyTag(tFleet)), ["phone", "company", "owner"]),
  ],
  assignmentRules: [assignmentRule("online-requests", "Online booking requests", all(has.anyTag(tRequest), has.unassigned()), [advisor])],
  forms: [serviceForm, quoteForm, feedbackSurvey],
  messageTemplates: [requestAck, dropOffConfirm, dropOffReminder, quoteReady, vehicleReady, serviceDueEmail, reviewAsk, winterCheck, tyreOffer],
  workflows: [requestFlow, reminderFlow, readyFlow, reviewFlow, serviceDueFlow, inspectionFlow],
  reports: [
    report("booking-sources", "Where bookings come from", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("repairs-pipeline", "Repair jobs pipeline", "Jobs by stage, approval rate and time in each stage.", fReports, ["pipeline", "deals"], forPipeline(repairs)),
    report("workshop-bookings", "Workshop bookings", "Drop-offs, diagnostics and tyre fittings in the last 30 days.", fReports, ["appointments"]),
    report("customer-updates", "Customer updates", "Messages and follow-ups sent in the last 30 days.", fReports, ["messaging", "followups"]),
  ],
});
