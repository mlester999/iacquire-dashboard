import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card-surface rounded-2xl", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex items-start justify-between gap-3 px-5 pt-5", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("text-[15px] font-semibold tracking-tight text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("mt-1 text-[13px] leading-relaxed text-muted", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 pb-5 pt-4", className)} {...props} />;
}

type Tone = "neutral" | "primary" | "success" | "warning" | "danger" | "violet" | "outline";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-ink-2 border-line",
  primary: "bg-primary-soft text-primary-ink border-transparent",
  success: "bg-success-soft text-success-ink border-transparent",
  warning: "bg-warning-soft text-warning-ink border-transparent",
  danger: "bg-danger-soft text-danger-ink border-transparent",
  violet: "bg-violet-soft text-violet-ink border-transparent",
  outline: "bg-transparent text-ink-2 border-line-strong",
};

export function Badge({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink shadow-soft outline-none transition",
        "placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 disabled:opacity-60 sm:h-10 sm:text-sm",
        "aria-[invalid=true]:border-danger aria-[invalid=true]:ring-danger/10",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-[96px] w-full resize-y rounded-xl border border-line-strong bg-surface px-3.5 py-2.5 text-[15px] leading-relaxed text-ink shadow-soft outline-none transition",
          "placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/12 sm:text-sm",
          "aria-[invalid=true]:border-danger",
          className,
        )}
        {...props}
      />
    );
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "h-11 w-full appearance-none rounded-xl border border-line-strong bg-surface pl-3.5 pr-9 text-[15px] text-ink shadow-soft outline-none transition",
          "focus:border-primary focus:ring-4 focus:ring-primary/12 sm:h-10 sm:text-sm",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <svg aria-hidden viewBox="0 0 20 20" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted">
        <path d="M5.5 7.5 10 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-medium text-ink-2", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  optional,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: string | null;
  optional?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor}>{label}</Label>
        {optional && <span className="text-[12px] text-faint">Optional</span>}
      </div>
      {children}
      {error ? (
        <p className="text-[12.5px] text-danger-ink" role="alert">
          {error}
        </p>
      ) : hint ? (
        <div className="text-[12.5px] leading-relaxed text-muted">{hint}</div>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-lg", className)} />;
}

export function Divider({ className }: { className?: string }) {
  return <div role="separator" className={cn("h-px w-full bg-line", className)} />;
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line bg-surface-2 px-1 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  compact,
  headingLevel = 3,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
  headingLevel?: 2 | 3 | 4;
}) {
  const titleClass = "text-[17px] font-semibold tracking-[-0.025em] text-ink";
  return (
    <div className={cn("empty-state flex flex-col items-center justify-center text-center", compact ? "px-4 py-7" : "px-6 py-10", className)}>
      {icon && (
        <div className="relative mb-4">
          <div className="absolute inset-0 -m-3 rounded-full bg-primary/10 blur-xl" aria-hidden />
          <div className="relative flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
            {icon}
          </div>
        </div>
      )}
      {headingLevel === 2 ? <h2 className={titleClass}>{title}</h2> : headingLevel === 4 ? <h4 className={titleClass}>{title}</h4> : <h3 className={titleClass}>{title}</h3>}
      {description && <div className="mt-2 max-w-md text-[13px] leading-[1.7] text-muted">{description}</div>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ProgressBar({ value, className, tone = "primary", label }: { value: number; className?: string; tone?: "primary" | "warning" | "danger" | "success"; label?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const fill = { primary: "bg-primary", warning: "bg-warning", danger: "bg-danger", success: "bg-success" }[tone];
  const track = { primary: "bg-primary-soft", warning: "bg-warning-soft", danger: "bg-danger-soft", success: "bg-success-soft" }[tone];
  return (
    <div
      className={cn("h-2 w-full overflow-hidden rounded-full", track, className)}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-700 ease-out", fill)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SectionHeading({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
