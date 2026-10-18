import { cache } from "react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { allowHostedFormView, hostedFormToken, resolveHostedForm } from "@/server/crm/forms/public";
import { PublicForm } from "@/components/crm/forms/public-form";
import { BusyNotice, FormShell } from "../../_components/shell";

export const dynamic = "force-dynamic";

type Params = Promise<{ org: string; key: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const load = cache((org: string, key: string) => resolveHostedForm(org, key));

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { org, key } = await params;
  const page = await load(org, key);
  return { title: page ? `${page.form.title} · ${page.business.name}` : "Form not available" };
}

/** The page the visit landed on, as this request asked for it (the form's address and its query, such as utm_source). */
function landingOf(org: string, key: string, sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) if (q.size < 30) q.append(k.slice(0, 40), one.slice(0, 200));
  return `/f/${org}/${key}${q.size ? `?${q}` : ""}`;
}

/** A business's form, on its own page: works on any device, with or without script. */
export default async function HostedFormPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
  if (!(await allowHostedFormView(ip))) return <BusyNotice />;
  const [{ org, key }, sp] = await Promise.all([params, searchParams]);
  const page = await load(org, key);
  if (!page) notFound();
  const f = page.form;
  const slugs = { org: page.business.slug, key: f.key };
  return (
    <FormShell business={page.business}>
      <div className="rounded-3xl border border-line bg-surface p-5 shadow-card sm:p-8">
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.03em] text-ink sm:text-[28px]">{f.title}</h1>
        {f.intro && <p className="mt-2 whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{f.intro}</p>}
        <div className="mt-6">
          <PublicForm
            def={f}
            action="/api/public/forms/submit"
            accent={page.business.brandColor}
            hidden={{ org: slugs.org, key: slugs.key, t: hostedFormToken(slugs.org, slugs.key), _l: landingOf(slugs.org, slugs.key, sp), _r: (h.get("referer") ?? "").slice(0, 500) }}
          />
        </div>
      </div>
      <p className="mt-4 text-center text-[12px] leading-relaxed text-muted">Your answers go to {page.business.name}. Questions marked (optional) can be left blank.</p>
    </FormShell>
  );
}
