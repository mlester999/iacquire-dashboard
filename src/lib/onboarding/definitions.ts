// The onboarding questionnaire. Version this whenever a question is added or an id changes meaning:
// saved answers are keyed by question id, so older sessions keep their answers and simply see new
// questions as outstanding.
import { BUSINESS_GOALS, LANGUAGES, LENGTH_COPY, TONE_COPY, TONES } from "@/lib/agent-settings";
import type { Answers, ChoiceOption, QuestionDef } from "./types";

export const QUESTIONNAIRE_VERSION = 2;

const opts = (...pairs: Array<[string, string, string?]>): ChoiceOption[] => pairs.map(([value, label, description]) => ({ value, label, description }));

export const INDUSTRY_OPTIONS = opts(
  ["real_estate", "Real estate", "Agents, brokers, developers and property managers"],
  ["healthcare", "Dental, medical or wellness", "Clinics, dentists, therapists and other health practices"],
  ["home_services", "Home services", "Roofing, plumbing, HVAC, cleaning, landscaping and similar trades"],
  ["agency", "Marketing or creative agency", "You sell services to other businesses"],
  ["consulting", "Consulting, coaching or professional services", "Advisors, trainers, accountants and similar"],
  ["legal_finance", "Legal or financial services", "Law firms, insurance, mortgage and wealth practices"],
  ["local_services", "Other local service business", "Salons, fitness, auto, education and similar"],
  ["ecommerce", "Retail or e-commerce", "You sell products to customers"],
  ["other", "Something else", "Choose this if nothing above fits"],
);

export const industryOf = (a: Answers): string => (typeof a["a.industry"] === "string" ? (a["a.industry"] as string) : "");
const inIndustry =
  (...keys: string[]) =>
  (a: Answers) =>
    keys.includes(industryOf(a));
export const wantsAppointments = (a: Answers) => a["b.appointments"] === true;
export const channelsOf = (a: Answers): string[] => (Array.isArray(a["c.channels"]) ? (a["c.channels"] as string[]) : []);
export const wantsWebsite = (a: Answers) => a["b.website_need"] === "new" || a["b.website_need"] === "improve";

const APPOINTMENT_GOALS: Record<string, ChoiceOption[]> = {
  real_estate: opts(["viewing", "Property viewings"], ["consultation", "Buyer or seller consultations"], ["valuation", "Free home valuations"]),
  healthcare: opts(["new_patient", "New patient appointments"], ["consultation", "Consultations"], ["checkup", "Check-ups and routine visits"]),
  home_services: opts(["quote_visit", "On-site quotes and inspections"], ["service_visit", "Service appointments"], ["consultation", "Phone consultations"]),
  agency: opts(["discovery", "Discovery calls"], ["strategy", "Strategy sessions"], ["demo", "Demos"]),
};
const DEFAULT_APPOINTMENT_GOALS = opts(["consultation", "Consultations"], ["discovery", "Discovery calls"], ["service_visit", "Service appointments"], ["sales_call", "Sales calls"]);
export const appointmentGoalOptions = (a: Answers): ChoiceOption[] => APPOINTMENT_GOALS[industryOf(a)] ?? DEFAULT_APPOINTMENT_GOALS;

const HOURS_EXAMPLE = "Monday to Friday, 9:00 to 17:00";

