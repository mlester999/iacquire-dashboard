import { withSystem } from "@/server/db";
import { createProjectRequest, decideQuote } from "@/server/projects/client";
import { saveQuoteDraft, sendQuote, updateProjectStatus } from "@/server/projects/agency";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./fixtures";

/**
 * A small world for the custom-project and change-order tests: one client workspace (owner, admin, member), a second client workspace, and an agency
 * with a Super Admin and team members who work on the first client (and one who does not).
 */
export async function projectsWorld() {
  const org = await createOrg({ name: "Projects Co" });
  const otherOrg = await createOrg({ name: "Other Projects Co" });
  const people = {
    owner: await createUser({ name: "Olivia Owner" }),
    admin: await createUser({ name: "Adam Admin" }),
    member: await createUser({ name: "Mia Member" }),
    outsider: await createUser({ name: "Otto Outsider" }),
  };
  await addMember(org.id, people.owner.id, "owner");
  await addMember(org.id, people.admin.id, "admin");
  await addMember(org.id, people.member.id, "member");
  await addMember(otherOrg.id, people.outsider.id, "owner");
  const raw = {
    superAdmin: await createUser({ platformRole: "agency_super_admin", name: "Sam Superadmin" }),
    staff: await createUser({ platformRole: "agency_staff", name: "Stan Staffer" }),
    staff2: await createUser({ platformRole: "agency_staff", name: "Sia Staffer" }),
    watcher: await createUser({ platformRole: "agency_staff", name: "Wes Watcher" }),
    outStaff: await createUser({ platformRole: "agency_staff", name: "Olga Unassigned" }),
  };
  await withSystem(async (db) => {
    for (const s of [raw.staff, raw.staff2, raw.watcher]) await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [org.id, s.id, raw.superAdmin.id]);
    await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [otherOrg.id, raw.outStaff.id, raw.superAdmin.id]);
  });
  const agency = {
    superAdmin: agencyUser(raw.superAdmin, "agency_super_admin"),
    staff: agencyUser(raw.staff, "agency_staff"),
    staff2: agencyUser(raw.staff2, "agency_staff"),
    watcher: agencyUser(raw.watcher, "agency_staff"),
    outStaff: agencyUser(raw.outStaff, "agency_staff"),
  };
  const ctx = {
    owner: ctxFor(people.owner, org, "owner"),
    admin: ctxFor(people.admin, org, "admin"),
    member: ctxFor(people.member, org, "member"),
    outsider: ctxFor(people.outsider, otherOrg, "owner"),
  };
  return { org, otherOrg, people, raw, agency, ctx };
}

export type ProjectsWorld = Awaited<ReturnType<typeof projectsWorld>>;

export const projectInput = (title = "AI receptionist for incoming calls") => ({
  title,
  problem: "We miss calls after hours and lose booked appointments.",
  currentProcess: "Calls go to voicemail and someone returns them the next day.",
  desiredOutcome: "An AI answers calls and books appointments on our calendar.",
  tools: ["GoHighLevel", "Google Calendar"],
});

export const fullQuote = () => ({
  projectName: "AI voice receptionist",
  scope: "Configure and deploy a voice receptionist that answers inbound calls, checks availability and books appointments.",
  deliverables: ["Voice agent", "Calendar integration", "Documentation"],
  includedIntegrations: ["Google Calendar"],
  exclusions: ["Telephony usage costs"],
  timelineText: "3–4 weeks",
  estimatedWeeksMin: 3,
  estimatedWeeksMax: 4,
  oneTimeCents: 120000,
  ongoingMonthlyCents: null,
  ongoingDescription: null,
  revisionTerms: "Two rounds of revisions are included.",
  paymentTerms: "50% to begin, 50% on delivery.",
  warrantyTerms: "30 days of post-launch fixes.",
  validUntil: null,
  internalNotes: "Margin is fine.",
});

/** A project taken from a request to an accepted quote (status approved) by the people who would do it. */
export async function approvedProject(w: ProjectsWorld, title = "Approved project", opts: { start?: boolean } = {}) {
  const id = (await createProjectRequest(w.ctx.owner, projectInput(title))).id;
  await updateProjectStatus(w.agency.staff, id, { status: "under_review" });
  const quoteId = (await saveQuoteDraft(w.agency.staff, id, fullQuote())).id;
  await sendQuote(w.agency.staff, id, quoteId);
  await decideQuote(w.ctx.owner, quoteId, "accepted");
  if (opts.start) await updateProjectStatus(w.agency.staff, id, { status: "in_development" });
  return { id, quoteId };
}

/** A project with a quote that is sent and waiting for the client. */
export async function quotedProject(w: ProjectsWorld, title = "Quoted project") {
  const id = (await createProjectRequest(w.ctx.owner, projectInput(title))).id;
  await updateProjectStatus(w.agency.staff, id, { status: "under_review" });
  const quoteId = (await saveQuoteDraft(w.agency.staff, id, fullQuote())).id;
  await sendQuote(w.agency.staff, id, quoteId);
  return { id, quoteId };
}
