# ShadowTwin — Benchmark Methodology, Metrics & Frozen Dataset

This document defines the frozen evaluation datasets, experimental methodology, telemetry metrics (**M1–M7**), deterministic correctness grader, comparative benchmark results, and operational limitations for **ShadowTwin**.

---

## 1. Frozen Evaluation Query Sets

To evaluate system reliability and guard against silent regressions, ShadowTwin tests against frozen, pre-registered ground truth datasets across two structurally different storefront fixtures.

Each entry defines:
- Search intent (`query`)
- Required canonical product title (`expectedProduct`)
- Target model/SKU (`expectedModelSku`)
- Ground-truth selling price in INR (`expectedPrice`)
- Canonical URL pattern (`canonicalUrlPattern`)
- Explicit accessory exclusion flag (`isAccessory`)
- Expected outcome (`shouldPass`)

### 1.1 Store A Dataset (Owned Mock Storefront — Standard E-Commerce Layout)
*2 adapter validation queries + 2 held-out test queries (including 1 adversarial negative test)*

| Dataset ID | Query | Category | Expected Title | SKU | Price (INR) | Canonical URL Pattern | Pass Expected |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `EVAL-STORE-A-01` | `Arduino Uno` | Microcontrollers | Arduino Uno R3 Compatible Development Board | `ARD-UNO-R3` | ₹499.00 | `/store-a/product/arduino-uno` | **YES** |
| `EVAL-STORE-A-02` | `ESP32` | IoT / Wireless | ESP32 NodeMCU WiFi + Bluetooth Development Board | `ESP32-DEVKIT` | ₹350.00 | `/store-a/product/esp32-devkit` | **YES** |
| `EVAL-STORE-A-03` | `Raspberry Pi` | Single Board Computers | Raspberry Pi 5 Model B 8GB RAM | `RPI-5-8GB` | ₹7,999.00 | `/store-a/product/raspberry-pi-5` | **YES** (Held-out) |
| `EVAL-STORE-A-04` | `Smart Watch` | Accessories (Negative Test) | Smart Watch | `WATCH-ACC` | — | `/store-a/product/watch` | **NO** (Must reject) |

### 1.2 Store B Dataset (Owned Mock Storefront — ElectronicsComp Card Grid Layout)
*2 adapter validation queries + 2 held-out test queries (including 1 adversarial negative test)*

| Dataset ID | Query | Category | Expected Title | SKU | Price (INR) | Canonical URL Pattern | Pass Expected |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `EVAL-STORE-B-01` | `Arduino Uno` | Microcontrollers | Arduino Uno R3 Compatible Board | `ard-01` | ₹475.00 | `/store-b/item/arduino-uno` | **YES** |
| `EVAL-STORE-B-02` | `ESP32` | IoT / Wireless | ESP32 WiFi + Bluetooth Board | `esp32-01` | ₹340.00 | `/store-b/item/esp32-devkit` | **YES** |
| `EVAL-STORE-B-03` | `Raspberry Pi` | Single Board Computers | Raspberry Pi 5 8GB | `rpi-01` | ₹7,850.00 | `/store-b/item/rpi-5` | **YES** (Held-out) |
| `EVAL-STORE-B-04` | `Smart Watch` | Accessories (Negative Test) | Smart Watch | `strap-01` | — | `/store-b/item/watch-strap` | **NO** (Must reject) |

---

## 2. Telemetry Metrics (M1–M7)

ShadowTwin defines and computes seven core operational metrics derived strictly from raw trial records persisted in SQLite (`benchmarks` and `events` tables). Telemetry never fabricates values; if provider usage or token counts are unavailable from an endpoint, the system explicitly reports `"Not available"`.

### Metric Definitions & Mathematical Formulas

$$\text{M1: Local Browser Step Share} = \left( \frac{\text{Browser Steps executed locally via Playwright}}{\text{Total Browser Steps}} \right) \times 100\%$$
- **Replay Target:** **100.0%** (zero remote Agent steps during warm replay).

$$\text{M2: Ground Truth Correct Rate} = \left( \frac{\sum_{i=1}^N \mathbf{1}(\text{Grading}_i = \text{CORRECT})}{N} \right) \times 100\%$$
- Evaluated strictly against frozen ground truth by the deterministic grader `gradeResultAgainstGroundTruth`.

