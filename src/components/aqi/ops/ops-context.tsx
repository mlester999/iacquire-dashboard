"use client";

import * as React from "react";

/**
 * What the sections of the console (overview, quick actions) can ask of the conversation. The overview
 * is rendered on the server and handed to the console as a slot, so it cannot receive callbacks as props.
 */
export interface OpsConsoleActions {
  /** Sends a question to AQi Operations in the current investigation context. */
  ask: (question: string) => void;
  /** Places text in the composer for the administrator to finish. */
  draft: (text: string) => void;
  /** Opens the investigation-context picker. */
  pickScope: () => void;
}

const noop: OpsConsoleActions = { ask: () => undefined, draft: () => undefined, pickScope: () => undefined };
export const OpsConsoleContext = React.createContext<OpsConsoleActions>(noop);
export const useOpsConsole = () => React.useContext(OpsConsoleContext);
