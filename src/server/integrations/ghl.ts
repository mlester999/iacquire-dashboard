import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { resolveCredential } from "@/server/security/credentials";
import { recordAudit } from "@/server/audit";
import { AppError } from "@/server/errors";
import { assertAssignableLocation, setIntegrationStatus } from "@/server/admin/tenants";
import { verifyGhlIdentity } from "@/server/integrations/inspection";
import { applyAppointmentEvent } from "@/server/appointments/ledger";
import { mapAppointmentStatus } from "@/lib/appointments";

/**
 * Read-only LeadConnector (GoHighLevel API v2) adapter.
 * The location is always resolved from the tenant's server-side mapping — never from a request —
 * and protected locations are rejected before any network call. Writes are not implemented here;
 * approved CRM changes stay blocked until a reviewed sync job is enabled.
 */

export interface GhlMapping {
  orgId: string;
  orgKind: "agency" | "client";
  locationId: string;
  pipelineId: string | null;
  calendarIds: string[];
  token: string;
}

const VERSION_DEFAULT = "2021-07-28";
const VERSION_CALENDARS = "2021-04-15";

async function loadMapping(db: Queryable, orgId: string): Promise<GhlMapping | null> {
  const { rows } = await db.query<{
    location_id: string;
    credential_id:string|null;
    pipeline_id: string | null;
    calendar_ids: string[];
    ciphertext: string | null;
    revoked_at: Date | null;
    kind: "agency" | "client";
  }>(
    `select g.credential_id,g.location_id, g.pipeline_id, g.calendar_ids, c.ciphertext, c.revoked_at, o.kind
     from ghl_location_mappings g join organizations o on o.id = g.org_id
     left join integration_credentials c on c.id = g.credential_id
     where g.org_id = $1 and g.status <> 'disabled'`,
    [orgId],
  );
  const r = rows[0];
  if (!r || !r.ciphertext || r.revoked_at) return null;
  assertAssignableLocation(r.location_id, r.kind);
  if (!r.credential_id) return null;
  const token=await resolveCredential(db,r.credential_id,orgId,"ghl");
  return token ? { orgId, orgKind: r.kind, locationId: r.location_id, pipelineId: r.pipeline_id, calendarIds: r.calendar_ids, token } : null;
}

class GhlError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

