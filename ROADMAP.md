# Implementation Roadmap

Build phases for the complete trading system.
**Stack:** Go everywhere. Zerodha. India markets only.
**Read first:** ARCHITECTURE.md for system overview, LEARNING_ROADMAP.md for market knowledge.

---

## Overview

```
Phase 0: Foundation         (2–4 weeks)   Infrastructure + data pipeline
Phase 1: Strategy + Backtest (4–6 weeks)   Backtest engine + Strategy Builder UI
Phase 2: Validation + Risk  (3–4 weeks)   Validation suite + risk engine
Phase 3: Paper Trading      (4–8 weeks)   Live paper trading + monitoring
Phase 4: Live Trading       (ongoing)     Real money, small capital first
```

---

## Phase 0 — Foundation (Weeks 1–4)

**Goal:** All data flowing, database running, infrastructure stable.
**Nothing tradeable yet — just plumbing.**

### Week 1–2: GCP + Database

```
Tasks:
  Create GCP project (trading-core, asia-south1)
  Create Compute Engine VM (e2-medium, always-on)
  Create Cloud SQL (PostgreSQL + TimescaleDB extension)
  Create Cloud Memorystore (Redis, 1 GB)
  Set up Cloud Pub/Sub (all 13 topics from PUBSUB_SCHEMA.md)
  Configure Cloud Secret Manager (TrueData, Zerodha, DB creds)
  Set up VPC + private IPs (no public DB/Redis)
  Run initial DB migrations (DATA_SCHEMA_INDIA.md schema)
```

**Done when:** PostgreSQL accessible from VM, TimescaleDB extension enabled.

### Week 3–4: Data Pipeline

```
Tasks:
  Build tick-receiver binary (Go) — TrueData WebSocket → Pub/Sub
  Build db-writer binary (Go) — Pub/Sub events → PostgreSQL/TimescaleDB
  Historical backfill — 2+ years daily OHLCV for Nifty, BankNifty, Gold, Crude, top 50 equity
  Instruments master refresh job (08:30 IST, Cloud Scheduler)
  Zerodha token refresh job (08:45 IST, TOTP automation)
  Data validation: gap detection, outlier detection, circuit halt flags
  Deploy all 7 EOD jobs (INGESTION_PIPELINE_SPEC.md)
```

**Done when:** Live ticks flowing for NIFTY-I, GOLD-I, RELIANCE, BankNifty. Historical data in TimescaleDB.

---

## Phase 1 — Strategy + Backtest (Weeks 5–10)

**Goal:** Can design a strategy in the UI, backtest it, see results.

### Week 5–7: Backtesting Engine

```
Tasks:
  Build backtest-engine Cloud Run service (Go)
  Event-driven bar-by-bar simulation
  India-correct costs: SPAN margin, brokerage ₹20 flat, STT
  Lot-sized position sizing (cannot buy fractional lots)
  Metrics: Sharpe, drawdown, win rate, R multiples
  Parameter sweep (grid + random search)
  REST API: POST /backtest → returns results JSON
```

**Test:** Run EMA Crossover (9/21) on NIFTY-I daily data 2022–2025. Check results make sense.

### Week 8–10: Strategy Builder UI + API

```
Tasks:
  Build strategy-builder-api Cloud Run service (Go)
    Strategy CRUD (create, read, update, delete)
    Template library (10 bundled strategies from STRATEGY_SCHEMA.md)
    Clone template endpoint
    Promote/demote lifecycle endpoints
  Build React SPA (Strategy Builder frontend)
    Condition builder (drag-drop, AND/OR nodes)
    Score Mode toggle + weight sliders
    Stop/target configuration (fixed % or ATR-based)
    Trailing stop setup
    Parameter definition (min/max/step/optimizable)
    Backtest trigger → show results
    Strategy versioning UI
```

**Done when:** Can create "NIFTY Mean Reversion" in UI, click Backtest, see results in < 30 seconds.

---

## Phase 2 — Validation + Risk Engine (Weeks 11–14)

**Goal:** Strategies properly validated. Risk rules in place. System won't blow up.

### Week 11–12: Validation Suite

```
Tasks:
  Build validation-suite Cloud Run service (Go)
  Walk-forward analysis (5 folds, IS/OOS split)
  Monte Carlo simulation (1,000 runs)
  Regime analysis (Trending / Ranging / High Vol)
  PASS / CAUTION / FAIL verdict logic
  Trigger automatically after backtest passes criteria
```

### Week 13–14: Core Engine (Risk + Pre-Trade)

```
Tasks:
  Build core binary (Go) — partial: risk engine + pre-trade filters only
  Risk Engine:
    Kill switch (4 levels, Redis-backed)
    Position sizing (2% rule + 3 caps)
    Portfolio Risk Monitor goroutine (every 30s)
    India guards: SPAN margin, MIS squareoff 15:15, MCX delivery block
  Pre-Trade Filters:
    Economic Event Filter (RBI MPC, Budget, FOMC calendar)
    R:R Engine (ATR stop, dynamic target, min 1.5 R:R)
    Portfolio Heat Check (max 6% total capital at risk)
  Segment Modules: equity, futures, commodity
```

