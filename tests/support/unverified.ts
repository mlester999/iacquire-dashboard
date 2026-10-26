// Fixtures for the tests of addresses a website visitor only typed. Synthetic workspaces only; no provider is contacted and the language model is a stub.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import type { Channel } from "@/lib/messaging";
import { answer, chatOrg, clientId, embedCall, hashOf, start, type ChatOrg } from "./webchat";
import { phone } from "./messaging";

export const uniqueEmail = () => `typed-${crypto.randomBytes(5).toString("hex")}@example.test`;

/** A workspace whose SMS and email go through native providers (no CRM link is needed to reach a contact), with the chat's promotional box offered. */
export const nativeChatOrg = (over: Parameters<typeof chatOrg>[0] = {}) => chatOrg({ offerMarketingOptIn: true, ...over }, { provider: { sms: "twilio", email: "resend", whatsapp: "meta_whatsapp" } });

export interface TypedLead {
  token: string;
  contactId: string;
  conversationId: string;
  phone: string | null;
  email: string | null;
}

/**
 * A visitor opens the chat, writes, and types their details into the form: the chat's own contact now holds an unverified phone number and/or email address with
 * consent recorded from the form. Pass null to leave one out; the promotional box is ticked when `marketing` is true.
 */
export async function typedLead(c: ChatOrg, over: { phone?: string | null; email?: string | null; marketing?: boolean } = {}): Promise<TypedLead> {
  const typedPhone = over.phone === undefined ? phone() : over.phone;
  const typedEmail = over.email === undefined ? uniqueEmail() : over.email;
  const token = await start(c);
  await embedCall(c, { action: "send", token, body: { text: "I need a quote", clientMessageId: clientId() }, generate: answer("Happy to help.").generate });
  const details: Record<string, string> = { name: "Dana Lee" };
  if (typedPhone) details.phone = typedPhone;
  if (typedEmail) details.email = typedEmail;
  const r = await embedCall(c, { action: "lead", token, body: { details, privacyAck: true, marketingOptIn: over.marketing === true } });
  if (r.status !== 200) throw new Error(`the details form was refused: ${JSON.stringify(r.body)}`);
  const s = (await withSystem((db) => db.query<{ contact_id: string; conversation_id: string }>("select contact_id, conversation_id from web_chat_sessions where token_hash = $1", [hashOf(token)]))).rows[0];
  return { token, contactId: s.contact_id, conversationId: s.conversation_id, phone: typedPhone, email: typedEmail };
}

/** The contact's conversation on a provider channel, created the way the automated paths create one (owned by the workspace's AI employee). */
export async function channelConversation(c: ChatOrg, contactId: string, channel: Channel): Promise<string> {
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, status, ai_agent_id, owner_kind) values ($1, $2, $3, 'open', $4, 'ai')
       on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
      [c.m.org.id, contactId, channel, c.m.salesAgentId],
    ),
  );
  return rows[0].id;
}

export const identityOf = async (orgId: string, kind: "phone" | "email", value: string) =>
  (await withSystem((db) => db.query<{ id: string; verified: boolean; verified_via: string | null; contact_id: string }>("select id, verified, verified_via, contact_id from contact_identities where org_id = $1 and kind = $2 and value = $3", [orgId, kind, value]))).rows[0];
