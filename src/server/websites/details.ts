import "server-only";
import { withUser } from "@/server/db";
import { confirmedAnswers, formatHours } from "@/lib/onboarding/engine";
import { getOnboardingSession } from "@/server/onboarding/service";
import { splitServices, type SiteDetails } from "@/lib/website/generate";
import type { BusinessHours } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * What we already know about the business, shaped for the site generator. Only answers the owner has confirmed are used:
 * suggestions from an AI assistant or a website read never reach a published page until the owner vouched for them.
 */
export async function buildSiteDetails(ctx: OrgContext): Promise<SiteDetails> {
  const session = await getOnboardingSession(ctx);
  const a = confirmedAnswers(session.answers);
  const profile = await withUser(ctx.user.id, async (db) =>
    (await db.query<{ name: string; industry: string | null; description: string | null; services: string | null; brand_color: string | null; brand_accent_color: string | null; contact_email: string | null; contact_phone: string | null; location: string | null }>(
      `select o.name, o.industry, p.description, p.services, p.brand_color, p.brand_accent_color, p.contact_email, p.contact_phone, p.location
       from organizations o left join company_profiles p on p.org_id = o.id where o.id = $1`,
      [ctx.org.orgId],
    )).rows[0],
  );
  const services = splitServices(str(a["b.services"]) || profile?.services || "");
  const faqs = Array.isArray(a["e.faqs"]) ? (a["e.faqs"] as Array<{ question: string; answer: string }>) : [];
  const colors = a["e.brand_colors"] as { primary?: string; accent?: string } | undefined;
  const logo = Array.isArray(a["e.logo"]) ? (a["e.logo"] as string[])[0] : null;
  const appointments = a["b.appointments"] === true;
  const industry = str(a["a.industry"]) || "other";
  const territories = str(a["a.territories"]).split(/\n|,|;/).map((s) => s.trim()).filter(Boolean);
  const pages = Array.isArray(a["e.website_pages"]) ? (a["e.website_pages"] as string[]) : undefined;
  return {
    businessName: str(a["a.business_name"]) || profile?.name || ctx.org.name,
    industry,
    description: str(a["a.description"]) || profile?.description || "",
    services: services.map((title) => ({ title })),
    phone: str(a["a.contact_phone"]) || profile?.contact_phone || "",
    email: str(a["a.contact_email"]) || profile?.contact_email || "",
    address: str(a["a.location"]) || profile?.location || "",
    hours: formatHours(a["a.hours"] as BusinessHours).replace(/; /g, "\n"),
    areas: territories.slice(0, 30),
    primary: colors?.primary || profile?.brand_color || undefined,
    accent: colors?.accent || profile?.brand_accent_color || undefined,
    pages: pages?.length ? Array.from(new Set(["home", ...pages, "contact"])).filter((p) => ["home", "about", "services", "faq", "gallery", "contact"].includes(p)) : undefined,
    faqs,
    aboutText: str(a["a.description"]),
    logoAssetId: logo,
    primaryAction: industry === "home_services" ? "call" : appointments ? "book" : "enquire",
  };
}
