"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import type { CrmActor } from "@/server/crm/actor";
import type { Permission } from "@/lib/permissions";
import { connectCalDav, connectIcsFeed, disconnectCalendar, listSyncRuns, updateConnectionOptions } from "@/server/calendars/connections";
import { syncConnectionBusy, syncConnectionNow } from "@/server/calendars/sync";

// Server actions for the Calendar connections screen. Connecting is always for the signed-in person's own calendar (the services refuse
// agency support sessions and anyone else); a manager may disconnect someone's connection. Passwords and feed links go straight to the
// service, which tests them and stores them encrypted; nothing secret is ever returned.

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

function refresh(actor: CrmActor) {
  revalidatePath("/crm", "layout");
  if (actor.kind === "agency") revalidatePath(`/admin/clients/${actor.orgId}/crm`, "layout");
}

async function act<T>(orgId: string | null | undefined, permission: Permission, fn: (actor: CrmActor) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, permission);
    const out = await fn(actor);
    if (opts.refresh !== false) refresh(actor);
    return out;
  });
}

const calDavSchema = z.object({
  preset: z.enum(["icloud", "caldav"]),
  serverUrl: z.string().max(500).nullable().optional(),
  username: z.string().min(1, "Enter the username.").max(200),
  password: z.string().min(1, "Enter the password.").max(200),
  label: z.string().max(200).nullable().optional(),
});

export async function connectCalDavAction(orgId: string | null, input: z.input<typeof calDavSchema>) {
  return act(orgId, "calendars.connect", async (actor) => {
    const out = await connectCalDav(actor, calDavSchema.parse(input));
    // The first read runs now so the screen shows real busy times, not a placeholder.
    await syncConnectionBusy(out.id).catch(() => undefined);
    return out;
  });
}

const icsSchema = z.object({ url: z.string().min(1, "Paste the calendar's address.").max(2000), label: z.string().max(200).nullable().optional() });

export async function connectIcsFeedAction(orgId: string | null, input: z.input<typeof icsSchema>) {
  return act(orgId, "calendars.connect", async (actor) => {
    const out = await connectIcsFeed(actor, icsSchema.parse(input));
    await syncConnectionBusy(out.id).catch(() => undefined);
    return out;
  });
}

const optionsSchema = z.object({
  checkConflicts: z.boolean().optional(),
  conflictCalendarIds: z.array(z.string().min(1).max(300)).max(50).optional(),
  writeEvents: z.boolean().optional(),
  writeCalendarId: z.string().min(1).max(300).nullable().optional(),
});

export async function updateCalendarConnectionAction(orgId: string | null, id: string, input: z.input<typeof optionsSchema>) {
  return act(orgId, "calendars.connect", (actor) => updateConnectionOptions(actor, uuid.parse(id), optionsSchema.parse(input)));
}

export async function disconnectCalendarAction(orgId: string | null, id: string) {
  return act(orgId, "appointments.view", (actor) => disconnectCalendar(actor, uuid.parse(id)));
}

export async function syncCalendarNowAction(orgId: string | null, id: string) {
  return act(orgId, "calendars.connect", (actor) => syncConnectionNow(actor, uuid.parse(id)));
}

export async function listCalendarSyncRunsAction(orgId: string | null, connectionId: string | null) {
  return act(orgId, "appointments.view", (actor) => listSyncRuns(actor, { connectionId: connectionId ? uuid.parse(connectionId) : null, limit: 30 }), { refresh: false });
}
