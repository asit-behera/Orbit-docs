# Quick Reference

Fast lookup. Common questions. Navigation guide.
**Updated May 2026** — India markets, Go stack, Zerodha only.

---

## Documentation Map

### Start Here
1. **README.md** — Project overview, what this is
2. **INDEX.md** — Complete list of all 29 files with reading paths

### Core System
3. **ARCHITECTURE.md** — System overview and technology decisions
4. **PRODUCTS.md** — What each of the 8 products does

### Build Guide
5. **ROADMAP.md** — Phase-by-phase build plan
6. **DEPLOYMENT.md** — GCP setup, costs, CI/CD

### Strategy
7. **STRATEGY_GUIDE.md** — How to build and deploy strategies (start here)
8. **STRATEGY_SCHEMA.md** — Strategy JSON format, indicator library
9. **STRATEGY_LIFECYCLE.md** — Promotion flow, versioning

### Deep Technical
10. **CORE_ARCHITECTURE.md** — Goroutine model, full pipeline diagram
11. **PUBSUB_SCHEMA.md** — All 13 message topics
12. **RISK_ENGINE_SPEC.md** — Kill switch, position sizing, India guards
13. **EXECUTION_SPEC.md** — Order flow, paper trader, rejections

---

## Quick Answers

### "What is this project?"
A personal automated trading system for Indian markets (NSE equity, NSE F&O, MCX commodities). Visual strategy builder, rigorous backtesting, paper trading simulation, then live execution via Zerodha.

### "What tech stack?"
- Language: Go (all services)
- Compute: Compute Engine VM (always-on) + Cloud Run (on-demand)
- Messaging: Cloud Pub/Sub (13 topics)
- Database: TimescaleDB + PostgreSQL (Cloud SQL)
- Cache: Redis (Cloud Memorystore)
- Broker: Zerodha Kite Connect only
- Cost: ~₹7,200/month infra + ~₹2,000/month TrueData + ₹500 Zerodha API

### "What markets do we trade?"
- NSE Equity (EQ) — large-cap stocks
- NSE F&O — Nifty, BankNifty, stock futures
- MCX — Gold, Silver, Crude Oil, Natural Gas
- NOT crypto, NOT US stocks, NOT forex

### "What is the 8-product system?"
1. Data Manager — ingest TrueData ticks + historical OHLCV
2. Strategy Builder — visual drag-drop condition editor
3. Backtesting Engine — historical simulation with India costs
4. Validation Suite — walk-forward + Monte Carlo robustness checks
5. Allocator — daily capital weight calculation per strategy
6. Core Trading Engine — live tick processing, signals, risk management
7. Paper Trader — simulated execution on live data
8. Live Executor — real execution via Zerodha Kite API

### "How do I build a strategy?"
1. Write hypothesis (what market pattern are you trading?)
2. Build in Strategy Builder UI (drag-drop conditions)
3. Backtest (Sharpe ≥ 1.0, 50+ trades, drawdown < 30%)
4. Validate (walk-forward passes, Monte Carlo passes)
5. Paper trade minimum 2 weeks on live TrueData data
6. Review: paper results within 20% of backtest
7. Human sign-off → go live (1 lot first)

See: STRATEGY_GUIDE.md for full walkthrough with India examples

### "How long to build this?"
~22 weeks at 14 hours/week (solo developer):
- Phase 0 (foundation): 4 weeks
- Phase 1 (backtest + UI): 6 weeks
- Phase 2 (validation + risk): 4 weeks
- Phase 3 (paper trading + monitoring): 8 weeks
- Phase 4 (live trading): ongoing

See: ROADMAP.md for full build phases

### "What is Score Mode?"
Instead of requiring ALL conditions to be true (AND mode), Score Mode assigns weights to conditions. If the total weighted score exceeds a threshold, the strategy fires.

Example: RSI(40) + SMA(35) + Volume(25) = 100 total. Threshold = 70.
RSI met + SMA met but not Volume → score 75 ≥ 70 → SIGNAL.

See: SCORING_ENGINE.md, STRATEGY_SCHEMA.md

### "What is the kill switch?"
4-level automatic protection based on portfolio drawdown:
- Level 1 (DD > 8%): reduce position sizes to 50%
- Level 2 (DD > 12%): block all new entries
- Level 3 (DD > 15%): close all positions at market
- Level 4: manual emergency trigger

Levels 2–4 require manual reset. Cannot auto-recover.

See: RISK_ENGINE_SPEC.md

### "What is the R:R Engine?"
Before every trade, the system calculates risk:reward ratio.
Stop price is set (ATR-based or fixed %). Target is set (R:R-driven or fixed %).
If reward/risk < minimum threshold (default 1.5), trade is rejected.

Example: Stop = ₹120 below entry. Target = ₹240 above (2:1 R:R). ✓
Example: Stop = ₹300 below entry. Target = ₹150 above (0.5:1 R:R). ✗ REJECTED.

See: RR_ENGINE_SPEC.md

### "What is trailing stop?"
After a position is entered, the stop loss moves toward price as it moves in your favour. It never moves against you.

Example (ATR-based, multiplier 2.0):
- Entry ₹19,500, initial stop ₹19,380 (ATR × 1.5 = 120)
- Price rises to ₹19,700 → new trail stop = ₹19,700 - (ATR × 2.0) = ₹19,540
- Price rises to ₹20,000 → new trail stop = ₹19,760
- Price falls to ₹19,760 → STOP HIT → exit with profit

Zerodha limit: 25 GTT modifications per order. System auto-refreshes at 22.

See: TRAILING_STOP_SPEC.md

