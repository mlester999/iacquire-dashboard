# iAcquire shared primitives

React 19, Next.js 16, Tailwind 4, Radix overlays and Motion. Preserve these components.

## src/components/ui/button.tsx

```tsx
"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "brand" | "soft";
type Size = "sm" | "md" | "lg" | "icon" | "icon-sm";

const base =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium " +
  "transition-[background-color,color,box-shadow,transform,border-color] duration-150 ease-out " +
  "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

const variants: Record<Variant, string> = {
  primary: "bg-ink text-surface shadow-soft hover:bg-ink/90 dark:bg-ink dark:text-bg",
  brand: "brand-gradient text-white shadow-glow hover:brightness-110",
  secondary: "border border-line bg-surface text-ink shadow-soft hover:bg-surface-2 hover:border-line-strong",
  outline: "border border-line-strong bg-transparent text-ink hover:bg-surface-2",
  ghost: "bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink",
  soft: "bg-primary-soft text-primary-ink hover:bg-primary/15",
  danger: "bg-danger text-white shadow-soft hover:bg-danger/90",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
  lg: "h-12 px-6 text-[15px]",
  icon: "h-10 w-10",
  "icon-sm": "h-8 w-8",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: React.ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return (
    <Link href={href} className={cn(base, variants[variant], sizes[size], className)} {...props}>
      {children}
    </Link>
  );
}

```

## src/components/ui/overlays.tsx

