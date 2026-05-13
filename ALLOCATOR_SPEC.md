# Adaptive Capital Allocator — Full System Specification

# Version 3.0 — India Market Corrections

**Status:** Design Phase — Ready to Implement
**Scope:** Architecture + Math + API + DB Schema + Integration
**Approach:** Rule-based, no ML, daily EOD rebalancing
**Asset Class:** NSE Equity, NSE F&O, MCX Commodity
**Markets:** India only — NSE + MCX via Zerodha + TrueData
**Language:** Go (consistent with full system stack)
**Changelog from V2:** India-specific corrections — timezone, settlement, currency,
language, market calendar, lot sizing, India VIX regime signal, MIS squareoff

-----

## 1. Purpose & Role in the System

The Allocator sits between the Strategy Engine and the Risk Monitor.
It answers one question at runtime:

> “Given current market conditions and strategy performance, how much
> capital should each strategy get?”

It does NOT:

- Generate trade signals (Strategy Engine)
- Approve individual orders (Risk Monitor)
- Execute trades (Live Executor)
- Force-close profitable positions to rebalance (ever)

It DOES:

- Classify the current market regime (rule-based, NIFTY-I reference)
- Score each strategy’s fitness for that regime
- Adjust weights based on recent performance and drawdown
- Enforce correlation constraints across strategies
- Output a target weight vector, daily
- Track rebalancing bands (not hard targets)
- Validate all configuration before applying it

-----

## 2. Core Design Principles

These govern every design decision in this spec.

```
1. Never force-close a profitable trade to rebalance.
   Rebalance at natural liquidity points (trade exits), not by
   creating exits. The cost of a forced close always exceeds the
   benefit of perfect weight alignment.

2. Every trade must have a hard stop loss before the order is placed.
   If stop placement fails at the broker, the entry order is cancelled.
   No exceptions.

3. Risk 2% of account equity per trade maximum.
   This means 50 consecutive full losses are required to cause
   significant damage — mathematically near-impossible with a
   validated strategy.

4. Weights are targets, not mandates.
   A strategy 12% over its target weight is not a crisis.
   A strategy 20% over its target weight needs passive reduction.

5. When in doubt, do less.
   Inaction is cheaper than a wrong rebalance.
   Transaction costs compound negatively.

6. Transparency first.
   Every allocation decision must be fully explainable via diagnostics.
   No black boxes.
```

-----

## 3. Where It Fits in the Existing Architecture

```
Data Manager (OHLCV + Market Calendar)
        ↓
  [ALLOCATOR] ←─── Strategy Performance History (DB)
        ↓                ↑
  Target Weight    Risk Monitor reports
  Vector (Redis)   gross exposure back
        ↓
  Core Binary reads weights at 09:15 IST session open
        ↓
  Scoring Engine uses Allocator Weight as Component 3 (W3=0.20)
  in the 4-component Composite Score for strategy selection
        ↓
  Risk Monitor enforces allocation bands on new entries
        ↓
  Live Executor (stop loss on every order — see EXECUTION_SPEC.md)
```

Runs once per day at 18:30 IST (after NSE market close, before MCX evening session ends).
Writes output to Redis so Core reads on next session open.
Skips automatically on NSE/MCX holidays and circuit-breaker halts.

**Scoring Engine integration (see SCORING_ENGINE.md — Component 3):**
The Allocator weight feeds directly into the Composite Score that determines
which strategy trades when multiple strategies signal on the same bar:

```
Composite Score = (Signal Strength × 0.40) + (Win Rate × 0.30)
                + (Allocator Weight × 0.20) + (Regime Match × 0.10)

Allocator Weight normalisation (done by Scoring Engine, not Allocator):
  normalised = strategy_weight / max_weight_across_active_strategies

  Strategy A: weight 0.30, max = 0.40 → normalised = 0.75
  Strategy B: weight 0.40, max = 0.40 → normalised = 1.00

Hard rule: If allocator_weight = 0 → strategy is SUPPRESSED.
  No signal evaluation, no composite score, excluded entirely.

Fallback: If Allocator weights unavailable in Redis:
  Scoring Engine uses equal weight (1/n strategies) + logs WARNING.
  Trading is never blocked due to Allocator unavailability.
```

-----

## 4. Stop Loss & Position Sizing (Foundation)

These rules are enforced by the Live Executor and Risk Monitor,
but the Allocator’s per-trade risk limit feeds directly into them.
Documented here because they are the foundation everything else
builds on.

### 4.1 Per-Trade Stop Loss (Non-Negotiable)

```
Rule: Every trade must have a hard stop loss confirmed by the broker
      before the entry order is considered placed.

Full stop loss placement protocol: see EXECUTION_SPEC.md → "Stop Loss Placement Protocol"

Summary:
  1. Risk Monitor calculates stop price (ATR-based or fixed %, per strategy config)
  2. Executor submits entry + GTT stop order simultaneously after fill
  3. If stop confirmation not received within 5 seconds:
     → Cancel entry position at market immediately
     → Do NOT hold a position without a confirmed stop — ever
  4. Stop loss can only be tightened after placement, never widened
  5. GTT Watchdog checks stop exists every 60 seconds — re-submits if missing

See EXECUTION_SPEC.md for: timeout handling, GTT monitoring, broker disconnect,
  re-submission protocol, and stop loss enforcement during emergency stops.
```

### 4.2 Per-Trade Capital Risk (The 2% Rule)

```
Max risk per trade = 2% of current account equity

Example:
  Account equity: ₹10,00,000 (10 lakhs)
  Max risk per trade: ₹20,000

  This means: 50 consecutive full losses = ₹10,00,000 lost
  With a validated strategy (Sharpe > 1.0, win rate > 50%),
  this scenario is statistically near-impossible.

Risk tightening rules (automatic):
  - Strategy in Level 1 kill switch (see Section 10):
    → Max risk reduced to 1% per trade
  - 5 consecutive losses on any strategy:
    → Max risk reduced to 1% for next 10 trades on that strategy
    → Resets automatically after 10 trades or 1 profitable trade
  - Portfolio drawdown > 8%:
    → Max risk reduced to 1% across all strategies
  - India VIX > 30 (extreme volatility):
    → Max risk reduced to 1% across all strategies
```

### 4.3 Position Size Calculation — NSE Equity

```
For NSE Equity (cash shares, no lot constraint):

  position_size = risk_amount / (entry_price - stop_price)

  Example:
    Account: ₹10,00,000
    Risk amount (2%): ₹20,000
    Entry price: ₹2,400 (e.g., Reliance)
    Stop price: ₹2,376 (1% below entry, ATR-based)

    position_size = ₹20,000 / ₹24 = 833 shares

    Resulting position value: 833 × ₹2,400 = ₹19,99,200
    This is ~200% of account — EXCEEDS max position limit.

    Therefore: apply max position cap:
    max_position_value = max_weight × account_equity
                       = 40% × ₹10,00,000 = ₹4,00,000

    Final position_size = min(833, ₹4,00,000 / ₹2,400) = min(833, 166) = 166 shares
    Actual risk on this trade: 166 × ₹24 = ₹3,984 (0.4%, under 2%)

Key insight: The 2% rule sets the MAXIMUM risk.
Position sizing takes the MINIMUM of:
  a) Size implied by 2% risk rule
  b) Size implied by max strategy weight cap
```

### 4.4 Position Size Calculation — NSE F&O and MCX (Lot-Based)

F&O and MCX trade in fixed lot sizes. Position size MUST be a whole number
of lots. Always round DOWN — never round up (rounding up adds unexpected risk).

```
Common lot sizes (verify from instruments master — these change):
  Nifty 50 futures:    75 units per lot
  BankNifty futures:   15 units per lot
  Gold (MCX full):    100 grams per lot
  Crude Oil (MCX):    100 barrels per lot

Lot-based sizing:
  risk_per_lot = (entry_price - stop_price) × lot_size
  raw_lots     = floor(risk_amount / risk_per_lot)
  final_lots   = min(raw_lots, cap_lots)

  Where:
    cap_lots = floor((max_weight × account_equity) / (entry_price × lot_size))

  Example (Nifty futures):
    Account: ₹10,00,000
    Risk amount (2%): ₹20,000
    Entry: ₹24,500, Stop: ₹24,220 (ATR-based, 280pts)
    Lot size: 75 units
    risk_per_lot = 280 × 75 = ₹21,000

    raw_lots = floor(₹20,000 / ₹21,000) = floor(0.95) = 0 lots

    Result: TRADE REJECTED — risk per lot exceeds 2% budget.
    This is correct behaviour. Widen the stop or reduce risk %.

  If entry: ₹24,500, Stop: ₹24,380 (120pts):
    risk_per_lot = 120 × 75 = ₹9,000
    raw_lots = floor(₹20,000 / ₹9,000) = floor(2.22) = 2 lots
    cap_lots = floor((40% × ₹10,00,000) / (₹24,500 × 75))
             = floor(₹4,00,000 / ₹18,37,500) = 0 lots → WEIGHT CAP HIT

    In practice: increase account size or reduce max_weight cap for F&O
    or accept that large F&O contracts need larger capital base.

Hard rule: NEVER trade a fractional lot. If final_lots = 0, do not trade.
```

