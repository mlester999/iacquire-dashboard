import "server-only";
import { z } from "zod";
import { readSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { neutralizeUntrusted } from "@/server/aqi/ops/redact";
import { OPS_SCOPE_TYPES, PLATFORM_SCOPE, type OpsScope, type OpsScopeRequest, type OpsScopeType } from "@/lib/aqi/ops/types";
import type { SessionUser } from "@/server/auth/service";

/**
 * Investigation scope. The browser says which context it wants; the server decides whether that
 * context exists and whether this administrator may open it, and derives the tenant from the
 * record itself (never from a client-supplied organization). Every tool then runs inside the
 * verified scope, and a scope change never carries one tenant's evidence into another.
 */

export const opsScopeRequestSchema = z.object({
  type: z.enum(OPS_SCOPE_TYPES),
  id: z.string().uuid().nullish(),
});

const NOT_AVAILABLE = "That investigation context was not found, or you don't have access to it.";

interface ScopeRow {
  id: string;
  label: string;
  org_id: string | null;
  org_name: string | null;
  allowed: boolean;
  platform_wide_ok?: boolean;
}

const QUERIES: Record<Exclude<OpsScopeType, "platform">, string> = {
  tenant: `select o.id, o.name as label, o.id as org_id, o.name as org_name, app.user_can_access_org($2, o.id) as allowed
           from organizations o where o.id = $1`,
  employee: `select a.id, a.display_name || ' (' || a.role_key || ')' as label, a.org_id, o.name as org_name, app.user_can_access_org($2, a.org_id) as allowed
             from agent_instances a join organizations o on o.id = a.org_id where a.id = $1`,
  workflow: `select w.id, w.name as label, w.org_id, o.name as org_name, app.user_can_access_org($2, w.org_id) as allowed
             from crm_workflows w join organizations o on o.id = w.org_id where w.id = $1`,
  ticket: `select t.id, t.ref || ' · ' || t.subject as label, t.org_id, o.name as org_name, app.user_can_access_org($2, t.org_id) as allowed
           from support_tickets t join organizations o on o.id = t.org_id where t.id = $1`,
  incident: `select i.id, i.title as label, i.org_id, o.name as org_name,
                    case when i.org_id is null then coalesce(app.user_has_agency_permission($2, 'agency.security.manage'), false)
                         else app.user_can_access_org($2, i.org_id) end as allowed
             from incidents i left join organizations o on o.id = i.org_id where i.id = $1`,
};

/** Validates a requested scope for this administrator. Throws one generic error for "missing" and "forbidden". */
export async function resolveOpsScope(user: Pick<SessionUser, "id" | "platformRole">, request: OpsScopeRequest | null | undefined): Promise<OpsScope> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
  if (!request || request.type === "platform") return PLATFORM_SCOPE;
  const parsed = opsScopeRequestSchema.safeParse(request);
  if (!parsed.success || !parsed.data.id) throw new AppError("invalid_input", "Choose a specific record for that investigation context.");
  const { type, id } = parsed.data;
  const { rows } = await readSystem((db) => db.query<ScopeRow>(QUERIES[type as Exclude<OpsScopeType, "platform">], [id, user.id]));
  const row = rows[0];
  if (!row || row.allowed !== true) throw new AppError("not_found", NOT_AVAILABLE);
  return {
    type,
    id: row.id,
    label: neutralizeUntrusted(row.label, 100).text || type,
    orgId: row.org_id,
    orgName: row.org_name ? neutralizeUntrusted(row.org_name, 80).text : null,
  };
}

export interface OpsScopeOption {
  type: OpsScopeType;
  id: string;
  label: string;
  detail: string | null;
}

const SEARCH_LIMIT = 6;

/**
 * Typeahead for the scope picker. One bounded statement; each branch is limited and filtered by the
 * viewer's own client scope. Short queries return the most recently active tenants only.
 */
export async function searchOpsScopes(
  user: Pick<SessionUser, "id" | "platformRole">,
  input: { q: string; types?: readonly OpsScopeType[] },
): Promise<OpsScopeOption[]> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "AQi Operations is available to Super Admins only.");
  const q = input.q.trim().slice(0, 80);
  const types = new Set((input.types?.length ? input.types : OPS_SCOPE_TYPES).filter((t) => t !== "platform"));
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const wantsText = q.length >= 2;
  const { rows } = await readSystem((db) => db.query<{ type: OpsScopeType; id: string; label: string; detail: string | null }>(
    `select u.type, u.id, u.label, u.detail from (
     (select 'tenant'::text as type, o.id, o.name as label, o.status || case when o.is_demo then ' · demo' else '' end as detail
        from organizations o
       where $3::boolean and o.kind = 'client' and o.status <> 'archived' and app.user_can_access_org($1, o.id)
         and ($4::boolean = false or o.name ilike $2 or o.slug ilike $2)
       order by o.updated_at desc limit ${SEARCH_LIMIT})
     union all
     (select 'employee', a.id, a.display_name || ' (' || a.role_key || ')', o.name
        from agent_instances a join organizations o on o.id = a.org_id
       where $5::boolean and $4::boolean and app.user_can_access_org($1, a.org_id)
         and (a.display_name ilike $2 or a.role_key ilike $2 or o.name ilike $2)
       order by a.updated_at desc limit ${SEARCH_LIMIT})
     union all
     (select 'ticket', t.id, t.ref || ' · ' || left(t.subject, 70), o.name
        from support_tickets t join organizations o on o.id = t.org_id
       where $6::boolean and $4::boolean and app.user_can_access_org($1, t.org_id)
         and (t.ref ilike $2 or t.subject ilike $2)
       order by t.last_message_at desc nulls last limit ${SEARCH_LIMIT})
     union all
     (select 'incident', i.id, left(i.title, 80), coalesce(o.name, 'Platform') || ' · ' || i.status
        from incidents i left join organizations o on o.id = i.org_id
       where $7::boolean and $4::boolean
         and (i.org_id is null and coalesce(app.user_has_agency_permission($1, 'agency.security.manage'), false) or i.org_id is not null and app.user_can_access_org($1, i.org_id))
         and (i.title ilike $2 or o.name ilike $2)
       order by i.detected_at desc limit ${SEARCH_LIMIT})
     union all
     (select 'workflow', w.id, w.name, o.name
        from crm_workflows w join organizations o on o.id = w.org_id
       where $8::boolean and $4::boolean and app.user_can_access_org($1, w.org_id)
         and (w.name ilike $2 or w.key ilike $2 or o.name ilike $2)
       order by w.updated_at desc limit ${SEARCH_LIMIT})
     ) u`,
    [user.id, pattern, types.has("tenant"), wantsText, types.has("employee"), types.has("ticket"), types.has("incident"), types.has("workflow")],
  ));
  return rows.map((row) => ({
    type: row.type,
    id: row.id,
    label: neutralizeUntrusted(row.label, 100).text,
    detail: row.detail ? neutralizeUntrusted(row.detail, 80).text : null,
  }));
}