```tsx
"use client";

import * as React from "react";
import { Dialog as D, DropdownMenu as DM, Tooltip as T, Tabs as TB, Switch as SW, Popover as PO } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  trigger?: React.ReactNode;
}) {
  const width = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size];
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger && <D.Trigger asChild>{trigger}</D.Trigger>}
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[2px] dark:bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
              />
            </D.Overlay>
            <D.Content asChild forceMount aria-describedby={description ? undefined : undefined}>
              <motion.div
                className={cn(
                  "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl border border-line bg-surface shadow-float outline-none",
                  "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-32px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl",
                  width,
                )}
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              >
                <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
                  <div className="min-w-0">
                    <D.Title className="text-[16px] font-semibold tracking-tight text-ink">{title}</D.Title>
                    {description ? (
                      <D.Description className="mt-1 text-[13px] leading-relaxed text-muted">{description}</D.Description>
                    ) : (
                      <D.Description className="sr-only">Dialog</D.Description>
                    )}
                  </div>
                  <D.Close className="-mr-1 rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink" aria-label="Close">
                    <X className="size-4" />
                  </D.Close>
                </div>
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
                {footer && <div className="safe-bottom flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">{footer}</div>}
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  );
}

// ---------------------------------------------------------------------------
// Sheet (side drawer)
// ---------------------------------------------------------------------------

export function Sheet({
  open,
  onOpenChange,
  side = "right",
  title,
  description,
  children,
  className,
  hideHeader,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "right" | "left" | "bottom";
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  hideHeader?: boolean;
}) {
  const position = {
    right: "inset-y-0 right-0 h-dvh w-full max-w-[min(520px,100vw)] border-l",
    left: "inset-y-0 left-0 h-dvh w-[86vw] max-w-[320px] border-r",
    bottom: "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-3xl border-t",
  }[side];
  const offset = side === "right" ? { x: "100%" } : side === "left" ? { x: "-100%" } : { y: "100%" };
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <D.Portal forceMount>
            <D.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/30 dark:bg-black/60"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
              />
            </D.Overlay>
            <D.Content asChild forceMount>
              <motion.div
                className={cn("fixed z-50 flex flex-col border-line bg-surface shadow-float outline-none", position, className)}
                initial={offset}
                animate={{ x: 0, y: 0 }}
                exit={offset}
                transition={{ type: "spring", stiffness: 380, damping: 38 }}
              >
                {hideHeader ? (
                  <>
                    <D.Title className="sr-only">{title}</D.Title>
                    <D.Description className="sr-only">{description ?? "Panel"}</D.Description>
                  </>
                ) : (
                  <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
                    <div className="min-w-0">
                      <D.Title className="truncate text-[16px] font-semibold tracking-tight text-ink">{title}</D.Title>
                      <D.Description className={description ? "mt-1 text-[13px] text-muted" : "sr-only"}>{description ?? "Panel"}</D.Description>
                    </div>
                    <D.Close className="-mr-1 rounded-lg p-1.5 text-muted transition hover:bg-surface-2 hover:text-ink" aria-label="Close">
                      <X className="size-4" />
                    </D.Close>
                  </div>
                )}
                <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
              </motion.div>
            </D.Content>
          </D.Portal>
        )}
      </AnimatePresence>
    </D.Root>
  );
}

// ---------------------------------------------------------------------------
// Dropdown menu
// ---------------------------------------------------------------------------

export const Menu = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ className, align = "end", ...props }: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        className={cn(
          "z-50 min-w-[200px] overflow-hidden rounded-xl border border-line bg-surface p-1 text-[13.5px] shadow-float",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  );
}

export function MenuItem({ className, destructive, ...props }: React.ComponentProps<typeof DM.Item> & { destructive?: boolean }) {
  return (
    <DM.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-ink-2 outline-none transition-colors",
        "data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        destructive && "text-danger-ink data-[highlighted]:bg-danger-soft data-[highlighted]:text-danger-ink",
        className,
      )}
      {...props}
    />
  );
}

export function MenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return <DM.Label className={cn("px-2.5 pb-1 pt-2 text-[11.5px] font-medium uppercase tracking-wider text-faint", className)} {...props} />;
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export const Popover = PO.Root;
export const PopoverTrigger = PO.Trigger;
export function PopoverContent({ className, align = "end", ...props }: React.ComponentProps<typeof PO.Content>) {
  return (
    <PO.Portal>
      <PO.Content
        align={align}
        sideOffset={8}
        collisionPadding={12}
        className={cn("z-50 rounded-2xl border border-line bg-surface shadow-float outline-none", className)}
        {...props}
      />
    </PO.Portal>
  );
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <T.Provider delayDuration={250}>{children}</T.Provider>;
}

export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] max-w-xs rounded-lg bg-inverse px-2.5 py-1.5 text-[12px] leading-snug text-bg shadow-float"
        >
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

// ---------------------------------------------------------------------------
// Tabs with an animated indicator
// ---------------------------------------------------------------------------

export function Tabs({
  value,
  onValueChange,
  items,
  className,
  id,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: Array<{ value: string; label: React.ReactNode; count?: number }>;
  className?: string;
  id: string;
}) {
  return (
    <TB.Root value={value} onValueChange={onValueChange}>
      <TB.List className={cn("scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1", className)} aria-label="Sections">
        {items.map((item) => (
          <TB.Trigger
            key={item.value}
            value={item.value}
            // Keeps the count separate from the label for screen readers ("Review queue, 4").
            aria-label={typeof item.label === "string" && item.count !== undefined ? `${item.label}, ${item.count}` : undefined}
            className="relative inline-flex h-9 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[13.5px] font-medium text-muted transition-colors hover:text-ink data-[state=active]:text-ink"
          >
            {value === item.value && (
              <motion.span
                layoutId={`tab-${id}`}
                className="absolute inset-0 rounded-xl border border-line bg-surface shadow-soft"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative">{item.label}</span>
            {item.count !== undefined && (
              <span className="relative rounded-full bg-surface-3 px-1.5 py-0.5 text-[11px] font-semibold text-ink-2">{item.count}</span>
            )}
          </TB.Trigger>
        ))}
      </TB.List>
    </TB.Root>
  );
}

export function Segmented<V extends string>({
  value,
  onChange,
  options,
  id,
  size = "md",
  ariaLabel,
}: {
  value: V;
  onChange: (v: V) => void;
  options: Array<{ value: V; label: React.ReactNode }>;
  id: string;
  size?: "sm" | "md";
  ariaLabel: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex rounded-xl border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "relative rounded-[10px] font-medium text-muted transition-colors hover:text-ink aria-checked:text-ink",
            size === "sm" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]",
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="absolute inset-0 rounded-[10px] bg-surface shadow-soft"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------

export function Switch({ className, ...props }: React.ComponentProps<typeof SW.Root>) {
  return (
    <SW.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-transparent bg-surface-3 transition-colors",
        "data-[state=checked]:bg-primary disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SW.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow-md transition-transform duration-200 data-[state=checked]:translate-x-[22px]" />
    </SW.Root>
  );
}

```

## src/components/ui/primitives.tsx

```tsx
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
        <p className="text-[12.5px] leading-relaxed text-muted">{hint}</p>
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
}: {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center text-center", compact ? "px-4 py-8" : "px-6 py-14", className)}>
      {icon && (
        <div className="relative mb-4">
          <div className="absolute inset-0 -m-3 rounded-full bg-primary/10 blur-xl" aria-hidden />
          <div className="relative flex size-12 items-center justify-center rounded-2xl border border-line bg-surface text-primary shadow-card">
            {icon}
          </div>
        </div>
      )}
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      {description && <div className="mt-1.5 max-w-md text-[13.5px] leading-relaxed text-muted">{description}</div>}
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

```
