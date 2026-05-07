# Risk Engine Specification

Risk management rules, position sizing, kill switch protocol, and India-specific guards.
The Risk Engine is not a separate binary — it is a set of goroutines and inline checks
that live within the Core Binary, backed by Redis state.

See CORE_ARCHITECTURE.md for where risk checks fit in the goroutine topology.
See EXECUTION_SPEC.md for how risk rejections are captured and stored.
See ALLOCATOR_SPEC.md for capital allocation weights that feed into risk limits.

---

## Design Principles

1. **Risk checks are in-memory.** No DB calls in the pre-trade risk path. All state lives in Redis.
2. **Hard rules cannot be overridden.** Stop loss confirmation, MCX delivery block, kill switch Level 3+ — these have no override mechanism in code.
3. **Fail safe, not fail open.** If risk state is unavailable (Redis miss, stale data), block the trade. Never assume safety.
4. **India-first rules.** SPAN margin, lot sizing, MIS squareoff, expiry protection, MCX delivery — all enforced as hard rules, not suggestions.
5. **Portfolio risk is sequential to trade risk.** Pre-trade checks gate individual orders. Portfolio risk monitor updates thresholds that future pre-trade checks use.

---

## Risk Engine Components

```
Within Core Binary:

┌─────────────────────────────────────────────────────────────┐
│  Risk Engine                                                │
│                                                             │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Pre-Trade Risk Gate (inline, Stage 3)          │      │
│  │  Runs in symbol engine goroutine                │      │
│  │  Blocks/allows individual orders                │      │
│  └─────────────────────────────────────────────────┘      │
│                                                             │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Position Sizer                                 │      │
│  │  Runs in symbol engine goroutine before Stage 3 │      │
│  │  Calculates lot count from risk model           │      │
│  └─────────────────────────────────────────────────┘      │
│                                                             │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Portfolio Risk Monitor (goroutine, every 30s)  │      │
│  │  Tracks: drawdown, margin, correlation          │      │
│  │  Updates: Redis risk state                      │      │
│  │  Triggers: kill switch escalation               │      │
│  └─────────────────────────────────────────────────┘      │
│                                                             │
│  ┌─────────────────────────────────────────────────┐      │
│  │  India Market Guards (inline, Stage 4)          │      │
│  │  Runs in segment module PreTradeChecks()        │      │
│  │  SPAN margin, MIS squareoff, MCX delivery       │      │
│  └─────────────────────────────────────────────────┘      │
│                                                             │
│  ┌─────────────────────────────────────────────────┐      │
│  │  Kill Switch Manager                            │      │
│  │  Runs as part of Portfolio Risk Monitor         │      │
│  │  4-level escalation, publishes events.risk      │      │
│  └─────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘
```

---

## Redis Risk State

Single source of truth for all pre-trade risk checks.
Written by Portfolio Risk Monitor. Read by Pre-Trade Risk Gate.

```json
{
  "state:risk": {
    "as_of": "2026-05-07T11:30:00+05:30",
    "session_date": "2026-05-07",

    "portfolio": {
      "account_equity_inr": 500000,
      "cash_available_inr": 95000,
      "available_margin_inr": 125000,
      "margin_used_inr": 375000,
      "margin_utilisation_pct": 75.0,
      "open_positions_count": 2,
      "gross_exposure_inr": 450000
    },

    "daily": {
      "realised_pnl_inr": -8500,
      "unrealised_pnl_inr": 3200,
      "total_pnl_inr": -5300,
      "daily_loss_limit_inr": 18000,
      "pct_of_limit_used": 47.2,
      "trades_today": 3
    },

    "drawdown": {
      "portfolio_peak_equity_inr": 512000,
      "portfolio_current_dd_pct": 2.3,
      "portfolio_max_dd_today_pct": 3.1
    },

    "kill_switch": {
      "level": 0,
      "reason": null,
      "activated_at": null,
      "requires_manual_reset": false
    },

    "strategies": {
      "strat_nifty_mean_rev": {
        "consecutive_losses": 2,
        "dd_from_peak_pct": 4.5,
        "current_risk_multiplier": 1.0,
        "status": "ACTIVE"
      },
      "strat_banknifty_breakout": {
        "consecutive_losses": 0,
        "dd_from_peak_pct": 1.2,
        "current_risk_multiplier": 1.0,
        "status": "ACTIVE"
      }
    },

    "regime": {
      "current": "trending",
      "india_vix": 14.8,
      "adx_nifty": 28.5,
      "last_updated": "2026-05-07T11:25:00+05:30"
    }
  }
}
```

