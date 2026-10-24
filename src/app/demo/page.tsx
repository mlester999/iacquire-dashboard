import type { Metadata } from "next";
import { cookies } from "next/headers";
import { requestMeta } from "@/server/auth/session";
import { getFormView } from "@/server/demo/public";
import { demoModelState } from "@/server/demo/generator";
import { DEMO_COOKIE } from "@/server/demo/tokens";
import { DemoLanding } from "@/components/demo/landing";
import { parseFieldWords, startNotice } from "@/lib/demo/outcomes";
import { cleanUtm } from "@/lib/demo/rules";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask for a demo" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Where a prospect asks for a demo. Everything on it comes from the service: closed, stopped, full for today, or open, truthfully for the settings in force. The word in the
 * address (`r`) says how the last form went and is shown only if this page knows it; campaign tags (utm_*) are carried into the form as hidden fields.
 */
export default async function DemoPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const meta = await requestMeta();
  const jar = await cookies();
  const view = await getFormView({
    ip: meta.ip,
    userAgent: meta.userAgent,
    sessionToken: jar.get(DEMO_COOKIE)?.value ?? null,
    modelReady: async () => (await demoModelState()).ready,
  });
  const notice = startNotice(one(q.r), { hasSession: view.ok && view.form.hasSession });
  const utm = cleanUtm(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, one(v)])));
  return <DemoLanding view={view} notice={notice} fieldErrors={parseFieldWords(one(q.f))} utm={utm} />;
}
