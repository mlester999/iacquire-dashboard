import { notFound } from "next/navigation";
import { TemplateFrame } from "@/components/website/frame/template-frame";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

/** Development only (404 in production): the same frame, without sign-in, so the gallery can be reviewed in a browser. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (env().NODE_ENV === "production") notFound();
  return <TemplateFrame q={await searchParams} base="/dev/frame/template" />;
}
