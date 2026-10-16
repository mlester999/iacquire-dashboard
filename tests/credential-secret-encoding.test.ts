import { describe, expect, it } from "vitest";
import { encodeCredentialSecret } from "@/server/security/credentials";

describe("credential secret encoding", () => {
  it("stores Hermes service-token parts as a deterministic Vault secret", () => {
    expect(encodeCredentialSecret({
      accessClientSecret: " access-secret ",
      accessClientId: " access-id ",
    })).toBe('{"accessClientId":"access-id","accessClientSecret":"access-secret"}');
  });

  it("rejects blank and multiline credential parts", () => {
    expect(() => encodeCredentialSecret({ accessClientId: "access-id", accessClientSecret: " " }))
      .toThrow("Enter every part of the service credential.");
    expect(() => encodeCredentialSecret({ accessClientId: "access-id", accessClientSecret: "line1\nline2" }))
      .toThrow("Enter every part of the service credential.");
  });
});
