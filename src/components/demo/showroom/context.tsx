"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Notice } from "@/lib/demo/outcomes";
import type { ConfirmKind } from "@/lib/demo/showroom/confirm-copy";
import type { SampleScenario } from "@/lib/demo/showroom/industry";
import type { ViewId } from "@/lib/demo/showroom/content";
import type { AgentRoleKey } from "@/lib/agents";

// What every showroom view shares: who the visitor is (their own first name, business and industry, as the demo session holds them), where the demo stands (the record's words, not a
// guess), the prices, and the few things a view may ask the shell to do: go to another view, put a question in the chat's box, or tell the team the visitor wants to talk.
// Nothing here is the prospect's email address, an id or a credential; the room's view never contains them.

export interface PlanFacts {
  /** The catalog's own list of what the monthly plan covers, or null when the catalog could not be read (the page then uses its fixed wording). */
  included: string[] | null;
  monthlyRequestAllowance: number | null;
}

export interface ShowroomState {
  firstName: string;
  business: string | null;
  industryLabel: string | null;
  scenario: SampleScenario;
  access: "unverified" | "open" | "ended" | "blocked" | "converted" | "erased";
  windowEndsAt: string | null;
  extended: boolean;
  messagesLeft: number;
  messageAllowance: number;
  aiEnabled: boolean;
  consultationRequested: boolean;
  consultationUrl: string | null;
  purchaseStarted: boolean;
  setupFeeUsd: number;
  monthlyPlanUsd: number;
  plan: PlanFacts;
  /** What a button without scripts did, only where the record agrees (src/lib/demo/outcomes.ts). */
  ctaNotice: Notice | null;
  /** A confirmation the address asked to be open (the link a button without scripts follows). It opens only if that request is still unrecorded. */
  initialConfirm: ConfirmKind | null;
}

export interface ShowroomApi extends ShowroomState {
  view: ViewId;
  /** Opens a view (and, for the AI workforce, the employee to show first). Moving around changes nothing about the demo and counts no message. */
  go: (view: ViewId, role?: AgentRoleKey) => void;
  /** The AI Employee the workforce view should show, when something else sent the visitor there. */
  focusRole: AgentRoleKey | null;
  /** Puts a question in the chat's box and opens the chat. It sends nothing and counts no message: the visitor presses Send. */
  ask: (question: string) => void;
  /** Tells the team the visitor wants to talk to a person (or is ready to start). The server records it once; a second press changes nothing. */
  request: (kind: "consultation" | "buy", source: string) => Promise<boolean>;
  /** The request the visitor is being asked to confirm, if any. Nothing is recorded until they confirm. */
  confirming: "consultation" | "buy" | null;
  openConfirm: (kind: "consultation" | "buy") => void;
  closeConfirm: () => void;
  requesting: "consultation" | "buy" | null;
  /** Why the last request did not go through, and which button it was pressed from (that button shows it, so it is never out of sight). */
  requestError: { source: string; text: string } | null;
  /** The record says the interactive window is over: every sales view still works, the chat does not. */
  ended: boolean;
}

const Ctx = React.createContext<ShowroomApi | null>(null);

export function useShowroom(): ShowroomApi {
  const v = React.useContext(Ctx);
  if (!v) throw new Error("useShowroom must be used inside the showroom");
  return v;
}

export function ShowroomProvider({
  state,
  view,
  go,
  focusRole,
  ask,
  children,
}: {
  state: ShowroomState;
  view: ViewId;
  go: (view: ViewId, role?: AgentRoleKey) => void;
  focusRole: AgentRoleKey | null;
  ask: (question: string) => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [requesting, setRequesting] = React.useState<"consultation" | "buy" | null>(null);
  const [requestError, setRequestError] = React.useState<{ source: string; text: string } | null>(null);
  const [confirming, setConfirming] = React.useState<"consultation" | "buy" | null>(state.initialConfirm);
  const openConfirm = React.useCallback((kind: "consultation" | "buy") => {
    setRequestError(null);
    setConfirming(kind);
  }, []);
  const closeConfirm = React.useCallback(() => setConfirming(null), []);

  const request = React.useCallback(
    async (kind: "consultation" | "buy", source: string): Promise<boolean> => {
      if (requesting) return false;
      setRequesting(kind);
      setRequestError(null);
      try {
        const res = await fetch("/api/public/demo/cta", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ kind }),
        });
        const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
        if (json?.ok) {
          router.refresh();
          return true;
        }
        setRequestError({ source, text: json?.error?.message ?? "That could not be recorded just now. Please try again in a moment." });
        return false;
      } catch {
        setRequestError({ source, text: "We could not reach the server. Check your connection and try again." });
        return false;
      } finally {
        setRequesting(null);
      }
    },
    [requesting, router],
  );

  const value = React.useMemo<ShowroomApi>(
    () => ({ ...state, view, go, focusRole, ask, request, confirming, openConfirm, closeConfirm, requesting, requestError, ended: state.access !== "open" }),
    [state, view, go, focusRole, ask, request, confirming, openConfirm, closeConfirm, requesting, requestError],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
