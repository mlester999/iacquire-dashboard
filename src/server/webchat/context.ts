import "server-only";
import { withSystem, withUser } from "@/server/db";
import type { OrgContext } from "@/server/tenancy/context";
import { validateQualificationQuestions } from "@/lib/webchat/rules";

/** What the team sees next to a website chat: where it ran, what the visit carried, and what the visitor shared. Read under the person's own access. */
export interface WebChatContext {
  surface: "site" | "embed";
  host: string;
  landingPath: string | null;
  referrer: string | null;
  startedAt: string;
  leadCaptured: boolean;
  /** The visitor ticked the box to receive offers (only possible when the owner offered it). */
  marketingOptIn: boolean;
  handoffRequested: boolean;
  qualification: Array<{ label: string; answer: string }>;
  /** A live contact that already holds the email or phone the visitor typed. A hint to check before replying; the two were NOT linked or merged. */
  possibleMatch: { id: string; name: string } | null;
}

export async function getWebChatContext(ctx: OrgContext, conversationId: string): Promise<WebChatContext | null> {
  const row = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{
      surface: "site" | "embed"; origin_host: string; landing_path: string | null; referrer: string | null; created_at: Date; lead_captured_at: Date | null; marketing_opt_in: boolean;
      handoff_requested_at: Date | null; qualification: Record<string, string>; possible_match_contact_id: string | null; match_name: string | null;
    }>(
      `select s.surface, s.origin_host, s.landing_path, s.referrer, s.created_at, s.lead_captured_at, s.marketing_opt_in, s.handoff_requested_at, s.qualification, s.possible_match_contact_id,
              (select k.display_name from contacts k where k.id = s.possible_match_contact_id and k.org_id = s.org_id and k.deleted_at is null) as match_name
       from web_chat_sessions s where s.conversation_id = $1 and s.org_id = $2`,
      [conversationId, ctx.org.orgId],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;
  // Question labels are workspace configuration, not visitor data: read for display whatever the person's website permission.
  const labels = await withSystem(async (db) => {
    const { rows } = await db.query<{ q: unknown }>("select qualification_questions as q from web_chat_widgets where org_id = $1", [ctx.org.orgId]);
    const parsed = validateQualificationQuestions(rows[0]?.q ?? []);
    return new Map((parsed.ok ? parsed.questions : []).map((x) => [x.key, x.label]));
  });
  return {
    surface: row.surface,
    host: row.origin_host,
    landingPath: row.landing_path,
    referrer: row.referrer,
    startedAt: new Date(row.created_at).toISOString(),
    leadCaptured: Boolean(row.lead_captured_at),
    marketingOptIn: row.marketing_opt_in,
    handoffRequested: Boolean(row.handoff_requested_at),
    qualification: Object.entries(row.qualification ?? {}).map(([key, answer]) => ({ label: labels.get(key) ?? key, answer })),
    possibleMatch: row.possible_match_contact_id && row.match_name ? { id: row.possible_match_contact_id, name: row.match_name } : null,
  };
}
