import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { DemoLanding } from "@/components/demo/landing";
import { PublicFrame } from "@/components/demo/shell";
import { startNotice } from "@/lib/demo/outcomes";
import { ForceTheme } from "../showroom-preview/force-theme";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demo request page preview", robots: { index: false, follow: false } };

type Q = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * The prospect demo's request page (/demo) with sample state, for design QA without the database. Development only. The address chooses the state:
 *   state=open (default) | full | ai_off | session | closed | stopped
 *   r=sent|left|invalid|... (the word the page is sent back with), f=name.email (fields to mark as wrong)
 *   theme=light|dark|system
 */
export default async function DemoLandingPreview({ searchParams }: { searchParams: Promise<Q> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const mode = one(q.state) ?? "open";
  const theme = one(q.theme);
  const hasSession = mode === "session";
  const view =
    mode === "closed"
      ? ({ ok: false, reason: "not_available", message: "The demo is not open right now." } as const)
      : mode === "stopped"
        ? ({ ok: false, reason: "unavailable", message: "The demo is temporarily unavailable. Please try again later." } as const)
        : ({ ok: true, form: { retentionDays: 90, full: mode === "full", hasSession, windowHours: 24, messageLimit: 10, aiChat: mode !== "ai_off" } } as const);
  const fields = (one(q.f) ?? "").split(".").filter((f): f is "name" | "email" | "business" | "industry" | "consent" => ["name", "email", "business", "industry", "consent"].includes(f));
  return (
    <>
      <ForceTheme theme={theme === "light" || theme === "dark" || theme === "system" ? theme : null} />
      <PublicFrame wide>
        <DemoLanding view={view} notice={startNotice(one(q.r), { hasSession })} fieldErrors={fields} utm={{}} />
      </PublicFrame>
    </>
  );
}
