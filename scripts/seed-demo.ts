import { getDatabase } from "../src/persistence/database.js";
import { Repository } from "../src/persistence/repository.js";
import { seedCleanDemo } from "../src/benchmark/demoSeed.js";
import { getEnv } from "../src/config/env.js";

function main() {
  const env = getEnv();
  const db = getDatabase();
  const repo = new Repository(db);
  const baseUrl = `http://localhost:${env.PORT}`;

  console.log("================================================================================");
  console.log("ShadowTwin — Clean Demo State Seeding");
  console.log("================================================================================");
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Environment: ${env.NODE_ENV}`);
  console.log("Resetting demo tables and seeding verified baseline skills, adapters & trials...\n");

  const outcome = seedCleanDemo(repo, baseUrl);

  console.log("✅ Seed completed successfully!");
  console.log(`- Active Skill ID: ${outcome.activeSkillId}`);
  console.log(`- Store A Adapter: v${outcome.storeAAdapterVersion} (ACTIVE)`);
  console.log(`- Store B Adapter: v${outcome.storeBAdapterVersion} (ACTIVE)`);
  console.log(`- Baseline Trials: ${outcome.baselineTrialCount} recorded`);
  console.log(`- Seeded At:       ${outcome.seededAt}`);
  console.log("================================================================================");
  console.log(`👉 Open Studio: ${baseUrl}/index.html`);
  console.log("================================================================================");
}

main();