-----

## 5. Market Calendar Integration

Runs before any Allocator logic. If market was not open, nothing proceeds.

```
Source: instruments_india table (refreshed at 08:30 IST by Data Manager)
        NSE holiday calendar + MCX holiday calendar maintained separately.
        Do NOT use any third-party calendar library — India-specific holidays
        (Diwali, Holi, Muhurat trading sessions) are not in generic libraries.

Daily check at 18:30 IST:

  1. Was today an NSE trading day?
     → Query: SELECT is_trading_day FROM market_calendar WHERE date = today
     → If holiday: skip entirely, log MARKET_HOLIDAY, extend Redis TTL
     → If normal day: proceed

  2. Was today a Muhurat trading session?
     (Special 1-hour Diwali session, treated as a short trading day)
     → Flag: MUHURAT_SESSION in allocation_runs
     → Use 18:30 IST data cutoff (Muhurat closes ~18:15)
     → Regime classification proceeds normally

  3. Did any NSE circuit breaker / market-wide halt occur today?
     → Check Data Manager flag: market_halt_today (Redis key: state:market:halt)
     → Level 1 halt (10% Nifty drop): trading resumes after 45 min
     → Level 2 halt (15%): resumes after 1h 45min
     → Level 3 halt (20%): market closed for day
     → If Level 3: use previous day's weights, log MARKET_HALT_L3
     → If Level 1 or 2 (market resumed): proceed normally, flag MARKET_HALT_PARTIAL

  4. MCX status (for commodity strategies):
     → MCX has independent holiday calendar
     → MCX evening session runs until 23:30 IST (23:00 on pre-holiday days)
     → Allocator runs at 18:30 IST regardless — MCX strategies still get weights
     → MCX holiday: commodity strategies receive min_weight for that session

  5. Is tomorrow a trading day?
     → If no: extend Redis TTL to cover the gap
     → Max extension: 4 days (covers long weekends + back-to-back holidays)
     → Diwali week may require 5-day TTL — check calendar at run time
```

-----

## 6. Regime Classifier

### 6.1 Design Philosophy

Regimes are NOT discrete. The classifier outputs a score vector,
not a single label. Each regime score is a float in [0.0, 1.0].
Scores can coexist (e.g., Bull 0.65 + HighVol 0.40 simultaneously).

This avoids cliff-edge rebalancing when a single threshold flips.

### 6.2 Reference Symbol

India markets (current phase): NIFTY-I (continuous near-month)

```
allocator_config.reference_symbol = 'NIFTY-I'  (configurable)
asset_class: 'equity' → reference: NIFTY-I
(Commodity reference: GOLD-I; added when commodity strategies are added)
```

### 6.3 Warm-Up Period (Gap 8 Fix)

SMA(200) requires 200 days of history. Handle insufficient history:

```
history_days = count of OHLCV records for reference symbol

< 50 days:
  → State: INSUFFICIENT_HISTORY
  → All regime scores = 0.0
  → Allocator uses equal weights for all strategies
  → Flag: REGIME_UNAVAILABLE
  → No regime-based multipliers applied

50–99 days:
  → Can compute: SMA(50), RSI, ADX, vol
  → Cannot compute: SMA(200), golden/death cross
  → Partial regime: Bull/Bear scores set to 0.5 max (low confidence)
  → Flag: REGIME_LOW_CONFIDENCE

100–199 days:
  → Can compute all signals except SMA(200)-based confirmation
  → Reduce Bull/Bear score max to 0.75
  → Flag: REGIME_PARTIAL

200+ days:
  → Full regime detection, no restrictions
```

### 6.4 Regime Signals

Five regime types, computed independently, each graduated 0.0–1.0.

-----

#### Regime 1: Trending Up (Bull)

```
Conditions and scoring:
  c1: price > SMA(50)
  c2: SMA(50) > SMA(200)                ← golden cross
  c3: ADX(14) > 25                       ← trend is strong
  c4: price > price[20 days ago]         ← momentum confirmation

  conditions_met = count of true conditions

  4 of 4: bull_score = 1.00
  3 of 4: bull_score = 0.65
  2 of 4: bull_score = 0.30
  1 of 4: bull_score = 0.10
  0 of 4: bull_score = 0.00
```

-----

#### Regime 2: Trending Down (Bear)

```
  c1: price < SMA(50)
  c2: SMA(50) < SMA(200)                ← death cross
  c3: ADX(14) > 25
  c4: price < price[20 days ago]

  Same scoring table as Bull.
  bull_score and bear_score are independent — both can be low
  (ambiguous regime) or one can dominate.
```

-----

#### Regime 3: Sideways / Range

```
  c1: ADX(14) < 20
  c2: |price - SMA(50)| / SMA(50) < 0.02   ← within 2% of average
  c3: (20-day high - 20-day low) / price < 0.05   ← tight range

  ADX < 15 AND range < 3%:  1.00
  ADX 15–20 AND range < 5%: 0.65
  ADX 20–25:                0.30
  ADX > 25:                 0.00
```

-----

#### Regime 4: High Volatility

India VIX is published by NSE and is the institutional standard for Indian
market volatility. Use it as the PRIMARY signal. Realized vol as secondary.

```
  india_vix = latest India VIX value (stored in TimescaleDB, ticks.nse_eq)
  realized_vol_30d = std(daily_returns[-30:]) * sqrt(252)   ← NIFTY-I
  baseline_vol_90d = std(daily_returns[-90:]) * sqrt(252)   ← NIFTY-I
  vol_ratio = realized_vol_30d / baseline_vol_90d

  India VIX thresholds (primary signal — per INDIA_MARKETS_SPEC.md):
    VIX > 30:        extreme → vix_score = 1.00
    VIX 20–30:       high    → vix_score = 0.75
    VIX 15–20:       normal  → vix_score = 0.30
    VIX < 15:        low     → vix_score = 0.00

  Realized vol ratio (secondary signal):
    vol_ratio > 2.0: 1.00
    vol_ratio 1.5–2.0: 0.75
    vol_ratio 1.2–1.5: 0.40
    vol_ratio < 1.2:   0.00

  Combined high_vol_score (VIX primary, ratio secondary):
    high_vol_score = 0.65 * vix_score + 0.35 * vol_ratio_score

  Rationale: India VIX leads realized vol — it reflects options market
  fear directly. Realized vol lags by days. Using VIX as primary means
  the regime classifier reacts before the damage shows in price history.
```

-----

#### Regime 5: Low Volatility

```
  India VIX thresholds (primary):
    VIX < 12:        very low → vix_low_score = 1.00
    VIX 12–15:       low     → vix_low_score = 0.65
    VIX 15–17:       borderline → vix_low_score = 0.30
    VIX > 17:        normal+ → vix_low_score = 0.00

  Realized vol ratio (secondary):
    vol_ratio < 0.60:    1.00
    vol_ratio 0.60–0.80: 0.65
    vol_ratio 0.80–0.90: 0.30
    vol_ratio > 0.90:    0.00

  low_vol_score = 0.65 * vix_low_score + 0.35 * vol_ratio_low_score

  Note: High Vol and Low Vol scores are mutually exclusive by VIX value.
  VIX cannot simultaneously be above 20 and below 15.
```

-----

### 6.5 Regime Persistence Filter (Gap 10 Fix)

A regime that lasts 1 day is probably noise. Before a regime shift
triggers a rebalance, the new regime must persist:

```
Minimum persistence before triggering rebalance:
  Normal regimes (Bull, Bear, Sideways, LowVol): 3 consecutive days
  High Volatility: 1 day (volatility acts immediately, waiting is costly)
  Extreme event (vol_ratio > 2.0): 1 day (act immediately)

Implementation:
  Track regime_duration[r] = consecutive days with regime_score[r] > 0.3
  
  Regime shift detected when:
    new_dominant_regime != previous_dominant_regime
    AND regime_duration[new_regime] >= persistence_threshold[new_regime]
  
  Smoothing factor during confirmed regime shift (see Section 9.2):
    Adjust smooth_factor based on shift magnitude
```

### 6.6 Regime Score Output

```json
{
  "date": "2025-05-01",
  "bull":       0.65,
  "bear":       0.00,
  "sideways":   0.30,
  "high_vol":   0.40,
  "low_vol":    0.00,
  "adx":        22.4,
  "india_vix":  17.8,
  "vol_ratio":  1.38,
  "sma50":      24180.5,
  "sma200":     23540.0,
  "price":      24350.0,
  "regime_duration": {"bull": 5, "sideways": 0, "high_vol": 2},
  "flags":      [],
  "warm_up_state": "FULL"
}
```

-----

## 7. Strategy Performance Tracker

### 7.1 What We Track Per Strategy

Updated daily at EOD, after market close and settlement lag handling.

