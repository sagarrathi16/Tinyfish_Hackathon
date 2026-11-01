import { randomUUID } from "node:crypto";
import { getEnv, redactSecret } from "../src/config/env.js";
import { TinyFishClient } from "../src/agents/tinyfishClient.js";
import { logger } from "../src/utils/logger.js";

async function runSmokeTest() {
  console.log("==================================================================");
  console.log("ShadowTwin — Server-Side TinyFish API Smoke Test");
  console.log("==================================================================");

  const env = getEnv();
  console.log(`[1/3] Environment: ${env.NODE_ENV}`);
  console.log(`[1/3] TinyFish Key configured: ${redactSecret(env.TINYFISH_API_KEY)}`);

  const client = new TinyFishClient();
  const testUrl = "https://books.toscrape.com";
  console.log(`[2/3] Dispatching small read-only task to: ${testUrl}`);

  const startTime = Date.now();
  try {
    const summary = await client.runAutomation({
      url: testUrl,
      goal: "Find the title of the first book listed on the page and its price in GBP.",
      outputSchema: {
        type: "object",
        properties: {
          book_title: { type: "string" },
          price: { type: "string" },
        },
        required: ["book_title", "price"],
      },
      browserProfile: "lite",
      maxDurationSeconds: 45,
      sessionId: randomUUID(),
    });

    const duration = Date.now() - startTime;
    console.log(`[3/3] Task completed in ${duration}ms!`);
    console.log(`  - Status: ${summary.status}`);
    console.log(`  - Run ID: ${summary.runId ?? "N/A"}`);
    console.log(`  - Steps: ${summary.numOfSteps ?? "N/A"}`);
    console.log(`  - Result:`, summary.result);

    if (summary.status === "COMPLETED" && summary.result) {
      console.log("\n>>> SMOKE TEST PASSED: TinyFish integration is fully verified. <<<\n");
      process.exitCode = 0;
    } else {
      console.error("\n>>> SMOKE TEST FAILED: Provider did not return expected result. <<<\n");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("\n>>> SMOKE TEST FAILED with error: <<<");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

runSmokeTest();
