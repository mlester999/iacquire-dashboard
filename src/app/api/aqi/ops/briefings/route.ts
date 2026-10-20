import { env } from "@/server/env";
import { generateBriefingNow, getBriefing, getBriefingSettings, listBriefings, saveBriefingSettings } from "@/server/aqi/ops/briefings";
import { opsError, opsJson, requireOpsAdmin, UUID } from "@/server/aqi/ops/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schedulerConfigured = () => Boolean(env().SCHEDULER_ENABLED && env().CRON_SECRET);

/** Settings and recent briefings, or one briefing with `?id=`. */
export async function GET(request: Request) {
  try {
    const user = await requireOpsAdmin();
    const id = new URL(request.url).searchParams.get("id");
    if (id) {
      if (!UUID.test(id)) return opsJson({ error: "Briefing not found.", code: "not_found" }, { status: 404 });
      return opsJson({ briefing: await getBriefing(user, id) });
    }
    const [settings, briefings] = await Promise.all([getBriefingSettings(user, schedulerConfigured()), listBriefings(user)]);
    return opsJson({ settings, briefings });
  } catch (err) {
    return opsError(err);
  }
}

/** Explicit administrative configuration. Nothing is scheduled until a switch is turned on here. */
export async function PUT(request: Request) {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    return opsJson({ settings: await saveBriefingSettings(user, await request.json().catch(() => null), schedulerConfigured()) });
  } catch (err) {
    return opsError(err);
  }
}

/** Generates one briefing now, for this administrator only. It is stored, never announced by notification. */
export async function POST() {
  try {
    const user = await requireOpsAdmin({ mutating: true });
    const { id, briefing } = await generateBriefingNow(user);
    return opsJson({ id, briefing });
  } catch (err) {
    return opsError(err);
  }
}