export const QUESTIONS: QuestionDef[] = [
  // ───────────────────────────── A · Business profile ─────────────────────────────
  {
    id: "a.business_name", section: "A", required: true, title: "What's your business called?",
    help: "Use the name your customers know. It appears in messages, your website and your workspace.",
    example: "Brightside Roofing", kind: { type: "text", max: 120, placeholder: "Your business name" }, reviewLabel: "Business name",
  },
  {
    id: "a.industry", section: "A", required: true, title: "Which industry are you in?",
    help: "This shapes the follow-up questions, so your team only answers what's relevant to you.",
    kind: { type: "choice", options: INDUSTRY_OPTIONS }, reviewLabel: "Industry",
  },
  {
    id: "a.business_model", section: "A", required: true, title: "How do you serve customers?",
    help: "Local businesses get questions about service areas. Online businesses skip them.",
    kind: { type: "choice", options: opts(["local", "In person or at their location", "Customers visit us, or we visit them"], ["online", "Online or remote", "We work with customers over phone, video or email"], ["mixed", "Both", "A mix of local and remote work"]) },
    reviewLabel: "How you serve customers",
  },
  {
    id: "a.description", section: "A", required: true, assist: "draft", title: "Tell us what your business does.",
    help: "Explain what your business does, who it serves, and what makes it different. Your authorized AI employees may use this to understand your company.",
    example: "We're a family-owned roofing company helping homeowners in Austin with repairs, inspections and replacements.",
    kind: { type: "longtext", max: 2000, rows: 4, placeholder: "What you do and who you help" }, reviewLabel: "What you do",
  },
  {
    id: "a.website", section: "A", assist: "draft", title: "Where can we find you online?",
    help: "Provide a company webpage containing information you want included in your business knowledge. We read public pages to suggest answers, and you decide what to keep.",
    example: "brightsideroofing.com", kind: { type: "url" }, reviewLabel: "Website",
  },
  {
    id: "a.location", section: "A", title: "Where is your business based?",
    help: "City, region and country. Your AI team uses this to answer where-are-you-located questions.",
    example: "Austin, Texas, USA", kind: { type: "text", max: 200, placeholder: "City, region, country" }, reviewLabel: "Based in",
  },
  {
    id: "a.territories", section: "A", title: "Which areas do you serve?",
    help: "List the cities, regions or postcodes you cover. The AI won't promise service outside these areas.",
    example: "Austin, Round Rock, Cedar Park and Georgetown",
    show: (a) => a["a.business_model"] !== "online" || inIndustry("real_estate", "home_services")(a),
    kind: { type: "longtext", max: 1000, rows: 3, placeholder: "Service areas" }, reviewLabel: "Service territories",
  },
  {
    id: "a.timezone", section: "A", required: true, title: "What time zone are you in?",
    help: "Appointment times, quiet hours and reminders all follow this.", kind: { type: "timezone" }, reviewLabel: "Time zone",
  },
  {
    id: "a.contact_email", section: "A", required: true, title: "What's the best email for your business?",
    help: "Where customers and iAcquire can reach you. This isn't shared with customers unless you say so.",
    example: "hello@brightsideroofing.com", kind: { type: "email" }, reviewLabel: "Business email",
  },
  {
    id: "a.contact_phone", section: "A", title: "What's the best phone number?",
    help: "Include the country code, for example +1 512 555 0100.", example: "+1 512 555 0100", kind: { type: "phone" }, reviewLabel: "Business phone",
  },
  {
    id: "a.hours", section: "A", title: "When are you open?",
    help: "Your AI team uses this for business-hours replies and for telling customers when someone is available.",
    example: HOURS_EXAMPLE, kind: { type: "hours" }, reviewLabel: "Business hours",
  },
  {
    id: "a.target_customers", section: "A", assist: "draft", title: "Who are your customers?",
    help: "Describe the people or businesses you usually work with.",
    example: "Homeowners with houses older than ten years, mostly in suburban neighbourhoods.",
    kind: { type: "longtext", max: 1500, rows: 3, placeholder: "Your typical customers" }, reviewLabel: "Target customers",
  },

  // ───────────────────────────── B · Business goals ─────────────────────────────
  {
    id: "b.goals", section: "B", required: true, title: "What would you like to improve?",
    help: "Choose the outcomes that matter most. Your AI team focuses on these first.",
    kind: { type: "multi", options: BUSINESS_GOALS.map((g) => ({ value: g.id, label: g.label })), max: 9 }, reviewLabel: "Main goals",
  },
  {
    id: "b.goal_other", section: "B", title: "What other goal do you have in mind?",
    help: "A short description is enough.", show: (a) => Array.isArray(a["b.goals"]) && (a["b.goals"] as string[]).includes("other"),
    kind: { type: "text", max: 300 }, reviewLabel: "Other goal",
  },
  {
    id: "b.lead_target", section: "B", title: "How many new leads would you like each month?",
    help: "A rough target helps your Performance Analyst tell you whether you're on track. It's never shown to customers.",
    kind: { type: "choice", options: opts(["lt20", "Fewer than 20"], ["20_50", "20 to 50"], ["50_150", "50 to 150"], ["150_plus", "More than 150"], ["unsure", "I'm not sure yet"]) },
    reviewLabel: "Monthly lead target",
  },
  {
    id: "b.ideal_customer", section: "B", assist: "draft", title: "What does your ideal customer look like?",
    help: "Describe the types of people or businesses you want to serve. Think of the customers you most want more of; budget, location, urgency and need all count.",
    example: "Homeowners with storm damage who want it fixed within a month and have insurance.",
    kind: { type: "longtext", max: 1500, rows: 4 }, reviewLabel: "Ideal customer",
  },
  {
    id: "b.qualification", section: "B", assist: "draft", title: "What makes a lead worth a conversation with your team?",
    help: "These are the things your AI checks before calling someone qualified.",
    example: "In our service area, owns the property, and wants work done within three months.",
    kind: { type: "longtext", max: 1500, rows: 4 }, reviewLabel: "Qualification criteria",
  },
  {
    id: "b.services", section: "B", assist: "draft", title: "What services or offers do you sell?",
    help: "List the products or services you provide. Include important limitations or conditions.",
    example: "Roof inspections, storm damage repair, gutter replacement. Free inspection this month.",
    kind: { type: "longtext", max: 2000, rows: 4 }, reviewLabel: "Services and offers",
  },
  {
    id: "b.lead_sources", section: "B", title: "Where do your leads come from today?",
    help: "Pick everything that applies so we know which sources to connect first.",
    kind: { type: "multi", options: opts(["website", "Website forms"], ["landing", "Landing pages or ads"], ["sms", "Text messages"], ["whatsapp", "WhatsApp"], ["email", "Email"], ["phone", "Phone calls"], ["social", "Social media"], ["referrals", "Referrals"], ["walk_in", "Walk-ins"]) },
    reviewLabel: "Lead sources",
  },
  {
    id: "b.sales_model", section: "B", title: "How do customers usually buy from you?",
    help: "This decides how your Sales Assistant moves a lead forward.",
    kind: { type: "choice", options: opts(["call_first", "Enquire, then a call", "They ask, then a person calls to close"], ["quote", "Enquire, then a quote", "We assess the job and send a price"], ["book_visit", "Book a visit or appointment directly"], ["online_purchase", "Buy online"], ["retainer", "Ongoing retainer or subscription"]) },
    reviewLabel: "Sales model",
  },
  {
    id: "b.appointments", section: "B", required: true, title: "Should your AI team book appointments?",
    help: "If yes, we'll ask about appointment types and availability. The AI only offers times from your real calendar.",
    kind: { type: "yesno" }, reviewLabel: "Book appointments",
  },
  {
    id: "b.appointment_goal", section: "B", show: wantsAppointments, title: "What should an appointment be for?",
    help: "Pick the main reason people book with you.", kind: { type: "choice", options: [] }, reviewLabel: "Appointment purpose",
  },
  {
    id: "b.website_need", section: "B", required: true, title: "Do you need a website?",
    help: "iAcquire builds and hosts websites on its own website engine, connected to your lead tracking.",
    kind: { type: "choice", options: opts(["new", "Yes, build me one", "We'll design it with you and publish it after you approve"], ["improve", "I have one but want a better one"], ["have", "No, my current site is fine"]) },
    reviewLabel: "Website",
  },
  // Real estate
  {
    id: "b.re_property_types", section: "B", show: inIndustry("real_estate"), title: "Which types of property do you handle?",
    help: "Your AI uses this to qualify enquiries and avoid promising what you don't offer.",
    kind: { type: "multi", options: opts(["residential_sale", "Residential sales"], ["rental", "Rentals"], ["condo", "Condos and apartments"], ["commercial", "Commercial property"], ["land", "Land and lots"], ["new_build", "New developments"]) },
    reviewLabel: "Property types",
  },
  {
    id: "b.re_buyers", section: "B", show: inIndustry("real_estate"), title: "Who are your typical clients?",
    help: "This shapes the questions your AI asks when someone enquires.",
    kind: { type: "multi", options: opts(["first_time", "First-time buyers"], ["investors", "Investors"], ["relocating", "People relocating"], ["sellers", "Home sellers"], ["renters", "Renters"], ["luxury", "Luxury buyers"]) },
    reviewLabel: "Client types",
  },
  // Healthcare
  {
    id: "b.hc_services", section: "B", show: inIndustry("healthcare"), title: "Which services do patients ask about most?",
    help: "Your AI will only talk about what you pick. It never gives medical advice.",
    kind: { type: "multi", options: opts(["checkup", "Check-ups and cleaning"], ["cosmetic", "Cosmetic treatments"], ["ortho", "Braces or aligners"], ["implants", "Implants and restorations"], ["emergency", "Emergency care"], ["therapy", "Therapy or counselling"], ["wellness", "Wellness programmes"], ["pediatric", "Children's care"]) },
    reviewLabel: "Main services",
  },
  // Home services
  {
    id: "b.hs_emergency", section: "B", show: inIndustry("home_services"), title: "Do you handle emergency call-outs?",
    help: "If so, urgent messages are flagged straight to you instead of waiting in a queue.",
    kind: { type: "choice", options: opts(["yes_24_7", "Yes, any time"], ["yes_hours", "Yes, during business hours"], ["no", "No emergency work"]) },
    reviewLabel: "Emergency call-outs",
  },
  // Agencies
  {
    id: "b.ag_target_clients", section: "B", show: inIndustry("agency"), title: "What kinds of clients do you want?",
    help: "Industry, company size and the problems you solve best.",
    example: "Local service businesses with 5 to 50 staff that want more booked appointments.",
    kind: { type: "longtext", max: 1200, rows: 3 }, reviewLabel: "Target clients",
  },
  {
    id: "b.ag_min_budget", section: "B", show: inIndustry("agency"), title: "What's the smallest budget you'll take on?",
    help: "Your AI uses this to politely qualify out leads that aren't a fit. It never quotes this figure unless you allow it.",
    kind: { type: "choice", options: opts(["none", "No minimum"], ["lt1k", "Under $1,000 a month"], ["1k_3k", "$1,000 to $3,000 a month"], ["3k_plus", "More than $3,000 a month"]) },
    reviewLabel: "Minimum budget",
  },
  // Consulting / professional
  {
    id: "b.pr_engagements", section: "B", show: inIndustry("consulting", "legal_finance"), title: "How do clients usually engage you?",
    help: "Pick the formats you offer.",
    kind: { type: "multi", options: opts(["consult", "One-off consultations"], ["project", "Fixed-price projects"], ["retainer", "Monthly retainers"], ["training", "Training or workshops"], ["advisory", "Ongoing advisory"]) },
    reviewLabel: "Engagement types",
  },

  // ───────────────────────────── C · AI communication ─────────────────────────────
  {
    id: "c.tone", section: "C", assist: "choice", title: "How should your AI team sound?",
    help: "Pick a voice that feels like your business. You'll see a short example for each.",
    kind: { type: "choice", options: TONES.map((t) => ({ value: t, label: TONE_COPY[t].label, description: `“${TONE_COPY[t].example}”` })) }, reviewLabel: "Tone",
  },
  {
    id: "c.reply_length", section: "C", title: "How much detail should replies include?",
    help: "Text messages work best short. You can change this per employee later.",
    kind: { type: "choice", options: (["concise", "balanced", "detailed"] as const).map((v) => ({ value: v, label: LENGTH_COPY[v].label, description: LENGTH_COPY[v].description })) },
    reviewLabel: "Reply length",
  },
  {
    id: "c.language", section: "C", title: "Which language should replies use?",
    help: "The default language for your AI employees.",
    kind: { type: "choice", options: LANGUAGES.map((l) => ({ value: l, label: l })) }, reviewLabel: "Language",
  },
  {
    id: "c.channels", section: "C", title: "How will customers reach you?",
    help: "Pick the channels you want your AI team on. Each one needs a verified sender before anything is sent, and we'll tell you any extra fees.",
    kind: { type: "multi", options: opts(["sms", "SMS", "Text messages from a business number"], ["whatsapp", "WhatsApp", "Needs an approved WhatsApp Business connection"], ["email", "Email", "Needs a verified sending address"]) },
    reviewLabel: "Messaging channels",
  },
  {
    id: "c.sms_sender", section: "C", show: (a) => channelsOf(a).includes("sms"), title: "Which number should texts come from?",
    help: "If you already have a business number, enter it. If not, leave this blank and we'll help you get one. Registration and number fees are disclosed before you approve them.",
    example: "+1 512 555 0100", kind: { type: "phone" }, reviewLabel: "SMS number",
  },
  {
    id: "c.whatsapp_number", section: "C", show: (a) => channelsOf(a).includes("whatsapp"), title: "Which number is on WhatsApp Business?",
    help: "WhatsApp only allows free-form replies for 24 hours after a customer writes. Anything later needs an approved template.",
    example: "+1 512 555 0100", kind: { type: "phone" }, reviewLabel: "WhatsApp number",
  },
  {
    id: "c.email_sender", section: "C", show: (a) => channelsOf(a).includes("email"), title: "Which address should emails come from?",
    help: "We'll ask you to verify this domain before any email is sent.", example: "hello@brightsideroofing.com", kind: { type: "email" }, reviewLabel: "Sending address",
  },
  {
    id: "c.response_hours", section: "C", title: "When may your AI reply?",
    help: "AI can answer around the clock. If you'd rather it only replies while you're open, choose business hours.",
    kind: { type: "choice", options: opts(["always", "Any time of day", "Replies 24/7 within quiet-hour limits"], ["business_hours", "Business hours only", "Outside hours, customers get a clear heads-up"]) },
    reviewLabel: "Reply hours",
  },
  {
    id: "c.ai_behavior", section: "C", title: "How much should your AI do on its own?",
    help: "This is what you'd like. Nothing goes autonomous until your connections are verified and you switch it on.",
    kind: { type: "choice", options: opts(["answer_book", "Answer, qualify and book", "Handle routine conversations, hand off the rest"], ["answer_handoff", "Answer questions, then hand off", "Never book or follow up without a person"], ["draft_only", "Draft only", "Prepare replies for a person to approve"]) },
    reviewLabel: "AI behaviour",
  },
  {
    id: "c.sensitive_topics", section: "C", title: "Which topics need a person?",
    help: "Your AI will pass these straight to your team instead of answering.", sensitive: true,
    kind: { type: "multi", options: opts(["pricing", "Exact prices and quotes"], ["refunds", "Refunds and billing disputes"], ["legal", "Legal or contract questions"], ["medical", "Medical or health advice"], ["complaints", "Complaints"], ["warranty", "Warranties and guarantees"], ["safety", "Safety concerns"]) },
    reviewLabel: "Topics for a person",
  },
  {
    id: "c.never_promise", section: "C", sensitive: true, title: "Is there anything your AI must never promise?",
    help: "Prices, timing, results — anything you can't stand behind.", example: "Exact prices before an assessment, same-day service, guaranteed results.",
    kind: { type: "longtext", max: 1000, rows: 3 }, reviewLabel: "Never promise",
  },
  {
    id: "c.human_escalation", section: "C", sensitive: true, title: "When should a person step in?",
    help: "Your AI hands these conversations to you first, then to your team. You choose who gets notified in Settings.",
    kind: { type: "multi", options: opts(["ready_to_close", "A lead is ready to close"], ["human_requested", "Someone asks for a person"], ["phone_consultation", "Someone wants a phone consultation"], ["complaint", "A complaint"], ["refund_concern", "A refund concern"], ["sensitive_negotiation", "A sensitive negotiation"], ["frustrated_customer", "A frustrated customer"], ["unanswered_question", "A question the AI can't answer"], ["unsafe_or_uncertain", "Anything unsafe or uncertain"]) },
    reviewLabel: "Human hand-off situations",
  },
  {
    id: "c.company_rules", section: "C", title: "Any rules your whole team should follow?",
    help: "Short and specific works best.", example: "Always offer a free inspection first.", kind: { type: "longtext", max: 1500, rows: 3 }, reviewLabel: "Company rules",
  },

  // ───────────────────────────── D · Sales and appointments ─────────────────────────────
  {
    id: "d.team", section: "D", title: "Who on your team talks to customers?",
    help: "Add the people who should receive hand-offs. Adding someone here does not send an invitation; you'll review and send invitations from Team settings.",
    kind: { type: "list", maxRows: 12, addLabel: "Add a person", fields: [
      { key: "name", label: "Name", type: "text", max: 80, required: true },
      { key: "email", label: "Email", type: "email", max: 320, required: true },
      { key: "role", label: "Role", type: "select", required: true, options: opts(["sales_rep", "Sales representative"], ["support", "Customer support"], ["admin", "Manager"], ["viewer", "Viewer"]) },
    ] },
    reviewLabel: "Team",
  },
  {
    id: "d.appt_types", section: "D", show: wantsAppointments, title: "What kinds of appointments do you offer?",
    help: "Each type has its own length. The AI only offers types you list here.",
    kind: { type: "list", maxRows: 10, addLabel: "Add an appointment type", fields: [
      { key: "name", label: "Name", type: "text", max: 80, required: true, placeholder: "Free inspection" },
      { key: "minutes", label: "Length (minutes)", type: "number", required: true, placeholder: "30" },
      { key: "mode", label: "Format", type: "select", required: true, options: opts(["in_person", "In person"], ["phone", "Phone"], ["video", "Video"]) },
    ] },
    reviewLabel: "Appointment types",
  },
  {
    id: "d.appt_availability", section: "D", show: wantsAppointments, title: "When can people book?",
    help: "Bookable hours can differ from opening hours. Real availability still comes from your connected calendar.",
    example: HOURS_EXAMPLE, kind: { type: "hours" }, reviewLabel: "Bookable hours",
  },
  {
    id: "d.appt_notice", section: "D", show: wantsAppointments, title: "How much notice do you need?",
    help: "The earliest slot your AI will offer.", kind: { type: "choice", options: opts(["none", "Same day is fine"], ["2h", "At least 2 hours"], ["24h", "At least 24 hours"], ["48h", "At least 48 hours"]) },
    reviewLabel: "Minimum notice",
  },
  {
    id: "d.appt_cancellation", section: "D", show: wantsAppointments, sensitive: true, title: "What is your cancellation policy?",
    help: "Your AI will quote this exactly and won't invent exceptions.", example: "Free to reschedule up to 24 hours before.",
    kind: { type: "longtext", max: 800, rows: 3 }, reviewLabel: "Cancellation policy",
  },
  {
    id: "d.re_viewings", section: "D", show: (a) => inIndustry("real_estate")(a) && wantsAppointments(a), title: "How do property viewings work?",
    help: "Your AI uses this when someone asks to see a property.",
    kind: { type: "choice", options: opts(["agent_led", "An agent shows the property"], ["self_guided", "Self-guided viewings"], ["virtual", "Virtual tours"], ["mixed", "A mix of these"]) },
    reviewLabel: "Viewings",
  },
  {
    id: "d.hc_insurance", section: "D", show: inIndustry("healthcare"), title: "Which insurance or payment options do you accept?",
    help: "Your AI will repeat this and refer anything else to your team.", example: "Most major dental insurance; payment plans available.",
    kind: { type: "longtext", max: 800, rows: 3 }, sensitive: true, reviewLabel: "Insurance and payment",
  },
  {
    id: "d.hc_emergency", section: "D", show: inIndustry("healthcare"), title: "What should happen when someone describes an emergency?",
    help: "Your AI never triages or gives medical advice. It follows your instruction and flags a person straight away.",
    kind: { type: "choice", options: opts(["call_us", "Tell them to call us immediately"], ["call_emergency", "Tell them to contact emergency services"], ["escalate_only", "Notify a person right away"]) },
    reviewLabel: "Emergency handling",
  },
  {
    id: "d.hs_quote", section: "D", show: inIndustry("home_services"), title: "How do you price jobs?",
    help: "This decides whether your AI offers an on-site visit before any figure is mentioned.",
    kind: { type: "choice", options: opts(["free_quote", "Free on-site quote"], ["paid_assessment", "Paid assessment"], ["phone_quote", "Quotes over the phone"], ["fixed_menu", "Fixed prices from a menu"]) },
    reviewLabel: "Quote process",
  },
  {
    id: "d.ag_discovery", section: "D", show: (a) => inIndustry("agency")(a) && wantsAppointments(a), title: "What should happen on a discovery call?",
    help: "Your AI uses this to set expectations before the call.", example: "30 minutes, we review your funnel and propose next steps.",
    kind: { type: "longtext", max: 800, rows: 3 }, reviewLabel: "Discovery call",
  },
  {
    id: "d.sales_process", section: "D", assist: "draft", title: "Walk us through your sales process.",
    help: "From first message to a closed sale, in a few steps.", example: "1. Enquiry. 2. Qualify. 3. Free inspection. 4. Quote. 5. Book the job.",
    kind: { type: "longtext", max: 2000, rows: 5 }, reviewLabel: "Sales process",
  },
  {
    id: "d.handoff_requirements", section: "D", title: "What should be confirmed before a person calls?",
    help: "These details are collected so your team never has to ask twice.", example: "Name, address, what's wrong, and when they can be reached.",
    kind: { type: "longtext", max: 1000, rows: 3 }, reviewLabel: "Before a hand-off",
  },
  {
    id: "d.followup", section: "D", title: "How persistent should follow-up be?",
    help: "Follow-ups always stop when someone replies, books, opts out, or a person takes over. Agency safety limits apply to every option.",
    kind: { type: "choice", options: opts(["gentle", "Gentle", "At most two follow-ups"], ["balanced", "Balanced", "Up to three over ten days (day 1, 3 and 7)"], ["persistent", "Persistent", "More active, still within quiet hours and consent"], ["off", "Off", "No automatic follow-ups"]) },
    reviewLabel: "Follow-up style",
  },
  {
    id: "d.pricing_policy", section: "D", sensitive: true, title: "May your AI share prices?",
    help: "Your AI can only quote figures you provide in the next step.",
    kind: { type: "choice", options: opts(["ranges", "Price ranges only"], ["exact", "Exact prices from my list"], ["never", "No — hand pricing questions to a person"]) },
    reviewLabel: "Pricing policy",
  },
  {
    id: "d.pricing_info", section: "D", sensitive: true, show: (a) => a["d.pricing_policy"] === "ranges" || a["d.pricing_policy"] === "exact", assist: "draft",
    title: "What prices can your AI share?", help: "Only what you write here is treated as approved pricing.", example: "Roof inspection: free. Gutter cleaning from $120. Repairs priced after inspection.",
    kind: { type: "longtext", max: 3000, rows: 5 }, reviewLabel: "Approved prices",
  },
  {
    id: "d.discount_rules", section: "D", sensitive: true, title: "What can your AI say about discounts?",
    help: "Your AI never invents a discount.", kind: { type: "choice", options: opts(["none", "No discounts"], ["listed_only", "Only the offers I've listed"], ["person_only", "A person decides every discount"]) },
    reviewLabel: "Discounts",
  },
  {
    id: "d.handoff_rules", section: "D", sensitive: true, assist: "draft", title: "Anything else about when a person should take over?",
    help: "The owner is notified first; eligible team members are kept informed and can take over if you don't respond in time.",
    example: "Any quote over $5,000 goes straight to me.", kind: { type: "longtext", max: 1000, rows: 3 }, reviewLabel: "Hand-off rules",
  },

  // ───────────────────────────── E · Company knowledge and branding ─────────────────────────────
  {
    id: "e.products", section: "E", assist: "draft", title: "Describe your products or services in more detail.",
    help: "Your AI uses this to answer customer questions accurately.", kind: { type: "longtext", max: 6000, rows: 6 }, reviewLabel: "Product and service details",
  },
  {
    id: "e.faqs", section: "E", sensitive: true, assist: "list", title: "What questions do customers ask most?",
    help: "Add questions customers commonly ask, along with the answers your employees are allowed to provide. Your AI will use these word for word where it can.",
    kind: { type: "list", maxRows: 20, addLabel: "Add a question", fields: [
      { key: "question", label: "Question", type: "text", max: 200, required: true },
      { key: "answer", label: "Answer", type: "longtext", max: 800, required: true },
    ] },
    reviewLabel: "FAQs",
  },
  {
    id: "e.policies", section: "E", sensitive: true, title: "What policies should your AI know?",
    help: "Refunds, warranties, guarantees, deposits, privacy. Only what you write counts as policy.",
    example: "30-day workmanship warranty. Deposits are refundable up to 48 hours before the job.",
    kind: { type: "longtext", max: 4000, rows: 5 }, reviewLabel: "Policies",
  },
  {
    id: "e.support_info", section: "E", title: "How can customers reach support?",
    help: "Hours, phone numbers, emergency contacts, anything that helps someone who needs a person.",
    kind: { type: "longtext", max: 1500, rows: 3 }, reviewLabel: "Support information",
  },
  {
    id: "e.documents", section: "E", title: "Do you have documents your team should read?",
    help: "Price lists, brochures, service guides. PDF, Word, text and CSV files up to 10 MB. Private to your workspace.",
    kind: { type: "files", assetKind: "document", max: 5 }, reviewLabel: "Documents",
  },
  {
    id: "e.logo", section: "E", title: "Upload your logo.",
    help: "Any normal logo works, including a JPG with a white background. We keep your original and can try to remove a plain background for you.",
    kind: { type: "files", assetKind: "logo", max: 1 }, reviewLabel: "Logo",
  },
  {
    id: "e.brand_colors", section: "E", title: "What are your brand colours?",
    help: "Used on your website and customer-facing pages.", kind: { type: "color" }, reviewLabel: "Brand colours",
  },
  {
    id: "e.design_style", section: "E", show: wantsWebsite, title: "What look are you after for your website?",
    help: "Pick up to three that feel right.",
    kind: { type: "multi", max: 3, options: opts(["modern", "Modern and clean"], ["bold", "Bold and high-contrast"], ["classic", "Classic and trustworthy"], ["warm", "Warm and friendly"], ["premium", "Premium and elegant"], ["playful", "Playful and bright"]) },
    reviewLabel: "Website style",
  },
  {
    id: "e.website_pages", section: "E", show: wantsWebsite, title: "Which pages do you need?",
    help: "We'll start with these; you can add or remove sections in Website Studio.",
    kind: { type: "multi", options: opts(["home", "Home"], ["about", "About"], ["services", "Services"], ["pricing", "Pricing"], ["gallery", "Gallery or portfolio"], ["faq", "FAQ"], ["contact", "Contact"], ["booking", "Book online"], ["blog", "Blog"]) },
    reviewLabel: "Website pages",
  },
  {
    id: "e.design_notes", section: "E", show: wantsWebsite, title: "Anything else about your website design?",
    help: "Sites you like, words to include, things to avoid.", kind: { type: "longtext", max: 1500, rows: 3 }, reviewLabel: "Design notes",
  },
  {
    id: "e.reference_images", section: "E", show: wantsWebsite, title: "Any photos or reference images?",
    help: "Optional. Team photos, your premises, work you're proud of, or a site you'd like to resemble.", kind: { type: "files", assetKind: "reference", max: 8 }, reviewLabel: "Reference images",
  },
  {
    id: "e.domain_plan", section: "E", show: wantsWebsite, title: "What web address do you want?",
    help: "Every site gets a free iAcquire address. Connecting your own domain is optional, and a domain is never bought without your approval.",
    kind: { type: "choice", options: opts(["subdomain", "Free iAcquire address is fine"], ["connect", "Connect a domain I already own"], ["buy", "Help me get a domain (needs my approval)"]) },
    reviewLabel: "Web address",
  },

  // ───────────────────────────── F · Review and approval ─────────────────────────────
  {
    id: "f.review", section: "F", required: true, title: "Review and approve your setup.",
    help: "Check each answer, edit anything, then approve. Nothing customer-facing is switched on by this step.",
    kind: { type: "review" },
  },
];

// Appointment goal options depend on industry, so resolve them lazily.
export function questionOptions(q: QuestionDef, a: Answers): ChoiceOption[] {
  if (q.id === "b.appointment_goal") return appointmentGoalOptions(a);
  return q.kind.type === "choice" || q.kind.type === "multi" ? q.kind.options : [];
}

export const QUESTION_BY_ID: Record<string, QuestionDef> = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
