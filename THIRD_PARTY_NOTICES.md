# Third-Party Notices & Dependency License Inventory

This project incorporates dependencies, APIs, and architectural patterns from third-party open-source projects. In accordance with `AGENTS.md` (Section 3), this document records all licenses, attributions, and usage policies.

---

## 1. Direct Project Dependencies

| Package | Version | License | Source / Repository | Purpose in ShadowTwin |
| :--- | :--- | :--- | :--- | :--- |
| **`@tiny-fish/sdk`** | `^0.11.0` | MIT | [github.com/tinyfish-io](https://github.com/tinyfish-io) | Official TinyFish TypeScript client for workflow exploration and recovery |
| **`playwright`** | `^1.64.1` | Apache-2.0 | [github.com/microsoft/playwright](https://github.com/microsoft/playwright) | Local Chromium execution runtime for deterministic zero-agent replay |
| **`better-sqlite3`** | `^13.0.3` | MIT | [github.com/WiseLibs/better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | Synchronous, high-performance SQLite engine with WAL concurrency |
| **`express`** | `^4.21.2` | MIT | [github.com/expressjs/express](https://github.com/expressjs/express) | HTTP server for health endpoints and studio dashboard |
| **`zod`** | `^3.24.1` | MIT | [github.com/colinhacks/zod](https://github.com/colinhacks/zod) | Typed contracts, agent envelopes, and schema validation |
| **`dotenv`** | `^16.4.7` | BSD-2-Clause | [github.com/motdotla/dotenv](https://github.com/motdotla/dotenv) | Local environment variable management |
| **`typescript`** | `^5.7.3` | Apache-2.0 | [github.com/microsoft/TypeScript](https://github.com/microsoft/TypeScript) | Strict static typechecking |
| **`vitest`** | `^3.0.4` | MIT | [github.com/vitest-dev/vitest](https://github.com/vitest-dev/vitest) | Unit and integration testing suite |
| **`tsx`** | `^4.19.2` | MIT | [github.com/privatenumber/tsx](https://github.com/privatenumber/tsx) | Fast TypeScript execution runtime |

---

## 2. Reference Architectures & Upstream Attributions

### 2.1 Browserbase Stagehand
* **Source:** `https://github.com/browserbase/stagehand`
* **License:** MIT License (Copyright (c) 2024 Browserbase, Inc.)
* **Usage Policy:** Studied for element grounding heuristics (`observe`, `act`, `extract`) using ARIA labels, roles, and semantic attributes. When any helper code is adapted, the original copyright notice is preserved.

### 2.2 AgentR Webcmd
* **Source:** `https://github.com/agentrhq/webcmd`
* **License:** Apache License 2.0 (Copyright (c) 2024 AgentR)
* **Usage Policy:** Studied for website navigation memory, site-adapter persistence, and sandboxed execution batching. ShadowTwin maintains an independent implementation complying with all applicable notices.

### 2.3 TinyFish Workflow Memory Reference
* **Source:** `https://github.com/peteteaa/tinyfish`
* **License:** No license file exposed during preparation.
* **Usage Policy:** **Treated strictly as all-rights-reserved.** No source code is copied, vendored, or adapted. ShadowTwin implements an independent architecture against official TinyFish documentation (`docs.tinyfish.ai`).

### 2.4 Official TinyFish Platform & SDK
* **Source:** `https://docs.tinyfish.ai`
* **Usage:** Official REST Automation API (`/v1/automation/run` & `/run-sse`), Browser CDP API, and MCP tools under TinyFish terms of service.

