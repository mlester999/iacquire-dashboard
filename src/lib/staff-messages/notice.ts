// The notice staff are shown about how their messages are kept and who can read them. It is DRAFT wording for counsel (docs/staff-messages.md, "Founder and counsel decisions"):
// the screens show it as a draft with this version, and nothing treats it as approved. It says only what the product does; it does not claim a legal basis, a policy of the
// company's or that the messages are private by cryptography (they are not: they are protected by access rules in the database and by the server's checks).

export const STAFF_MESSAGES_NOTICE_VERSION = "draft-2026-10-24";

export const STAFF_MESSAGES_NOTICE_STATUS = "Draft wording for counsel. It has not been approved and is not a policy.";

export const STAFF_MESSAGES_NOTICE_LINES: readonly string[] = [
  "Messages are kept in iAcquire's database. They are protected by access rules, not by encryption: people who run the system and anyone with access to the database or its backups could read them.",
  "Inside the product, only the people in a conversation can read it. A Super Admin cannot open a direct message or a private group they are not part of. A Super Admin can archive a channel and remove a message in a channel they belong to; that is recorded.",
  "Messages and files are kept until a Super Admin chooses a retention period. If one is chosen, older messages are deleted for good.",
  "When someone leaves the team, their messages stay where they were written and show as from a former team member.",
  "Notifications about messages stay in iAcquire. An email, if one is ever sent, carries a title and a link, never the text of a message.",
];
