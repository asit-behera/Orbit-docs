# Product Specifications

The 8 products that make up the trading system.
See ARCHITECTURE.md for technical design. See individual spec files for deep detail.

**Stack:** Go. Zerodha only. India markets — NSE EQ, NSE F&O, MCX.

---

## System at a Glance

```
TrueData WebSocket
      ↓
[1] Data Manager          ← ingestion, validation, storage
      ↓
[2] Strategy Builder      ← visual strategy design (React UI)
      ↓
[3] Backtesting Engine    ← historical simulation (Cloud Run)
      ↓
[4] Validation Suite      ← walk-forward, Monte Carlo (Cloud Run)
      ↓
[5] Allocator             ← daily capital weight calculation
      ↓
[6] Core Trading Engine   ← live tick processing, signals, risk
      ↓
[7] Paper Trader  ←→  [8] Live Executor   (interchangeable, same payload)
      ↓
Analytics Dashboard
```

---

## 1. Data Manager

**Purpose:** Ingest, validate, and store market data for the whole system.

**What it does:**
- Connects to TrueData WebSocket — NSE EQ, NSE F&O, MCX live ticks
- Historical backfill via TrueData REST API on first run
- Validates ticks: gap detection, outlier detection, circuit breaker flags, split/dividend adjustments
- Stores OHLCV in TimescaleDB, archives ticks > 2 years to Parquet on Cloud Storage
- Refreshes instruments master at 08:30 IST (lot sizes, margins, expiry dates, circuit bands)
- Publishes ticks to Cloud Pub/Sub (ticks.nse_eq, ticks.nse_fno, ticks.mcx)

**Runs on:** Compute Engine VM — tick-receiver binary, always-on
**Key specs:** TRUEDATA_SPEC.md, INGESTION_PIPELINE_SPEC.md, DATA_SCHEMA_INDIA.md

---

## 2. Strategy Builder

**Purpose:** Visual strategy design — no coding required.

**What it does:**
- React SPA (browser-based, iPad-compatible)
- Drag-drop condition builder with AND / OR / SCORE Mode logic
- 20+ indicators: SMA, EMA, RSI, MACD, ATR, Bollinger Bands, Supertrend, VWAP, ADX, OI, India VIX
- Stop configuration: fixed % or ATR-based
- Target configuration: fixed % or R:R-driven (dynamic target from stop width)
- Trailing stop setup: 6 trail types (fixed %, ATR, chandelier, MA, swing structure, points)
- 10 bundled India-market strategy templates to clone and customise
- Semantic versioning: PATCH (parameter tweak), MINOR (indicator change), MAJOR (structure change)
- Saves strategy as JSON to PostgreSQL, notifies Core via Pub/Sub

**Deployment:** Cloud Run (strategy-builder-api + React SPA)
**Key specs:** STRATEGY_SCHEMA.md, STRATEGY_LIFECYCLE.md

---

## 3. Backtesting Engine

**Purpose:** Simulate how a strategy would have performed on historical data.

**What it does:**
- Event-driven bar-by-bar simulation — never looks ahead
- India-correct execution: lot-sized positions, SPAN margin, brokerage + STT costs
- Slippage model: configurable % or volume-adaptive
- Metrics: Sharpe ratio, Sortino, Max Drawdown, Win Rate, Profit Factor, R multiple distribution
- Parameter sweep: grid or random search over optimizable parameters
- Returns: equity curve, trade log, monthly returns breakdown, per-trade detail

**Pass criteria (to advance to VALIDATED status):**
- Sharpe ≥ 1.0, Max Drawdown < 30%, at least 50 trades

**Deployment:** Cloud Run — triggered on demand when user clicks "Backtest"

---

## 4. Validation Suite

**Purpose:** Confirm strategy is robust before risking capital. Separate skill from luck.

**What it does:**
- **Walk-forward analysis:** 5 in-sample / out-of-sample folds. OOS Sharpe must be ≥ 70% of IS Sharpe.
- **Monte Carlo simulation:** 1,000 runs with randomised trade order and ±0.1% price noise
- **Regime testing:** Does the strategy hold in trending, ranging, and high-volatility regimes?
- **Statistical significance:** Sharpe confidence intervals, minimum 100 trades required
- **Verdict:** PASS / CAUTION / FAIL

**Deployment:** Cloud Run — triggered after backtest passes

---

## 5. Allocator

**Purpose:** Calculate daily capital allocation weights for active strategies.

**What it does:**
- Classifies current market regime (Trending / Ranging / High Vol / Low Vol) using Nifty-I ADX + India VIX
- Scores each strategy's fit to the current regime
- Calculates allocation weights: 0–40% per strategy, diversification enforced
- Considers: recent performance, drawdown, strategy correlation (max 0.70)
- Portfolio-level kill switch: WARNING → REDUCE → EXIT → EMERGENCY
- Writes weights to Redis at 18:30 IST daily — Core reads on next session open

**Deployment:** Cloud Run — Cloud Scheduler triggers at 18:30 IST weekdays
**Key spec:** ALLOCATOR_SPEC.md

---

