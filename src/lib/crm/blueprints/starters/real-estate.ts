// Real Estate starter: buyer and seller pipelines, showings and home valuations, buyer and valuation forms, and follow-up drafts for an
// agency or a small brokerage team. Original iAcquire content; no customer data, people or business details.
import {
  COLOR, EMAIL_UNSUBSCRIBE, MON_SAT, SMS_STOP, ask, anyOf, assignmentRule, calendar, configValue, cv, field, folder, form, fq, has, all, memberSlot, msg, pipeline,
  report, forPipeline, smartList, starter, step, tag, weekly, when, workflow,
} from "@/lib/crm/blueprints/starters/kit";

const buyerAgent = memberSlot("buyer-agent", "Buyer's agent", "Takes buyer consultations and showings, and follows up new buyer enquiries.");
const listingAgent = memberSlot("listing-agent", "Listing agent", "Visits homes for valuations and looks after sellers.");

// Folders
const fType = folder("tag", "lead-type", "Lead type");
const fTimeline = folder("tag", "timeline", "Moving timeline");
const fStatus = folder("tag", "progress", "Progress");
const fLists = folder("smart_list", "agent-desk", "Agent desk");
const fBuyerMsgs = folder("template", "buyers", "Buyer messages");
const fSellerMsgs = folder("template", "sellers", "Seller messages");
const fFlows = folder("workflow", "lead-care", "Lead care");
const fForms = folder("form", "website", "Website forms");
const fCalendars = folder("calendar", "viewings", "Viewings and valuations");
const fReports = folder("report", "weekly-review", "Weekly review");

// Tags
const tBuyer = tag("buyer", "Buyer", COLOR.blue, fType, "Looking to buy a home.");
const tSeller = tag("seller", "Seller", COLOR.green, fType, "Thinking of selling a home.");
const tInvestor = tag("investor", "Investor", COLOR.violet, fType, "Buying to rent out or renovate.");
const tFirstTime = tag("first-time-buyer", "First-time buyer", COLOR.cyan, fType);
const tReadyNow = tag("ready-now", "Moving within 3 months", COLOR.red, fTimeline);
const tSoon = tag("moving-soon", "Moving in 3 to 12 months", COLOR.amber, fTimeline);
const tBrowsing = tag("browsing", "Just browsing", COLOR.slate, fTimeline);
const tWebEnquiry = tag("web-enquiry", "Website enquiry", COLOR.orange, fStatus, "Added by the website forms; starts the enquiry follow-up draft.");
const tPreApproved = tag("pre-approved", "Mortgage pre-approved", COLOR.lime, fStatus);
const tValuation = tag("valuation-requested", "Valuation requested", COLOR.pink, fStatus);
const tPastClient = tag("past-client", "Past client", COLOR.violet, fStatus, "Bought or sold with us. Starts the review request draft.");

// Fields
const propertyType = field("contact", "property_type", "Property type", "select", { options: ["House", "Apartment or condo", "Townhouse", "Multi-family", "Land"], group: "Home search" });
const budgetMax = field("contact", "budget_max", "Budget up to", "currency", { group: "Home search", help: "The most they want to spend, in your workspace's currency." });
const bedrooms = field("contact", "bedrooms", "Bedrooms", "number", { group: "Home search" });
const areas = field("contact", "preferred_areas", "Preferred areas", "textarea", { group: "Home search", help: "Neighbourhoods, school zones or streets they mentioned." });
const timeline = field("contact", "move_timeline", "Moving timeline", "select", { options: ["Within 3 months", "3 to 6 months", "6 to 12 months", "Just exploring"], group: "Home search" });
const financing = field("contact", "financing", "Financing", "select", { options: ["Pre-approved", "Applying for a mortgage", "Paying cash", "Not started"], group: "Home search" });
const currentHome = field("contact", "current_home", "Current home", "select", { options: ["Renting", "Own and need to sell", "Own and keeping it", "Living with family"], group: "Situation" });
const saleAddress = field("contact", "sale_property_address", "Address of the home to sell", "text", { group: "Selling" });
const sellReason = field("contact", "selling_reason", "Reason for selling", "select", { options: ["Moving up", "Downsizing", "Relocating", "Investment property", "Other"], group: "Selling" });
const listPrice = field("opportunity", "list_price", "List price", "currency", { help: "The asking price agreed with the seller." });
const listingRef = field("opportunity", "listing_reference", "Listing reference", "text", { help: "The listing or MLS number once the home is listed." });

