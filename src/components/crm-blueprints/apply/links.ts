// Where the editor and the apply wizard link to. Kept in one place so the routes other screens own (the Blueprint page, the application
// history, the client's CRM) are named once.

export const blueprintHref = (id: string) => `/admin/crm-blueprints/${id}`;
/** The Blueprint's page with its publish dialog open (on the Versions tab, which holds the dialog). */
export const publishHref = (id: string) => `/admin/crm-blueprints/${id}?tab=versions&publish=1`;
export const editHref = (id: string, section?: string) => `/admin/crm-blueprints/${id}/edit${section && section !== "details" ? `?section=${encodeURIComponent(section)}` : ""}`;
export const applyHref = (id: string, opts: { client?: string; version?: number } = {}) => {
  const sp = new URLSearchParams();
  if (opts.client) sp.set("client", opts.client);
  if (opts.version) sp.set("version", String(opts.version));
  return `/admin/crm-blueprints/${id}/apply${sp.size ? `?${sp}` : ""}`;
};
/** The application's detail in the library's application history. */
export const applicationHref = (orgId: string, applicationId: string) => `/admin/crm-blueprints/applications/${orgId}/${applicationId}`;
/** The client's CRM as the agency opens it (support access is asked for there). */
export const clientCrmHref = (orgId: string, path = "") => `/admin/clients/${orgId}/crm${path}`;
export const clientHref = (orgId: string) => `/admin/clients/${orgId}`;
