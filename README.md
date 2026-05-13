# Personal Automated Trading Suite

A professional-grade, self-hosted algorithmic trading system for Indian markets. Covers NSE Equity, NSE Futures (F&O), and MCX Commodity Futures — with visual strategy building, rigorous backtesting, paper trading, and live execution via Zerodha.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [System Architecture](#system-architecture)
- [Products Overview](#products-overview)
- [Getting Started](#getting-started)
- [Documentation Structure](#documentation-structure)

## Quick Start

**Cost:** ~₹7,200/month on GCP (infra only — see DEPLOYMENT.md for breakdown)  
**Deployment:** Single GCP project (can clone for friends/family)  
**No coding required to:** Build strategies, backtest, deploy  
**Time to first trade:** ~6 months (with learning phase)

## System Architecture

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md) for detailed technical design.

**High-level:**

```
Visual Strategy Builder
         ↓
Backtesting Engine → Validation Suite
         ↓
Paper Trading → Risk Monitor
         ↓
Live Executor ← Analytics (Grafana)
```

Always-on binaries (tick receiver, core, executor, db-writer) run on a Compute Engine VM.
On-demand services (backtesting, validation, allocator) run on Cloud Run.
All backed by PostgreSQL + TimescaleDB + Redis + Grafana monitoring.

## Products Overview

|Product                |Purpose                           |User                    |
|-----------------------|----------------------------------|------------------------|
|**Data Manager**       |Ingest & validate market data     |System (automatic)      |
|**Strategy Builder**   |Create trading logic visually     |You (drag-drop UI)      |
|**Backtesting Engine** |Test strategies on historical data|You (click “backtest”)  |
|**Validation Suite**   |Separate signal from luck         |System (automated)      |
|**Risk Monitor**       |Position sizing & drawdown limits |System (real-time)      |
|**Analytics Dashboard**|P&L tracking, charts, alerts      |You (24/7 view)         |
|**Paper Trading**      |Simulate live trading risk-free   |You (1-4 weeks testing) |
|**Live Executor**      |Execute real trades               |System (with safeguards)|

See [PRODUCTS.md](./docs/PRODUCTS.md) for detailed product specs.

## Getting Started

**Step 1: Learn Trading Fundamentals**
→ [LEARNING_ROADMAP.md](./docs/LEARNING_ROADMAP.md)

**Step 2: Understand the System**
→ [ARCHITECTURE.md](./docs/ARCHITECTURE.md)

**Step 3: Deploy Infrastructure**
→ [DEPLOYMENT.md](./docs/DEPLOYMENT.md)

**Step 4: Build Your First Strategy**
→ [STRATEGY_GUIDE.md](./docs/STRATEGY_GUIDE.md)

**Step 5: Development Timeline**
→ [ROADMAP.md](./docs/ROADMAP.md)

## Documentation Structure

```
docs/
├─ ARCHITECTURE.md              # Technical design, databases, APIs
├─ PRODUCTS.md                  # Detailed specs for each product
├─ LEARNING_ROADMAP.md          # What you need to learn about markets
├─ STRATEGY_GUIDE.md            # How to build profitable strategies
├─ DEPLOYMENT.md                # GCP setup, Docker, configuration
├─ ROADMAP.md                   # 6-month implementation timeline
├─ INDIA_MARKETS_SPEC.md        # NSE EQ, NSE F&O, MCX structure & rules
├─ TRUEDATA_SPEC.md             # TrueData Velocity integration
├─ INGESTION_PIPELINE_SPEC.md   # Live tick ingestion service design
├─ DATA_SCHEMA_INDIA.md         # TimescaleDB schema for India data
├─ CONTINUOUS_CONTRACTS_SPEC.md # Futures roll & back-adjustment
├─ ALLOCATOR_SPEC.md            # Capital allocation logic
├─ OPTIONS.md                   # Options system design (Phase 2, deferred)
└─ MONITORING.md                # Grafana dashboards, alerts
```

## Key Principles

1. **Simpler than you think.** No coding needed for trading logic.
1. **More rigorous than you expect.** Validation before live trading.
1. **Your data, your rules.** Self-hosted, fully customizable.
1. **Scalable from day 1.** Start with 1 strategy, grow to 100.
1. **India-first.** Built for NSE and MCX market structure — lot sizes, expiry cycles, SPAN margin.

## Asset Support

|Segment          |Exchange|Data Source             |Executor        |
|-----------------|--------|------------------------|----------------|
|Equity (Cash)    |NSE EQ  |TrueData Velocity Ultima|Zerodha Kite API|
|Futures          |NSE F&O |TrueData Velocity Ultima|Zerodha Kite API|
|Commodity Futures|MCX     |TrueData Velocity Ultima|Zerodha Kite API|

**Out of scope (Phase 1):** Options, Forex, Crypto.  
**Options:** Deferred to Phase 2 — see [OPTIONS.md](./OPTIONS.md) for future design.

## Next Steps

1. Read [LEARNING_ROADMAP.md](./docs/LEARNING_ROADMAP.md) to understand markets
1. Read [ARCHITECTURE.md](./docs/ARCHITECTURE.md) to understand the system
1. Follow [ROADMAP.md](./docs/ROADMAP.md) for implementation phases
1. Deploy on GCP following [DEPLOYMENT.md](./docs/DEPLOYMENT.md)
1. Build first strategy using [STRATEGY_GUIDE.md](./docs/STRATEGY_GUIDE.md)

-----

**Last Updated:** May 2026  
**Status:** Design Phase (ready to implement)  
**Markets:** NSE Equity · NSE Futures · MCX Commodity  
**Data:** TrueData Velocity Ultima  
**Execution:** Zerodha Kite API