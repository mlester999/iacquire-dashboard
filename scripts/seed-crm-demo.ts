/**
 * Fictional Native CRM sample data for the clearly labelled local demo workspace (is_demo = true), for visual QA of the CRM screens.
 * Run through `npm run db:seed -- --demo --crm`. Refuses to run in production or against a workspace that is not a demo. Idempotent:
 * if the demo workspace already has CRM tags, nothing is added again. Every name, email and phone number here is made up
 * (example.test addresses and 555-01xx numbers reserved for fiction).
 */
import { withSystem } from "../src/server/db/index";
import { systemActor, type CrmActor } from "../src/server/crm/actor";
import { createContact } from "../src/server/crm/contacts";
import { createCompany } from "../src/server/crm/companies";
import { createTag } from "../src/server/crm/tags";
import { createCustomField } from "../src/server/crm/fields";
import { createSmartList } from "../src/server/crm/smart-lists";
import { addNote } from "../src/server/crm/notes";
import { listPipelines } from "../src/server/crm/pipelines";
import { closeOpportunity, createOpportunity, moveOpportunity } from "../src/server/crm/opportunities";
import { createTask } from "../src/server/crm/tasks";

const PEOPLE: Array<[string, string, string, string, string]> = [
  ["Avery", "Brooks", "Website form", "qualified", "House"],
  ["Jamie", "Santos", "Referral", "new", "Condo"],
  ["Taylor", "Nguyen", "Google Ads", "contacted", "House"],
  ["Morgan", "Reyes", "Facebook", "new", "Townhouse"],
  ["Casey", "Patel", "Website form", "open", "House"],
  ["Riley", "Kim", "Referral", "customer", "House"],
  ["Jordan", "Lopez", "Walk-in", "contacted", "Commercial"],
  ["Quinn", "Garcia", "Website form", "new", "Condo"],
  ["Drew", "Martinez", "Google Ads", "unqualified", "House"],
  ["Hayden", "Cruz", "Referral", "qualified", "Townhouse"],
  ["Rowan", "Bautista", "Facebook", "new", "House"],
  ["Sage", "Mendoza", "Website form", "open", "Condo"],
  ["Emerson", "Dela Cruz", "Walk-in", "customer", "House"],
  ["Finley", "Ramos", "Google Ads", "contacted", "Commercial"],
  ["Parker", "Tan", "Referral", "qualified", "House"],
  ["Reese", "Lim", "Website form", "new", "Townhouse"],
  ["Skyler", "Villanueva", "Facebook", "inactive", "House"],
  ["Cameron", "Aquino", "Website form", "open", "Condo"],
];

