import type { Metadata } from "next";

// A customer's invoice page: no portal shell, no sign-in. The address carries the invoice's private link (or a checkout's reference), so the page is never indexed and never
// passes its address on as a referrer. In print the backdrop is dropped, so the invoice prints as a plain document.
export const metadata: Metadata = {
  title: { default: "Your invoice", template: "%s" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function PayLayout({ children }: { children: React.ReactNode }) {
  return <div className="app-backdrop min-h-dvh print:bg-white print:bg-none">{children}</div>;
}
