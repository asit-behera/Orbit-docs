# Personal Automated Trading Suite

A professional-grade, self-hosted algorithmic trading system designed for personal traders. Supports equities, forex, and crypto with visual strategy building, rigorous backtesting, and live execution.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [System Architecture](#system-architecture)
- [Products Overview](#products-overview)
- [Getting Started](#getting-started)
- [Documentation Structure](#documentation-structure)

## Quick Start

**Cost:** ~$25-50/month on GCP  
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

All services deployed on GCP Cloud Run with PostgreSQL + Grafana monitoring.

## Products Overview

| Product | Purpose | User |
|---------|---------|------|
| **Data Manager** | Ingest & validate market data | System (automatic) |
| **Strategy Builder** | Create trading logic visually | You (drag-drop UI) |
| **Backtesting Engine** | Test strategies on historical data | You (click "backtest") |
| **Validation Suite** | Separate signal from luck | System (automated) |
| **Risk Monitor** | Position sizing & drawdown limits | System (real-time) |
| **Analytics Dashboard** | P&L tracking, charts, alerts | You (24/7 view) |
| **Paper Trading** | Simulate live trading risk-free | You (1-4 weeks testing) |
| **Live Executor** | Execute real trades | System (with safeguards) |

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
├─ ARCHITECTURE.md          # Technical design, databases, APIs
├─ PRODUCTS.md              # Detailed specs for each product
├─ LEARNING_ROADMAP.md      # What you need to learn about markets
├─ STRATEGY_GUIDE.md        # How to build profitable strategies
├─ DEPLOYMENT.md            # GCP setup, Docker, configuration
├─ ROADMAP.md               # 6-month implementation timeline
├─ DATA_SPEC.md             # Asset types, data requirements
├─ RISK_MANAGEMENT.md       # Position sizing, drawdown limits
└─ MONITORING.md            # Grafana dashboards, alerts
```

## Key Principles

1. **Simpler than you think.** No coding needed for trading logic.
2. **More rigorous than you expect.** Validation before live trading.
3. **Your data, your rules.** Self-hosted, fully customizable.
4. **Scalable from day 1.** Start with 1 strategy, grow to 100.
5. **Asset-agnostic.** Same system handles stocks, forex, crypto.

## Asset Support

- **Equities:** Yahoo Finance, Alpaca API
- **Forex:** OANDA, Interactive Brokers
- **Crypto:** Binance, Kraken
- **All:** Same strategy engine, different data sources

## Next Steps

1. Read [LEARNING_ROADMAP.md](./docs/LEARNING_ROADMAP.md) to understand markets
2. Read [ARCHITECTURE.md](./docs/ARCHITECTURE.md) to understand the system
3. Follow [ROADMAP.md](./docs/ROADMAP.md) for implementation phases
4. Deploy on GCP following [DEPLOYMENT.md](./docs/DEPLOYMENT.md)
5. Build first strategy using [STRATEGY_GUIDE.md](./docs/STRATEGY_GUIDE.md)

---

**Last Updated:** May 2025  
**Status:** Design Phase (ready to implement)  
**Author's Goal:** Personal automated trader, scalable to 100+ strategies
