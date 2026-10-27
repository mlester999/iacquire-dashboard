import { notFound } from "next/navigation";
import { env } from "@/server/env";
import { Workspace } from "@/components/demo/showroom/workspace";
import { ForceTheme } from "./force-theme";
import { DEMO_INDUSTRIES, demoIndustryLabel } from "@/lib/demo/industries";
import { isViewId } from "@/lib/demo/showroom/content";
import { scenarioFor } from "@/lib/demo/showroom/industry";
import { REFUSAL_COPY } from "@/lib/demo/rules";
import { SETUP_FEE_USD, MAINTENANCE_MONTHLY_USD } from "@/lib/billing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Demo showroom preview", robots: { index: false, follow: false } };

type Q = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
/** The end of the window, this many hours from now (negative: it ended that long ago). */
const endsIn = (hours: number): string => new Date(Date.now() + hours * 3_600_000).toISOString();

/**
 * The prospect demo room with sample state, for design QA without a demo session. Development only. The address chooses the state to look at:
 *   view=overview|workforce|crm|inbox|automation|reports|pricing|why|summary
 *   state=open (default) | ended | ai_off | exhausted
 *   left=0..10 (messages left), hours=0.1..24 (window left), industry=<questionnaire value>
 *   confirm=consultation|buy (open the confirmation dialog)
 *   theme=light|dark|system (the colour theme to open in)
 *   consult=1 (consultation requested), buy=1 (purchase started), link=1 (a scheduling page is set), history=1 (a short conversation), plan=0 (the catalog could not be read)
 * Sending a message or pressing a request posts to the real demo endpoints, which answer "no session" here: that is the error path, not a bug.
 */
export default async function ShowroomPreview({ searchParams }: { searchParams: Promise<Q> }) {
  if (env().NODE_ENV === "production") notFound();
  const q = await searchParams;
  const view = one(q.view);
  const mode = one(q.state) ?? "open";
  const ended = mode === "ended";
  const aiOff = mode === "ai_off";
  const exhausted = mode === "exhausted";
  const left = exhausted || ended ? 0 : Math.max(0, Math.min(10, Number(one(q.left) ?? (aiOff ? 10 : 9))));
  const hours = Math.max(0.01, Math.min(24, Number(one(q.hours) ?? 23.6)));
  const industry = one(q.industry) ?? DEMO_INDUSTRIES[0].value;
  const windowEndsAt = endsIn(ended ? -2 : hours);
  const refusal = ended ? REFUSAL_COPY.window_ended : exhausted ? REFUSAL_COPY.limit_reached : aiOff ? REFUSAL_COPY.ai_off : null;
  const at = endsIn(0);
  const transcript =
    one(q.history) === "1" || exhausted
      ? [
          { id: "l1", seq: 1, role: "user" as const, employeeRole: null, body: "What does the Appointment Setter do?", state: "answered" as const, at },
          { id: "l2", seq: 2, role: "assistant" as const, employeeRole: "appointment_setter", body: "The Appointment Setter turns interest into booked meetings. It reads new enquiries, checks the calendar you connect for open times and prepares a reply for you to approve. In this demo everything is sample data.", state: null, at },
          { id: "l3", seq: 3, role: "user" as const, employeeRole: null, body: "Do I need to pay monthly?", state: "answered" as const, at },
          { id: "l4", seq: 4, role: "assistant" as const, employeeRole: null, body: "No. The implementation is paid once and the system is yours to use. Managed Maintenance is optional.", state: null, at },
        ]
      : [];
  const theme = one(q.theme);
  const confirm = one(q.confirm);
  return (
    <>
    <ForceTheme theme={theme === "light" || theme === "dark" || theme === "system" ? theme : null} />
    <Workspace
      initialView={isViewId(view) ? view : "overview"}
      state={{
        firstName: "Avery",
        business: one(q.business) ?? "Harborview Realty Group",
        industryLabel: demoIndustryLabel(industry),
        scenario: scenarioFor(industry),
        access: ended ? "ended" : "open",
        windowEndsAt,
        extended: one(q.extended) === "1",
        messagesLeft: left,
        messageAllowance: 10,
        aiEnabled: !aiOff,
        consultationRequested: one(q.consult) === "1",
        consultationUrl: one(q.link) === "1" ? "https://calendar.example.com/iacquire/intro" : null,
        purchaseStarted: one(q.buy) === "1",
        setupFeeUsd: SETUP_FEE_USD,
        monthlyPlanUsd: MAINTENANCE_MONTHLY_USD,
        plan: one(q.plan) === "0" ? { included: null, monthlyRequestAllowance: null } : { included: null, monthlyRequestAllowance: 4 },
        ctaNotice: null,
        initialConfirm: confirm === "consultation" || confirm === "buy" ? confirm : null,
      }}
      chat={{
        initial: { transcript, messagesLeft: left, messageAllowance: 10, canSend: !refusal, refusalMessage: refusal },
        fallbackMessageId: "00000000-0000-4000-8000-000000000000",
        pageNotice: null,
        show: !aiOff || transcript.length > 0,
      }}
    />
    </>
  );
}