// Configuration values
const vBrokerage = configValue("brokerage_name", "Brokerage name", "text", "Compliance");
const vLicence = configValue("licence_number", "Licence number", "text", "Compliance");
const vOffice = configValue("office_address", "Office address", "text", "Contact details");
const vBooking = configValue("consultation_link", "Buyer consultation booking link", "url", "Links");
const vListings = configValue("listings_link", "Current listings page", "url", "Links");

// Pipelines
const buyers = pipeline("buyers", "Buyers", "From the first enquiry to the keys.", true, [
  ["new-enquiry", "New enquiry", "open", 10],
  ["consultation", "Consultation held", "open", 20],
  ["viewing", "Actively viewing", "open", 35, COLOR.cyan],
  ["offer-made", "Offer made", "open", 60, COLOR.amber],
  ["under-contract", "Under contract", "open", 80, COLOR.lime],
  ["closed", "Closed", "won", 100, COLOR.green],
  ["lost", "Lost", "lost", 0],
]);
const sellers = pipeline("sellers", "Sellers", "From a valuation request to the sale.", false, [
  ["valuation-requested", "Valuation requested", "open", 10],
  ["valuation-done", "Valuation done", "open", 25],
  ["agreement-signed", "Listing agreement signed", "open", 50, COLOR.blue],
  ["listed", "On the market", "open", 65, COLOR.cyan],
  ["under-contract", "Under contract", "open", 85, COLOR.lime],
  ["sold", "Sold", "won", 100, COLOR.green],
  ["withdrawn", "Withdrawn", "lost", 0],
]);

// Calendars (drafts until hosts, hours and connections are verified in the workspace)
const buyerCalendar = calendar("buyer-meetings", "Buyer meetings", {
  description: "Consultations and property showings for buyers.", assignment: "round_robin", color: COLOR.blue, folder: fCalendars,
  bookingIntro: "Book a time to talk about your home search, or to see a property with one of our agents.", hours: weekly(MON_SAT, "09:00", "18:00"), hosts: [buyerAgent],
}, (t) => [
  t("consultation", "Buyer consultation", {
    description: "A video call about areas, budget, financing and timing, so we only show you homes that fit.", durationMinutes: 45, bufferAfterMinutes: 15,
    minNoticeMinutes: 240, maxDaysAhead: 30, locationKind: "video", meetingProvider: "google_meet", color: COLOR.blue,
    questions: [ask.text("areas", "Which areas are you looking in?"), ask.choice("financing", "Where are you with financing?", ["Pre-approved", "Applying for a mortgage", "Paying cash", "Not started yet"])],
    confirmationMessage: "You're booked in. We look forward to talking about your search.",
  }),
  t("showing", "Property showing", {
    description: "A visit to one property with an agent.", durationMinutes: 30, bufferBeforeMinutes: 15, bufferAfterMinutes: 15, minNoticeMinutes: 1440, maxDaysAhead: 21,
    locationKind: "in_person", locationDetail: "At the property. Your agent confirms the address and where to meet.", requiresConfirmation: true, color: COLOR.cyan,
    questions: [ask.text("listing", "Which property would you like to see?", true), ask.long("notes", "Anything we should know before the visit?")],
    confirmationMessage: "Thanks. Your agent will confirm the showing once the seller agrees to the time.",
  }),
]);
const valuationCalendar = calendar("valuations", "Home valuations", {
  description: "Valuation visits and selling strategy calls for homeowners.", assignment: "single", color: COLOR.green, folder: fCalendars,
  bookingIntro: "Find out what your home could sell for. A valuation is free and there's no obligation to sell.", hours: weekly(MON_SAT, "09:00", "17:00"), hosts: [listingAgent],
}, (t) => [
  t("valuation-visit", "Home valuation visit", {
    description: "We look around your home and talk you through comparable sales.", durationMinutes: 60, bufferBeforeMinutes: 30, bufferAfterMinutes: 30, minNoticeMinutes: 1440,
    maxDaysAhead: 45, dailyLimit: 4, locationKind: "in_person", locationDetail: "At your home", color: COLOR.green,
    questions: [ask.text("address", "Address of the home", true), ask.choice("reason", "What prompted the valuation?", ["Thinking of selling", "Refinancing", "Just curious"])],
  }),
  t("strategy-call", "Selling strategy call", {
    description: "A phone call about pricing, timing and how we would market your home.", durationMinutes: 30, minNoticeMinutes: 120, locationKind: "phone",
    locationDetail: "We call the number you give us.", color: COLOR.lime,
  }),
]);

