import { FileX2 } from "lucide-react";
import { FormShell } from "./_components/shell";

/**
 * Every miss under /f looks the same: an unknown business, a form that is a draft, archived or not offered as a page, or a link that
 * isn't valid any more. Nothing here says which, so the page can't be used to discover what exists.
 */
export default function FormNotFound() {
  return (
    <FormShell business={null}>
      <div className="mx-auto mt-10 max-w-md text-center sm:mt-16">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
          <FileX2 className="size-5" aria-hidden />
        </div>
        <h1 className="mt-5 text-[22px] font-semibold tracking-[-0.03em] text-ink">This form isn&apos;t available</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          The link may be mistyped or out of date, or the business may not be taking answers here right now. Check the link with the business that shared it.
        </p>
      </div>
    </FormShell>
  );
}
