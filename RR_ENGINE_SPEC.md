# Pre-Trade Filter Engines

Three engines that sit between strategy selection and order emission.
Together they ensure every trade taken has sound math, clean market context,
and acceptable total portfolio risk.

```
Signal Generated + Strategy Selected
          ↓
[1] Economic Event Filter    ← Is this a dangerous time to trade?
          ↓
[2] R:R Engine               ← Does the trade math make sense?
          ↓
[3] Portfolio Heat Check     ← Can we afford this risk right now?
          ↓
Risk Check (daily limit, margin, kill switch)
          ↓
Order Intent Emitted
```

See CORE_ARCHITECTURE.md for where these run in the goroutine topology.
See EXECUTION_SPEC.md for how their rejections are captured (stages 2.1–2.3).
See RISK_ENGINE_SPEC.md for the downstream risk rules that follow.

---

## Engine 1 — Economic Event Filter

### Purpose

Avoid trading during scheduled high-volatility events where technical signals
become unreliable. These events cause price spikes unrelated to the strategy's
edge, invalidate stop placements, and cause excessive slippage.

### How It Works

```
Check runs between strategy selection and R:R engine.

1. Load today's events from Redis (loaded at session start):
   events:today:{segment}  → JSON array of events with buffer windows

2. For each relevant event:
   minutes_until = |current_time - event_time| in minutes

   If minutes_until <= pre_event_buffer:
     → Reject: EVENT_TOO_CLOSE

   minutes_since = current_time - event_time (if event already passed)
   If 0 < minutes_since <= post_event_buffer:
     → Reject: POST_EVENT_COOLDOWN

3. If no events in either window: PASS

Default buffers:
  pre_event_buffer_minutes:  30   (don't enter before event)
  post_event_buffer_minutes: 15   (let volatility settle after)

Per-strategy override in strategy JSON:
  risk.avoid_events: true          (default)
  risk.pre_event_buffer_minutes: 30
  risk.post_event_buffer_minutes: 15
  Set avoid_events: false only for strategies specifically designed
  to trade around announcements.
```

### India Event Calendar

**NSE (Equity + F&O):**

| Event | Frequency | Pre-Buffer | Post-Buffer | Impact |
|---|---|---|---|---|
| RBI MPC Policy Decision | 6×/year | 60 min | 30 min | EXTREME |
| Union Budget | Annual (Feb 1) | Full session | Full session | EXTREME |
| NSE Weekly Expiry (Thu) | Weekly | — | — | handled by avoid_expiry_day |
| Nifty50 Rebalance | 2×/year | 30 min | 30 min | HIGH |
| Stock Earnings (equity only) | Quarterly | 30 min | 30 min | HIGH |
| Ex-Dividend Date (equity) | As announced | 30 min | — | MEDIUM |

**MCX (Commodities):**

| Event | Frequency | Pre-Buffer | Post-Buffer | Impact |
|---|---|---|---|---|
| US Fed FOMC Decision | 8×/year | 60 min | 30 min | EXTREME (Gold, Crude) |
| US CPI Data Release | Monthly | 30 min | 15 min | HIGH (Gold) |
| MCX Contract Expiry | Monthly | handled by delivery block | — | HIGH |

**Budget Day special rule:**
```
Union Budget (typically Feb 1) is NOT a market holiday.
Markets open normally but volatility is extreme all day.
For strategies with avoid_events = true AND impact_level = EXTREME:
  → block entire trading session (not just 30-min window)
  → configured via: risk.avoid_budget_day = true
```

### Event Calendar Storage

```sql
CREATE TABLE market_events (
  event_id         UUID PRIMARY KEY,
  event_date       DATE NOT NULL,
  event_time_ist   TIME,
  event_type       VARCHAR(50) NOT NULL,
  segments_affected TEXT[] NOT NULL,
  symbol_specific  VARCHAR(30),
  event_name       VARCHAR(200) NOT NULL,
  impact_level     VARCHAR(10),      -- LOW | MEDIUM | HIGH | EXTREME
  pre_buffer_min   SMALLINT DEFAULT 30,
  post_buffer_min  SMALLINT DEFAULT 15,
  source           VARCHAR(50),      -- 'RBI' | 'NSE' | 'MCX' | 'FED' | 'MANUAL'
  created_at       TIMESTAMPTZ
);
CREATE INDEX ON market_events (event_date, segments_affected);
```

Redis cache key: `events:today:{segment}` — loaded at 08:30 IST, TTL 24h.