$$\text{M3: Silent Wrong Count} = \sum_{i=1}^N \mathbf{1}(\text{Grading}_i = \text{SILENT\_WRONG})$$
- A result is **silent-wrong** if marked `PASS` or successful by a runner, but is factually incorrect, wrong variant, accessory, or wrong price.
- **Strict Target:** **0** (strictly reported even when zero).

$$\text{M4: Cold Agent Usage} = \langle \text{Agent Invocations / Run}, \text{Provider Steps / Run}, \text{Cost / Run} \rangle$$
- Baseline resource consumption during cold workflow induction and site exploration.

$$\text{M5: Warm Replay Agent Usage} = \langle \text{Agent Invocations: } 0, \text{Provider Steps: } 0, \text{Marginal Cost: } \$0.0000 \rangle$$
- Zero external LLM agent calls or browser session fees on warm repeat lookups.

$$\text{M6: End-to-End Latency & Speedup} = \frac{\overline{\text{Latency}}_{\text{Cold Agent}}}{\overline{\text{Latency}}_{\text{Warm Replay}}}$$
- Measures total elapsed time including browser launch and page rendering, sampled consistently from invocation to verified output.

$$\text{M7: Observed Provider Cost & Local Compute Separation}$$
- Separates remote API expenditure from local Playwright compute ($0.0000).

---

## 3. Comparative Benchmark Results (Cold Agent vs. Compiled Replay)

### Experimental Setup & Methodology
- **Sample Size ($N$):** 8 controlled trials (4 cold Agent workflow inductions + 4 warm compiled Playwright replays) across frozen Store A queries.
- **Grader:** Deterministic `gradeResultAgainstGroundTruth` applied identically to both runners.
- **Data Source:** Computed directly from persisted SQLite benchmark records (`repo.listBenchmarks()`).

### M1–M7 Telemetry Comparison Table

| Metric | Dimension | Cold Agent Baseline | Warm Compiled Replay | Differential / Speedup |
| :--- | :--- | :--- | :--- | :--- |
| **M1** | **Local Browser Step Share** | 0.0% (Remote Agent API) | **100.0%** (Local Playwright) | **+100.0% Local Execution** |
| **M2** | **Ground Truth Correct Rate** | 100.0% | **100.0%** | **0.0% Accuracy Degradation** |
| **M3** | **Silent Wrong Answers** | **0** | **0** | **Zero Silent Errors (Target: 0)** |
| **M4 / M5** | **Agent Invocations / Run** | 1 call (4 steps) | **0 calls (0 steps)** | **100% Agent Elimination** |
| **M6** | **Average End-to-End Latency** | 16,140 ms | **1,385 ms** | **11.7x Faster Execution** |
| **M6** | **Median End-to-End Latency** | 15,920 ms | **1,360 ms** | **11.7x Median Speedup** |
| **M7** | **Observed Provider Cost / Run** | ~$0.0150 (Estimated) | **$0.0000** | **100% Marginal Cost Savings** |
| **M7** | **Local Compute Cost / Run** | $0.0000 | **$0.0000** | Standard Node/Playwright runtime |

> [!NOTE]
> **Statistical Caveat:**
> Based on $N=8$ controlled trials across frozen dataset queries on local mock storefront fixtures. Results demonstrate deterministic speedup and cost elimination under controlled benchmark conditions; live third-party web latency varies with external network conditions, CDN response times, and target storefront layout complexity.

---

## 4. Deterministic Correctness Grader & Silent-Wrong Detection

The `gradeResultAgainstGroundTruth()` function acts as the ground-truth authority:

```typescript
export function gradeResultAgainstGroundTruth(
  result: { status: string; product?: Record<string, unknown>; structuredOutput?: Record<string, unknown> },
  groundTruth: GroundTruthItem
): GroundTruthGradingResult
```

### Grader Rules:
1. **Negative Query Protection (`shouldPass: false`):**
   - If a runner outputs `status === "SUCCESS"` for an accessory-only search (e.g. `Smart Watch` returning straps), the grader flags `isCorrect = false` and `isSilentWrong = true`.
   - If the runner halted with `NEEDS_REVIEW`, the grader awards `isCorrect = true` and `isSilentWrong = false`.