**Done when:** Risk engine rejects trades correctly. Kill switch escalates. MCX delivery block works.

---

## Phase 3 — Paper Trading + Monitoring (Weeks 15–22)

**Goal:** Full system running in paper mode. Strategies validated against live data.

### Week 15–17: Core Engine (Full) + Executor

```
Tasks:
  Complete core binary:
    Tick aggregation (ring buffer, candle building)
    Strategy evaluation (AND mode + SCORE mode)
    Composite scoring engine (4 components, 12 edge cases)
    Pre/post trade pipeline (full flow from CORE_ARCHITECTURE.md)
    Post-entry monitor goroutine (trailing stop, exit monitoring)
    Symbol engine supervisor (panic recovery, stall detection, restarts)
    Strategy Registry with hot loading
  Build executor binary (Go):
    Paper Trader (simulated fills, slippage, portfolio tracking)
    Executor interface (same payload for paper + live)
    Pub/Sub integration (reads events.orders, writes events.order_results)
  Build db-writer binary (Go):
    Consumes all Pub/Sub event topics
    Writes to TRADE_INTELLIGENCE_SPEC.md tables
```

### Week 18–19: Monitoring + Alerting

```
Tasks:
  Deploy Prometheus on VM
  Deploy Grafana on VM
  All 4 dashboards (MONITORING.md)
  Telegram alerting (all critical + warning alert rules)
  All Prometheus metrics from MONITORING.md
```

### Week 20–22: Paper Trading

```
Tasks:
  Deploy 2–3 strategies to paper mode:
    EMA Crossover (9/21) on NIFTY-I 5m
    Supertrend on BankNifty 5m
    ORB (Opening Range Breakout) on NIFTY-I 15m
  Run for minimum 2 weeks
  Monitor via Grafana dashboards
  Compare paper results to backtest expectations
  Tune: risk rules, score thresholds, trail types
```

**Done when:** Paper trading running for 2+ weeks. Results within 20% of backtest Sharpe. No unexpected system errors.

---

## Phase 4 — Live Trading (Week 23+)

**Goal:** Real money. Small capital first. Grow only after consistency proven.

### Week 23–24: Go Live (Minimum Capital)

```
Tasks:
  Build live executor (Zerodha Kite API integration)
    Market + limit orders
    GTT stop-loss placement
    Fill monitoring (500ms polling)
    25-modification GTT budget management
    Emergency stop
  Zerodha account: verify API access, TOTP setup
  Start with: 1 strategy, 1 symbol, 1 lot only
  Capital deployed: ₹1,00,000 (enough for 1 Nifty lot + margin buffer)
```

**Done when:** First real trade executed, stop placed, fill confirmed in Grafana.

### Month 6+: Expansion

```
Criteria before adding more:
  ✓ 30+ live trades with results within 20% of paper results
  ✓ No unexpected risk engine failures
  ✓ All monitoring alerts working correctly
  ✓ Emergency stop tested (in paper mode first)

Then:
  Add 2nd strategy (different type — e.g., if first is trend, add mean reversion)
  Increase capital gradually as confidence builds
  Add MCX if not already running
  Deploy Allocator for multi-strategy capital weighting
```

---

## Build Order Priority

If you can only work on one thing at a time, build in this order:

```
1. Data pipeline (tick-receiver + db-writer) — everything needs data first
2. TimescaleDB schema + historical backfill — backtester needs history
3. Backtest engine — validates strategies before risking anything
4. Strategy Builder UI — strategy design requires backtest
5. Risk engine — must exist before any live or paper trading
6. Core engine — strategy evaluation + goroutine model
7. Paper executor — test all flows without real money
8. Monitoring — know the system is healthy before going live
9. Live executor — final step, real money
10. Validation suite — can be added after backtest is working
11. Allocator — needed when running 2+ strategies simultaneously
```

---

## Effort Estimates

| Phase | Duration | Hours (solo dev) | Notes |
|---|---|---|---|
| Phase 0: Foundation | 4 weeks | ~60h | Mostly GCP setup + Go binaries |
| Phase 1: Backtest + UI | 6 weeks | ~80h | React UI is the bulk |
| Phase 2: Validation + Risk | 4 weeks | ~50h | Logic-heavy but well-spec'd |
| Phase 3: Full Core + Paper | 8 weeks | ~100h | Most complex phase |
| Phase 4: Live | Ongoing | ~20h setup | Then maintenance only |
| **Total to go live** | **~22 weeks** | **~310h** | ~14h/week at consistent pace |

---

## Risk Mitigation

| Risk | Mitigation |
|---|---|
| TrueData WebSocket drops | Reconnection with exponential backoff, supervisor restarts tick-receiver |
| Zerodha API rejects order | Executor catches error, emits rejection event, no retry for market orders |
| Core crashes with open position | Position Watchdog + Zerodha GTT orders — position protected even if Core is down |
| Bad strategy deployed live | Strict promotion flow: backtest → validate → paper → sign-off → live |
| Daily loss limit hit | Kill switch auto-triggers, all new entries blocked |
| MCX physical delivery | HARD_IRREVOCABLE block 3 days before expiry — code cannot bypass this |
