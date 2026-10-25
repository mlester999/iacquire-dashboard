"use client";

import * as React from "react";
import { Dialog as D, DropdownMenu as DM, Tooltip as T, Tabs as TB, Switch as SW, Popover as PO } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useGuidance } from "@/components/aqi/tutorial/tutorial-store";

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
  icon,
  iconClassName,
  ariaLabel,
  hideBodyWhenEmpty = false,
  fullScreen = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  trigger?: React.ReactNode;
  icon?: React.ReactNode;
  iconClassName?: string;
  ariaLabel?: string;
  hideBodyWhenEmpty?: boolean;
  fullScreen?: boolean;
}) {
  const width = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" }[size];
  const hasBody = !hideBodyWhenEmpty || React.Children.toArray(children).length > 0;
  const returnFocus = React.useRef<HTMLElement | null>(null);
  // While AQi is guiding someone, a page dialog must not hide the guidance card from the
  // accessibility tree or trap focus away from its controls. The dialog keeps its own focus order.
  const guidanceOpen = useGuidance().open;
  return (
    <D.Root open={open} onOpenChange={onOpenChange} modal={!guidanceOpen}>
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
            <D.Content
              asChild
              forceMount
              onPointerDownOutside={(event) => { if (guidanceOpen) event.preventDefault(); }}
              onFocusOutside={(event) => { if (guidanceOpen) event.preventDefault(); }}
              onInteractOutside={(event) => { if (guidanceOpen) event.preventDefault(); }}
              onEscapeKeyDown={(event) => { if (guidanceOpen) event.preventDefault(); }}
              onOpenAutoFocus={() => {
                // Programmatically opened dialogs also need an explicit return target.
                if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
              }}
              onCloseAutoFocus={(event) => {
                if (returnFocus.current?.isConnected) {
                  event.preventDefault();
                  returnFocus.current.focus();
                }
              }}
            >
              <motion.div
                className={cn(
                  "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-3xl border border-line bg-surface shadow-float outline-none",
                  "sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-32px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl",
                  width,
                  fullScreen && "max-h-[100dvh] rounded-none sm:inset-4 sm:left-4 sm:top-4 sm:h-[calc(100dvh-32px)] sm:w-[calc(100vw-32px)] sm:max-w-none sm:translate-x-0 sm:translate-y-0 sm:rounded-2xl",
                )}
                initial={{ opacity: 0, y: 24, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 16, scale: 0.98 }}
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              >
                <div className={cn("flex items-start justify-between gap-4 px-5 py-4 sm:px-6", hasBody && "border-b border-line")}>
                  <div className="flex min-w-0 items-start gap-3">
                    {icon && <span aria-hidden className={cn("mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-ink-2", iconClassName)}>{icon}</span>}
                    <div className="min-w-0">
                      <D.Title className="text-[16px] font-semibold tracking-tight text-ink">{title}</D.Title>
                      {description ? (
                        <D.Description className="mt-1 text-[14px] leading-relaxed text-muted">{description}</D.Description>
                      ) : (
                        <D.Description className="sr-only">Dialog</D.Description>
                      )}
                    </div>
                  </div>
                  <D.Close className="-mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink sm:size-8" aria-label="Close">
                    <X className="size-4" />
                  </D.Close>
                </div>
                {hasBody && (
                  <div tabIndex={0} role="region" aria-label={ariaLabel ?? (typeof title === "string" ? `${title} content` : "Dialog content")} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:px-6">{children}</div>
                )}
                {footer && <div className={cn("flex flex-wrap justify-end gap-2 px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-6", hasBody && "border-t border-line")}>{footer}</div>}
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
  const returnFocus = React.useRef<HTMLElement | null>(null);
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
            <D.Content
              asChild
              forceMount
              onOpenAutoFocus={() => {
                if (document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
              }}
              onCloseAutoFocus={(event) => {
                if (returnFocus.current?.isConnected) {
                  event.preventDefault();
                  returnFocus.current.focus();
                }
              }}
            >
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
                      <D.Title className="break-words text-[16px] font-semibold tracking-tight text-ink">{title}</D.Title>
                      <D.Description className={description ? "mt-1 text-[14px] text-muted" : "sr-only"}>{description ?? "Panel"}</D.Description>
                    </div>
                    <D.Close className="-mr-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-surface-2 hover:text-ink sm:size-8" aria-label="Close">
                      <X className="size-4" />
                    </D.Close>
                  </div>
                )}
                <div tabIndex={0} role="region" aria-label={typeof title === "string" ? `${title} content` : "Panel content"} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">{children}</div>
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
          "z-50 min-w-[200px] overflow-hidden rounded-xl border border-line bg-surface p-1 text-[14px] shadow-float",
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
  return <DM.Label className={cn("px-2.5 pb-1 pt-2 text-[12px] font-medium uppercase tracking-wider text-faint", className)} {...props} />;
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
  children,
}: {
  value: string;
  onValueChange: (v: string) => void;
  items: Array<{ value: string; label: React.ReactNode; count?: number }>;
  className?: string;
  id: string;
  children?: React.ReactNode;
}) {
  return (
    <TB.Root value={value} onValueChange={onValueChange}>
      <TB.List className={cn("scrollbar-thin -mx-1 flex max-w-full gap-1 overflow-x-auto px-1", className)} aria-label="Sections">
        {items.map((item) => (
          <TB.Trigger
            key={item.value}
            value={item.value}
            // No aria-label here: the visible label and count badge already form the accessible name, and a
            // hand-built name drifts from what is on screen (WCAG 2.5.3).
            className="relative inline-flex h-9 shrink-0 items-center gap-2 rounded-xl px-3.5 text-[14px] font-medium text-muted transition-colors hover:text-ink data-[state=active]:text-ink"
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
              <span className="relative rounded-full bg-surface-3 px-1.5 py-0.5 text-[12px] font-semibold text-ink-2">{item.count}</span>
            )}
          </TB.Trigger>
        ))}
      </TB.List>
      {items.map((item) => (
        <TB.Content key={item.value} value={item.value} forceMount hidden={item.value !== value} className="mt-6 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-4 focus-visible:ring-offset-bg">
          {item.value === value ? children : null}
        </TB.Content>
      ))}
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
  const groupName = React.useId();
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex max-w-full overflow-x-auto rounded-xl border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[10px] font-medium text-muted transition-colors hover:text-ink has-[:checked]:text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
            size === "sm" ? "min-h-11 px-2.5 text-[13px] sm:min-h-7" : "min-h-11 px-3 text-[14px] sm:min-h-8",
          )}
        >
          <input type="radio" name={groupName} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
          {value === o.value && (
            <motion.span
              layoutId={`seg-${id}`}
              className="absolute inset-0 rounded-[10px] bg-surface shadow-soft"
              transition={{ type: "spring", stiffness: 500, damping: 38 }}
            />
          )}
          <span className="relative">{o.label}</span>
        </label>
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
