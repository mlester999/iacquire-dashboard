import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getProject } from "@/server/projects/client";
import { ProjectWorkspace } from "@/components/projects/project-workspace";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ submitted?: string }> }) {
  const ctx = await requireOrgContext("projects.view");
  const { id } = await params;
  const { submitted } = await searchParams;
  const project = await getProject(ctx, id);
  if (!project) notFound();
  return (
    <div className="space-y-5">
      <Link href="/projects" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> My projects
      </Link>
      <ProjectWorkspace
        project={project}
        timeZone={ctx.org.timezone}
        canRequest={ctx.can("projects.request")}
        canApproveQuote={ctx.can("projects.approve_quote")}
        canOpenSupport={ctx.can("support.use")}
        justSubmitted={submitted === "1"}
      />
    </div>
  );
}
