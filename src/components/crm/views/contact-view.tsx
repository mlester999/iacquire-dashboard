import { notFound } from "next/navigation";
import { AppError } from "@/server/errors";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import { getContactDetail, listAssignableMembers, listContactAppointments, listContactConversations } from "@/server/crm/contacts";
import { getTimeline } from "@/server/crm/timeline";
import { listNotes } from "@/server/crm/notes";
import { listTasks } from "@/server/crm/tasks";
import { listOpportunities } from "@/server/crm/opportunities";
import { listTags } from "@/server/crm/tags";
import { listPipelines } from "@/server/crm/pipelines";
import { listContactCalls } from "@/server/crm/calls";
import type { CrmScope } from "@/server/crm/page";
import { ContactProfile } from "@/components/crm/contact-profile";
import { getPriority } from "@/server/lead-scoring/priority";
import { getContactAttribution } from "@/server/attribution/touches";
import { openCaseFor } from "@/server/missed-calls/ops";
import { getContactReputation } from "@/server/reputation/feedback";
import { listProposals } from "@/server/proposals/proposals";
import { invoicesForActor } from "@/server/invoices/search";

export async function ContactView({ actor, scope, id }: { actor: CrmActor; scope: CrmScope; id: string }) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let detail;
  try {
    detail = await getContactDetail(actor, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const [timeline, notes, tasks, opportunities, conversations, appointments, tags, members, pipelines] = await Promise.all([
    getTimeline(actor, { contactId: id }, { limit: 40 }),
    listNotes(actor, "contact", id),
    listTasks(actor, { view: "all", contactId: id, limit: 100 }),
    actor.can("sales.view") ? listOpportunities(actor, { contactId: id, status: "all", pageSize: 50 }) : Promise.resolve(null),
    actor.can("inbox.view") ? listContactConversations(actor, id) : Promise.resolve([]),
    actor.can("appointments.view") ? listContactAppointments(actor, id) : Promise.resolve([]),
    listTags(actor),
    listAssignableMembers(actor),
    actor.can("sales.view") ? listPipelines(actor) : Promise.resolve([]),
  ]);
  // Calls can carry recording links, so they're only loaded for people who may see call records.
  const calls = actor.can("calls.view") ? await listContactCalls(actor, id, 20) : null;
  // The explained priority and any missed call still waiting. Neither may stop the page from opening.
  const [priority, missedCall, attribution, reputation, proposals, invoices] = await Promise.all([
    getPriority(actor, id).catch(() => null),
    actor.can("calls.view") ? openCaseFor(actor, { contactId: id }).catch(() => null) : Promise.resolve(null),
    getContactAttribution(actor, id).catch(() => null),
    // What this person privately told the business (private feedback only). Like the others, it may not stop the page from opening.
    getContactReputation(actor, id).catch(() => null),
    // Proposals belong to the client's own team: an agency person looking in a support session is not offered them, and a workspace that does not have the module gets no tab.
    actor.kind === "member" && actor.can("proposals.view") ? listProposals(actor, { contactId: id, limit: 50 }).catch(() => null) : Promise.resolve(null),
    // Invoices likewise: the client's own team only, and a workspace that does not have the module gets no tab.
    invoicesForActor(actor, { contactId: id }),
  ]);
  await auditSupportView(actor, "contact", id);
  const data = JSON.parse(JSON.stringify({ detail, timeline, notes, tasks, opportunities: opportunities?.rows ?? [], conversations, appointments, calls: calls ?? undefined, priority, missedCall, attribution, reputation, proposals, invoices }));
  return (
    <ContactProfile
      scope={scope}
      {...data}
      tags={tags.map((t) => ({ id: t.id, name: t.name, color: t.color }))}
      members={members}
      pipelines={pipelines.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault, stages: p.stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name })) }))}
    />
  );
}