### "Why is the executor separate from core?"
Core is responsible for intelligence (decide what to trade).
Executor is responsible for execution (call Zerodha API).
Separation allows executor to restart without stopping core.
Both communicate via Pub/Sub — loose coupling, each has single responsibility.

### "What happens if core crashes with an open position?"
1. Position Watchdog (separate goroutine) monitors all open positions every 30s
2. GTT stop-loss order already placed at Zerodha — survives Core crash
3. On Core restart: loads open positions from Redis, resumes monitoring
4. If stop is already breached: emergency close fires immediately on restart

See: CORE_ARCHITECTURE.md (Position Watchdog section)

### "How do paper trading and live trading switch?"
Same Executor binary, same Order payload. The `execution_mode` field on the order determines which path:
- `paper` → Paper Trader (simulated fills)
- `live` → Zerodha Kite API (real fills)

Switch via Strategy Builder UI → changes `execution_mode` in strategy JSON → publishes change to Core via Pub/Sub → Core's next signal uses new mode.

---

## Checklists

### Before Running Backtest
```
✓ At least 3 years of data available for this symbol
✓ Strategy hypothesis written down (not just gut feeling)
✓ Stop and target configured (not just entry conditions)
✓ Lot size set to read from instruments table (not hardcoded)
✓ Brokerage and STT costs included in backtest config
```

### Before Paper Trading
```
✓ Backtest passed: Sharpe ≥ 1.0, trades ≥ 50, DD < 30%
✓ Validation suite: PASS verdict
✓ Risk rules reviewed: trade window, avoid_expiry_day, max positions
✓ Monitoring running: Grafana accessible, Telegram alerts configured
✓ Kill switch tested: verified it fires at correct thresholds
```

### Before Going Live
```
✓ 2+ weeks paper trading completed
✓ Paper results within 20% of backtest Sharpe
✓ Paper trade list reviewed manually (signals look sensible)
✓ Zerodha GTT order placed and confirmed via Kite app
✓ Emergency stop tested in paper mode
✓ Starting capital: 1 lot only (Nifty ≈ ₹1.5L including buffer)
✓ MIS squareoff at 15:15 IST confirmed in Grafana
```

---

## India Market Quick Facts

```
NSE EQ trading hours:    09:15–15:30 IST
NSE F&O trading hours:   09:15–15:30 IST (15:25 MIS squareoff by Zerodha)
MCX trading hours:       09:00–23:30 IST (evening session 17:00–23:30)
MCX holiday-eve close:   17:00 IST

Nifty lot size:          25 units
BankNifty lot size:      15 units  
Gold lot size (MCX):     100 grams (full), 1 gram (mini)
Crude Oil lot size:      100 barrels

MIS squareoff:           15:15 IST (our system) / 15:20–15:25 (Zerodha auto)
MCX forced exit:         23:00 IST (30 min before close)
MCX delivery block:      3 days before expiry (HARD rule, no override)

Expiry day (NSE F&O):    Last Thursday of month (monthly), every Thursday (weekly index)
Expiry day (MCX):        Varies by commodity — check instruments table

India VIX:
  < 15:  low volatility (trending, good for trend strategies)
  15–20: normal
  > 20:  high volatility (mean reversion riskier, breakouts work better)
  > 30:  extreme — reduce all position sizes
```

---

## Key Limits (Zerodha)

```
Orders per day:              3,000 (all varieties combined)
Order modifications per order: 25 maximum (then cancel + re-place)
API rate limit:              200 orders/minute, 10 orders/second
WebSocket subscriptions:     3,000 instruments maximum
Kite Connect cost:           ₹500/month (waived if you trade that month)

GTT orders: NOT counted in daily order limit (only entry/exit orders count)
Order modifications: NOT counted in daily limit (only new orders count)
```

---

## File Quick Reference

| If you need to know about... | Read this file |
|---|---|
| Full list of all docs | INDEX.md |
| System architecture | ARCHITECTURE.md |
| What each product does | PRODUCTS.md |
| When to build what | ROADMAP.md |
| GCP setup + costs | DEPLOYMENT.md |
| All Pub/Sub message formats | PUBSUB_SCHEMA.md |
| Go goroutine model + pipeline | CORE_ARCHITECTURE.md |
| Segment-specific rules (equity/futures/MCX) | SEGMENT_MODULES.md |
| Order flow + executor + paper trader | EXECUTION_SPEC.md |
| Kill switch + position sizing + SPAN | RISK_ENGINE_SPEC.md |
| R:R engine + event filter + heat check | RR_ENGINE_SPEC.md |
| Composite scoring + Score Mode | SCORING_ENGINE.md |
| Strategy JSON format + indicators | STRATEGY_SCHEMA.md |
| Strategy promotion + versioning | STRATEGY_LIFECYCLE.md |
| How to build a strategy | STRATEGY_GUIDE.md |
| Trailing stop types + GTT limits | TRAILING_STOP_SPEC.md |
| Trade data storage + degradation | TRADE_INTELLIGENCE_SPEC.md |
| Grafana dashboards + alerts | MONITORING.md |
| NSE/MCX market rules | INDIA_MARKETS_SPEC.md |
| TimescaleDB schema | DATA_SCHEMA_INDIA.md |
| TrueData WebSocket | TRUEDATA_SPEC.md |
| Futures roll detection | CONTINUOUS_CONTRACTS_SPEC.md |
| Zerodha API details | Zerodha_Spec.md |
| Capital allocation algorithm | ALLOCATOR_SPEC.md |
| Options (Phase 2) | OPTIONS.md |
