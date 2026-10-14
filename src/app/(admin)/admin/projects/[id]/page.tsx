import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencyProject } from "@/server/projects/agency";
import { AdminProjectWorkspace } from "@/components/admin/admin-project-workspace";

export const metadata = { title: "Project" };

export default async function AdminProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireAgency();
  const { id } = await params;
  const project = await getAgencyProject(user, id);
  if (!project) notFound();
  return (
    <div className="space-y-5">
      <Link href="/admin/projects" className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="size-3.5" /> Custom projects
      </Link>
      <AdminProjectWorkspace project={project} currentUserId={user.id} />
    </div>
  );
}