```
Rolling metrics (20-day and 60-day windows):
  sharpe_20d, sharpe_60d
  win_rate_20d, win_rate_60d
  avg_pnl_20d
  realized_vol_20d  (floor: max(vol, 0.001) — see Gap 25 fix)

Drawdown tracking:
  peak_equity          (running high-water mark, settled equity only)
  current_drawdown_pct (= (equity - peak) / peak)
  days_in_drawdown     (counter, resets at new peak)
  max_drawdown_20d

Regime-conditional Sharpe (rolling 60d, segmented):
  sharpe_in_bull, sharpe_in_bear, sharpe_in_sideways,
  sharpe_in_high_vol, sharpe_in_low_vol
  (Only computed once strategy has 20+ trades in that regime)

Trade activity:
  total_trades
  trades_last_20d
  trades_last_60d
  consecutive_losses   (resets on any win)
  
Status flags:
  is_bootstrapping
  low_activity         (trades_last_20d == 0)
  is_paused            (set by Risk Monitor)
  is_retirement_candidate
  intraday_strategy    (true/false — affects weight validation timing)
```

### 7.2 Settlement Lag Handling (Gap 6 Fix)

NSE Equity trades settle T+1 (India moved to T+1 settlement in 2023).
NSE F&O and MCX settle on expiry or on close — no multi-day lag.
Using unsettled P&L in Sharpe calculations distorts performance metrics.

```
Settlement rules by segment:
  NSE Equity (EQ):   settlement_date = trade_date + 1 NSE business day
  NSE F&O:           settlement_date = trade_date (same day MTM settlement)
  MCX:               settlement_date = trade_date (same day MTM settlement)

All P&L records tagged with:
  trade_date       (when the trade occurred, IST)
  settlement_date  (per segment rules above)
  is_settled       (boolean, updated daily at 08:30 IST)

Performance snapshots use SETTLED P&L only.
Unsettled P&L stored in trades table but excluded from:
  - sharpe_20d, sharpe_60d calculations
  - peak_equity high-water mark updates
  - drawdown calculations

Practical impact (NSE EQ only):
  Performance metrics reflect trades from 1 business day ago.
  F&O and MCX: no lag — MTM P&L is same-day settled.

Grafana note: Show both settled and unsettled P&L in dashboard,
  clearly labelled. Do not combine them into one figure.
```

### 7.3 Intraday vs Swing Strategy Handling (Gap 19 Fix)

```
strategy_type = 'intraday' or 'swing' (set at strategy creation)

Intraday strategies (MIS product type at Zerodha):
  - HARD DEADLINE: all positions closed by 15:15 IST (system-enforced)
    Zerodha auto-squareoff begins at 15:20–15:25 IST. We act first.
    If system fails to close by 15:15: Risk Monitor sends emergency close.
    This is non-negotiable — MIS positions left open past squareoff
    attract penalties and forced execution at unfavourable prices.
  - Capital is fully liquid at EOD (no overnight margin requirement)
  - Weight validated at OPEN (09:15 IST, before first trade of day)
  - Excluded from overnight position-weight calculations
  - Overnight weight calculation: treat as 0% deployed

Swing strategies (NRML product type at Zerodha):
  - Hold positions overnight with GTT stop orders
  - Weight validated at CLOSE (15:30 IST, after last trade)
  - Included in overnight position-weight calculations
  - Margin blocked overnight — capital not available for intraday reuse

Allocation weight applies to both identically.
Only the timing of weight enforcement and the squareoff deadline differ.

MCX intraday strategies:
  - MCX MIS squareoff: 23:00 IST (30 min before MCX close)
  - Treated same as NSE intraday but with different deadline
  - strategy_type: 'intraday_mcx' to distinguish from NSE intraday
```

### 7.4 Statistical Validity Gate

```
Minimum requirements for non-zero allocation (beyond min_weight floor):
  total_trades >= 30
  At least 10 days of live or paper trading history

Below threshold: bootstrap mode (see 7.5)
```

### 7.5 New Strategy Bootstrap

```
Phase 1 (0–29 trades): bootstrap mode
  is_bootstrapping = true
  weight = min_weight floor (5%)
  perf_score = 0.5 (neutral, no performance adjustment)
  Use backtest Sharpe as read-only reference (not used in scoring)
  Regime-conditional Sharpe: not available → static fit matrix only

Phase 2 (30+ trades): normal mode
  is_bootstrapping = false
  Full performance scoring applies
  Backtest Sharpe no longer used

First run (cold start, no history at all):
  cold_start = true
  Previous weights: equal across all strategies
  Smoothing: disabled (no previous to blend with)
  Regime scoring: available if 200+ days of NIFTY-I data
```

-----

## 8. Allocation Algorithm

### 8.1 Pre-Flight Config Validation (Gap 4 Fix)

Before any allocation run, validate the config. Reject if any fails.

```
Validation rules:
  n = number of active strategies

  Rule 1: n * min_weight <= total_allocation_target
    Example: 5 strategies * 25% min = 125% > 90% target → REJECT
    Error: "min_weight too high for strategy count"

  Rule 2: max_weight >= min_weight
    Error: "max_weight must exceed min_weight"

  Rule 3: max_weight <= total_allocation_target
    Error: "max_weight cannot exceed total allocation target"

  Rule 4: smooth_factor in [0.0, 1.0]
    Error: "smooth_factor must be between 0 and 1"

  Rule 5: total_allocation_target in [0.50, 1.00]
    Error: "allocation target must be between 50% and 100%"

  Rule 6: rebalance_drift_threshold >= 0.02
    Error: "drift threshold below 2% will cause excessive churn"

  Rule 7: min_weight >= 0.01
    Error: "min_weight must be at least 1%"

If any rule fails: reject config, return 400 with specific error.
DO NOT silently apply a corrected config.
```

### 8.2 Overview — 6 Sequential Steps

```
Step 1: Compute base weights (inverse volatility / risk parity)
Step 2: Apply regime-fit multipliers
Step 3: Apply performance adjustment (recent Sharpe)
Step 4: Apply drawdown penalty
Step 5: Apply correlation constraint
Step 6: Normalize + clip to [min, max] + smooth
```

All steps applied in order. Each step’s output feeds the next.
After steps 2, 3, 4: re-normalize to sum to 1.0 before continuing.

-----

### Step 1: Base Weights (Inverse Volatility / Risk Parity)

Risk parity allocates equal RISK to each strategy, not equal capital.

```
For each strategy i:
  vol_floor = 0.001  (0.1% annualized minimum — Gap 25 fix)
  vol_20d[i] = max(realized_vol_20d[i], vol_floor)
  
  base_weight[i] = (1 / vol_20d[i]) / sum_j(1 / vol_20d[j])

Fallback hierarchy for missing vol data:
  1. Use vol_20d if available (>= 10 returns)
  2. Use vol_60d if available
  3. Use backtest volatility estimate
  4. Use equal weight (1 / n_strategies)

Example (3 strategies):
  A: vol=12% → 1/0.12 = 8.33
  B: vol=8%  → 1/0.08 = 12.50
  C: vol=20% → 1/0.20 = 5.00
  Sum = 25.83

  base_weight[A] = 8.33/25.83 = 32.2%
  base_weight[B] = 12.50/25.83 = 48.4%
  base_weight[C] = 5.00/25.83 = 19.4%
```

-----

### Step 2: Regime-Fit Multipliers

#### 8.3a Static Fit Matrix (default values, configurable per strategy)

```
              Bull  Bear  Sideways  HighVol  LowVol
Trend         1.0   0.8   0.1       0.3      0.7
Mean Rev      0.3   0.3   1.0       0.2      1.0
Breakout      0.6   0.6   0.1       1.0      0.1
Pullback      0.9   0.5   0.1       0.2      0.6

Stored in: strategy_regime_fit table (one row per strategy per regime)
Editable via: POST /v1/allocator/strategy/{id}/fit-matrix
Range: 0.0 to 1.0
```

#### 8.3b Composite Regime-Fit Score

```
regime_score_sum = sum(all regime_scores)

If regime_score_sum < 0.1:
  → REGIME_AMBIGUOUS state (Gap 7.4)
  → regime_multiplier[i] = 1.0 for all strategies (neutral)
  → Log: REGIME_AMBIGUOUS
  → Skip regime scoring entirely for this run

Else:
  regime_fit[i] = sum over r: (regime_score[r] * fit_matrix[i][r])
                  / regime_score_sum

  regime_fit_floored[i] = max(regime_fit[i], 0.20)
  (Never fully suppress a strategy based on regime alone —
   regime classification is probabilistic, not certain)

  regime_multiplier[i] = 0.5 + 1.0 * regime_fit_floored[i]
  → Range: [0.5 + 0.2, 0.5 + 1.0] = [0.70, 1.50]
```

-----

### Step 3: Performance Adjustment

