"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, LogOut } from "lucide-react";
import { logoutAction } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

interface UnsavedState {
  label: string;
  returnHref: string;
  secretLabel: string | null;
}

interface LogoutContextValue {
  requestLogout: () => void;
  setUnsavedState: (registrationId: string, state: UnsavedState | null) => void;
}

const LogoutContext = React.createContext<LogoutContextValue | null>(null);

export function LogoutConfirmationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [unsavedById, setUnsavedById] = React.useState<Record<string, UnsavedState>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pendingRef = React.useRef(false);
  const requestLogout = React.useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);
  const setUnsavedState = React.useCallback((registrationId: string, state: UnsavedState | null) => {
    setUnsavedById((current) => {
      const next = { ...current };
      if (state) next[registrationId] = state;
      else delete next[registrationId];
      return next;
    });
  }, []);
  const unsavedEntries = Object.entries(unsavedById);
  const unsaved = unsavedEntries[0]?.[1] ?? null;

  async function confirmLogout() {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      await logoutAction();
      setOpen(false);
      router.replace("/login?signed_out=1");
      router.refresh();
    } catch {
      setError("We couldn't end your session. Please try again.");
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <LogoutContext.Provider value={{ requestLogout, setUnsavedState }}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          setOpen(next);
          if (next) setError(null);
        }}
        title="Log out of iAcquire?"
        description={unsaved
          ? <>Your {unsaved.label.toLowerCase()} has changes that may not be saved yet. {unsaved.secretLabel ? `Any ${unsaved.secretLabel} entered but not saved will be cleared.` : "Recent edits still being saved may be lost."}{unsavedEntries.length > 1 ? ` You also have ${unsavedEntries.length - 1} other unsaved change${unsavedEntries.length === 2 ? "" : "s"}.` : ""}</>
          : "You'll be signed out of iAcquire on this device. You can sign in again anytime."}
        icon={unsaved ? <AlertTriangle className="size-4" /> : <LogOut className="size-4" />}
        iconClassName={unsaved ? "bg-warning-soft text-warning-ink" : "bg-danger-soft text-danger-ink"}
        hideBodyWhenEmpty
        size="sm"
        footer={
          <>
            {unsaved && <Button variant="secondary" disabled={pending} onClick={() => { setOpen(false); router.push(unsaved.returnHref); }}>Return to save</Button>}
            <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" className="bg-[#b42328] text-white hover:bg-[#981b1f]" loading={pending} onClick={() => void confirmLogout()}>Log out</Button>
          </>
        }
      >
        {error && <p className="rounded-xl bg-danger-soft p-3 text-xs text-danger-ink" role="alert">{error}</p>}
      </Dialog>
    </LogoutContext.Provider>
  );
}

export function useLogoutConfirmation() {
  const context = React.useContext(LogoutContext);
  if (!context) throw new Error("Logout controls must be inside LogoutConfirmationProvider.");
  return context;
}

export function useLogoutUnsavedChanges(
  label: string,
  dirty: boolean,
  containsSecret: boolean,
  returnHref: string,
  secretLabel = "credentials",
  registrationId = label,
) {
  const { setUnsavedState } = useLogoutConfirmation();
  React.useEffect(() => {
    setUnsavedState(registrationId, dirty ? { label, secretLabel: containsSecret ? secretLabel : null, returnHref } : null);
    return () => setUnsavedState(registrationId, null);
  }, [dirty, label, containsSecret, returnHref, secretLabel, registrationId, setUnsavedState]);
}

export function LogoutTrigger({ className, children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { requestLogout } = useLogoutConfirmation();
  return (
    <button
      type="button"
      className={cn(className)}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) requestLogout();
      }}
    >
      {children}
    </button>
  );
}
