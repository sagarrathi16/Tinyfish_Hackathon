import { describe, it, expect, beforeEach, afterEach } from "vitest";
import DatabaseConstructor from "better-sqlite3";
import { initSchema } from "../../src/persistence/database.js";
import { Repository } from "../../src/persistence/repository.js";
import { TaskUnderstandingAgent } from "../../src/agents/taskUnderstanding.js";

describe("Task Understanding & Multi-Agent Dispatch", () => {
  let db: ReturnType<typeof DatabaseConstructor>;
  let repo: Repository;
  let taskAgent: TaskUnderstandingAgent;

  beforeEach(() => {
    db = new DatabaseConstructor(":memory:");
    initSchema(db);
    repo = new Repository(db);
    taskAgent = new TaskUnderstandingAgent(repo);
  });

  afterEach(() => {
    db.close();
  });

  it("understands natural language queries and extracts primary and secondary target sites", async () => {
    const parsedBooks = await taskAgent.understand("Find books on books.toscrape.com and cross reference on webscraper");
    expect(parsedBooks.primaryDomain).toBe("books.toscrape.com");
    expect(parsedBooks.secondaryDomains).toContain("webscraper.io");
    expect(parsedBooks.isLiveWeb).toBe(true);

    const parsedElectronics = await taskAgent.understand("Search for Arduino Uno on robu.in and compare with makerbazar.in");
    expect(parsedElectronics.primaryDomain).toBe("robu.in");
    expect(parsedElectronics.secondaryDomains).toContain("makerbazar.in");
    expect(parsedElectronics.searchQuery.toLowerCase()).toContain("arduino uno");
  });

  it("detects Amazon bot challenges / CAPTCHA requirements and requests human intervention", async () => {
    const parsedAmazon = await taskAgent.understand("Search for iPhone 15 on amazon.in");
    expect(parsedAmazon.primaryDomain).toBe("amazon.in");
    expect(parsedAmazon.requiresInterventionCheck).toBe(true);

    const outcome = await taskAgent.runWorkflow(parsedAmazon);
    expect(outcome.status).toBe("NEEDS_INTERVENTION");
    expect(outcome.interventionReason).toContain("challenge");
    expect(outcome.summaryMessage).toContain("verification required");
  });

  it("executes full multi-agent workflow: learns on Site A, transfers to Site B, computes cost savings", async () => {
    const parsed = {
      summary: "Discover books on books.toscrape.com and transfer to webscraper.io",
      searchQuery: "Fiction",
      primaryDomain: "books.toscrape.com",
      primaryUrl: "https://books.toscrape.com",
      secondaryDomains: ["webscraper.io"],
      isLiveWeb: true,
      requiresInterventionCheck: false,
    };

    const outcome = await taskAgent.runWorkflow(parsed);
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.learningAgentSite).toBe("books.toscrape.com");
    expect(outcome.transferredSites).toContain("webscraper.io");
    expect(outcome.products.length).toBeGreaterThanOrEqual(2);

    // Verify cost savings calculation
    expect(outcome.costSavings.savingsPercentage).toBeGreaterThan(0);
    expect(outcome.costSavings.deterministicReplayRuns).toBeGreaterThanOrEqual(1);
    expect(outcome.costSavings.savingsUsd).toBeGreaterThanOrEqual(0.02);
  });
});