```
If is_bootstrapping or trades_last_20d == 0:
  perf_score = 0.5 (neutral)

Else:
  sharpe_score_20d = clip(sharpe_20d, -1.0, 2.0)
  sharpe_score_60d = clip(sharpe_60d, -1.0, 2.0)
  
  normalize = lambda x: (x - (-1.0)) / (2.0 - (-1.0))  ← maps to [0,1]
  
  score_20d = normalize(sharpe_score_20d)
  score_60d = normalize(sharpe_score_60d)
  
  blended = 0.6 * score_20d + 0.4 * score_60d
  
  perf_score = max(0.3, blended)
  (Floor at 0.3 — don't punish a bad 20d if 60d is good)

perf_multiplier[i] = 0.7 + 0.6 * perf_score[i]
→ Range: [0.7 + 0.7*0.3, 0.7 + 0.6*1.0] = [0.91, 1.30]

Note: Sharpe clipped to [-1.0, 2.0] before scoring.
A one-week outlier win (Sharpe of 4.0) is capped at 2.0.
This prevents a single lucky trade from dominating allocation.
```

-----

### Step 4: Drawdown Penalty

```
dd = abs(current_drawdown_pct)
days = days_in_drawdown

depth_penalty = max(0.0, 1.0 - 2.0 * dd)
  → At dd=0%:   1.00 (no penalty)
  → At dd=25%:  0.50
  → At dd=50%:  0.00 (capital starved)

time_penalty = max(0.5, 1.0 - 0.01 * days)
  → At 0 days:  1.00
  → At 50 days: 0.50 (hard floor)

drawdown_multiplier[i] = depth_penalty * time_penalty
→ Range: [0.0, 1.0]
(No re-normalization gap: multiplier of 1.0 means no change)

Special case — drawdown cluster (all strategies in DD):
  If all strategies have current_drawdown_pct < -5%:
    → Apply extra penalty: multiply each drawdown_multiplier by 0.7
    → Increase cash buffer (see Section 9.4 — Gap 17 fix)
    → Flag: DRAWDOWN_CLUSTER
    → Alert user
```

-----

### Step 5: Correlation Constraint

#### 8.7a Normal Operation

```
Compute pairwise Pearson correlation using daily returns, 60-day lookback.

For each pair (i, j) where corr(i,j) > correlation_threshold (default 0.70):
  reduction_factor = (corr(i,j) - 0.70) / 0.30   ← scales 0→1 as corr goes 0.7→1.0
  
  Apply reduction to the smaller-weighted strategy only:
  smaller = argmin(adjusted_weight[i], adjusted_weight[j])
  adjusted_weight[smaller] *= (1.0 - 0.30 * reduction_factor)

Maximum reduction from correlation step alone: 30%
```

#### 8.7b Correlation Crisis Detection (Gap 7.2 Fix)

```
median_corr = median of all pairwise correlations

If median_corr > 0.65:
  → Skip Step 5 entirely (applying it would push all weights to zero)
  → Instead: apply portfolio vol scaling
  
  target_vol_annual = 10%
  portfolio_vol = sqrt(weights' * corr_matrix * diag(vols)^2 * weights)
                  * sqrt(252)
  
  scale = target_vol_annual / portfolio_vol
  total_allocation_target *= min(scale, 1.0)
  (Only scale DOWN, never UP — don't lever up in a crisis)
  
  → Flag: CORRELATION_CRISIS
  → Log reason, do not alert unless portfolio_vol > 20%
```

#### 8.7c Single Strategy Edge Case

```
If n_active_strategies == 1:
  Skip Steps 1 and 5 entirely.
  Output: total_allocation_target to the single strategy.
  Regime, performance, and drawdown steps still apply.
```

-----

### Step 6: Normalize + Clip + Smooth

#### 8.8a Iterative Clipping (Gap 7.8 Fix)

Weight clipping can cascade. Use iterative convergence.

```
min_weight = config.min_weight  (default 5%)
max_weight = config.max_weight  (default 40%)
total_target = regime_adjusted_allocation_target (see Section 9.4)

Algorithm:
  max_iterations = 10
  for iteration in range(max_iterations):
    clipped = clip(adjusted_weights, min_weight, max_weight)
    normalized = clipped / sum(clipped) * total_target
    
    violations = any(w < min_weight or w > max_weight for w in normalized)
    if not violations:
      break
  
  if iteration == 9:
    log WARNING: "Clipping did not converge in 10 iterations"
    log current weights, config values
    use last iteration result anyway (do not halt)

After convergence: final_weight = normalized
```

#### 8.8b Smoothing (Convergence Documented — Gap 11 Fix)

```
Convergence timeline with smooth_factor=0.7:
  Day 1: 70% of the way to new target
  Day 2: 91% of the way to new target
  Day 3: 97.3% — effectively converged

Regime-dependent smooth_factor:
  Normal market:              0.70
  High vol confirmed (1 day): 0.50  (2 days to ~97%)
  Extreme event (vol > 2x):   0.30  (faster response)
  Bear regime confirmed:      0.50

output_weight[i] = smooth_factor * final_weight[i]
                 + (1 - smooth_factor) * previous_weight[i]

Smoothing SKIPPED entirely when:
  - cold_start = true (no previous to blend)
  - Kill switch Level 3 triggered (immediate full application)
  - Strategy just un-paused (starts from min_weight, no blend)
  - Strategy crosses bootstrap threshold (full scoring applies immediately)
```

-----

## 9. Rebalancing Logic

### 9.1 Rebalancing Bands — Not Hard Targets (Gap 1 Fix)

```
Weights are targets, not mandates. Forced mid-trade closures
are prohibited. Use rebalancing bands:

Band 1: Drift < 5% of target weight
  Action: Do nothing.
  Rationale: Normal market movement. Not worth the transaction cost.

Band 2: Drift 5–10% over target weight
  Action: Soft cap — no new entries on the over-weight strategy
          until natural trade exits bring it back.
  Mechanism: Risk Monitor blocks new BUY signals for this strategy.
             Existing positions run with their stop losses intact.
  Rationale: Let winners run. Passive rebalancing via natural exits.

Band 3: Drift 10–15% over target weight
  Action: Soft trim — on next natural exit in the over-weight strategy,
          do not re-enter at full position size. Reduce by 50%.
          Direct freed capital to underweight strategies.
  Mechanism: Risk Monitor flags strategy as TRIMMING_MODE.
             No forced closes. Trim happens at next exit point.
  Rationale: Cost of trim is exit commission only. No slippage from
             forced entry-exit cycle.

Band 4: Drift > 15% over target weight
  Action: Hard trim — at next SESSION OPEN, reduce largest position
          in over-weight strategy by enough to bring back to
          target + 10% buffer.
  Mechanism: Live Executor receives PARTIAL_CLOSE instruction.
             Executed as limit order at market open + 5 minutes.
             (Avoid opening gap slippage.)
  Rationale: Concentration risk now outweighs transaction cost.
             A 15%+ overweight on one strategy is a real risk event.

Underweight strategy handling:
  New capital (from deposits, profits, trimming) is always
  deployed to the most underweight strategy first.
  This is the primary rebalancing mechanism — deploy to the
  deficit, not withdraw from the surplus.
```

### 9.2 When Rebalancing Triggers

Daily check at 18:30 IST. Actual rebalancing only if ANY condition met:

```
Condition A — Weight in Band 3 or 4 (>10% drift):
  max(|actual_weight[i] - target_weight[i]|) > 0.10

Condition B — Regime shift confirmed (persistence filter passed):
  max(|regime_score_today[r] - regime_score_yesterday[r]|) > 0.30
  AND regime_duration[new_regime] >= persistence_threshold

Condition C — Kill switch threshold crossed today

Condition D — New strategy crosses bootstrap threshold (30 trades)

Condition E — Strategy un-paused by Risk Monitor

If none: skip rebalancing.
  Log: "Rebalance skipped — weights stable"
  Do NOT update Redis if weights unchanged.
```

### 9.3 Multiple Runs Same Day (Gap 9 Fix)

```
First run of the day (scheduled): is_primary = true
  → Writes to Redis
  → Writes to allocation_runs as primary

Subsequent runs (manual): is_primary = false
  → Does NOT overwrite Redis unless force=true is passed
  → Writes to allocation_runs with is_primary = false
  → Returns diagnostics only

Manual override endpoint:
  POST /v1/allocator/run?force=true
  → Requires explicit confirmation parameter: "confirm": "OVERRIDE_TODAY"
  → Overwrites Redis
  → Sets is_primary = false on previous run, true on new run
  → Logs: MANUAL_OVERRIDE with timestamp and operator info
```

### 9.4 Regime-Aware Cash Buffer (Gap 17 Fix)

```
total_allocation_target is dynamic based on regime:

Condition                           Target    Cash Buffer
─────────────────────────────────────────────────────────
Low vol + Bull (calm bull)          95%       5%
Normal (default)                    90%       10%
High vol (vol_ratio 1.2–1.5)        85%       15%
High vol + Bear                     75%       25%
Extreme (vol_ratio > 2.0)           65%       35%
Extreme + DRAWDOWN_CLUSTER          55%       45%

Transition: target changes smoothly (same smoothing as weights)
Never increase target above 95%.
Never decrease below 55% (always some market exposure).
```

### 9.5 Transaction Cost Check Before Rebalance (Gap 22 Fix)

Before executing any rebalance, verify it’s worth the cost:

