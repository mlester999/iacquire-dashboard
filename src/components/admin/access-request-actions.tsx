"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Phone, X } from "lucide-react";
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {request.status === "new" && (
          <Button variant="secondary" className="w-full sm:w-auto" onClick={() => set("contacted")}>
            <Phone className="size-4" aria-hidden /> Mark contacted
          </Button>
        )}
        {open && (
          <>
            <Button variant="secondary" className="w-full sm:w-auto" onClick={() => set("approved")}>
              <Check className="size-4" aria-hidden /> Mark approved
            </Button>
            <div className="w-full sm:w-auto [&>button]:w-full sm:[&>button]:w-auto">
              <CreateClientButton initial={{ name: request.company, email: request.email, website: request.website }} />
            </div>
          </>
        )}
      </div>
      {open && (
        <div className="flex border-t border-line pt-3">
          <Button variant="outline" className="w-full border-danger/30 text-danger-ink hover:border-danger/50 hover:bg-danger-soft sm:w-auto" onClick={() => set("declined")}>
            <X className="size-4" aria-hidden /> Decline request
          </Button>
        </div>
      )}
    </div>
  );
}
