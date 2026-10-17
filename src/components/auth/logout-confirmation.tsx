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
  containsSecret: boolean;
}

interface LogoutContextValue {
  requestLogout: () => void;
  setUnsavedState: (state: UnsavedState | null) => void;
}

const LogoutContext = React.createContext<LogoutContextValue | null>(null);

export function LogoutConfirmationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [unsaved, setUnsaved] = React.useState<UnsavedState | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const pendingRef = React.useRef(false);
  const requestLogout = React.useCallback(() => {
    setError(null);
    setOpen(true);
  }, []);
  const setUnsavedState = React.useCallback((state: UnsavedState | null) => setUnsaved(state), []);

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
          ? <>Your {unsaved.label.toLowerCase()} has changes that may not be saved yet. {unsaved.containsSecret ? "Any Cloudflare credentials entered but not saved will be cleared." : "Recent edits still being saved may be lost."}</>
          : "This ends your iAcquire session on this device. You can sign in again later."}
        icon={unsaved ? <AlertTriangle /> : <LogOut />}
        size="sm"
        footer={
          <>
            {unsaved && <Button variant="secondary" disabled={pending} onClick={() => { setOpen(false); router.push(unsaved.returnHref); }}>Return to save</Button>}
            <Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" loading={pending} onClick={() => void confirmLogout()}>Log out</Button>
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

export function useLogoutUnsavedChanges(label: string, dirty: boolean, containsSecret: boolean, returnHref: string) {
  const { setUnsavedState } = useLogoutConfirmation();
  React.useEffect(() => {
    setUnsavedState(dirty ? { label, containsSecret, returnHref } : null);
    return () => setUnsavedState(null);
  }, [dirty, label, containsSecret, returnHref, setUnsavedState]);
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