```
Estimated rebalance cost:
  cost[i] = |weight_change[i]| * account_equity * (commission_rate + slippage_estimate)
  total_cost = sum(cost[i] for all strategies)

Estimated rebalance benefit:
  benefit = (expected_sharpe_improvement * account_equity * 0.01)
  (Conservative: assume 1% monthly improvement in risk-adjusted return)

Proceed with rebalance only if: benefit > 2 * total_cost

Exception: Always rebalance regardless of cost if:
  - Band 4 (>15% drift) — risk overrides cost
  - Kill switch triggered — risk overrides cost
  - Strategy paused/resumed — must act

Log: estimated_cost and estimated_benefit in allocation_runs table.
```

### 9.6 Capital Flow Protocol (Gap 20 Fix)

```
Explicit rules for how capital moves between strategies:

Rule 1 — Weight increase (strategy gets more capital):
  No immediate action. Risk Monitor allows new BUY signals
  up to the new weight limit. Capital deploys naturally via
  new trade entries.

Rule 2 — Weight decrease (strategy gets less capital):
  No new entries allowed (Risk Monitor blocks BUYs).
  Existing positions continue to their natural exit
  (stop loss, take profit, or time exit).
  Weight drifts down naturally as positions close.

Rule 3 — Freed capital routing:
  Capital freed from a closed position goes to:
  Step 1: Cash buffer (ensure it's at target level)
  Step 2: Most underweight active strategy
  Step 3: If all strategies at target: stays in cash

Rule 4 — No cross-strategy capital transfers:
  Each strategy operates within its own budget.
  No direct P&L transfer between strategies.

Rule 5 — New deposit handling:
  New capital deposited to account:
  → Allocator runs immediately (force=true)
  → New capital distributed to underweight strategies proportionally
  → Most underweight strategy gets priority
```

-----

## 10. Kill Switch & Emergency Protocol (Gap 21 Fix)

### 10.1 Portfolio-Level Kill Switch

Four escalating levels based on total portfolio drawdown:

```
Level 1 — WARNING (portfolio DD > 8%):
  Action:
    - Reduce max risk per trade: 2% → 1%
    - Tighten all existing stop losses to 1.5x ATR
      (Do NOT move stops away from price)
    - Alert user with daily summary
    - No position changes
  Auto-reset: when portfolio recovers to < 5% drawdown

Level 2 — REDUCE (portfolio DD > 12%):
  Action:
    - Halt ALL new trade entries immediately
    - Existing positions continue with tightened stops
    - Stops moved to breakeven where profitable
    - Alert user: URGENT flag, requires acknowledgement
    - Allocator still runs (to reflect updated weights)
    - No allocation changes take effect until user acknowledges
  Auto-reset: manual only (user must acknowledge and reset)

Level 3 — EXIT (portfolio DD > 15%):
  Action:
    - Close ALL open positions at market
    - Execution: Live Executor sends market close orders
    - Timing: immediate, not waiting for session open
    - After close: halt all strategies (allocation = 0%)
    - Cash position: 100%
    - Alert: CRITICAL — SMS/email if configured
    - Requires full manual review and system restart
  Auto-reset: never — full manual restart required

Level 4 — EMERGENCY (manual kill switch):
  Action: identical to Level 3
  Trigger: user presses kill switch in dashboard
  Use case: news event, broker issue, personal emergency
  Response time target: all positions closed within 30 seconds
```

### 10.2 Strategy-Level Kill Switch

```
Individual strategy drawdown thresholds:

DD > 15%:
  → Reduce strategy allocation by 50%
  → Apply consecutive_loss_penalty (1% risk per trade)
  → Flag: STRATEGY_DD_WARNING

DD > 20%:
  → Set strategy allocation to min_weight (5%)
  → No new entries
  → Existing trades run to natural exit
  → Flag: STRATEGY_DD_CRITICAL
  → Alert user

DD > 25% (or 5 consecutive full-stop losses):
  → Halt strategy entirely: allocation = 0%
  → Close all open positions in this strategy at market
  → Flag: STRATEGY_HALTED
  → Requires manual review and restart

Recovery:
  When a halted strategy recovers to < 10% DD AND
  user manually restarts it:
  → Start at min_weight (5%)
  → Bootstrap mode reactivated (perf_score = 0.5)
  → Weight builds back over time via smoothing
```

### 10.3 Stop Loss Enforcement Chain

```
Order of enforcement (every single trade):

1. Risk Monitor calculates stop price (based on 2% rule + ATR)
2. Live Executor submits bracket order: entry + stop simultaneously
3. Broker confirms stop order within 5 seconds
   → If no confirmation: cancel entry, log STOP_PLACEMENT_FAILED, alert
4. After fill: monitor stop order status continuously
   → If stop order disappears (broker glitch): re-submit immediately
   → If 2nd re-submit fails: close position at market, alert
5. Never, under any circumstance, remove a stop loss without replacing it
   before removing it.

Stop loss cannot be widened once placed.
Stop loss can only be tightened (moved toward price, never away).
```

-----

## 11. Gross Exposure Tracking (Gap 2 Fix)

The Allocator works in capital weight terms. But a strategy with
2x internal leverage has 2x the risk exposure of its capital weight.

```
Effective exposure = capital_allocated * leverage_factor

Risk Monitor tracks and reports to Redis:
  Key: "risk:gross_exposure:{strategy_id}"
  Value: {"capital_weight": 0.30, "leverage": 1.5, "gross_exposure": 0.45}

Allocator reads gross_exposure at Step 6 for constraint validation:
  If gross_exposure[i] > max_weight:
    → Reduce capital_allocated[i] until gross_exposure <= max_weight
    → Log: LEVERAGE_CAP_APPLIED

Portfolio gross exposure limit:
  sum(gross_exposure[i]) must not exceed 150% of account equity
  (Allows moderate leverage but prevents extreme concentration)

For equities (current phase): leverage is typically 1x.
  This step is primarily for future forex expansion where
  leverage can be 10x.
```

-----

## 12. Redis Integrity (Gap 5 Fix)

```
Write protocol (Allocator):
  payload = {
    "weights": {"strategy_id_1": 0.391, ...},
    "date": "2025-05-01",
    "run_id": "uuid",
    "cash_pct": 0.102,
    "flags": ["DRAWDOWN_CLUSTER"],
    "checksum": sha256(json.dumps(weights, sort_keys=True))
  }
  
  Redis.set("allocator:weights:current", json.dumps(payload), TTL=26h)
  Redis.set("allocator:weights:previous", previous_payload, TTL=52h)
  (Always keep previous as fallback)

Read protocol (Risk Monitor):
  payload = Redis.get("allocator:weights:current")
  
  Verify:
    recomputed = sha256(json.dumps(payload["weights"], sort_keys=True))
    if recomputed != payload["checksum"]:
      → CHECKSUM_FAILED
      → Use "allocator:weights:previous" as fallback
      → Alert: REDIS_INTEGRITY_ERROR
      → Do NOT use corrupted weights under any circumstance
  
  Staleness check:
    if payload["date"] < today - 1 business day:
      → STALE_WEIGHTS
      → Halt new entries (do not use stale weights)
      → Alert user

Write atomicity:
  Use Redis MULTI/EXEC transaction to write current + update TTL atomically.
  This prevents partial writes from corrupting the payload.
```

-----

## 13. Configuration & Audit Trail

### 13.1 Config Reference

```
min_weight                  = 5%    (floor per strategy)
max_weight                  = 40%   (cap per strategy)
total_allocation_target     = 90%   (base, regime-adjusted dynamically)
smooth_factor               = 0.70  (overridden by regime)
rebalance_drift_threshold   = 5%    (Band 1/2 boundary)
regime_shift_threshold      = 0.30  (regime delta to check persistence)
regime_persistence_normal   = 3     (days before acting on Bull/Bear/Sideways)
regime_persistence_highvol  = 1     (days before acting on HighVol)
correlation_threshold       = 0.70  (above this: reduce smaller strategy)
drawdown_cluster_threshold  = 5%    (all strategies below → cluster flag)
reference_symbol            = 'NIFTY-I' (equities phase)
transaction_cost_rate       = 0.001 (0.1% for cost-benefit check)
```

### 13.2 Config Audit Trail (Gap 13 Fix)

Every config change is immutably logged. There is NO in-place update.

```sql
-- New table: allocator_config_history
-- Every write to allocator_config creates a row here first.
CREATE TABLE allocator_config_history (
    id                          BIGSERIAL PRIMARY KEY,
    changed_at                  TIMESTAMP DEFAULT NOW(),
    changed_by                  VARCHAR(100),
    change_reason               TEXT,
    min_weight                  DECIMAL(4,3),
    max_weight                  DECIMAL(4,3),
    total_allocation_target     DECIMAL(4,3),
    smooth_factor               DECIMAL(4,3),
    rebalance_drift_threshold   DECIMAL(4,3),
    regime_shift_threshold      DECIMAL(4,3),
    regime_persistence_normal   INTEGER,
    regime_persistence_highvol  INTEGER,
    correlation_threshold       DECIMAL(4,3),
    drawdown_cluster_threshold  DECIMAL(4,3),
    reference_symbol            VARCHAR(20),
    transaction_cost_rate       DECIMAL(6,4),
    previous_config_id          BIGINT REFERENCES allocator_config_history(id)
);

API change requires:
  POST /v1/allocator/config
  Body must include: "changed_by" and "change_reason" (required fields)
  Returns 400 if either missing.
```

