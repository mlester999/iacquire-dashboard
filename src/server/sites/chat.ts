import "server-only";
import { withSiteRuntime } from "@/server/db";

// Whether a published site shows the website chat, and the address of the script that provides it. The site runtime has no table access, so the answer
// comes from one security-definer function (app.site_chat_widget) that returns the widget's public key for a verified, live host whose workspace switched
// the chat on and chose to install it on its own sites. The chat itself is served by the portal; the site only loads its script.

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; key: string | null }>();

export function clearSiteChatCache() {
  cache.clear();
}

export async function siteChatKey(host: string): Promise<string | null> {
  const h = host.toLowerCase();
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.key;
  let key: string | null = null;
  try {
    const { rows } = await withSiteRuntime((db) => db.query<{ public_key: string }>("select public_key from app.site_chat_widget($1)", [h]));
    key = rows[0]?.public_key ?? null;
  } catch {
    // A failure to look up the chat never breaks the page: the site simply renders without it.
    key = null;
  }
  if (cache.size > 2000) cache.clear();
  cache.set(h, { at: Date.now(), key });
  return key;
}

/** The script's address on the portal, from APP_URL. Null when the portal's address is not configured (then no chat is added). */
export function chatScriptSrc(): string | null {
  try {
    return `${new URL(process.env.APP_URL ?? "").origin}/widget/chat.js`;
  } catch {
    return null;
  }
}
