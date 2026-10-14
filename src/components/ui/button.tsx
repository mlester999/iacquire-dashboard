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
  sm: "h-11 px-3 text-[13px] sm:h-8",
  md: "h-11 px-4 text-sm sm:h-10",
  lg: "h-12 px-6 text-[15px]",
  icon: "h-11 w-11 sm:h-10 sm:w-10",
  "icon-sm": "h-11 w-11 sm:h-8 sm:w-8",
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
