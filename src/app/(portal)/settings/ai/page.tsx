import { requireOrgContext } from "@/server/tenancy/context";
import { getProfile } from "@/server/settings/service";
import { AiPrefsForm } from "@/components/settings/settings-forms";
import { aiPreferencesSchema } from "@/lib/agent-settings";

export const metadata = { title: "AI preferences" };

export default async function AiPreferencesPage() {
  const ctx = await requireOrgContext();
  const p = await getProfile(ctx);
  const raw = (p?.ai_preferences ?? {}) as Record<string, unknown>;
  const prefs = aiPreferencesSchema.parse(aiPreferencesSchema.safeParse(raw).success ? raw : {});
  const days = typeof raw.chatRetentionDays === "number" ? String(raw.chatRetentionDays) : "forever";
  return <AiPrefsForm prefs={prefs} retention={["30", "90", "365"].includes(days) ? days : "forever"} canEdit={ctx.can("agents.configure")} />;
}
