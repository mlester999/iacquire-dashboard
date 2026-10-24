"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import {
  addNote, assignOwner, blockProspect, convertProspect, declineProspect, eraseProspect, exportProspect, expireNow, extendDemo, markConsultationDone, readTranscript, reopenProspect,
} from "@/server/demo/admin";
import { saveDemoSettings } from "@/server/demo/settings";
import { inviteOutcome } from "@/lib/demo/admin-view";

// Server actions for the agency's Prospects screens. Each one signs the person in as an agency user and hands over to src/server/demo, where the permission is read again from the
// database for this request (src/server/demo/access.ts) and the change is applied by the pure rules and audited. The id of a prospect travels as text and is checked there.
// Nothing here converts a prospect except convertProspect, which a Super Admin presses on purpose.

const refresh = () => revalidatePath("/admin/prospects", "layout");

async function act<T>(fn: (user: SessionUser) => Promise<T>, opts: { refresh?: boolean } = {}) {
  return guard(async () => {
    const out = await fn(await requireAgencyOrThrow());
    if (opts.refresh !== false) refresh();
    return out;
  });
}

export async function extendDemoAction(id: string, input: { hours: unknown; extraMessages: unknown; reason: unknown }) {
  return act(async (user) => {
    const r = await extendDemo(user, id, input);
    return { windowEndsAt: r.windowEndsAt.toISOString(), extraMessages: r.extraMessages, reactivated: r.reactivated };
  });
}

export async function expireDemoAction(id: string, reason: unknown) {
  return act(async (user) => {
    await expireNow(user, id, reason);
    return true as const;
  });
}

export async function blockProspectAction(id: string, reason: unknown) {
  return act(async (user) => {
    await blockProspect(user, id, reason);
    return true as const;
  });
}

export async function declineProspectAction(id: string, reason: unknown) {
  return act(async (user) => {
    await declineProspect(user, id, reason);
    return true as const;
  });
}

export async function reopenProspectAction(id: string) {
  return act((user) => reopenProspect(user, id));
}

export async function assignProspectAction(id: string, ownerUserId: string | null) {
  return act(async (user) => {
    await assignOwner(user, id, ownerUserId);
    return true as const;
  });
}

export async function addProspectNoteAction(id: string, text: unknown) {
  return act(async (user) => {
    await addNote(user, id, text);
    return true as const;
  });
}

export async function consultationDoneAction(id: string) {
  return act(async (user) => {
    await markConsultationDone(user, id);
    return true as const;
  });
}

/** Reads a prospect's conversation. Each call is recorded on their timeline and in the audit trail, so the page itself never carries the words: this is the only way to see them. */
export async function readTranscriptAction(id: string) {
  return act((user) => readTranscript(user, id));
}

/** Everything held about one prospect, to give to the person who asked. Recorded in the audit trail (counts only). */
export async function exportProspectAction(id: string) {
  return act((user) => exportProspect(user, id), { refresh: false });
}

export async function eraseProspectAction(id: string, reason: unknown) {
  return act((user) => eraseProspect(user, id, reason));
}

export async function convertProspectAction(id: string, input: { name?: unknown; ownerEmail?: unknown; timezone?: unknown }) {
  return act(async (user) => {
    const r = await convertProspect(user, id, input);
    return { orgId: r.orgId, ...inviteOutcome(r.emailDelivery, r.inviteLink) };
  });
}

export async function saveDemoSettingsAction(patch: unknown, expectedVersion: number) {
  return act(async (user) => {
    const saved = await saveDemoSettings(user, patch, expectedVersion);
    return { version: saved.version, settings: saved.settings };
  });
}
