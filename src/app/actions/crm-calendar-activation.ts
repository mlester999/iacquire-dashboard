"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import type { CrmActor } from "@/server/crm/actor";
import { resolveCrmActor } from "@/server/crm/request";
import { activateCalendar, applyCalendarHoursTemplate, verifyCalendar } from "@/server/calendars/activation";

// Verifying and activating draft calendars (from a Blueprint), and giving their hosts the suggested hours. The actor is resolved on the
// server; the services require calendar management and re-run every check themselves.

const uuid = z.string().uuid({ error: "That calendar wasn't found." });
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

export async function verifyCalendarAction(orgId: string | null, calendarId: string) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "calendars.manage");
    return verifyCalendar(actor, uuid.parse(calendarId));
  });
}

export async function activateCalendarAction(orgId: string | null, calendarId: string) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "calendars.manage");
    const res = await activateCalendar(actor, uuid.parse(calendarId));
    if (res.activated) refresh(actor);
    return res;
  });
}

export async function applyCalendarHoursTemplateAction(orgId: string | null, calendarId: string) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "calendars.manage");
    const res = await applyCalendarHoursTemplate(actor, uuid.parse(calendarId));
    refresh(actor);
    return res;
  });
}
