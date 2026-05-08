# Documentation Index

Complete reference for all 30 documentation files.
**Last updated:** May 2026 — reflects Go + Compute VM + Cloud Pub/Sub architecture.

-----

## Start Here

|File             |Type     |Purpose                                           |
|-----------------|---------|--------------------------------------------------|
|`README.md`      |Guide    |Project overview. Read first.                     |
|`ARCHITECTURE.md`|Reference|System overview, tech stack decisions, service map|
|`ROADMAP.md`     |Guide    |Build phases, what to build in what order         |

-----

## Core Trading Engine Specs

Read in this order when building the core.

|#|File                        |What It Covers                                                             |
|-|----------------------------|---------------------------------------------------------------------------|
|1|`PUBSUB_SCHEMA.md`          |All 13 Pub/Sub topics, message schemas, message flow diagram               |
|2|`CORE_ARCHITECTURE.md`      |Goroutine model, segment modules, ring buffer, full pre/post trade pipeline|
|3|`SEGMENT_MODULES.md`        |Go interface — equity, futures, commodity, options module rules            |
|4|`EXECUTION_SPEC.md`         |Order flow, executor, paper trader, 6 rejection stages                     |
|5|`RISK_ENGINE_SPEC.md`       |Kill switch (4 levels), position sizing, SPAN margin, India guards         |
|6|`RR_ENGINE_SPEC.md`         |R:R Engine, Economic Event Filter, Portfolio Heat Check                    |
|7|`SCORING_ENGINE.md`         |Score Mode, composite 4-component scoring, 12 edge cases                   |
|8|`TRAILING_STOP_SPEC.md`     |6 trail types, 25-mod GTT budget, Zerodha modification policy              |
|9|`TRADE_INTELLIGENCE_SPEC.md`|Full trade data store, strategy degradation detection                      |

-----

## Strategy Specs

|File                   |What It Covers                                                                |
|-----------------------|------------------------------------------------------------------------------|
|`STRATEGY_SCHEMA.md`   |JSON schema, AST condition tree, indicator library, 10 bundled templates      |
|`STRATEGY_LIFECYCLE.md`|DRAFT→LIVE promotion, semantic versioning, rebalancing, position state machine|
|`STRATEGY_GUIDE.md`    |Practical guide to building strategies with India examples                    |

-----

## Infrastructure & Operations

|File           |What It Covers                                                      |
|---------------|--------------------------------------------------------------------|
|`DEPLOYMENT.md`|GCP resources, ₹7,220/month cost breakdown, VM setup, CI/CD pipeline|
|`MONITORING.md`|Prometheus metrics, 4 Grafana dashboards, Telegram alert rules      |

-----

## Data & Markets

|File                          |What It Covers                                                                         |
|------------------------------|---------------------------------------------------------------------------------------|
|`INDIA_MARKETS_SPEC.md`       |NSE EQ, NSE F&O, MCX — lot sizes, expiry, margin, PCR, circuit breakers                |
|`MCX_SPEC.md`                 |MCX deep-dive — all instruments, physical delivery, USD exposure, session rules, margin|
|`DATA_SCHEMA_INDIA.md`        |TimescaleDB schema, all tables, PCR snapshots, retention policy                        |
|`INGESTION_PIPELINE_SPEC.md`  |7 EOD jobs, 4 live loops, TrueData ingestion, NSE PCR fetcher                          |
|`TRUEDATA_SPEC.md`            |WebSocket integration, reconnection, subscription management                           |
|`CONTINUOUS_CONTRACTS_SPEC.md`|Futures roll detection, ratio/difference price adjustment                              |

-----

## Broker & Allocator

|File               |What It Covers                                                         |
|-------------------|-----------------------------------------------------------------------|
|`Zerodha_Spec.md`  |Kite Connect Go SDK, TOTP auth, GTT orders, rate limits (25 mods/order)|
|`ALLOCATOR_SPEC.md`|Capital allocation weights, regime classifier, 6-step algorithm        |

-----

## Phase 2 Reference

