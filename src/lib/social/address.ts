// Reading values out of an address (a query string or a path) before a page uses them. Pure.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A canonical UUID. The database column types are uuid, so anything else must never reach a query: Postgres would raise instead of saying "not found". */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