TTL: None. Updated every 30 seconds by Portfolio Risk Monitor.
Stale threshold: If `as_of` > 5 minutes ago → treat as unavailable → block all new trades.

---

## Position Sizing

Runs before the Pre-Trade Risk Gate. Calculates the correct number of lots to trade.

### The 2% Rule (Base)

```
risk_amount_inr = account_equity × risk_per_trade_pct / 100
                = ₹5,00,000 × 2% = ₹10,000

stop_distance = entry_price - stop_loss_price  [for LONG]
              = ₹19,503.50 - ₹19,308.47 = ₹195.03

raw_quantity = risk_amount_inr / stop_distance
             = ₹10,000 / ₹195.03 = 51.27 units

lot_size = 25 (NIFTY-I, from instruments table)
lots = floor(raw_quantity / lot_size) = floor(51.27 / 25) = 2 lots
actual_quantity = 2 × 25 = 50 units

If lots = 0 (raw_quantity < lot_size):
  → Cannot trade even 1 lot within risk limits
  → Emit Rejection: POSITION_SIZE_ZERO
  → This means either: stop is too wide, or account equity too small for this instrument

Resulting position value: 50 × ₹19,503.50 = ₹9,75,175
Margin required (SPAN): ~₹1,12,000 for 2 lots of Nifty
```

### Position Size Caps

```
After calculating lots from risk model, apply caps:

Cap 1 — Max position pct of equity:
  position_value = lots × lot_size × entry_price
  If position_value > account_equity × max_position_pct:
    → Reduce lots until position_value <= cap
    → Log: POSITION_CAP_APPLIED

Cap 2 — Max margin utilisation:
  new_margin_used = current_margin_used + required_margin
  If new_margin_used / available_margin > max_margin_utilisation_pct (80%):
    → Reduce lots until margin utilisation stays under cap
    → If even 1 lot exceeds cap: emit Rejection MARGIN_INSUFFICIENT

Cap 3 — Allocator weight cap (from ALLOCATOR_SPEC.md):
  strategy_weight = allocator_weight for this strategy
  strategy_value_limit = account_equity × strategy_weight
  current_strategy_exposure = sum of all open positions for this strategy
  If current_strategy_exposure + position_value > strategy_value_limit:
    → Reduce lots to fit within allocator weight
    → Log: ALLOCATOR_CAP_APPLIED

Final lots = min(risk_lots, cap1_lots, cap2_lots, cap3_lots)
```

### Risk Multiplier (Tightening Rules)

```
Base risk_per_trade_pct = 2.0%

Automatic tightening (applied multiplicatively):

  Rule 1 — Consecutive losses on this strategy:
    0–2 consecutive losses: multiplier = 1.0 (normal)
    3–4 consecutive losses: multiplier = 0.75 (reduce to 1.5%)
    5+  consecutive losses: multiplier = 0.5  (reduce to 1.0%)
    Reset: after 1 profitable trade OR 10 trades (whichever first)

  Rule 2 — Kill switch Level 1 active (portfolio DD > 8%):
    All strategies: multiplier = 0.5 (reduce to 1.0%)

  Rule 3 — Strategy drawdown > 15%:
    That strategy: multiplier = 0.5 (reduce to 1.0%)

  Rule 4 — High volatility regime (India VIX > 20):
    Mean reversion strategies: multiplier = 0.75 (VIX > 20 = mean reversion is risky)
    Breakout strategies:       multiplier = 1.0  (high vol suits breakouts)
    Trend strategies:          multiplier = 0.75 (trends are whippy in high vol)

  Multipliers stack multiplicatively:
    3 consecutive losses AND kill switch Level 1:
    effective_risk = 2.0% × 0.75 × 0.5 = 0.75%

  Floor: effective_risk never goes below 0.5% (always trade at least minimum size)
  Ceiling: effective_risk never goes above 2.0% regardless of any multiplier > 1.0
```

---

## Kill Switch — 4-Level Escalation

Portfolio-level protection. Escalates based on total portfolio drawdown.

