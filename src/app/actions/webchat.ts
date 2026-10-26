"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { studioContext } from "@/server/websites/studio-ctx";
import { rotatePublicKey, saveWidgetSettings, type WidgetPatch } from "@/server/webchat/config";

// Server actions for the website chat's settings. Who may change what is decided in src/server/webchat/config.ts (website.edit); these resolve the
// signed-in workspace and refresh the screens.

const refresh = () => revalidatePath("/website", "layout");

export async function saveWebChatSettingsAction(patch: WidgetPatch, expectedVersion: number, orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    const saved = await saveWidgetSettings(ctx, patch, Number(expectedVersion));
    refresh();
    return { version: saved.version, allowedOrigins: saved.allowedOrigins };
  });
}

export async function rotateWebChatKeyAction(orgId?: string) {
  return guard(async () => {
    const ctx = await studioContext(orgId, "website.edit");
    const next = await rotatePublicKey(ctx);
    refresh();
    return { publicKey: next.publicKey, version: next.version };
  });
}
