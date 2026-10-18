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
  await auditSupportView(actor, "contact", id);
  const data = JSON.parse(JSON.stringify({ detail, timeline, notes, tasks, opportunities: opportunities?.rows ?? [], conversations, appointments, calls: calls ?? undefined }));
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