```
Level 0 — NORMAL (portfolio DD < 8%):
  All strategies: ACTIVE
  Risk multiplier: 1.0
  New entries: ALLOWED
  Auto-reset: N/A (default state)

Level 1 — WARNING (portfolio DD >= 8%):
  Trigger: portfolio_current_dd_pct >= 8.0
  Actions:
    → Reduce all risk multipliers to 0.5 (half position sizes)
    → Tighten all existing stop losses to 1.5× ATR from current price
       (stop moves TOWARD price, never away)
    → Publish events.risk: level=1, reason=PORTFOLIO_DD_8PCT
    → Alert: WARNING notification
  New entries: ALLOWED (at reduced size)
  Auto-reset: when portfolio recovers to DD < 5% (gives buffer before re-escalation)
  Manual reset: not required

Level 2 — REDUCE (portfolio DD >= 12%):
  Trigger: portfolio_current_dd_pct >= 12.0
  Actions:
    → HALT all new trade entries immediately
    → Existing positions continue with tightened stops (breakeven where profitable)
    → Move all profitable stops to breakeven price (lock in zero loss)
    → Publish events.risk: level=2, reason=PORTFOLIO_DD_12PCT
    → Alert: URGENT — requires acknowledgement from operator
    → Allocator continues running (reflects updated weights) but no new trades execute
  New entries: BLOCKED
  Auto-reset: NEVER — requires manual reset via API
  Manual reset: POST /risk/kill-switch/reset  (after operator review)

Level 3 — EXIT (portfolio DD >= 15%):
  Trigger: portfolio_current_dd_pct >= 15.0
  Actions:
    → Close ALL open positions at market immediately
    → Executor fires emergency close orders for all symbols
    → After close: set all strategy allocations = 0%
    → Cash position: 100%
    → Publish events.risk: level=3, reason=PORTFOLIO_DD_15PCT
    → Alert: CRITICAL — SMS/email if configured
  New entries: BLOCKED PERMANENTLY until manual restart
  Auto-reset: NEVER — requires full manual review and system restart
  Positions: CLOSED

Level 4 — EMERGENCY (manual trigger):
  Trigger: Operator presses kill switch in dashboard
           OR: API POST /risk/kill-switch/emergency
  Actions: Identical to Level 3
  Use case: News event, broker API issue, personal emergency, any reason
  Response time target: all positions closed within 30 seconds
  Auto-reset: NEVER
```

### Kill Switch State Transitions

```
0 ──(DD≥8%)──▶ 1 ──(DD≥12%)──▶ 2 ──(DD≥15%)──▶ 3
0 ◀──(DD<5%)── 1               ▲               ▲
                                │               │
                         Manual only      Manual/Emergency

Level 4 can be triggered from any level.
Levels 2, 3, 4 require manual reset (no automatic recovery).
Level 1 auto-resets when drawdown recovers.
```

### Strategy-Level Kill Switch

```
Per-strategy drawdown thresholds (independent of portfolio kill switch):

DD > 15%:
  → Reduce strategy risk multiplier to 0.5
  → Apply consecutive_loss_penalty (see Position Sizing)
  → Status: STRATEGY_DD_WARNING
  → Alert: WARNING

DD > 20%:
  → Set strategy allocation to min_weight (5% of portfolio)
  → Block new entries for this strategy
  → Existing positions run to natural exit
  → Status: STRATEGY_DD_CRITICAL
  → Alert: URGENT

DD > 25% OR 5 consecutive full stop-loss hits:
  → Halt strategy entirely: allocation = 0%
  → Close all open positions for this strategy at market
  → Status: STRATEGY_HALTED
  → Alert: CRITICAL
  → Requires manual review + restart

Recovery from STRATEGY_HALTED:
  When operator manually restarts (POST /strategies/{id}/restart):
  → Start at min_weight (5%)
  → Risk multiplier starts at 0.5 (half size for first 10 trades)
  → Weight builds back over time via Allocator's normal smoothing
```

---

## Portfolio Risk Monitor (Goroutine)

Runs every 30 seconds inside Core. Updates Redis risk state.

```
Every 30 seconds:

  1. Calculate portfolio metrics
     a. Fetch all open positions from Redis (state:positions)
     b. Fetch current prices for all open symbols from Redis (last ticks)
     c. Calculate unrealised P&L per position
     d. Sum unrealised + realised P&L = total daily P&L
     e. Calculate portfolio drawdown from session peak equity

  2. Update margin state
     a. For F&O and MCX positions: recalculate SPAN margin requirements
        (margins change throughout the day as prices move)
     b. Update available_margin in Redis

  3. Check kill switch thresholds
     a. Compare portfolio DD to each threshold
     b. If threshold crossed: escalate kill switch (if not already at that level)
     c. If DD recovered below reset threshold: de-escalate Level 1 only

  4. Update strategy metrics
     a. For each active strategy: recalculate DD from peak, consecutive losses
     b. Apply strategy-level kill switch if thresholds breached

  5. Update regime
     a. Fetch last India VIX tick from Redis
     b. Calculate ADX for Nifty-I from candle buffer
     c. Classify regime: trending (ADX>25) | ranging (ADX<20) | high_vol (VIX>20)
     d. Update Redis regime state

  6. Write updated state:risk to Redis
     a. Atomic write (Redis MULTI/EXEC transaction)
     b. Include checksum (SHA256 of state JSON)
     c. If write fails: log ERROR, do NOT update state

  7. Publish events.risk if any threshold changed
```