## 6. Core Trading Engine

**Purpose:** The heart of live trading. Tick ingestion → strategy evaluation → position management.

**Pre-trade pipeline (on every bar close):**
- Aggregates ticks into OHLCV candles (ring buffer, evaluates on closed bar only)
- Evaluates all active strategies using AND or SCORE Mode conditions
- Composite scoring: signal strength (40%) + win rate (30%) + allocator weight (20%) + regime match (10%)
- Pre-trade filter engines: Economic Event Filter → R:R Engine → Portfolio Heat Check
- Risk gate: daily loss limit, kill switch level, margin check, trade window
- Segment validation: lot sizing, expiry block, MCX delivery protection

**Post-entry monitoring (every tick, per open position):**
- Trailing stop engine: moves GTT stop at Zerodha as price moves favorably
- Exit monitoring: take profit, signal exit, time exit (on bar close)
- Position watchdog: emergency close if symbol engine fails with open position

**Background goroutines:**
- Portfolio Risk Monitor: updates drawdown, margin, kill switch every 30 seconds
- Strategy Degradation Monitor: live vs backtest comparison, auto-halts degrading strategies

**Deployment:** Compute Engine VM — core binary, always-on
**Key specs:** CORE_ARCHITECTURE.md, RISK_ENGINE_SPEC.md, RR_ENGINE_SPEC.md, SCORING_ENGINE.md

---

## 7. Paper Trader

**Purpose:** Simulate live trading with real TrueData ticks. Zero financial risk.

**What it does:**
- Receives identical Order payload to Live Executor — completely interchangeable
- Simulates fills: market orders instant + slippage, limit orders wait for price to reach level
- Tracks paper portfolio state: cash, positions, running P&L
- Persists paper trades to PostgreSQL — same schema as live trades
- Compares paper results to backtest baseline, alerts if diverging > 20%
- Runs minimum 2 weeks before strategy can be promoted to Live

**Mode:** Built into Executor binary. Activated when `execution_mode = "paper"` on the order.
**Switch:** Changed via Strategy Builder — publishes mode change event to Core via Pub/Sub.

**Minimum paper criteria before Live promotion:**
- 2+ weeks paper trading
- Paper Sharpe within 20% of backtest Sharpe
- Explicit human sign-off required (no automatic promotion to live)

---

## 8. Live Executor

**Purpose:** Execute real money orders via Zerodha Kite Connect.

**What it does:**
- Subscribes to `events.orders` Pub/Sub topic
- Pre-flight checks: Zerodha session valid, no duplicate order, margin recheck
- Calls Zerodha Kite API: market orders, limit orders, GTT stop-loss orders
- Polls for fill confirmation every 500ms
- Handles partial fills (accept for market orders, retry for limit)
- Processes trailing stop commands from `events.position_commands` → modifies GTT at Zerodha
- Enforces Zerodha's 25-modification limit per order: auto cancel+replace at modification 22
- Emergency stop: closes all open positions at market within 30 seconds
- Publishes fill results to `events.order_results` → Core updates position state

**Broker:** Zerodha Kite Connect only.
**Deployment:** Compute Engine VM — executor binary, always-on
**Key specs:** EXECUTION_SPEC.md, Zerodha_Spec.md, TRAILING_STOP_SPEC.md

---

## Analytics Dashboard

**Purpose:** Monitor trading performance, analyse results, review rejections.

**Dashboards:**
- System Health: all binaries running, TrueData feed status, tick channel depths
- Live Trading: daily P&L, open positions, kill switch level, margin utilisation
- Strategy Performance: equity curves, win rates, live vs backtest comparison
- Execution Quality: slippage trends, fill latency, rejection breakdown

**Rejection analysis:** Every blocked trade stored with full context. Nightly enrichment job tags each rejection with "what price actually did" — surfaces missed profitable trades for risk rule calibration.

**Deployment:** Cloud Run (analytics-api + Grafana on VM)
**Key spec:** MONITORING.md, TRADE_INTELLIGENCE_SPEC.md

---

## Product Interaction Matrix

```
                    Data    Strategy  Backtest  Validate  Allocator  Core  Executor  Analytics
Data Manager         —        R         R         R          R        R       —          R
Strategy Builder     R        —         W         R          —        W       —          R
Backtest Engine      R        R         —         R          —        —       —          W
Validation Suite     R        R         R         —          —        —       —          W
Allocator            R        R         R         —          —        W       —          W
Core Engine          R        R         —         —          R        —       W          W
Executor             —        —         —         —          —        R       —          W
Analytics            R        R         R         R          R        R       R          —

R = reads from    W = writes to
```

---

## Monthly Operating Cost

```
Compute Engine VM:    ₹2,800
Cloud SQL:            ₹2,900
Cloud Memorystore:    ₹500
Cloud Pub/Sub:        ₹700
Cloud Run + misc:     ₹320
Total infra:          ~₹7,220/month

Zerodha API:          ₹500/month (included if you trade that month)
TrueData Ultima plan: ~₹2,000/month (NSE EQ + F&O + MCX)

All-in: ~₹9,700–10,000/month
```
