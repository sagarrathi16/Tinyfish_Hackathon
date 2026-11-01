import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { getEnv, redactSecret } from "./config/env.js";
import { logger } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createServer() {
  const env = getEnv();
  logger.setLevel(env.LOG_LEVEL);

  const app = express();
  app.use(express.json());

  // Static files for Studio UI (completely separated from backend code/secrets)
  const publicDir = path.join(__dirname, "ui", "public");
  app.use(express.static(publicDir));

  // Health & Readiness Endpoint
  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "shadowtwin",
      version: "0.1.0",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      tinyfishConfigured: Boolean(env.TINYFISH_API_KEY),
    });
  });

  // System Diagnostics Endpoint (Redacted)
  app.get("/api/diagnostics", (_req: Request, res: Response) => {
    res.json({
      environment: env.NODE_ENV,
      port: env.PORT,
      logLevel: env.LOG_LEVEL,
      tinyFishKeyStatus: redactSecret(env.TINYFISH_API_KEY),
      allowedTargetDomains: env.ALLOWED_TARGET_DOMAINS.split(",").map((d) => d.trim()),
      maxConcurrentExplorers: env.MAX_CONCURRENT_EXPLORERS,
      maxAgentRunsPerJob: env.MAX_AGENT_RUNS_PER_JOB,
      jobTimeoutSeconds: env.JOB_TIMEOUT_SECONDS,
      stepTimeoutSeconds: env.STEP_TIMEOUT_SECONDS,
    });
  });

  return app;
}

// Start server if executed directly
if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  try {
    const env = getEnv();
    const app = createServer();
    app.listen(env.PORT, () => {
      logger.info(`ShadowTwin server started successfully`, {
        port: env.PORT,
        environment: env.NODE_ENV,
        healthEndpoint: `http://localhost:${env.PORT}/health`,
      });
    });
  } catch (error) {
    console.error("Fatal startup error:", error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