---

## Pre-Trade Risk Gate (Stage 3 — Inline Checks)

Runs in symbol engine goroutine. All checks are pure in-memory reads from Redis.

```
Load risk state from Redis:
  riskState = redis.Get("state:risk")

  If riskState is nil:
    → FAIL SAFE: block trade
    → Emit Rejection: RISK_STATE_UNAVAILABLE
    → Alert: WARNING (risk monitor may be down)
    → Return

  If riskState.as_of is > 5 minutes ago:
    → FAIL SAFE: block trade
    → Emit Rejection: RISK_STATE_STALE
    → Alert: WARNING
    → Return

Sequential checks (any failure → emit rejection and return):

  Check 1: Kill switch
    If riskState.kill_switch.level >= 2:
      → KILL_SWITCH_ACTIVE

  Check 2: Daily loss limit
    If riskState.daily.realised_pnl_inr <= -daily_loss_limit_inr:
      → DAILY_LOSS_LIMIT_REACHED

    If riskState.daily.realised_pnl_inr <= -(daily_loss_limit_inr × 0.9):
      → Emit WARNING event (not a block)
      → Continue to next check (warning only)

  Check 3: Max open positions
    If riskState.portfolio.open_positions_count >= strategy.risk.max_open_positions:
      → MAX_POSITIONS_EXCEEDED

  Check 4: Margin
    required = segment_module.MarginRequired(symbol, lots, price)
    If riskState.portfolio.available_margin_inr < required:
      → MARGIN_INSUFFICIENT

  Check 5: Margin utilisation cap
    new_utilisation = (riskState.portfolio.margin_used_inr + required) /
                      (riskState.portfolio.margin_used_inr + riskState.portfolio.available_margin_inr)
    If new_utilisation > 0.80:
      → MARGIN_UTILISATION_CAP

  Check 6: Trade window
    now_ist = time.Now().In(IST)
    If now_ist.Before(trade_window_start) OR now_ist.After(trade_window_end):
      → OUTSIDE_TRADE_WINDOW

  Check 7: Engine state
    If engine.Status == RECOVERING:
      → ENGINE_RECOVERING

  All passed → calculate position size → emit OrderIntent
```

---

## India-Specific Guards (Stage 4 — Segment Module)

### NSE Equity Guards

```
Circuit Breaker Check:
  Some stocks hit upper/lower circuit during the day.
  Check from instruments_india table (refreshed every 30 min by Data Manager).
  If symbol is in circuit: INSTRUMENT_IN_CIRCUIT → block trade

Price Band Check:
  NSE imposes ±5% / ±10% / ±20% daily price bands on stocks.
  Order price must be within band.
  If entry price > upper band or < lower band: ORDER_OUTSIDE_PRICE_BAND

Corporate Action Check:
  Ex-dividend, bonus, split — price adjustment day.
  Avoid trading on corporate action dates (listed in instruments table).
  If today is ex-date: CORPORATE_ACTION_DAY → log WARNING (not hard block)
```

### NSE F&O Guards

```
Expiry Day Block:
  If strategy.risk.avoid_expiry_day = true
  AND today is weekly or monthly expiry Thursday:
    → EXPIRY_DAY_BLOCK

  Why: Intraday volatility on expiry day is extreme, premiums decay rapidly,
       stop losses are more likely to be hit randomly.
       Strategies that work on normal days often fail on expiry.

  Override: Set avoid_expiry_day = false per strategy if you specifically
            want to trade expiry day momentum.

Expiry Proximity Warning:
  If futures contract expires in <= 3 days AND strategy is NOT roll-aware:
    → Log WARNING: EXPIRY_APPROACHING (not a hard block)
    → Roll is handled by Data Manager/Continuous Contracts, not Risk Engine

SPAN Margin Check:
  Required margin = SPAN margin + Exposure margin
  Both values from instruments_india table (refreshed morning and intraday).
  If available_margin < SPAN + Exposure: MARGIN_INSUFFICIENT

  Note: SPAN margins change during the day (NSE updates them).
        The intraday margin refresh job (see INGESTION_PIPELINE_SPEC.md) keeps
        the instruments table current. Risk Engine reads from this table via Redis.
```