### 13.3 Manual Weight Override (Gap 14 Fix)

```sql
CREATE TABLE strategy_weight_overrides (
    id              UUID PRIMARY KEY,
    strategy_id     UUID REFERENCES strategies(id),
    override_weight DECIMAL(4,3),
    override_reason TEXT NOT NULL,
    created_by      VARCHAR(100),
    created_at      TIMESTAMP DEFAULT NOW(),
    expires_at      TIMESTAMP NOT NULL,   -- mandatory expiry
    is_active       BOOLEAN DEFAULT TRUE,
    CONSTRAINT max_7_days CHECK (expires_at <= created_at + INTERVAL '7 days')
);
-- Overrides expire automatically. Maximum 7 days.
-- No permanent overrides without weekly renewal (intentional friction).
```

Override behavior in Allocator:

```
If active override exists for strategy_id:
  → Use override_weight directly
  → Skip Steps 1–5 for this strategy
  → Deduct override_weight from remaining pool
  → Distribute remaining pool across non-overridden strategies
  → Log: WEIGHT_OVERRIDE_APPLIED
```

-----

## 14. API Design (Complete)

```
POST /v1/allocator/run
  Trigger allocation run (normally scheduled)
  Params: ?force=true&dry_run=true
  Body (if force): {"confirm": "OVERRIDE_TODAY"}
  Response: {"run_id": "uuid", "status": "queued", "dry_run": false}

GET /v1/allocator/weights/current
  Current target weights + regime + flags
  Response: {
    "date": "2025-05-01",
    "run_id": "uuid",
    "weights": {"strategy_id_1": 0.391, ...},
    "cash_pct": 0.102,
    "actual_weights": {"strategy_id_1": 0.41, ...},
    "drift": {"strategy_id_1": 0.019, ...},
    "band": {"strategy_id_1": 1},   ← 1=no action, 2=soft cap, 3=trim, 4=hard trim
    "regime": {"bull": 0.65, "high_vol": 0.40, ...},
    "allocation_target": 0.90,
    "flags": [],
    "checksum": "sha256..."
  }

GET /v1/allocator/weights/history
  ?from=2025-01-01&to=2025-05-01&strategy_id=optional
  Returns: time series of weights + regime per day

GET /v1/allocator/regime/current
  Current regime score vector + warm-up state

GET /v1/allocator/regime/history
  ?from=2025-01-01

GET /v1/allocator/diagnostics/{run_id}
  Full step-by-step breakdown of a specific run
  Response: {
    "run_id": "uuid",
    "config_snapshot": {...},
    "pre_flight_validation": "PASSED",
    "warm_up_state": "FULL",
    "regime": {...},
    "steps": {
      "base_weights":      {"strategy_1": 0.333, ...},
      "after_regime":      {"strategy_1": 0.371, ...},
      "after_performance": {"strategy_1": 0.415, ...},
      "after_drawdown":    {"strategy_1": 0.439, ...},
      "after_correlation": {"strategy_1": 0.439, ...},
      "after_clip":        {"strategy_1": 0.395, ...},
      "after_smooth":      {"strategy_1": 0.391, ...}
    },
    "multipliers": {
      "regime":      {"strategy_1": 1.108, ...},
      "performance": {"strategy_1": 1.25,  ...},
      "drawdown":    {"strategy_1": 0.96,  ...}
    },
    "rebalance_triggered": true,
    "trigger_reason": "WEIGHT_DRIFT",
    "estimated_rebalance_cost": 45.20,
    "estimated_rebalance_benefit": 210.50,
    "flags": [],
    "transaction_cost_check": "PROCEED"
  }

POST /v1/allocator/config
  Update configuration
  Body: {config fields} + "changed_by" + "change_reason" (required)
  Validation runs before saving. Returns 400 on failure with reason.

GET /v1/allocator/config/history
  All config changes, newest first

POST /v1/allocator/strategy/{id}/fit-matrix
  Update regime fit scores for a specific strategy
  Body: {"bull": 1.0, "bear": 0.8, "sideways": 0.1, ...}

POST /v1/allocator/override
  Set a manual weight override
  Body: {
    "strategy_id": "uuid",
    "override_weight": 0.30,
    "override_reason": "text",    ← required
    "expires_at": "2025-05-08"    ← max 7 days, required
  }

DELETE /v1/allocator/override/{strategy_id}
  Remove active override before expiry

GET /v1/allocator/performance/attribution
  P&L attribution per strategy using TWR methodology
  ?from=2025-01-01

GET /v1/allocator/performance/benchmark
  Portfolio vs. equal-weight vs. Nifty 50 benchmark
  ?from=2025-01-01

GET /v1/allocator/kill-switch/status
  Current kill switch level (0-4) + thresholds

POST /v1/allocator/kill-switch/manual
  Trigger Level 4 emergency stop
  Body: {"confirm": "CLOSE_ALL_POSITIONS"}

GET /v1/allocator/health
  {
    "status": "ok",
    "last_run": "2025-05-01T18:30:00Z",
    "last_run_result": "REBALANCED",
    "data_staleness_hours": 0.5,
    "redis_connected": true,
    "redis_checksum_valid": true,
    "market_open_today": true,
    "strategies_tracked": 3,
    "kill_switch_level": 0,
    "warm_up_state": "FULL"
  }
```

-----

## 15. Database Schema (Complete)

