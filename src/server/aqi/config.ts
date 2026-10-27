import "server-only";
import { withSystem } from "@/server/db";
import { aqiConfigSchema, DEFAULT_AQI_CONFIG, type AqiConfigView } from "@/lib/aqi/config";

export { aqiConfigSchema, DEFAULT_AQI_CONFIG, effectiveAqiModel, type AqiConfig, type AqiConfigView } from "@/lib/aqi/config";

/** Reads only the platform-wide published AQi configuration; it does not load viewer or workspace data. */
export async function getPublishedAqiConfig(): Promise<AqiConfigView> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; version: number; config: unknown }>(
      "select id, version, config from aqi_config_versions where status = 'published' order by published_at desc nulls last limit 1",
    );
    const row = rows[0];
    if (!row) return { versionId: null, version: 0, config: DEFAULT_AQI_CONFIG };
    const parsed = aqiConfigSchema.safeParse(row.config);
    return { versionId: row.id, version: row.version, config: parsed.success ? parsed.data : DEFAULT_AQI_CONFIG };
  });
}