### MCX Commodity Guards

```
Physical Delivery Block (HARD — cannot be overridden):
  MCX commodities have physical delivery obligation if held to expiry.
  Gold, Silver, Copper → physical delivery.
  Crude Oil, Natural Gas → cash settled (but still risky near expiry).

  Rule: If futures contract expires in <= 3 days:
    → BLOCK ALL NEW ENTRIES for this symbol
    → If position already open: FORCE EXIT at market immediately
    → This is not configurable. No override. Physical delivery is real financial risk.

Evening Session Guard:
  MCX trades until 23:30 IST.
  Risk Engine must check MCX market hours separately from NSE.
  ForcedExitTime for MCX = 23:00 IST (30 minutes before close, to avoid last-minute volatility)

  The CommodityModule.ForcedExitTime() returns 23:00 IST.
  Core's MIS squareoff goroutine checks this per segment.

INR/USD Exposure Check:
  Crude Oil and Natural Gas prices in USD, settled in INR.
  If USD/INR rate has moved > 1% intraday: log WARNING (not a block).
  Large INR moves can affect P&L significantly for commodities.
```

---

## MIS Auto-Squareoff (Intraday Protection)

Applies to all MIS (intraday) positions across NSE EQ, NSE F&O.
MCX uses a different forced exit time (23:00 IST).

```
Squareoff Goroutine (runs inside Core):

  Every minute from 15:00 IST:
    Check all open MIS positions
    If time >= 15:10 IST AND position.order_product == "MIS":
      → Emit warning: MIS_SQUAREOFF_APPROACHING (5 minutes warning)

  At 15:15 IST exactly:
    For ALL open MIS positions (NSE EQ, NSE F&O):
      → Emit emergency close OrderIntent
      → Mark as: FORCED_EXIT reason = MIS_SQUAREOFF
      → Do NOT wait for signals. Close unconditionally.

  Why 15:15 and not 15:25 (Zerodha's actual cutoff)?
    Zerodha squares off MIS at 15:20-15:25 at market prices.
    By closing at 15:15 we get cleaner fills and avoid the
    end-of-day rush when everyone else is also being squared off.
    Slippage at 15:15 is significantly lower than at 15:25.

  After squareoff:
    → All MIS positions closed
    → No new MIS orders accepted until next session
    → NRML positions are unaffected
```

---

## Correlation Monitoring

```
Correlation between strategies is monitored to detect over-concentration.

Calculation:
  Every 30 minutes (part of Portfolio Risk Monitor):
    For each pair of active strategies:
      Calculate Pearson correlation of their daily P&L series (last 20 trading days)
      Store in Redis: risk:correlation:{strat_a}:{strat_b}

Thresholds:
  Correlation > 0.70:
    → WARNING: STRATEGY_CORRELATION_HIGH
    → Log: "Strategy A and B are highly correlated (r=0.82)"
    → Recommendation: reduce one strategy's allocation
    → NOT a hard block (allocator handles this via ALLOCATOR_SPEC.md correlations)

  Correlation > 0.90:
    → ALERT: STRATEGY_CORRELATION_CRITICAL
    → Reduce both strategies' risk multiplier to 0.5
    → They are effectively the same strategy — no diversification benefit

Note: Correlation monitoring requires 20 days of strategy P&L history.
      New strategies (< 20 days) skip correlation monitoring.
      Correlation is strategy P&L correlation, not price correlation.
```

---

## Risk Events Published

All state changes and threshold crossings are published to `events.risk` (Pub/Sub).
DB Writer persists to PostgreSQL `risk_events` table.

```
Event types:

KILL_SWITCH_ESCALATED      Level changed from N to N+1
KILL_SWITCH_RESET          Level manually reset
DAILY_LOSS_APPROACHING     90% of daily limit used (warning)
DAILY_LOSS_REACHED         Daily limit hit, all new trades blocked
STRATEGY_HALTED            Individual strategy halted by risk rules
STRATEGY_RESTARTED         Halted strategy manually restarted
MARGIN_WARNING             Margin utilisation > 70%
MARGIN_CRITICAL            Margin utilisation > 80%
CORRELATION_WARNING        Strategy pair correlation > 0.70
CORRELATION_CRITICAL       Strategy pair correlation > 0.90
MCX_DELIVERY_FORCE_EXIT    MCX position closed due to delivery proximity
MIS_SQUAREOFF              End-of-day MIS forced close
RISK_STATE_STALE           Risk monitor failed to update within 5 minutes
CONSECUTIVE_LOSS_PENALTY   Risk multiplier reduced due to consecutive losses
REGIME_CHANGE              Market regime changed (trending ↔ ranging ↔ high_vol)
```