```sql
-- Daily allocation output
CREATE TABLE allocation_history (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                UUID NOT NULL,
    date                  DATE NOT NULL,
    strategy_id           UUID REFERENCES strategies(id),
    target_weight         DECIMAL(6,4),
    actual_weight         DECIMAL(6,4),   ← NEW: current actual weight
    drift                 DECIMAL(6,4),   ← NEW: actual - target
    rebalance_band        SMALLINT,       ← NEW: 1/2/3/4
    base_weight           DECIMAL(6,4),
    after_regime_weight   DECIMAL(6,4),
    after_perf_weight     DECIMAL(6,4),
    after_dd_weight       DECIMAL(6,4),
    after_corr_weight     DECIMAL(6,4),
    regime_multiplier     DECIMAL(6,4),
    perf_multiplier       DECIMAL(6,4),
    drawdown_multiplier   DECIMAL(6,4),
    gross_exposure        DECIMAL(6,4),   ← NEW: capital * leverage
    is_bootstrapping      BOOLEAN DEFAULT FALSE,
    is_overridden         BOOLEAN DEFAULT FALSE,
    override_weight       DECIMAL(6,4),
    created_at            TIMESTAMP DEFAULT NOW(),
    UNIQUE (date, strategy_id),
    INDEX idx_date (date DESC),
    INDEX idx_strategy (strategy_id)
);

-- Allocation run metadata
CREATE TABLE allocation_runs (
    id                      UUID PRIMARY KEY,
    date                    DATE NOT NULL,
    is_primary              BOOLEAN DEFAULT TRUE,   ← NEW
    triggered_by            VARCHAR(50),
    trigger_reason          VARCHAR(100),
    rebalanced              BOOLEAN,
    cash_pct                DECIMAL(6,4),
    allocation_target       DECIMAL(6,4),   ← NEW: actual target used
    flags                   TEXT[],
    smooth_factor_used      DECIMAL(4,3),   ← NEW
    estimated_rebalance_cost  DECIMAL(10,2),  ← NEW
    estimated_rebalance_benefit DECIMAL(10,2), ← NEW
    cost_benefit_check      VARCHAR(20),    ← NEW: PROCEED/SKIP/OVERRIDE
    market_open             BOOLEAN,        ← NEW
    warm_up_state           VARCHAR(30),    ← NEW
    kill_switch_level       SMALLINT DEFAULT 0,  ← NEW
    duration_ms             INTEGER,
    created_at              TIMESTAMP DEFAULT NOW(),
    INDEX idx_date (date DESC)
);

-- Daily regime scores
CREATE TABLE regime_history (
    date           DATE PRIMARY KEY,
    bull           DECIMAL(4,3),
    bear           DECIMAL(4,3),
    sideways       DECIMAL(4,3),
    high_vol       DECIMAL(4,3),
    low_vol        DECIMAL(4,3),
    adx            DECIMAL(6,2),
    india_vix      DECIMAL(6,2),      ← NEW: India VIX at close
    vol_ratio      DECIMAL(6,3),
    price          DECIMAL(12,4),     ← NIFTY-I close
    sma50          DECIMAL(12,4),
    sma200         DECIMAL(12,4),
    warm_up_state  VARCHAR(30),
    regime_duration JSONB,
    flags          TEXT[],
    created_at     TIMESTAMP DEFAULT NOW()
);

-- Per-strategy daily performance snapshot
CREATE TABLE strategy_performance_snapshots (
    id                    BIGSERIAL PRIMARY KEY,
    date                  DATE NOT NULL,
    strategy_id           UUID REFERENCES strategies(id),
    sharpe_20d            DECIMAL(6,3),
    sharpe_60d            DECIMAL(6,3),
    win_rate_20d          DECIMAL(5,3),
    vol_20d               DECIMAL(6,4),
    vol_20d_raw           DECIMAL(6,4),  ← NEW: before floor applied
    drawdown_pct          DECIMAL(6,4),
    days_in_drawdown      INTEGER,
    peak_equity           DECIMAL(12,2),
    peak_equity_settled   DECIMAL(12,2), ← NEW: settled only
    trades_last_20d       INTEGER,
    trades_total          INTEGER,
    consecutive_losses    INTEGER,       ← NEW
    perf_score            DECIMAL(4,3),
    is_bootstrapping      BOOLEAN,
    low_activity          BOOLEAN,
    is_paused             BOOLEAN,       ← NEW
    is_retirement_candidate BOOLEAN,     ← NEW
    strategy_type         VARCHAR(20),   ← NEW: intraday/swing
    created_at            TIMESTAMP DEFAULT NOW(),
    UNIQUE (date, strategy_id),
    INDEX idx_date (date DESC),
    INDEX idx_strategy (strategy_id)
);

-- Pairwise correlation snapshots
CREATE TABLE strategy_correlations (
    date              DATE NOT NULL,
    strategy_id_a     UUID REFERENCES strategies(id),
    strategy_id_b     UUID REFERENCES strategies(id),
    correlation_60d   DECIMAL(5,3),
    median_portfolio_corr DECIMAL(5,3),   ← NEW: portfolio-level median
    crisis_detected   BOOLEAN DEFAULT FALSE, ← NEW
    created_at        TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (date, strategy_id_a, strategy_id_b),
    INDEX idx_date (date DESC)
);

-- Strategy fit matrix
CREATE TABLE strategy_regime_fit (
    strategy_id   UUID REFERENCES strategies(id),
    regime        VARCHAR(20),
    fit_score     DECIMAL(3,2) CHECK (fit_score BETWEEN 0.0 AND 1.0),
    updated_at    TIMESTAMP DEFAULT NOW(),
    updated_by    VARCHAR(100),
    PRIMARY KEY (strategy_id, regime)
);

-- Config (single live row)
CREATE TABLE allocator_config (
    id                          INTEGER PRIMARY KEY DEFAULT 1,
    min_weight                  DECIMAL(4,3) DEFAULT 0.05,
    max_weight                  DECIMAL(4,3) DEFAULT 0.40,
    total_allocation_target     DECIMAL(4,3) DEFAULT 0.90,
    smooth_factor               DECIMAL(4,3) DEFAULT 0.70,
    rebalance_drift_threshold   DECIMAL(4,3) DEFAULT 0.05,
    regime_shift_threshold      DECIMAL(4,3) DEFAULT 0.30,
    regime_persistence_normal   INTEGER DEFAULT 3,
    regime_persistence_highvol  INTEGER DEFAULT 1,
    correlation_threshold       DECIMAL(4,3) DEFAULT 0.70,
    drawdown_cluster_threshold  DECIMAL(4,3) DEFAULT 0.05,
    reference_symbol            VARCHAR(20) DEFAULT 'NIFTY-I',
    transaction_cost_rate       DECIMAL(6,4) DEFAULT 0.001,
    updated_at                  TIMESTAMP DEFAULT NOW(),
    CONSTRAINT single_row CHECK (id = 1)
);

-- Config audit trail (immutable)
CREATE TABLE allocator_config_history (
    id                          BIGSERIAL PRIMARY KEY,
    changed_at                  TIMESTAMP DEFAULT NOW(),
    changed_by                  VARCHAR(100) NOT NULL,
    change_reason               TEXT NOT NULL,
    min_weight                  DECIMAL(4,3),
    max_weight                  DECIMAL(4,3),
    total_allocation_target     DECIMAL(4,3),
    smooth_factor               DECIMAL(4,3),
    rebalance_drift_threshold   DECIMAL(4,3),
    regime_shift_threshold      DECIMAL(4,3),
    regime_persistence_normal   INTEGER,
    regime_persistence_highvol  INTEGER,
    correlation_threshold       DECIMAL(4,3),
    drawdown_cluster_threshold  DECIMAL(4,3),
    reference_symbol            VARCHAR(20),
    transaction_cost_rate       DECIMAL(6,4),
    previous_config_id          BIGINT REFERENCES allocator_config_history(id)
);

-- Manual weight overrides
CREATE TABLE strategy_weight_overrides (
    id              UUID PRIMARY KEY,
    strategy_id     UUID REFERENCES strategies(id),
    override_weight DECIMAL(4,3),
    override_reason TEXT NOT NULL,
    created_by      VARCHAR(100) NOT NULL,
    created_at      TIMESTAMP DEFAULT NOW(),
    expires_at      TIMESTAMP NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    CONSTRAINT max_7_days CHECK (expires_at <= created_at + INTERVAL '7 days')
);

-- Kill switch event log
CREATE TABLE kill_switch_events (
    id              BIGSERIAL PRIMARY KEY,
    triggered_at    TIMESTAMP DEFAULT NOW(),
    level           SMALLINT NOT NULL,      -- 1/2/3/4
    trigger_type    VARCHAR(20),            -- 'automatic' or 'manual'
    trigger_reason  TEXT,
    portfolio_dd    DECIMAL(6,4),
    positions_closed INTEGER,
    total_pnl_at_trigger DECIMAL(12,2),
    resolved_at     TIMESTAMP,
    resolved_by     VARCHAR(100),
    INDEX idx_triggered (triggered_at DESC)
);

-- Strategy retirement tracking
CREATE TABLE strategy_retirement_log (
    id              BIGSERIAL PRIMARY KEY,
    strategy_id     UUID REFERENCES strategies(id),
    flagged_at      TIMESTAMP,
    retired_at      TIMESTAMP,
    retired_by      VARCHAR(100),
    reason          TEXT,
    sharpe_at_retirement DECIMAL(6,3),
    lifetime_pnl    DECIMAL(12,2)
);

-- P&L attribution (TWR methodology)
CREATE TABLE pnl_attribution (
    id              BIGSERIAL PRIMARY KEY,
    date            DATE NOT NULL,
    strategy_id     UUID REFERENCES strategies(id),
    weight_at_open  DECIMAL(6,4),
    weight_at_close DECIMAL(6,4),
    daily_return    DECIMAL(8,6),
    attributed_pnl  DECIMAL(12,2),
    benchmark_return DECIMAL(8,6),         -- Nifty 50 return for same day
    alpha           DECIMAL(8,6),
    INDEX idx_date (date DESC),
    INDEX idx_strategy (strategy_id)
);

-- Benchmark returns (Nifty 50 daily)
CREATE TABLE benchmark_returns (
    date            DATE PRIMARY KEY,
    symbol          VARCHAR(20) DEFAULT 'NIFTY-I',
    daily_return    DECIMAL(8,6),
    cumulative_return DECIMAL(8,6),
    created_at      TIMESTAMP DEFAULT NOW()
);
```

-----

## 16. Benchmark & Attribution (Gap 23 Fix)

### P&L Attribution Methodology (Gap 18 Fix)

```
Method: Time-Weighted Return (TWR)

When a rebalance occurs mid-period:
  Day is split into pre-rebalance and post-rebalance sub-periods.
  P&L for each sub-period attributed using the weight active during that period.
  
  sub_period_return = (equity_end - equity_start) / equity_start
  attributed_pnl = sub_period_return * weight_during_period * account_equity

This prevents the rebalance itself from distorting strategy P&L.
```

### Benchmarks Tracked

```
1. Portfolio (actual allocation)
2. Equal weight (1/n per strategy, daily rebalanced)
3. Nifty 50 buy-and-hold (benchmark)
4. Risk-free rate (India 91-day T-bill, RBI reference rate)

Metrics vs benchmark:
  Alpha = annualized portfolio return - annualized Nifty 50 return
  Beta  = portfolio daily returns correlated with Nifty 50 daily returns
  Information Ratio = (portfolio_return - benchmark_return)
                    / std(portfolio_return - benchmark_return)

Dashboard: All four equity curves shown on same Grafana chart.
```

-----

## 17. Strategy Retirement (Gap 24 Fix)

```
Retirement criteria (ALL must be true):
  - Live trading history > 90 days
  - sharpe_60d < 0 for 30+ consecutive days
  - All regime-conditional Sharpes negative (where data exists)
  - NOT in bootstrap mode
  - NOT currently paused (paused strategies are not retired automatically)

When criteria met:
  Step 1: Flag strategy as retirement_candidate = true
  Step 2: Alert user with details (Sharpe history, regime breakdown)
  Step 3: Auto-reduce to min_weight (5%) for 14 days
          (Observation window — market conditions may recover)
  Step 4: If no user action after 14 days:
          → Set allocation to 0%
          → Flag: STRATEGY_AUTO_HALTED_PENDING_REVIEW
          → Do NOT delete strategy data
  Step 5: User must explicitly call:
          POST /v1/allocator/strategy/{id}/retire
          to permanently free the capital and archive the strategy.

Why not auto-retire fully?
  Strategies can recover. A strategy that underperforms for
  3 months may be regime-dependent, not dead. The human makes
  the final call on permanent retirement.
```