// Templates
const buyerWelcome = msg.email("buyer_welcome", "Buyer enquiry: welcome", "service", fBuyerMsgs, "Your home search with {{business.name}}", [
  "Hi {{contact.first_name}},",
  "Thanks for telling us what you're looking for. An agent will look through your details and get in touch to talk about areas, budget and timing.",
  `If you'd like to choose a time now, you can book a buyer consultation here: ${cv(vBooking)}`,
  `In the meantime, our current listings are here: ${cv(vListings)}`,
  `{{business.name}}\n${cv(vBrokerage)}, licence ${cv(vLicence)}`,
].join("\n\n"), "Enquiries");
const buyerNudge = msg.sms("buyer_follow_up", "Buyer enquiry: follow-up text", "service", fBuyerMsgs,
  `Hi {{contact.first_name}}, it's {{business.name}} following up on your home search. Would a quick call help? You can also book a time here: ${cv(vBooking)}`, "Enquiries");
const valuationAck = msg.email("valuation_received", "Valuation request: received", "service", fSellerMsgs, "We've received your valuation request", [
  "Hi {{contact.first_name}},",
  "Thank you for asking us to value your home. Your listing agent will call you to arrange a visit at a time that suits you.",
  "Before the visit it helps to note any work you've done on the home, such as a new kitchen, roof or heating system. There's no need to tidy up for us.",
  `{{business.name}}\n${cv(vOffice)}\n${cv(vBrokerage)}, licence ${cv(vLicence)}`,
].join("\n\n"), "Enquiries");
const bookingConfirm = msg.sms("appointment_confirmation", "Appointment confirmation text", "service", fBuyerMsgs,
  "Hi {{contact.first_name}}, your {{appointment.type}} with {{business.name}} is booked for {{appointment.date}} at {{appointment.time}}. To change it: {{appointment.manage_link}}", "Appointments");
const bookingReminder = msg.whatsapp("appointment_reminder", "Appointment reminder (WhatsApp)", "service", fBuyerMsgs,
  "Hi {{contact.first_name}}, a reminder of your {{appointment.type}} with {{business.name}} on {{appointment.date}} at {{appointment.time}}. If you need to reschedule or cancel: {{appointment.manage_link}}", "Appointments");
const missed = msg.sms("missed_appointment", "Missed appointment text", "service", fBuyerMsgs,
  "Hi {{contact.first_name}}, we missed you for your {{appointment.type}} today. No problem, these things happen. Reply to this text and we'll find a new time.", "Appointments");
const reviewAsk = msg.email("closing_review", "Review request after closing", "service", fSellerMsgs, "How did we do, {{contact.first_name}}?", [
  "Hi {{contact.first_name}},",
  "Congratulations again on your move. We'd really value hearing how working with {{business.name}} went for you.",
  "It takes a minute: {{review.link}}",
  "Thank you for trusting us with such a big decision.",
].join("\n\n"), "Reviews");
const marketUpdate = msg.email("market_update", "Local market update", "marketing", fSellerMsgs, "What's happening in your local property market", [
  "Hi {{contact.first_name}},",
  "Here's a short update from {{business.name}} on what homes near you have been selling for, and how long they take to sell.",
  `If you'd like a fresh valuation of your own home, just reply to this email. You can browse our current listings here: ${cv(vListings)}`,
  EMAIL_UNSUBSCRIBE,
].join("\n\n"), "Newsletter");
const newListings = msg.sms("new_listings", "New listings text", "marketing", fBuyerMsgs,
  `{{business.name}}: new homes have just come on the market. See them here: ${cv(vListings)} ${SMS_STOP}`, "Newsletter");

