import "server-only";
import crypto from "node:crypto";

// The identifiers this domain hands out. Both come from the system's secure random source.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Names a connection in its webhook address: cpk_ and 20 lower-case letters or digits. Not a secret. */
export const newPublicKey = (): string => `cpk_${Array.from({ length: 20 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("")}`;

/** The reference of one checkout attempt: CP- and 128 random bits. The provider echoes it back, so a payment is tied to its attempt. */
export const newReference = (): string => `CP-${crypto.randomBytes(16).toString("hex")}`;
