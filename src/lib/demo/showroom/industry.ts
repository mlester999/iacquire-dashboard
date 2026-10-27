// What the showroom borrows from the one thing the visitor told us about their business: which industry they chose from the questionnaire's own list. Everything here is a plain-language
// SAMPLE for that kind of business (invented people, invented numbers of nothing in particular); none of it is a fact about the visitor's real business, and the showroom never says it
// looked at one. Pure.

export interface SampleScenario {
  /** What the business calls the people it serves, in the plural ("homeowners"). */
  people: string;
  /** What a new enquiry is about, as a short phrase. */
  enquiry: string;
  /** The sample lead the showroom follows through the pipeline: an invented first name and last initial. */
  lead: string;
  /** What gets booked. */
  appointment: string;
  /** The kind of record a deal is, in the sample. */
  deal: string;
  /** What the Lead Hunter is asked to look for, as an invented ideal-customer brief. */
  huntBrief: string;
  /** Names of invented businesses the Lead Hunter "finds" in the sample (all fictional). */
  prospects: [string, string, string, string, string];
  /** One sentence that says why this kind of business gains from the system, written as a possibility, never a promise. */
  benefit: string;
}

const GENERIC: SampleScenario = {
  people: "customers",
  enquiry: "a new enquiry",
  lead: "Jordan R.",
  appointment: "an intro call",
  deal: "a service package",
  huntBrief: "Independent businesses of about 5 to 20 people in your area that look like the customers you serve best.",
  prospects: ["Harbor & Pine Co.", "Northline Supply", "Bright Table Studio", "Maple Row Services", "Cedar Point Group"],
  benefit: "A new enquiry can get a first answer quickly, follow-ups can stop slipping, and the next step can always be in front of you.",
};

const BY_INDUSTRY: Record<string, Partial<SampleScenario>> = {
  real_estate: {
    people: "buyers and sellers",
    enquiry: "a question about a property",
    lead: "Casey M.",
    appointment: "a property viewing",
    deal: "a listing or a purchase",
    huntBrief: "Homeowners in your areas who have owned for years and may be thinking about selling.",
    prospects: ["Willow Lane homeowner", "Granite Court owners", "Oakridge duplex landlord", "Birchwood townhome owner", "Lakeside Row owners"],
    benefit: "Enquiries from listings and ads can be answered fast, viewings can be offered from your calendar, and every buyer and seller can be followed up in one place.",
  },
  healthcare: {
    people: "patients and clients",
    enquiry: "a question about booking a first visit",
    lead: "Riley T.",
    appointment: "a first visit",
    deal: "a treatment plan",
    huntBrief: "Nearby residents and local organisations that match the services your practice wants to grow.",
    prospects: ["Sunrise Fitness Club", "Eastgate Community Centre", "Blue Heron Dance School", "Parkview Senior Living", "Millstone Workplace Health"],
    benefit: "New-patient enquiries can be answered promptly, appointment slots offered from your calendar, and reminders and follow-ups kept consistent, with a person approving anything sensitive.",
  },
  home_services: {
    people: "homeowners",
    enquiry: "a request for a quote",
    lead: "Sam K.",
    appointment: "an on-site quote visit",
    deal: "a job",
    huntBrief: "Property managers and landlords in your service area who regularly need repairs and maintenance.",
    prospects: ["Elmwood Property Care", "Riverbend Rentals", "Summit Ridge HOA", "Oak & Anchor Apartments", "Pinecrest Landlords"],
    benefit: "Quote requests can be answered while you are on a job, visits offered from your calendar, and quotes chased up before they go cold.",
  },
  agency: {
    people: "client accounts",
    enquiry: "an enquiry about your services",
    lead: "Alex P.",
    appointment: "a discovery call",
    deal: "a retainer",
    huntBrief: "Growing local businesses with an active website and room to improve how they get customers.",
    prospects: ["Copperleaf Dental", "Tidewater Realty", "Fernhill Fitness", "Ironbark Plumbing", "Juniper & Vale Salon"],
    benefit: "Inbound leads can be qualified and booked for discovery calls, proposals prepared for your review, and your pipeline kept tidy as you take on more accounts.",
  },
  consulting: {
    people: "clients",
    enquiry: "an enquiry about working with you",
    lead: "Morgan L.",
    appointment: "a discovery call",
    deal: "an engagement",
    huntBrief: "Founders and small-team owners in your niche who have recently grown or changed what they sell.",
    prospects: ["Larkspur Studio", "Stonebridge Advisory clients", "Quill & Compass Co.", "Westmere Collective", "Ashgrove Partners"],
    benefit: "Enquiries can get a thoughtful first reply, discovery calls can be booked from your calendar, and proposals and follow-ups prepared for you to approve.",
  },
  legal_finance: {
    people: "clients",
    enquiry: "an enquiry about a consultation",
    lead: "Drew H.",
    appointment: "an initial consultation",
    deal: "an engagement",
    huntBrief: "Local business owners and families whose circumstances suggest they may need your kind of advice.",
    prospects: ["Rosemont Family Business", "Alder Creek Contracting", "Kestrel Logistics", "Hollis & Marsh Retail", "Tamarack Holdings"],
    benefit: "Enquiries can be acknowledged promptly, consultations offered from your calendar, and every follow-up recorded, with approvals required before anything is sent.",
  },
  local_services: {
    people: "customers",
    enquiry: "a question about booking",
    lead: "Taylor B.",
    appointment: "a booking",
    deal: "a package or membership",
    huntBrief: "Nearby residents and businesses that fit the customers your service is best at helping.",
    prospects: ["Northside Gym", "Daisy Chain Florist", "Cobalt Auto Care", "Olive Branch Cafe", "Silverline Studio"],
    benefit: "Booking requests can be answered at any hour, slots offered from your calendar, and quiet customers followed up before they drift away.",
  },
  ecommerce: {
    people: "customers",
    enquiry: "a question about an order or a product",
    lead: "Jamie S.",
    appointment: "a call or a consultation",
    deal: "a wholesale or repeat-order account",
    huntBrief: "Retailers and businesses that could stock or regularly buy what you sell.",
    prospects: ["Marigold Gift Shop", "Trailhead Outfitters", "Brick & Bloom Market", "Harvest Moon Co-op", "Lantern Home Store"],
    benefit: "Customer and wholesale enquiries can be answered promptly, follow-ups kept consistent, and your best accounts kept visible.",
  },
};

/** The sample scenario for an industry key. An unknown or missing key gets the neutral one. */
export function scenarioFor(industry: string | null | undefined): SampleScenario {
  return { ...GENERIC, ...(industry ? BY_INDUSTRY[industry] ?? {} : {}) };
}
