import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/server/env";

// The social media variables. The Graph version check once lost its backslashes and rejected every real version, which made env() throw for the whole app
// as soon as someone copied the documented value; the test environment never set the variable, so nothing noticed.
const saved = { ...process.env };

const restore = () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  resetEnvCache();
};

describe("social media environment variables", () => {
  beforeEach(() => {
    delete process.env.META_GRAPH_VERSION;
    delete process.env.SOCIAL_MEDIA_STORAGE_MB;
    resetEnvCache();
  });
  afterEach(restore);

  it("accepts the documented Graph version and any other real one", () => {
    for (const version of ["v26.0", "v9.0", "v21.0", "v99.0"]) {
      process.env.META_GRAPH_VERSION = version;
      resetEnvCache();
      expect(env().META_GRAPH_VERSION, version).toBe(version);
    }
  });

  it("rejects a value that is not a Graph version, naming the variable", () => {
    for (const junk of ["latest", "26.0", "v26", "vdd.d", "v26.0.1", "v26.x", "V26.0"]) {
      process.env.META_GRAPH_VERSION = junk;
      resetEnvCache();
      expect(() => env(), junk).toThrow(/Invalid server environment configuration: META_GRAPH_VERSION/);
    }
  });

  it("falls back to v26.0 when the variable is unset or blank", () => {
    expect(env().META_GRAPH_VERSION).toBe("v26.0");
    process.env.META_GRAPH_VERSION = "  ";
    resetEnvCache();
    expect(env().META_GRAPH_VERSION).toBe("v26.0");
  });

  it("reads the social media storage cap in megabytes, 2048 by default", () => {
    expect(env().SOCIAL_MEDIA_STORAGE_MB).toBe(2048);
    process.env.SOCIAL_MEDIA_STORAGE_MB = "512";
    resetEnvCache();
    expect(env().SOCIAL_MEDIA_STORAGE_MB).toBe(512);
    process.env.SOCIAL_MEDIA_STORAGE_MB = "";
    resetEnvCache();
    expect(env().SOCIAL_MEDIA_STORAGE_MB).toBe(2048);
    for (const bad of ["0", "-5", "lots", "1.5"]) {
      process.env.SOCIAL_MEDIA_STORAGE_MB = bad;
      resetEnvCache();
      expect(() => env(), bad).toThrow(/SOCIAL_MEDIA_STORAGE_MB/);
    }
  });
});
