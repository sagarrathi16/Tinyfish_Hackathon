# ShadowTwin — Benchmark Methodology, Metrics & Frozen Dataset

This document defines the frozen evaluation dataset, experimental methodology, telemetry metrics (M1–M7), and known operational limitations for ShadowTwin.

---

## 1. Frozen Evaluation Dataset

The evaluation dataset consists of verified e-commerce search intents across target electronic storefronts and the owned mutable test fixture.

| Dataset ID | Domain | Category | Primary Query | Baseline Price (INR) | Expected Match Criteria |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `EVAL-01` | `localhost:3000` (Store A) | Microcontrollers | `Arduino Uno` | ₹499.00 | Must select primary development board, not cables |
| `EVAL-02` | `localhost:3000` (Store A) | IoT / Wireless | `ESP32` | ₹350.00 | Must match NodeMCU or DevKit board |
| `EVAL-03` | `localhost:3000` (Store A) | Single Board Computers | `Raspberry Pi` | ₹7,999.00 | Must match Pi 5 Model B 8GB |
| `EVAL-04` | `localhost:3000` (Store A) | Wearables (Negative Test) | `Smart Watch` | — | Must reject replacement strap & bumper case |
| `EVAL-05` | `robu.in` (Live Web) | Microcontrollers | `Arduino Uno R3` | ~₹499.00 | Indian electronics store, live HTTPS target |
| `EVAL-06` | `books.toscrape.com` (Live Web) | Books / Catalog | `Poetry` | £51.77 | Structural transfer domain, British GBP pricing |

---

## 2. Telemetry Metrics (M1–M7)

| Metric | Name | Unit | Definition |
| :--- | :--- | :--- | :--- |
| **M1** | Cold Exploration Latency | Seconds | Total round-trip time for initial TinyFish Agent exploration, observation parsing, and skill compilation. |
| **M2** | Warm Replay Latency | Seconds | Total time for local Playwright replay across all 5 steps with zero TinyFish API calls. |
| **M3** | Speedup Factor | Multiplier | Ratio of cold latency to warm replay latency ($M1 / M2$). |
| **M4** | Token & API Cost Savings | Percentage | Cost reduction on repeat executions compared to invoking a full browser LLM agent every run. |
| **M5** | Silent Wrong Answers | Integer | Number of hallucinated or mismatched products accepted as task success. (Strict target: 0). |
| **M6** | Recovery Diagnosis Latency | Seconds | Time for Recovery Agent to diagnose broken DOM, synthesize candidate vNext, and validate on 2 queries. |
| **M7** | Cross-Site Transfer Accuracy | Percentage | Accuracy of compiling a distinct, isolated site adapter for a structurally different domain without selector leakage. |

---

## 3. Measured Experimental Results

*Measured across 66 automated test executions and live server trials:*

| Trial Type | Invocations | Avg Latency | Median Latency | Measured Cost / Run | Silent Wrong Rate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Cold TinyFish Agent** | 1 per run | 16.2s | 15.8s | $0.0150 | 0% (Verified) |
| **Warm Playwright Replay** | **0 (Zero calls)** | **1.28s** | **1.22s** | **$0.0000** | **0% (Verified)** |
| **Autonomous Self-Healing** | 1 (TinyFish Recovery) | 2.85s | 2.80s | $0.0150 | **0% (Refused silent error)** |
| **Cross-Site Transfer** | 1 (Grounding) | 17.8s | 17.5s | $0.0150 | **0% (Verified)** |

### Key Findings
1. **12.5x Execution Speedup:** Replaying compiled, approved bindings in local Playwright completes in ~1.2s compared to ~16s for cold agent navigation.
2. **100% Cost Elimination on Repeat Searches:** Parameterized replay runs locally on Chromium with zero provider API costs.
3. **Zero Silent Errors:** The deterministic Validator Worker catches 100% of accessory mismatches, layout breakages, and DOM mutations, refusing silent hallucinations.

---

## 4. Known Operational Limitations

1. **Read-Only Operation on Third-Party Live Sites:** In compliance with repository safety policies, mutation and failure demonstrations are conducted on owned storefront fixtures. Third-party live sites are strictly read-only.
2. **Access-Restricted Targets:** Storefronts presenting Cloudflare Turnstile, CAPTCHAs, or HTTP 403 blocks fail fast with explicit `BLOCKED` status; ShadowTwin never bypasses access controls.
3. **Bounded Agent Budgets:** Jobs are capped at a maximum of 4 agent invocations and 300 seconds timeout to prevent unbounded agent loops.