async function ghlGet<T>(m: GhlMapping, path: string, params: Record<string, string>, version = VERSION_DEFAULT): Promise<T> {
  if(new URL(env().GHL_API_BASE).origin!=="https://services.leadconnectorhq.com")throw new GhlError("GoHighLevel must use the official API host.");
  const url = new URL(path, env().GHL_API_BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${m.token}`, Version: version, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new GhlError("GoHighLevel could not be reached.");
  }
  if (res.status === 401 || res.status === 403) throw new GhlError("GoHighLevel rejected the credential or its scopes.", res.status);
  if (res.status === 429) throw new GhlError("GoHighLevel rate limit reached. Try again shortly.", 429);
  if (!res.ok) throw new GhlError(`GoHighLevel returned ${res.status}.`, res.status);
  const body:unknown=await res.json().catch(()=>null);
  if(!body || typeof body!=="object" || Array.isArray(body))throw new GhlError("GoHighLevel returned an unsupported response.");
  return body as T;
}

/** Do not cache or attest a successful empty result when the provider omitted the expected list. */
function scopedRows<T extends {id:string}>(rows:T[]|undefined,m:GhlMapping,calendarId?:string):T[] {
  if(!Array.isArray(rows))throw new GhlError("GoHighLevel returned an unsupported response.");
  for(const row of rows) {
    if(!row || typeof row!=="object" || typeof row.id!=="string" || !row.id)throw new GhlError("GoHighLevel returned unsupported record metadata.");
    const meta=row as T & {locationId?:unknown;location_id?:unknown;calendarId?:unknown};
    if((meta.locationId!==undefined && meta.locationId!==m.locationId) || (meta.location_id!==undefined && meta.location_id!==m.locationId))throw new GhlError("GoHighLevel returned records for another location.");
    if(calendarId && meta.calendarId!==calendarId)throw new GhlError("GoHighLevel returned records for another calendar.");
  }
  return rows;
}

interface PipelineResponse {
  pipelines?: Array<{ id: string; name: string; stages?: Array<{ id: string; name: string; position?: number }> }>;
}
interface OpportunityResponse {
  opportunities?: Array<{
    id: string;
    name?: string;
    pipelineId?: string;
    pipelineStageId?: string;
    status?: string;
    monetaryValue?: number;
    assignedTo?: string;
    source?: string;
    updatedAt?: string;
    contact?: { name?: string; companyName?: string };
  }>;
  meta?: { nextPageUrl?: string | null; startAfterId?: string; startAfter?: number; total?: number };
}
interface EventsResponse {
  events?: Array<{
    id: string;
    calendarId: string;
    title?: string;
    appointmentStatus?: string;
    contactId?: string;
    assignedUserId?: string;
    startTime: string;
    endTime: string;
    address?: string;
    dateUpdated?: string;
  }>;
}

export type SyncSummary = { ok: boolean; detail: string; pipelines?: number; opportunities?: number; appointments?: number };

/** Confirms the stored credential can read the mapped location. */
export async function verifyGhlConnection(orgId: string, actorUserId: string | null, opts: { skipSetupSync?: boolean } = {}): Promise<SyncSummary> {
  const result = await verifyGhlConnectionInner(orgId, actorUserId);
  if (!opts.skipSetupSync) {
    try {
      const { reconcileSetupAutomation } = await import("@/server/setup/automation");
      await reconcileSetupAutomation(orgId);
    } catch {
      if (process.env.NODE_ENV !== "test") console.error("[iacquire] setup sync after CRM verification failed");
    }
  }
  return result;
}

async function verifyGhlConnectionInner(orgId: string, actorUserId: string | null): Promise<SyncSummary> {
  const mapping = await withSystem((db) => loadMapping(db, orgId));
  if (!mapping) {
    await withSystem((db) => setIntegrationStatus(db, orgId, "ghl", "not_configured", "No location credential stored."));
    return { ok: false, detail: "No GoHighLevel credential is configured for this workspace." };
  }
  try {
    await verifyGhlIdentity({locationId:mapping.locationId,orgKind:mapping.orgKind,token:mapping.token});
    const data = await ghlGet<PipelineResponse>(mapping, "/opportunities/pipelines", { locationId: mapping.locationId });
    const count = scopedRows(data.pipelines,mapping).length;
    await withSystem(async (db) => {
      await db.query("update ghl_location_mappings set status = 'connected', verified_at = now() where org_id = $1", [orgId]);
      await setIntegrationStatus(db, orgId, "ghl", "connected", `Verified read access · ${count} pipeline${count === 1 ? "" : "s"}`);
      await recordAudit({ orgId, actorUserId, actorKind: actorUserId ? "agency" : "system", action: "integration.ghl_verified", result: "success" }, db);
    });
    return { ok: true, detail: `Verified read access (${count} pipelines).`, pipelines: count };
  } catch (err) {
    const detail = err instanceof GhlError ? err.message : "Verification failed.";
    await withSystem(async (db) => {
      await db.query("update ghl_location_mappings set status = 'error' where org_id = $1", [orgId]);
      await setIntegrationStatus(db, orgId, "ghl", "error", detail);
      await recordAudit({ orgId, actorUserId, actorKind: actorUserId ? "agency" : "system", action: "integration.ghl_verified", result: "failure", metadata: { detail } }, db);
    });
    return { ok: false, detail };
  }
}

/** Refreshes the tenant's read-through cache of pipelines, opportunities and appointments. */
export async function syncGhl(orgId: string, actorUserId: string | null): Promise<SyncSummary> {
  const mapping = await withSystem((db) => loadMapping(db, orgId));
  if (!mapping) throw new AppError("integration_unavailable", "Your CRM isn't connected yet.");
  try {
    await verifyGhlIdentity({locationId:mapping.locationId,orgKind:mapping.orgKind,token:mapping.token});
    const pipelines = await ghlGet<PipelineResponse>(mapping, "/opportunities/pipelines", { locationId: mapping.locationId });
    const pipelineRows=scopedRows(pipelines.pipelines,mapping);
    const stageNames = new Map<string, string>();
    for (const p of pipelineRows) for (const s of p.stages ?? []) stageNames.set(s.id, s.name);

    const opportunities: NonNullable<OpportunityResponse["opportunities"]> = [];
    let startAfterId: string | undefined;
    let startAfter: number | undefined;
    for (let page = 0; page < 5; page++) {
      const params: Record<string, string> = { location_id: mapping.locationId, limit: "100" };
      if (mapping.pipelineId) params.pipeline_id = mapping.pipelineId;
      if (startAfterId && startAfter !== undefined) {
        params.startAfterId = startAfterId;
        params.startAfter = String(startAfter);
      }
      const res = await ghlGet<OpportunityResponse>(mapping, "/opportunities/search", params);
      const pageRows=scopedRows(res.opportunities,mapping);
      if(mapping.pipelineId && pageRows.some(o=>o.pipelineId!==mapping.pipelineId))throw new GhlError("GoHighLevel returned records for another pipeline.");
      opportunities.push(...pageRows);
      if (!res.meta?.nextPageUrl || !res.meta.startAfterId) break;
      startAfterId = res.meta.startAfterId;
      startAfter = res.meta.startAfter;
    }

    const events: NonNullable<EventsResponse["events"]> = [];
    const start = Date.now() - 30 * 86400000;
    const end = Date.now() + 60 * 86400000;
    for (const calendarId of mapping.calendarIds) {
      const res = await ghlGet<EventsResponse>(
        mapping,
        "/calendars/events",
        { locationId: mapping.locationId, calendarId, startTime: String(start), endTime: String(end) },
        VERSION_CALENDARS,
      );
      events.push(...scopedRows(res.events,mapping,calendarId));
    }

    await withSystem(async (db) => {
      for (const p of pipelineRows) {
        await db.query(
          `insert into crm_pipelines (org_id, ghl_pipeline_id, name, stages, synced_at) values ($1, $2, $3, $4, now())
           on conflict (org_id, ghl_pipeline_id) do update set name = excluded.name, stages = excluded.stages, synced_at = now()`,
          [orgId, p.id, p.name, JSON.stringify((p.stages ?? []).map((s) => ({ id: s.id, name: s.name, position: s.position ?? 0 })))],
        );
      }
      for (const o of opportunities) {
        const status = ["open", "won", "lost", "abandoned"].includes(o.status ?? "") ? o.status : "open";
        await db.query(
          `insert into crm_opportunities (org_id, ghl_opportunity_id, ghl_pipeline_id, stage_id, stage_name, name, status,
             monetary_value, contact_label, assigned_to, source, remote_updated_at, synced_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
           on conflict (org_id, ghl_opportunity_id) do update set ghl_pipeline_id = excluded.ghl_pipeline_id,
             stage_id = excluded.stage_id, stage_name = excluded.stage_name, name = excluded.name, status = excluded.status,
             monetary_value = excluded.monetary_value, contact_label = excluded.contact_label, assigned_to = excluded.assigned_to,
             source = excluded.source, remote_updated_at = excluded.remote_updated_at, synced_at = now()`,
          [
            orgId, o.id, o.pipelineId ?? null, o.pipelineStageId ?? null, stageNames.get(o.pipelineStageId ?? "") ?? null,
            (o.name ?? "Untitled opportunity").slice(0, 200), status, o.monetaryValue ?? null,
            (o.contact?.companyName || o.contact?.name || null)?.slice(0, 200) ?? null, o.assignedTo ?? null, o.source ?? null, o.updatedAt ?? null,
          ],
        );
      }
      for (const e of events) {
        // Every calendar snapshot goes through the same ordered ledger as the webhooks, so a stale snapshot can never overwrite a newer change.
        // A snapshot that carries no timestamp can add an appointment we have not seen but can never change one we have.
        const startAt = new Date(e.startTime);
        if (Number.isNaN(startAt.getTime())) continue;
        const endAt = new Date(e.endTime);
        await applyAppointmentEvent(db, {
          orgId,
          source: "sync",
          providerEventId: `sync:${e.id}:${e.dateUpdated ?? "none"}`,
          event: {
            kind: "update",
            locationId: mapping.locationId,
            appointmentId: e.id,
            calendarId: e.calendarId,
            contactId: e.contactId ?? null,
            status: mapAppointmentStatus(e.appointmentStatus),
            assignedUserId: e.assignedUserId ?? null,
            title: (e.title ?? "Appointment").slice(0, 200),
            address: e.address ?? null,
            startAt,
            endAt: Number.isNaN(endAt.getTime()) || endAt <= startAt ? new Date(startAt.getTime() + 30 * 60_000) : endAt,
            eventTime: e.dateUpdated && !Number.isNaN(Date.parse(e.dateUpdated)) ? new Date(e.dateUpdated) : new Date(0),
            source: "sync",
          },
        });
      }
      await setIntegrationStatus(db, orgId, "ghl", "connected", `Synced ${opportunities.length} opportunities`);
      if (mapping.calendarIds.length) await setIntegrationStatus(db, orgId, "ghl_calendar", "connected", `Synced ${events.length} appointments`);
      await recordAudit(
        { orgId, actorUserId, actorKind: actorUserId ? "user" : "system", action: "integration.ghl_synced", result: "success", metadata: { opportunities: opportunities.length, appointments: events.length } },
        db,
      );
    });
    return { ok: true, detail: "Synced", pipelines: pipelineRows.length, opportunities: opportunities.length, appointments: events.length };
  } catch (err) {
    const detail = err instanceof GhlError ? err.message : "Sync failed.";
    await withSystem((db) => setIntegrationStatus(db, orgId, "ghl", "error", detail));
    return { ok: false, detail };
  }
}

/** The verified location and credential for a tenant, for the messaging provider. Returns null when none is usable. */
export { loadMapping as loadGhlMapping };
