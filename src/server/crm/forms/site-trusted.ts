import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { isVerifiedSite, type LiveSite } from "@/server/sites/runtime";
import { FORM_KEY_RE } from "@/lib/crm/forms/spec";
import { contactsAreNative, loadPublishedByKey, type FormRow, type VersionRow } from "@/server/crm/forms/store";

// The ONLY place the public website runtime reads native forms with trusted (table-owner) access. It follows the same rules as the
// booking boundary (src/server/sites/booking-trusted.ts):
//
//  * Every function takes the LiveSite that resolveSite returned for the request's verified host, and refuses anything else at run time
//    (`isVerifiedSite`). The workspace is always that site's orgId; nothing the browser sends can name another one.
//  * It reads only published, non-archived forms of that workspace, by key, and only while the workspace's contacts are native.
//  * Every read runs in a READ ONLY transaction, so a bug here can't change data. Submissions are written through
//    app.submit_crm_form as iaq_site_runtime (src/server/crm/forms/site.ts), never from here.
//
// tests/crm-forms.test.ts fails if this module accepts a forged site or if the runtime reaches native forms any other way.

export interface SiteLiveForm {
  form: Pick<FormRow, "id" | "key" | "name" | "kind">;
  version: VersionRow;
  callingCode: string | null;
}

function orgOf(site: LiveSite): string {
  if (!isVerifiedSite(site)) throw new Error("Website forms need the site resolved from the request's verified host.");
  return site.orgId;
}

async function readOnly<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withSystem(async (db) => {
    await db.query("set transaction read only");
    return fn(db);
  });
}

/** The live native forms of this site's workspace among `keys` (unknown, draft and archived keys are simply absent). */
export async function siteLiveForms(site: LiveSite, keys: readonly string[]): Promise<Map<string, SiteLiveForm>> {
  const orgId = orgOf(site);
  const wanted = [...new Set(keys.map((k) => k.trim().toLowerCase()).filter((k) => FORM_KEY_RE.test(k)))].slice(0, 20);
  const out = new Map<string, SiteLiveForm>();
  if (!wanted.length) return out;
  return readOnly(async (db) => {
    if (!(await contactsAreNative(db, orgId))) return out;
    const code = (await db.query<{ c: string | null }>("select default_calling_code as c from crm_workspaces where org_id = $1", [orgId])).rows[0]?.c ?? null;
    for (const key of wanted) {
      const live = await loadPublishedByKey(db, orgId, key);
      if (live && live.form.org_id === orgId && live.version.org_id === orgId) {
        out.set(key, { form: { id: live.form.id, key: live.form.key, name: live.form.name, kind: live.form.kind }, version: live.version, callingCode: code });
      }
    }
    return out;
  });
}