export async function seedCrmDemo(orgId: string, ownerId: string, memberId: string) {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed CRM demo data in production.");
  const org = await withSystem(async (db) => (await db.query<{ id: string; name: string; timezone: string; is_demo: boolean }>("select id, name, timezone, is_demo from organizations where id = $1", [orgId])).rows[0]);
  if (!org?.is_demo) throw new Error("CRM sample data is only added to a demo workspace.");
  const existing = await withSystem(async (db) => (await db.query("select 1 from crm_tags where org_id = $1 limit 1", [orgId])).rows.length);
  if (existing) {
    console.log("Demo CRM data already present; nothing added.");
    return;
  }
  const actor: CrmActor = { ...systemActor({ id: org.id, name: org.name, timezone: org.timezone }, "Demo seed"), userId: ownerId };

  const tags: Record<string, string> = {};
  for (const [name, color] of [["Hot lead", "#dc2626"], ["Warm", "#ea580c"], ["Referral", "#059669"], ["Repeat customer", "#2563eb"], ["Newsletter", "#7c3aed"], ["Commercial", "#0891b2"]] as const) {
    tags[name] = (await createTag(actor, { name, color })).id;
  }
  await createCustomField(actor, { entity: "contact", label: "Property type", type: "select", options: ["House", "Condo", "Townhouse", "Commercial"] });
  await createCustomField(actor, { entity: "contact", label: "Budget", type: "currency" });
  await createCustomField(actor, { entity: "contact", label: "Service interest", type: "multiselect", options: ["Repairs", "Inspection", "Renovation", "Maintenance plan"] });
  await createCustomField(actor, { entity: "contact", label: "Preferred contact time", type: "select", options: ["Morning", "Afternoon", "Evening"] });
  await createCustomField(actor, { entity: "opportunity", label: "Job type", type: "select", options: ["Repair", "Renovation", "Inspection", "Maintenance plan"] });

  const companies = [
    (await createCompany(actor, { name: "Harbor Point HOA", website: "https://harborpoint.example", industry: "Property management", city: "Austin", country: "US" })).id,
    (await createCompany(actor, { name: "Lakeside Property Group", website: "https://lakeside-property.example", industry: "Real estate", city: "Round Rock", country: "US" })).id,
    (await createCompany(actor, { name: "Oak & Pine Realty", website: "https://oakpine.example", industry: "Real estate", city: "Austin", country: "US" })).id,
  ];

  const contactIds: string[] = [];
  for (const [i, [first, last, source, status, property]] of PEOPLE.entries()) {
    const t: string[] = [];
    if (status === "qualified" || i % 5 === 0) t.push(tags["Hot lead"]);
    if (status === "contacted") t.push(tags.Warm);
    if (source === "Referral") t.push(tags.Referral);
    if (status === "customer") t.push(tags["Repeat customer"]);
    if (i % 4 === 1) t.push(tags.Newsletter);
    if (property === "Commercial") t.push(tags.Commercial);
    const r = await createContact(actor, {
      firstName: first, lastName: last, email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, "")}@example.test`,
      phone: `+1512555${String(100 + i).padStart(4, "0")}`, source, leadStatus: status as never, leadScore: status === "qualified" ? 70 + i : status === "new" ? 20 + i : null,
      ownerId: i % 3 === 0 ? ownerId : i % 3 === 1 ? memberId : null, city: i % 2 ? "Austin" : "Round Rock", country: "US", tagIds: t,
      companyId: property === "Commercial" ? companies[i % companies.length] : i === 4 ? companies[2] : null,
      customFields: { property_type: property, budget: 1500 + i * 750, service_interest: i % 2 ? ["Repairs", "Inspection"] : ["Renovation"] },
    });
    contactIds.push(r.id);
  }

  const pipe = (await listPipelines(actor, { ensureDefault: true }))[0];
  const stage = (name: string) => pipe.stages.find((s) => s.name === name)!.id;
  const deals: Array<[number, string, number, string]> = [
    [0, "Kitchen renovation", 18500, "Proposal Sent"], [2, "Roof inspection", 450, "Contacted"], [4, "Bathroom remodel", 12400, "Qualified"],
    [6, "Office HVAC maintenance plan", 6200, "Negotiation"], [9, "Deck repair", 2300, "Appointment Scheduled"], [11, "Window replacement", 7800, "New Lead"],
    [13, "Commercial lobby refresh", 24000, "Appointment Completed"], [14, "Annual maintenance plan", 1200, "New Lead"], [5, "Fence rebuild", 3400, "Won"], [8, "Basement waterproofing", 9100, "Lost"],
  ];
  for (const [idx, name, value, st] of deals) {
    const d = await createOpportunity(actor, { name, contactId: contactIds[idx], value, ownerId: idx % 2 ? memberId : ownerId, expectedCloseDate: new Date(Date.now() + (idx + 7) * 86_400_000).toISOString().slice(0, 10) });
    if (st === "Won") await closeOpportunity(actor, d.id, "won");
    else if (st === "Lost") await closeOpportunity(actor, d.id, "lost", { lostReason: "Chose to postpone the project" });
    else if (st !== "New Lead") await moveOpportunity(actor, d.id, { stageId: stage(st) });
  }

  const day = 86_400_000;
  const tasks: Array<[string, number, string, "low" | "normal" | "high" | "urgent", number | null]> = [
    ["Call back about the kitchen quote", -1, ownerId, "high", 0], ["Send inspection checklist", 1, memberId, "normal", 2], ["Confirm site visit time", 0, memberId, "urgent", 9],
    ["Follow up on the HOA proposal", 3, ownerId, "normal", 6], ["Ask for a review after the fence job", 2, ownerId, "low", 5], ["Prepare maintenance plan options", 5, memberId, "normal", 14],
  ];
  for (const [title, offset, assignee, priority, contactIdx] of tasks) {
    await createTask(actor, { title, dueAt: new Date(Date.now() + offset * day).toISOString(), assigneeId: assignee, priority, contactId: contactIdx === null ? null : contactIds[contactIdx] });
  }

  await addNote(actor, "contact", contactIds[0], "Wants the work done before the holidays. Prefers email over calls.");
  await addNote(actor, "contact", contactIds[6], "Manages three office buildings; decision needs the facilities committee.");
  await addNote(actor, "contact", contactIds[5], "Happy with the fence work; open to a maintenance plan next spring.");

  const ownerActor: CrmActor = { ...actor, can: () => true };
  await createSmartList(ownerActor, { name: "Hot leads", visibility: "team", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags["Hot lead"]] }] } });
  await createSmartList(ownerActor, { name: "Unassigned new leads", visibility: "team", filter: { op: "and", conditions: [{ field: "owner", op: "is_unassigned" }, { field: "lead_status", op: "in", value: ["new", "open"] }] } });
  await createSmartList(ownerActor, { name: "Referrals", filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tags.Referral] }] } });
  console.log(`Demo CRM data added: ${PEOPLE.length} contacts, ${companies.length} companies, ${deals.length} deals, ${tasks.length} tasks.`);
}