---

## Engine 2 — Risk:Reward Engine

### Purpose

Every trade must have a minimum reward:risk ratio before it is taken.
A trade where the potential gain doesn't justify the potential loss is
rejected regardless of signal strength.

This enforces the "sniper" philosophy:
```
50% win rate × 2:1 R:R  → ₹1,400 net per 10 trades (₹100 risk each)
70% win rate × 0.5:1 R:R → -₹200 net per 10 trades

Win rate alone is meaningless. R:R determines profitability.
```

### Stop Price Calculation

**Mode A — Fixed Percent**
```
stop_price = entry_price × (1 - stop_pct / 100)   [LONG]
stop_price = entry_price × (1 + stop_pct / 100)   [SHORT]

Config:  "stop": { "type": "fixed_pct", "value": 1.0 }
```

**Mode B — ATR-Based (Recommended)**
```
atr        = ATR(period) from candle buffer at bar close
stop_price = entry_price - (atr × multiplier)      [LONG]
stop_price = entry_price + (atr × multiplier)      [SHORT]

Config:  "stop": { "type": "atr_based", "period": 14, "multiplier": 1.5 }

Why ATR is better:
  Volatile market (ATR=150) → wider stop → avoids noise exits
  Calm market (ATR=40) → tighter stop → more precise trade
  Fixed % gives identical stop in both conditions — wrong both times
```

### Target Price Calculation

**Mode A — Fixed Percent**
```
target_price = entry_price × (1 + take_profit_pct / 100)   [LONG]
Config:  "target": { "type": "fixed_pct", "value": 2.0 }
```

**Mode B — R:R Driven (Recommended)**
```
risk_points  = entry_price - stop_price
target_price = entry_price + (risk_points × desired_rr)     [LONG]

Config:  "target": { "type": "rr_based", "desired_rr": 2.0 }

Why R:R-driven is better:
  The target automatically scales with the stop width.
  ATR-wide stop (300pts) → 600pt target required (at 2:1)
  ATR-tight stop (80pts) → only 160pt target needed
  R:R stays exactly 2:1 regardless of market volatility.
```

### R:R Ratio and Gate

```
rr_ratio = (target_price - entry_price) / (entry_price - stop_price)

Examples:
  Entry ₹19,500 | Stop ₹19,305 (1%) | Target ₹19,890 (2%)
  rr = 390 / 195 = 2.0 ✓

  Entry ₹19,500 | ATR stop ₹19,380 (120pts) | Target ₹19,890 (390pts)
  rr = 390 / 120 = 3.25 ✓ (excellent — wide stop still has good R:R)

  Entry ₹19,500 | ATR stop ₹19,150 (350pts) | Fixed target ₹19,700 (200pts)
  rr = 200 / 350 = 0.57 ✗ REJECTED — wide stop with small target is bad math

Minimum R:R by strategy type (configurable):
  trend_following:    2.0
  mean_reversion:     1.5   (targets are closer, acceptable)
  breakout:           2.0
  momentum:           2.0
  volatility_squeeze: 1.5
```

### Strategy JSON — Stop and Target Config

```json
"exit": {
  "stop": {
    "type": "atr_based",
    "period": 14,
    "multiplier": 1.5
  },
  "target": {
    "type": "rr_based",
    "desired_rr": 2.0
  },
  "trailing_stop": {
    "type": "atr_based",
    "atr_period": 14,
    "atr_multiplier": 2.0,
    "min_bars_between_updates": 2,
    "atr_fraction_threshold": 0.5
  },
  "priority_order": [
    { "type": "forced" },
    { "type": "risk_breach" },
    { "type": "trailing_stop" },
    { "type": "take_profit" },
    { "type": "signal_exit" },
    { "type": "time_exit", "max_bars": 20 }
  ]
}
```

Note: `trailing_stop` and static `stop_loss` are mutually exclusive.
With trailing_stop configured, the initial stop comes from `exit.stop`.
After entry fill, the Trailing Stop Engine takes over from that price.

---

## Engine 3 — Portfolio Heat Check

### Purpose

Total capital at risk across ALL open positions must stay bounded.
Six positions at 1% risk each = 6% total heat. A 7th position would push
to 7%. Heat Check enforces a ceiling on total simultaneous downside.

### Heat Calculation