|File        |Status  |What It Covers                                                   |
|------------|--------|-----------------------------------------------------------------|
|`OPTIONS.md`|Deferred|Options system design — do not implement until Phase 1 profitable|

-----

## Learning & Navigation

|File                 |What It Covers                                             |
|---------------------|-----------------------------------------------------------|
|`PRODUCTS.md`        |8 product descriptions, interaction matrix, system overview|
|`LEARNING_ROADMAP.md`|6-phase trading knowledge curriculum (India-focused)       |
|`QUICK_REFERENCE.md` |Fast lookup, common questions, checklists                  |

-----

## Reading Paths

### “I want to understand the full system”

```
README.md → ARCHITECTURE.md → PRODUCTS.md → ROADMAP.md
```

### “I’m building the core trading engine”

```
PUBSUB_SCHEMA.md → CORE_ARCHITECTURE.md → SEGMENT_MODULES.md
→ EXECUTION_SPEC.md → RISK_ENGINE_SPEC.md → RR_ENGINE_SPEC.md
```

### “I’m building the strategy system”

```
STRATEGY_SCHEMA.md → STRATEGY_LIFECYCLE.md → SCORING_ENGINE.md
→ TRAILING_STOP_SPEC.md
```

### “I’m setting up infrastructure on GCP”

```
DEPLOYMENT.md → MONITORING.md → PUBSUB_SCHEMA.md
→ DATA_SCHEMA_INDIA.md → INGESTION_PIPELINE_SPEC.md
```

### “I want to build a trading strategy”

```
LEARNING_ROADMAP.md → STRATEGY_GUIDE.md → STRATEGY_SCHEMA.md
→ STRATEGY_LIFECYCLE.md
```

### “I need India market rules”

```
INDIA_MARKETS_SPEC.md → MCX_SPEC.md → CONTINUOUS_CONTRACTS_SPEC.md
→ Zerodha_Spec.md → SEGMENT_MODULES.md
```

-----

## Complete File Status (30 files)

|# |File                        |Status       |
|--|----------------------------|-------------|
|1 |README.md                   |✅ Current    |
|2 |ARCHITECTURE.md             |✅ Current    |
|3 |ROADMAP.md                  |✅ Current    |
|4 |PRODUCTS.md                 |✅ Current    |
|5 |PUBSUB_SCHEMA.md            |✅ Current    |
|6 |CORE_ARCHITECTURE.md        |✅ Current    |
|7 |SEGMENT_MODULES.md          |✅ Current    |
|8 |EXECUTION_SPEC.md           |✅ Current    |
|9 |RISK_ENGINE_SPEC.md         |✅ Current    |
|10|RR_ENGINE_SPEC.md           |✅ Current    |
|11|SCORING_ENGINE.md           |✅ Current    |
|12|TRAILING_STOP_SPEC.md       |✅ Current    |
|13|TRADE_INTELLIGENCE_SPEC.md  |✅ Current    |
|14|STRATEGY_SCHEMA.md          |✅ Current    |
|15|STRATEGY_LIFECYCLE.md       |✅ Current    |
|16|STRATEGY_GUIDE.md           |✅ Current    |
|17|DEPLOYMENT.md               |✅ Current    |
|18|MONITORING.md               |✅ Current    |
|19|INDIA_MARKETS_SPEC.md       |✅ Current    |
|20|MCX_SPEC.md                 |✅ Current    |
|21|DATA_SCHEMA_INDIA.md        |✅ Current    |
|22|INGESTION_PIPELINE_SPEC.md  |✅ Current    |
|23|TRUEDATA_SPEC.md            |✅ Current    |
|24|CONTINUOUS_CONTRACTS_SPEC.md|✅ Current    |
|25|Zerodha_Spec.md             |✅ Current    |
|26|ALLOCATOR_SPEC.md           |✅ Current    |
|27|OPTIONS.md                  |✅ Phase 2 ref|
|28|QUICK_REFERENCE.md          |✅ Current    |
|29|LEARNING_ROADMAP.md         |✅ Current    |
|30|INDEX.md                    |✅ This file  |
