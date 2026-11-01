import dotenv from "dotenv";
import { z } from "zod";

// Load environment variables from .env file if present
dotenv.config();

/**
 * Server-only environment schema.
 * Client/Frontend bundles must NEVER import this module.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TINYFISH_API_KEY: z.string().min(1, "TINYFISH_API_KEY is required and cannot be empty"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("gemini-2.0-flash"),
  DATABASE_URL: z.string().default("data/shadowtwin.db"),
  ALLOWED_TARGET_DOMAINS: z
    .string()
    .default("robu.in,makerbazar.in,books.toscrape.com,webscraper.io,localhost,127.0.0.1"),
  MAX_CONCURRENT_EXPLORERS: z.coerce.number().int().min(1).default(2),
  MAX_AGENT_RUNS_PER_JOB: z.coerce.number().int().min(1).default(4),
  JOB_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
  STEP_TIMEOUT_SECONDS: z.coerce.number().int().min(5).default(30),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cachedEnv: ServerEnv | null = null;

/**
 * Validates and returns the server-only configuration.
 * Fails fast with clear, sanitized error messages if validation fails.
 * Never prints raw secret values in errors or logs.
 */
export function validateEnv(customEnv?: Record<string, string | undefined>): ServerEnv {
  const source = customEnv ?? process.env;

  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    const formattedErrors = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return `  - [${path}]: ${issue.message}`;
      })
      .join("\n");

    const message = `Server configuration validation failed:\n${formattedErrors}\nCheck your .env file or environment variables against .env.example.`;
    throw new Error(message);
  }

  // Security guardrail: Ensure no NEXT_PUBLIC_ or VITE_ keys carry secret tokens
  for (const key of Object.keys(source)) {
    if (
      (key.startsWith("NEXT_PUBLIC_") || key.startsWith("VITE_")) &&
      (key.includes("SECRET") || key.includes("KEY") || key.includes("TOKEN") || key.includes("PASSWORD"))
    ) {
      throw new Error(
        `Security boundary violation: Secret key "${key}" has a client-exposed prefix (NEXT_PUBLIC_ or VITE_).`
      );
    }
  }

  return result.data;
}

/**
 * Accessor for the validated server configuration singleton.
 */
export function getEnv(): ServerEnv {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
}

/**
 * Resets cached environment (used for testing).
 */
export function resetEnvCache(): void {
  cachedEnv = null;
}

/**
 * Redacts known sensitive keys or patterns from strings or objects.
 */
export function redactSecret(value: string | undefined | null): string {
  if (!value) return "[NOT_SET]";
  if (value.length <= 8) return "[REDACTED]";
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

/**
 * Deep-redacts sensitive fields in arbitrary JSON objects before logging.
 */
export function sanitizeForLogging(data: unknown): unknown {
  if (data === null || data === undefined) return data;
  if (typeof data !== "object") return data;

  if (Array.isArray(data)) {
    return data.map(sanitizeForLogging);
  }

  const sensitiveFieldNames = [
    "apikey",
    "api_key",
    "token",
    "secret",
    "password",
    "authorization",
    "cookie",
    "tinyfish_api_key",
    "llm_api_key",
  ];

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveFieldNames.some((s) => lowerKey.includes(s));

    if (isSensitive && typeof val === "string") {
      sanitized[key] = redactSecret(val);
    } else if (typeof val === "object" && val !== null) {
      sanitized[key] = sanitizeForLogging(val);
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

