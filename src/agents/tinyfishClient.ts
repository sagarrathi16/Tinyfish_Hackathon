import {
  BrowserProfile,
  RunStatus,
  TinyFish,
  type AgentRunResponse,
} from "@tiny-fish/sdk";
import { getEnv, redactSecret } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface AutomationRequest {
  url: string;
  goal: string;
  outputSchema?: Record<string, unknown>;
  browserProfile?: "lite" | "stealth";
  maxSteps?: number;
  maxDurationSeconds?: number;
  sessionId?: string;
}

export interface ProviderExecutionSummary {
  runId: string | null;
  status: RunStatus;
  result: Record<string, unknown> | null;
  numOfSteps: number | null;
  durationMs: number;
  startedAt: string | null;
  finishedAt: string | null;
  error?: {
    code?: string;
    message: string;
    category?: string;
    retryAfter?: number | null;
  };
}

export class TinyFishClient {
  private client: TinyFish;

  constructor(apiKeyOverride?: string) {
    const key = apiKeyOverride ?? getEnv().TINYFISH_API_KEY;
    if (!key) {
      throw new Error("TINYFISH_API_KEY is required to initialize TinyFishClient");
    }
    this.client = new TinyFish({ apiKey: key });
    logger.debug("TinyFishClient initialized", { apiKey: redactSecret(key) });
  }

  /**
   * Executes a browser automation run with timeout protection and bounded safe retries.
   */
  async runAutomation(
    params: AutomationRequest,
    options?: { timeoutMs?: number; maxRetries?: number }
  ): Promise<ProviderExecutionSummary> {
    const env = getEnv();
    const timeoutMs = options?.timeoutMs ?? env.JOB_TIMEOUT_SECONDS * 1000;
    const maxRetries = options?.maxRetries ?? 1;

    let lastError: unknown = null;
    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          logger.warn(`Retrying TinyFish automation call (attempt ${attempt + 1}/${maxRetries + 1})`, {
            url: params.url,
          });
          // Exponential backoff
          await new Promise((res) => setTimeout(res, 2000 * Math.pow(2, attempt - 1)));
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const profile =
            params.browserProfile === "stealth"
              ? BrowserProfile.STEALTH
              : BrowserProfile.LITE;

          const runParams: any = {
            url: params.url,
            goal: params.goal,
            browser_profile: profile,
            output_schema: params.outputSchema,
          };

          const response: AgentRunResponse = await this.client.agent.run(runParams);

          clearTimeout(timer);

          const durationMs = Date.now() - startTime;

          return {
            runId: response.run_id ?? null,
            status: response.status,
            result: (response.result as Record<string, unknown>) ?? null,
            numOfSteps: response.num_of_steps ?? null,
            durationMs,
            startedAt: response.started_at ?? null,
            finishedAt: response.finished_at ?? null,
            error: response.error
              ? {
                  code: response.error.code,
                  message: response.error.message,
                  category: response.error.category,
                  retryAfter: response.error.retry_after,
                }
              : undefined,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);

        // Do not retry 400 Bad Request (schema error) or 401/403/402 errors
        if (
          errMsg.includes("400") ||
          errMsg.includes("schema") ||
          errMsg.includes("401") ||
          errMsg.includes("402") ||
          errMsg.includes("403")
        ) {
          logger.error("Non-retryable provider error", { error: errMsg });
          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    throw new Error(
      `TinyFish automation failed after ${maxRetries + 1} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      } (duration: ${durationMs}ms)`
    );
  }
}
