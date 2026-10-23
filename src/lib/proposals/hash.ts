// The hash an approval, a decision and a signature are bound to. Kept apart from doc.ts because it needs Node's crypto, which a browser bundle must not pull in:
// only server code and tests import this file.
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/proposals/doc";

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** sha256 of the canonical JSON of a value: equal content, equal hash, whatever order the keys were written in. */
export const contentHash = (value: unknown): string => sha256Hex(canonicalJson(value));