// Forms
const buyerForm = form({
  key: "buyer-enquiry", name: "Buyer enquiry", purpose: "qualification", folder: fForms,
  title: "Tell us what you're looking for", intro: "Share a few details and an agent will be in touch to help with your search.", submitLabel: "Send my details",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(),
    fq.choice("property_type", "What kind of home?", propertyType),
    fq.number("budget_max", "Budget up to", { field: budgetMax, min: 0, width: "half" }),
    fq.number("bedrooms", "Bedrooms", { field: bedrooms, min: 0, max: 20, integer: true, width: "half" }),
    fq.choice("move_timeline", "When would you like to move?", timeline, { display: "radio" }),
    fq.choice("financing", "Where are you with financing?", financing),
    fq.long("areas", "Which areas interest you?", { field: areas }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by email, phone call or text message about my home search.",
  marketing: "Email me new listings and market updates. I can unsubscribe at any time.",
  tags: [tBuyer, tWebEnquiry],
  deal: { pipeline: buyers, stage: "new-enquiry", name: "{{contact.full_name}} - home search", valueQuestion: "budget_max" },
  thanks: "Thank you. We've received your details and an agent will be in touch soon.",
});
const valuationForm = form({
  key: "home-valuation", name: "Home valuation request", purpose: "quote", folder: fForms,
  title: "What's your home worth?", intro: "Ask for a free, no-obligation valuation from a local agent.", submitLabel: "Request a valuation",
  questions: [
    fq.firstName(), fq.lastName(), fq.email(), fq.phone(true),
    fq.text("sale_address", "Address of the home", { field: saleAddress, required: true }),
    fq.choice("property_type", "Property type", propertyType),
    fq.number("bedrooms", "Bedrooms", { field: bedrooms, min: 0, max: 20, integer: true, width: "half" }),
    fq.choice("selling_reason", "Why are you thinking of selling?", sellReason),
    fq.choice("move_timeline", "When might you move?", timeline, { display: "radio" }),
    fq.utmSource(),
  ],
  consent: "I agree to be contacted by phone call, email or text message about my valuation.",
  tags: [tSeller, tValuation, tWebEnquiry],
  deal: { pipeline: sellers, stage: "valuation-requested", name: "{{contact.full_name}} - valuation" },
  thanks: "Thank you. Your local agent will call you to arrange the valuation.",
});
const closingSurvey = form({
  key: "closing-feedback", name: "After-closing feedback", kind: "survey", purpose: "survey", folder: fForms,
  title: "How did we do?", intro: "Two minutes of feedback helps us look after the next family better.", submitLabel: "Send feedback",
  questions: [
    fq.email(),
    fq.pick("rating", "How would you rate working with us?", ["Excellent", "Good", "Okay", "Poor"], { required: true }),
    fq.pick("recommend", "Would you recommend us to a friend?", ["Yes", "Maybe", "No"], { required: true }),
    fq.long("comments", "What could we have done better?"),
  ],
  consent: "I agree to be contacted by email about my feedback.",
  tags: [tPastClient],
  notify: ["owner"],
  thanks: "Thank you for taking the time to tell us.",
});

// Workflow drafts
const enquiryFlow = workflow("enquiry_follow_up", "Website enquiry follow-up", "Welcomes a new buyer or seller, gives the owner a call task, and texts buyers who haven't replied after two days.", fFlows,
  when.tagAdded([tWebEnquiry]), [
    step.ifContact("seller_check", all(has.anyTag(tSeller)), "seller_ack", "buyer_ack"),
    step.send("seller_ack", valuationAck, "seller_call"),
    step.task("seller_call", "Call {{contact.first_name}} to arrange the valuation", { priority: "high", due: [4, "hours"], linkOpportunity: true }, null),
    step.send("buyer_ack", buyerWelcome, "buyer_call"),
    step.task("buyer_call", "Call {{contact.first_name}} about their home search", { priority: "high", due: [4, "hours"], linkOpportunity: true }, "wait_two_days"),
    step.wait("wait_two_days", 2, "days", "replied"),
    step.ifNoReply("replied", "nudge", null),
    step.send("nudge", buyerNudge, null),
  ]);
const bookingFlow = workflow("appointment_reminders", "Appointment confirmation and reminder", "Texts a confirmation when a consultation, showing or valuation is booked, and a WhatsApp reminder the day before.", fFlows,
  when.appointment("appointment.booked", [buyerCalendar, valuationCalendar]), [
    step.send("confirm", bookingConfirm, "day_before", "appointment_setter"),
    step.beforeAppointment("day_before", 1, "days", "remind"),
    step.send("remind", bookingReminder, null, "appointment_setter"),
  ]);
const noShowFlow = workflow("missed_appointment", "Missed appointment follow-up", "Offers a new time after a no-show and asks the contact's owner to follow up.", fFlows,
  when.appointment("appointment.no_show", [buyerCalendar, valuationCalendar]), [
    step.send("text", missed, "task", "appointment_setter"),
    step.task("task", "Rebook {{contact.first_name}} after a missed appointment", { due: [1, "days"] }, null),
  ]);
const contractFlow = workflow("under_contract", "Buyer under contract checklist", "Gives the buyer's agent the contract-to-close task list when a buyer deal goes under contract.", fFlows,
  when.stageReached(buyers, "under-contract"), [
    step.task("checklist", "Contract to close: inspection, appraisal and financing deadlines", {
      description: "Put the inspection, appraisal, financing and closing dates in the deal's notes, and confirm each one with the buyer.", priority: "high", due: [1, "days"], assignee: buyerAgent, linkOpportunity: true,
    }, "tell_team"),
    step.notify("tell_team", "A buyer deal is under contract", { body: "Check the closing dates are in the deal." }, null),
  ]);
const reviewFlow = workflow("past_client_review", "Review request after closing", "Asks a past client for a review three days after they're tagged as a past client.", fFlows,
  when.tagAdded([tPastClient]), [
    step.wait("settle_in", 3, "days", "ask"),
    step.review("ask", reviewAsk),
  ]);
const nurtureFlow = workflow("past_client_update", "Market update for past clients (start by hand)", "Someone in the team starts it for a past client who agreed to marketing: a market update email, then new listings by text two weeks later.", fFlows,
  when.manual(), [
    step.send("update", marketUpdate, "two_weeks"),
    step.wait("two_weeks", 14, "days", "listings"),
    step.send("listings", newListings, null),
  ]);

export const realEstateStarter = starter({
  key: "real-estate-starter",
  name: "Real Estate starter",
  description: "Buyer and seller pipelines, buyer consultations, showings and home valuations, buyer and valuation forms, follow-up and reminder drafts, and weekly reports for an estate agency or brokerage team.",
  industry: "real_estate",
}, [buyerAgent, listingAgent], {
  folders: [fType, fTimeline, fStatus, fLists, fBuyerMsgs, fSellerMsgs, fFlows, fForms, fCalendars, fReports],
  tags: [tBuyer, tSeller, tInvestor, tFirstTime, tReadyNow, tSoon, tBrowsing, tWebEnquiry, tPreApproved, tValuation, tPastClient],
  customFields: [propertyType, budgetMax, bedrooms, areas, timeline, financing, currentHome, saleAddress, sellReason, listPrice, listingRef],
  customValues: [vBrokerage, vLicence, vOffice, vBooking, vListings],
  pipelines: [buyers, sellers],
  calendars: [buyerCalendar, valuationCalendar],
  smartLists: [
    smartList("ready-buyers", "Buyers ready to move", "Buyers moving within three months.", fLists, all(has.anyTag(tBuyer), has.anyTag(tReadyNow)), ["phone", budgetMax, "owner", "tags", "last_activity_at"], { by: "last_activity_at", dir: "desc" }),
    smartList("sellers-to-value", "Sellers waiting for a valuation", "Asked for a valuation and have no appointment yet.", fLists, all(has.anyTag(tValuation), has.noAppointments()), ["phone", saleAddress, "owner", "created_at"]),
    smartList("no-reply", "Waiting on a reply for 5 days", "We messaged last and haven't heard back in five days.", fLists, all(has.noReplyForDays(5), has.status("new", "open", "contacted")), ["phone", "owner", "lead_status", "last_activity_at"], { by: "last_activity_at", dir: "asc" }),
    smartList("upcoming", "Upcoming showings and valuations", "Contacts with an appointment coming up.", fLists, all(has.upcomingAppointment()), ["phone", "owner", "tags"]),
    smartList("under-contract", "Under contract", "Buyers and sellers whose deal is under contract.", fLists, anyOf(has.inStages(buyers, "under-contract"), has.inStages(sellers, "under-contract")), ["phone", "owner", "tags"]),
    smartList("past-clients-opted-in", "Past clients open to updates", "Past clients who agreed to marketing emails.", fLists, all(has.anyTag(tPastClient), has.marketingConsent("email")), ["email", "city", "last_activity_at"]),
  ],
  assignmentRules: [assignmentRule("buyer-enquiries", "New buyer enquiries", all(has.anyTag(tBuyer), has.unassigned()), [buyerAgent])],
  forms: [buyerForm, valuationForm, closingSurvey],
  messageTemplates: [buyerWelcome, buyerNudge, valuationAck, bookingConfirm, bookingReminder, missed, reviewAsk, marketUpdate, newListings],
  workflows: [enquiryFlow, bookingFlow, noShowFlow, contractFlow, reviewFlow, nurtureFlow],
  reports: [
    report("lead-sources", "Where leads come from", "New contacts and form submissions by source this month.", fReports, ["leads"], { range: "mtd" }),
    report("buyer-pipeline", "Buyer pipeline", "Open buyer deals by stage, win rate and time in each stage.", fReports, ["pipeline", "deals"], forPipeline(buyers)),
    report("seller-pipeline", "Seller pipeline", "Valuations, listings and sales.", fReports, ["pipeline", "deals"], forPipeline(sellers)),
    report("appointments", "Showings and valuations", "Booked, attended and missed appointments in the last 30 days.", fReports, ["appointments"]),
    report("agent-workload", "Agent workload", "Open and overdue tasks and follow-ups per agent this week.", fReports, ["workload", "followups"], { range: "7d" }),
  ],
});