```
Heat per position  = (entry_price - current_stop_price) × quantity
                   = maximum loss if this stop is hit today

Portfolio heat     = Σ(heat per open position) / account_equity × 100

New trade heat     = (new_entry - new_stop) × new_quantity / account_equity × 100

Projected heat     = portfolio_heat + new_trade_heat

If projected_heat ≤ max_heat_pct:  → PASS
If projected_heat > max_heat_pct:  → try size reduction first

Size reduction:
  max_risk_budget = (max_heat_pct - portfolio_heat) / 100 × account_equity
  max_lots        = floor(max_risk_budget / risk_per_lot)

  If max_lots ≥ 1:  → use max_lots, log: HEAT_CAP_SIZE_REDUCED
  If max_lots = 0:  → reject: PORTFOLIO_HEAT_EXCEEDED
```

### Heat Thresholds

```
Kill switch level 0 (normal):   max_heat = 6.0%
Kill switch level 1 (warning):  max_heat = 3.0%   (already drawing down, reduce exposure)
Kill switch level 2+ (reduce):  max_heat = 0.0%   (no new entries)

Defaults configurable per deployment in config YAML.
```

### Position Sizer vs Heat Check

```
Position Sizer:   sizes each trade to risk exactly X% of capital
                  (independent, per-trade)

Portfolio Heat:   checks the sum of ALL open trade risks
                  (portfolio-level)

Both are needed:
  Position Sizer correctly sizes each trade at 1% risk.
  But if you have 10 open positions, that's 10% total heat.
  Heat Check catches what Position Sizer cannot see.
```

---

## Rejection Context (All Three Engines)

All three engines emit to `events.rejections` on rejection.
Each rejection includes which engine blocked the trade and why.

**Event Filter rejection:**
```json
{
  "rejection_stage": 2,
  "rejection_reason": "EVENT_TOO_CLOSE",
  "event_context": {
    "event_name": "RBI MPC Policy Decision",
    "event_time_ist": "10:00",
    "minutes_until_event": 23,
    "pre_buffer_minutes": 60,
    "impact_level": "EXTREME"
  }
}
```

**R:R rejection:**
```json
{
  "rejection_stage": 2,
  "rejection_reason": "RR_BELOW_THRESHOLD",
  "rr_context": {
    "entry_price": 19503.50,
    "stop_price": 19153.50,
    "target_price": 19693.50,
    "risk_points": 350.0,
    "reward_points": 190.0,
    "rr_ratio": 0.54,
    "min_rr_required": 1.5,
    "stop_type": "atr_based",
    "atr_value": 116.67,
    "atr_multiplier": 3.0
  }
}
```

**Heat check rejection:**
```json
{
  "rejection_stage": 2,
  "rejection_reason": "PORTFOLIO_HEAT_EXCEEDED",
  "heat_context": {
    "current_heat_pct": 5.8,
    "new_trade_heat_pct": 0.9,
    "projected_heat_pct": 6.7,
    "max_allowed_pct": 6.0,
    "open_positions": 3,
    "size_reduction_attempted": true,
    "max_affordable_lots": 0
  }
}
```

---

## Configuration

```yaml
pre_trade_filters:
  economic_event_filter:
    enabled: true
    pre_event_buffer_minutes: 30
    post_event_buffer_minutes: 15
    rbi_mpc_pre_buffer_minutes: 60
    rbi_mpc_post_buffer_minutes: 30
    avoid_budget_day: true

  rr_engine:
    enabled: true
    min_rr_by_strategy_type:
      trend_following:    2.0
      mean_reversion:     1.5
      breakout:           2.0
      momentum:           2.0
      volatility_squeeze: 1.5
    stop_default:
      type: atr_based
      period: 14
      multiplier: 1.5
    target_default:
      type: rr_based
      desired_rr: 2.0

  portfolio_heat:
    enabled: true
    max_heat_pct: 6.0
    max_heat_by_kill_switch_level:
      0: 6.0
      1: 3.0
      2: 0.0
    allow_size_reduction: true
```

---

## Processing Budget

```
Economic Event Filter:  ~0.5ms   (Redis lookup)
R:R Engine:             ~2ms     (ATR arithmetic + ratio check)
Portfolio Heat Check:   ~1ms     (Redis read + sum)
Total added:            ~3.5ms   within 15-25ms total Core budget
```

---

*See TRAILING_STOP_SPEC.md for how stop_price and target_price from R:R Engine
initialise the trailing stop after entry confirmation.*

*See TRADE_INTELLIGENCE_SPEC.md for rejection data storage and enrichment.*
