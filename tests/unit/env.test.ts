import { describe, expect, it } from "vitest";
import {
  redactSecret,
  sanitizeForLogging,
  validateEnv,
} from "../../src/config/env.js";

describe("Environment Configuration & Security Boundary", () => {
  it("successfully parses valid configuration", () => {
    const config = validateEnv({
      NODE_ENV: "test",
      PORT: "4000",
      TINYFISH_API_KEY: "tf_live_sample_key_1234567890",
      ALLOWED_TARGET_DOMAINS: "robu.in,books.toscrape.com",
    });

    expect(config.NODE_ENV).toBe("test");
    expect(config.PORT).toBe(4000);
    expect(config.TINYFISH_API_KEY).toBe("tf_live_sample_key_1234567890");
    expect(config.MAX_CONCURRENT_EXPLORERS).toBe(2);
  });

  it("fails fast with a useful error when required TINYFISH_API_KEY is missing", () => {
    expect(() =>
      validateEnv({
        NODE_ENV: "test",
        TINYFISH_API_KEY: "",
      })
    ).toThrowError(/TINYFISH_API_KEY is required/i);
  });

  it("does not expose secret values in the validation error message", () => {
    const sensitiveKey = "super_secret_raw_token_xyz999";
    try {
      validateEnv({
        NODE_ENV: "invalid_env" as unknown as string,
        TINYFISH_API_KEY: sensitiveKey,
      });
      expect.unreachable("Should have thrown validation error");
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(message).toContain("Server configuration validation failed");
      expect(message).not.toContain(sensitiveKey);
    }
  });

  it("rejects client-exposed secret prefixes (NEXT_PUBLIC_ or VITE_)", () => {
    expect(() =>
      validateEnv({
        TINYFISH_API_KEY: "valid_key",
        NEXT_PUBLIC_API_KEY: "leaked_secret_token",
      })
    ).toThrowError(/Security boundary violation/i);
  });

  it("redacts sensitive tokens in redactSecret()", () => {
    expect(redactSecret(undefined)).toBe("[NOT_SET]");
    expect(redactSecret("short")).toBe("[REDACTED]");
    expect(redactSecret("tf_live_1234567890")).toBe("tf_...890");
  });

  it("recursively sanitizes sensitive object keys for structured logging", () => {
    const rawLog = {
      user: "sagar",
      action: "teach_workflow",
      apiKey: "secret_api_key_123456",
      nested: {
        authorization: "Bearer secret_bearer_token",
        safeData: "hello_world",
      },
    };

    const sanitized = sanitizeForLogging(rawLog) as Record<string, unknown>;
    expect(sanitized.user).toBe("sagar");
    expect(sanitized.apiKey).toBe("sec...456");
    expect((sanitized.nested as Record<string, unknown>).safeData).toBe("hello_world");
    expect((sanitized.nested as Record<string, unknown>).authorization).toBe("Bea...ken");
  });
});

