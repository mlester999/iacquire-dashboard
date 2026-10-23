import { CircleAlert, CircleCheck, Hourglass, Link2Off } from "lucide-react";
import { Monogram } from "@/app/book/_components/shell";

// The frame of the customer's pages: the business's name and colour, a way past the header, one main region. Works without scripts. Plain pages, no portal navigation.

export function PublicShell({ business, children, wide = false }: { business: { name: string; brandColor: string | null } | null; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <a href="#invoice-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-surface focus:px-4 focus:py-2 focus:text-[14px] focus:text-ink focus:shadow-float print:hidden">
        Skip to content
      </a>
      {business && (
        <header className={`mx-auto w-full px-4 pt-6 sm:px-6 sm:pt-10 print:hidden ${wide ? "max-w-3xl" : "max-w-2xl"}`}>
          <div className="flex min-w-0 items-center gap-3">
            <Monogram name={business.name} color={business.brandColor} />
            <p className="min-w-0 truncate text-[16px] font-semibold tracking-[-0.02em] text-ink">{business.name}</p>
          </div>
        </header>
      )}
      <main id="invoice-main" tabIndex={-1} className={`mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 sm:py-8 print:max-w-none print:p-0 ${wide ? "max-w-3xl" : "max-w-2xl"}`}>
        {children}
      </main>
    </div>
  );
}

const NOTICE_ICONS = { invalid: Link2Off, wait: Hourglass, ok: CircleCheck, problem: CircleAlert } as const;

/** A whole-page message: a link that does not open anything, a busy moment. */
export function PublicNotice({ kind, title, children }: { kind: keyof typeof NOTICE_ICONS; title: string; children: React.ReactNode }) {
  const Icon = NOTICE_ICONS[kind];
  return (
    <div className="mx-auto mt-6 max-w-md text-center sm:mt-12">
      <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
        <Icon className="size-5" aria-hidden />
      </div>
      <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">{title}</h1>
      <div className="mt-2 space-y-3 text-[14px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}
