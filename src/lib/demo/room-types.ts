// The shapes the demo room's browser code works with. They are plain data (what src/server/demo/public.ts getRoom returns, and what the API sends as JSON), kept here so a client
// component never has to import from src/server, not even for a type. Pure.

export interface RoomLine {
  id: string;
  seq: number;
  role: "user" | "assistant";
  employeeRole: string | null;
  body: string;
  /** A prospect's own message: waiting for its answer, answered, or not counted because no answer came. Null for an answer. */
  state: "pending" | "answered" | "failed" | null;
  at: string;
}

export interface RoomChatState {
  transcript: RoomLine[];
  messagesLeft: number;
  messageAllowance: number;
  canSend: boolean;
  /** Why a message cannot be sent now, in the words to show; null when one can. */
  refusalMessage: string | null;
}

/** A key for one message: sending the same key again counts nothing twice. 36 characters of letters, digits and hyphens. */
export function newClientMessageId(): string {
  return globalThis.crypto.randomUUID();
}