-----

## 18. Allocator Backtesting (Gap 16 Fix)

```
Endpoint: POST /v1/allocator/backtest

Request:
  {
    "from": "2022-01-01",
    "to": "2024-12-31",
    "config": { ...allocator config to test... },
    "strategy_ids": ["uuid1", "uuid2"]
  }

Process:
  Replay historical data day by day:
    1. Load regime_history for each day
    2. Load strategy_performance_snapshots for each day
    3. Run full 6-step allocation pipeline
    4. Record output weights per day
    5. Simulate capital deployment using actual historical strategy returns

Output:
  {
    "weight_history": [...],
    "rebalance_events": [...],
    "portfolio_returns": [...],
    "vs_equal_weight": {...},
    "vs_nifty50": {...},
    "sharpe_ratio": 1.45,
    "max_drawdown": -0.082,
    "total_return": 0.34,
    "rebalance_count": 12,
    "estimated_total_cost_inr": 40500.00
  }

Use case: validate a new config or fit matrix before applying live.
Duration: ~5–30 seconds for 2-year backtest on 5 strategies.
```

-----

## 19. Monitoring & Observability

### Prometheus Metrics

```
allocator_run_duration_seconds
allocator_rebalance_triggered_total{trigger_reason}
allocator_regime_score{regime}
allocator_strategy_weight{strategy_id}
allocator_strategy_actual_weight{strategy_id}
allocator_strategy_drift{strategy_id}
allocator_strategy_band{strategy_id}          ← 1/2/3/4
allocator_flags_total{flag}
allocator_data_staleness_hours
allocator_kill_switch_level
allocator_cash_buffer_pct
allocator_allocation_target_pct
allocator_redis_checksum_failures_total
```

### Grafana Alerts

```
CRITICAL:
  Kill switch Level 3 or 4 triggered
  Redis checksum failure
  Allocator run failed 2 consecutive days
  All strategies in Band 4 simultaneously

WARNING:
  DRAWDOWN_CLUSTER flag
  CORRELATION_CRISIS flag
  Data staleness > 24 hours
  All strategies at min_weight
  Config validation failure attempted

INFO:
  Rebalance executed (with reason)
  Strategy retirement candidate flagged
  Weight override applied or expired
```

-----

## 20. Integration Points (Updated)

### What the Allocator Reads

```
From Data Manager:
  - OHLCV for NIFTY-I (regime calculation)
  - Market calendar (holiday/halt detection)

From strategies table:
  - Active strategy list, strategy_type (intraday/swing)

From strategy_regime_fit:
  - Fit scores per strategy per regime

From trades + equity_curve:
  - Settled P&L for performance snapshots

From positions table:
  - Current open positions → actual weights + gross exposure

From Risk Monitor (Redis):
  - Paused strategy list
  - Gross exposure per strategy (leverage-adjusted)

From benchmark_returns:
  - Nifty 50 daily returns for attribution
```

### What the Allocator Writes

```
Redis (read by Risk Monitor):
  "allocator:weights:current" → weights + checksum + flags (TTL: 26h)
  "allocator:weights:previous" → previous weights (TTL: 52h, fallback)

DB:
  allocation_history, allocation_runs, regime_history,
  strategy_performance_snapshots, strategy_correlations,
  pnl_attribution, benchmark_returns (if not already written)

Event to Risk Monitor:
  REBALANCE_COMPLETE → Risk Monitor updates band enforcement
  KILL_SWITCH_LEVEL_CHANGE → Risk Monitor updates risk limits
```

### Risk Monitor Integration (Updated)

```
For each incoming BUY signal:
  target_weight = Redis.get("allocator:weights:current").weights[strategy_id]
  actual_weight = positions[strategy_id].value / account_equity
  drift = actual_weight - target_weight
  
  Band 1 (drift < 5%):  approve, normal position sizing
  Band 2 (drift 5-10%): block new BUYs, log SOFT_CAP_HIT
  Band 3 (drift 10-15%): block BUYs, flag TRIMMING_MODE
  Band 4 (drift > 15%): block BUYs, initiate partial close instruction
  
  Kill switch check:
    If kill_switch_level >= 2: block all new entries
    If kill_switch_level >= 3: close all positions
```

-----

## 21. Deployment Notes

```
Language:   Go (consistent with full system stack — see ARCHITECTURE.md)
Runtime:    Cloud Run (pay-per-invocation, ideal for daily schedule)
Schedule:   Cloud Scheduler → 18:30 IST, Monday–Friday (NSE trading days)
            Cloud Scheduler timezone: Asia/Kolkata
            Skip condition: handled in-process via market_calendar check
Redis:      Existing Memorystore instance (shared with Core + Risk Monitor)
Database:   Existing PostgreSQL/TimescaleDB instance (new tables only)
Cost:       < ₹100/month additional (one ~10-second Cloud Run invocation/day)
```

-----

## 22. Build Order

```
1.  DB schema migrations (all tables above)
2.  Market calendar integration (standalone, no dependencies)
3.  Benchmark returns loader (Nifty 50 daily, runs with Data Manager)
4.  Strategy performance snapshot job (feeds Steps 3+4)
5.  Regime classifier (standalone, validate against historical NIFTY-I)
6.  Config validation pre-flight (test all rules exhaustively)
7.  Base weight calculator (Step 1)
8.  Allocation pipeline (Steps 2–6) — unit test each step independently
9.  Rebalancing band logic → Risk Monitor integration
10. Redis write + checksum protocol
11. Kill switch framework → Live Executor integration
12. Stop loss enforcement chain → Live Executor integration
13. REST API layer
14. Allocator backtesting endpoint
15. P&L attribution + benchmark tracking
16. Grafana panels + alerts
17. Cloud Scheduler job + retry policy
18. End-to-end integration test with paper trading
```

-----

## 23. Gap Resolution Summary

|# |Gap                         |Resolution                                                                           |
|--|----------------------------|-------------------------------------------------------------------------------------|
|1 |Weight realization gap      |4-band system: passive drift → soft cap → soft trim → hard trim at natural exits     |
|2 |Leverage blind spot         |Risk Monitor reports gross exposure to Redis; Allocator enforces on gross not capital|
|3 |Division by zero            |Hard floors: vol floor 0.001, regime sum floor 0.1, single-strategy path             |
|4 |Config constraint validation|Pre-flight 7-rule validation, rejects with specific error message                    |
|5 |Redis integrity             |SHA256 checksum on write, verified on read, fallback to previous on failure          |
|6 |Settlement lag              |T+1 tagging (NSE EQ); F&O/MCX same-day MTM — no lag                                  |
|7 |Market calendar             |NSE/MCX calendar from instruments_india table, no third-party library                |
|8 |Regime warm-up              |4-state system: INSUFFICIENT/LOW_CONFIDENCE/PARTIAL/FULL                             |
|9 |Multiple runs same day      |is_primary flag, force confirmation required to override                             |
|10|Regime persistence          |3-day filter normal regimes, 1-day for HighVol                                       |
|11|Smoothing convergence       |Documented 3-day convergence, regime-dependent smooth_factor                         |
|12|Reference symbol            |NIFTY-I configurable, expandable to GOLD-I for commodity phase                       |
|13|Config audit trail          |allocator_config_history, immutable, changed_by + reason required                    |
|14|Manual weight override      |strategy_weight_overrides table, 7-day max expiry                                    |
|15|Dry run mode                |?dry_run=true on run endpoint, no side effects                                       |
|16|Allocator backtesting       |Full backtest endpoint with benchmark comparison                                     |
|17|Static cash buffer          |Regime-aware target: 55%–95% based on vol + regime                                   |
|18|P&L attribution             |TWR methodology, pre/post rebalance sub-period split                                 |
|19|Intraday capital            |strategy_type field, separate weight validation timing                               |
|20|Capital flow protocol       |5 explicit rules, freed capital → cash first → most underweight                      |
|21|Kill switch                 |4-level portfolio kill switch + strategy-level, stop loss enforcement chain          |
|22|Transaction costs           |Cost-benefit check, rebalance only if benefit > 2x cost                              |
|23|Benchmark tracking          |Nifty 50 + equal-weight + risk-free tracked, alpha/beta/IR calculated                |
|24|Strategy retirement         |Criteria-based flagging, 14-day observation, human approval to retire                |
|25|Volatility floor            |Hard floor: vol_20d = max(vol_20d, 0.001) before inverse calculation                 |

-----

**Next step:** When ready to code, start with the Regime Classifier (#5 in build order).
It has zero dependencies, can be validated against 2+ years of NIFTY-I historical data,
and its output gates everything downstream.