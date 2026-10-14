"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CreateClientButton } from "@/components/admin/create-client";
import { updateAccessRequestAction } from "@/app/(admin)/admin/actions";

export function AccessRequestActions({ request }: { request: { id: string; status: string; company: string; email: string; website: string } }) {
  const router = useRouter();
  const set = async (status: "contacted" | "approved" | "declined") => {
    const res = await updateAccessRequestAction(request.id, status);
    if (!res.ok) return toast.error(res.error);
    toast.success(`Marked ${status}`);
    router.refresh();
  };
  const open = request.status !== "approved" && request.status !== "declined";
  return (
    <div className="flex flex-wrap gap-2">
      {request.status === "new" && (
        <Button size="sm" variant="secondary" onClick={() => set("contacted")}>
          Mark contacted
        </Button>
      )}
      {open && (
        <>
          <Button size="sm" variant="ghost" onClick={() => set("declined")}>
            Decline
          </Button>
          <Button size="sm" variant="secondary" onClick={() => set("approved")}>
            Mark approved
          </Button>
          <CreateClientButton initial={{ name: request.company, email: request.email, website: request.website }} />
        </>
      )}
    </div>
  );
}
