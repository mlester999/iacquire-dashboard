import type { Metadata } from "next";
import { requestMeta } from "@/server/auth/session";
import { peekVerification } from "@/server/demo/public";
import { looksLikeDemoToken } from "@/server/demo/tokens";
import { VerifyPanel } from "@/components/demo/verify-panel";
import { verifyNotice } from "@/lib/demo/outcomes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Open your demo", robots: { index: false, follow: false }, referrer: "no-referrer" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The page an emailed link opens. Looking at it changes nothing (a mail scanner that follows every link cannot use the link up): it only reads whether the link is still good and
 * shows a button, and the button is what starts the demo. After a button press that failed, the person comes back here WITHOUT the link and with a word (`e`) saying why.
 */
export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string | string[]; e?: string | string[] }> }) {
  const q = await searchParams;
  const token = one(q.token);
  const notice = verifyNotice(one(q.e));
  if (!looksLikeDemoToken(token)) return <VerifyPanel token="" peek={null} notice={notice ?? { tone: "error", text: "That link is not valid. Ask for a new one from the demo page." }} />;
  const meta = await requestMeta();
  const peek = await peekVerification(token, { ip: meta.ip, userAgent: meta.userAgent });
  return <VerifyPanel token={token} peek={peek} notice={null} />;
}
