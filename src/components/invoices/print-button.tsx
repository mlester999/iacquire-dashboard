"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Prints the page with the browser's own print; the page frame and the buttons drop out. */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button variant="secondary" size="sm" className="print:hidden" onClick={() => window.print()}>
      <Printer className="size-4" aria-hidden />{label}
    </Button>
  );
}
