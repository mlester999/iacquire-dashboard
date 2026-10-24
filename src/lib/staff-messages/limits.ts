// Limits the screens, the services and the database agree on, in one place so the composer never offers more than the server keeps. Pure.
// Each number that is a choice rather than a fact is a proposal for the founder (docs/staff-messages.md lists them).

/** The workspace switch (org_features, on the agency workspace): absent means off. */
export const STAFF_MESSAGES_FEATURE = "staff_messages";

/** The longest message. The database check (0096) repeats it. */
export const MAX_BODY_CHARS = 8000;
export const MAX_NAME_CHARS = 80;
export const MAX_TOPIC_CHARS = 250;
/** People in one conversation. The member trigger in 0096 repeats it. */
export const MAX_MEMBERS = 200;
/** People one message may mention. The database check repeats it. */
export const MAX_MENTIONS = 20;

/** Files on one message and the size of each. The attachment trigger and check in 0096 repeat them. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** A file chosen in the composer and not sent is removed after this long. */
export const STAGED_UPLOAD_TTL_HOURS = 24;
/** Files one person can have waiting to be sent at once; more is almost certainly a script. */
export const MAX_STAGED_PER_PERSON = 20;

/** Messages in one page of a conversation, and the most a caller may ask for. */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_MAX_RESULTS = 30;

/** The retention period a Super Admin may choose, in days (the database check repeats it). There is none by default: nothing is deleted by age. */
export const RETENTION_DAYS_MIN = 30;
export const RETENTION_DAYS_MAX = 3650;

/** How much one run of the maintenance job may do, so a tick (cut off at 120 seconds) is never held up by it. */
export const MAINTENANCE_BUDGET_MS = 20_000;
export const MAINTENANCE_BATCH = 100;