---

## Risk Configuration

Per-deployment defaults. Configurable via environment variables.

```yaml
risk:
  # Portfolio level
  daily_loss_limit_inr: 18000
  max_margin_utilisation_pct: 80.0
  kill_switch:
    level1_dd_pct: 8.0
    level2_dd_pct: 12.0
    level3_dd_pct: 15.0
    level1_reset_dd_pct: 5.0

  # Trade level
  base_risk_per_trade_pct: 2.0
  min_risk_per_trade_pct: 0.5
  consecutive_loss_thresholds:
    - losses: 3
      multiplier: 0.75
    - losses: 5
      multiplier: 0.5

  # Strategy level
  strategy_dd_warning_pct: 15.0
  strategy_dd_critical_pct: 20.0
  strategy_dd_halt_pct: 25.0
  strategy_consecutive_halt: 5

  # India guards
  mfis_squareoff_time_ist: "15:15"
  mcx_forced_exit_time_ist: "23:00"
  mcx_delivery_block_days: 3

  # Monitoring
  risk_state_update_interval_sec: 30
  risk_state_stale_threshold_sec: 300
  correlation_recalc_interval_min: 30
  correlation_warning_threshold: 0.70
  correlation_critical_threshold: 0.90
```

---

## Risk State at Session Start

Every trading day at 09:00 IST, before market opens:

```
1. Reset daily metrics:
   daily_realised_pnl = 0
   daily_trades = 0
   pct_of_limit_used = 0

2. Carry forward:
   kill_switch.level       (Level 2, 3, 4 persist across days — manual reset required)
   strategy.status         (STRATEGY_HALTED persists until manual restart)
   strategy.dd_from_peak   (drawdown is from peak since strategy was last started)

3. Refresh margin data:
   Fetch latest SPAN margins from instruments_india table
   Update Redis with new margin requirements

4. Refresh regime:
   Calculate overnight ADX on Nifty-I daily data
   Check India VIX opening level
   Set initial regime for the day

5. Verify broker session:
   Confirm Zerodha access token is valid (refreshed by auth job at 08:30)
   If invalid: alert operator, block all live trades until token refreshed

6. Publish events.risk: SESSION_START
```

---

## Pre-Trade Filter Engines (Summary)

Three additional filter engines run between strategy selection and the Risk Check Gate.
Full specification in `RR_ENGINE_SPEC.md`. Summary here for completeness:

```
[1] Economic Event Filter
    Blocks entries when a scheduled high-impact event is within buffer window.
    Events: RBI MPC, Union Budget, FOMC, US CPI, NSE rebalance.
    Buffer: 30 min pre-event, 15 min post-event (wider for EXTREME events).
    Rejection: EVENT_TOO_CLOSE | POST_EVENT_COOLDOWN

[2] R:R Engine
    Calculates stop price (ATR-based or fixed %) and target price.
    Computes R:R ratio = reward / risk.
    Rejects trade if ratio < min_rr_ratio (default 1.5, configurable per strategy type).
    Rejection: RR_BELOW_THRESHOLD
    Output: stop_price, target_price → used for initial stop placement at entry

[3] Portfolio Heat Check
    Calculates total capital at risk across ALL open positions.
    heat = Σ(position risks) / account_equity × 100
    Rejects if projected heat > max_heat_pct (default 6%).
    Attempts lot reduction before full rejection.
    Rejection: PORTFOLIO_HEAT_EXCEEDED | HEAT_CAP_SIZE_REDUCED (warning + size reduction)

Complete pre-trade pipeline order:
  1. Economic Event Filter   (before signal is even scored)
  2. Strategy Selection      (composite scoring)
  3. R:R Engine              (stop/target calculation + ratio gate)
  4. Portfolio Heat Check    (total exposure check)
  5. Risk Check Gate         (this file — daily limit, margin, kill switch)
  6. Order Validation        (segment module — expiry, delivery, circuits)
```

See RR_ENGINE_SPEC.md for configuration, rejection context schemas, and processing budget.

---

*Next: SCORING_ENGINE.md — composite strategy scoring, edge cases, inter-strategy selection.*