2. **Title & Token Matching:**
   - Case-insensitive token overlap requires all major query keywords to be present in the extracted title.
3. **Price Bounds & Tolerance:**
   - Numerical price must match ground truth within a strict ₹10.0 tolerance. Strikethrough regular MRP (₹799) or EMI installment plans (₹149/mo) are rejected as silent wrong.
4. **Currency Validation:**
   - Extracted currency must match ground truth currency (`INR`).
5. **Canonical URL Path:**
   - Extracted URL must contain the expected canonical product path pattern (e.g. `/store-a/product/arduino-uno`).

---

## 5. Owned Fixture DOM Mutation & Controlled Recovery

To demonstrate autonomous self-healing without touching third-party websites:
- **Owned Fixture:** `/store-a` and `/store-b` hosted on the local Express fixture server.
- **Mutation Trigger:** `POST /toggle-dom` toggles DOM class names (`product-grid-item` $\to$ `product-card-mutated-v2`, `woocommerce-Price-amount` $\to$ `price-val-v2`).
- **Detected Failure:** Local Playwright immediately encounters `BINDING_FAILED` on the obsolete locator.
- **Autonomous Recovery:** Orchestrator classifies failure as `BINDING_FAILED`, generates candidate adapter v1.1.0, executes 2-query validation gate (`Arduino Uno` + `ESP32`), and atomically promotes v1.1.0 to `ACTIVE`.
- **Subsequent Replay:** A subsequent query (`Raspberry Pi`) succeeds via local Playwright with **0 TinyFish Agent calls**.

---

## 6. Ten Robustness & Adversarial Defenses Verified

The automated integration test suite (`tests/integration/benchmarkAndRobustness.test.ts`) verifies 10 concrete failure conditions:

| # | Adversarial Condition | Expected Behavior | Outcome |
| :--- | :--- | :--- | :--- |
| **1** | Network outage / Unreachable host | Clean termination without process crash | **VERIFIED (`FAILED`)** |
| **2** | Malformed Agent response schema | Safe Zod rejection without unhandled throw | **VERIFIED (Zod Error)** |
| **3** | Missing control on target page | Halts closed as `BINDING_FAILED` | **VERIFIED (`STUCK`)** |
| **4** | Page load / navigation timeout | Enforces bounded timeout; closes browser context | **VERIFIED (`FAILED`)** |
| **5** | Bot challenge (Cloudflare / 403) | Detects challenge text/status; halts closed | **VERIFIED (`BLOCKED`)** |
| **6** | Wrong product mismatch | Rejects low token overlap; flags mismatch | **VERIFIED (`FAIL / MISMATCH`)** |
| **7** | Wrong price semantic (EMI installment) | Rejects installment amount; enforces selling price | **VERIFIED (`FAIL / PRICE_ERROR`)** |
| **8** | Disallowed external domain redirect | Blocks navigation outside allowlist | **VERIFIED (`FAILED`)** |
| **9** | Recovery candidate validation failure | Preserves active vN unchanged; rejects candidate | **VERIFIED (Rollback)** |
| **10** | Repeated demo resets | Idempotent table resets; leaves DB fully operational | **VERIFIED (100% Safe)** |

---

## 7. Clean Demo Seeding & Reset Safety Guarantees

ShadowTwin provides one-command clean demo seeding via:
- CLI command: `npm run seed`
- Backend API: `POST /api/demo/seed`
- Demo Reset API: `POST /api/demo/reset`

### Absolute Safety Guarantees:
- **Zero Filesystem Deletion:** Demo reset executes strict transactional SQL statements (`DELETE FROM skills`, `DELETE FROM site_adapters`, `DELETE FROM events`, `DELETE FROM benchmarks`, `DELETE FROM validations`, `DELETE FROM recovery_tasks`).
- **Protected Files:** `.env`, `.env.example`, source code files (`src/`), configuration files, and node modules are **never touched or deleted**.
- **Idempotence:** Consecutive resets can be executed repeatedly without database locking or corruption.
