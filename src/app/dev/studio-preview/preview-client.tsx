"use client";

import dynamic from "next/dynamic";

const Inner = dynamic(() => import("./preview-inner"), { ssr: false, loading: () => <p className="p-8 text-center text-sm text-muted">Loading preview…</p> });

export default function PreviewClient({ role, template }: { role: "owner" | "editor"; template: string }) {
  return <Inner role={role} template={template} />;
}
