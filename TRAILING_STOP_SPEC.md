# Trailing Stop Specification

Design for the Trailing Stop Engine — the post-entry monitoring system
that moves stop loss orders as price moves favorably.

See EXECUTION_SPEC.md for stop loss placement at entry.
See TRADE_INTELLIGENCE_SPEC.md for how stop updates are stored.
See Zerodha_Spec.md for GTT order API details.

---

## Design Principles

1. **Stop only moves in one direction.** Toward price for a long, away from price for a short. Never widened once placed.
2. **Modification budget is finite.** Zerodha allows 25 modifications per order. Design treats this as a hard constraint, not a guideline.
3. **Only update when meaningful.** Do not modify GTT on every tick. Apply a threshold — only update when the new stop is significantly better than the current one.
4. **Runs on every tick for open positions.** Unlike strategy evaluation (bar close only), the trailing stop engine runs on every incoming tick.
5. **Configurable per strategy.** Each strategy defines its trail type and parameters in its JSON definition.

---

## Where It Runs

```
Core Binary — Post-Entry Monitor goroutine
  (separate from Symbol Engine, runs per open position)

Inputs:
  ├─ Live ticks (from symbol's tick channel — shared read, no lock needed)
  ├─ Open position state (from Redis)
  └─ Strategy trail config (from StrategyRegistry)

Outputs:
  └─ events.position_commands (Pub/Sub) → Executor updates GTT at Zerodha

Frequency: evaluates on every tick received for the symbol
           (not just on bar close — trailing stops need tick precision)
```

---

## Zerodha Order Modification Limits

From official Kite Connect documentation:

```
Per-order modification limit:  25 modifications
After 25:                       must cancel + re-place (new order, fresh 25 budget)
Modification requests:          do NOT count toward daily order limit (3000/day)
Cancel + re-place:              DOES count toward daily order limit (uses 1 order)
API rate limit:                 200 requests/minute, 10 orders/second

Implication for trailing stops:
  For a 6-hour trade on 5m candles = 72 bars.
  If we modified on every bar: 72 modifications → would hit limit in ~2 hours.
  Solution: threshold-based updates → 8-15 modifications per typical trade.
  Buffer: cancel+replace at modification 22 (not 25) → leaves 3 as safety margin.
```

---

## Modification Budget Management

```go
type StopOrderState struct {
    ZerodhaOrderID     string
    CurrentStopPrice   float64
    ModificationCount  int       // starts at 0, max 25
    LastModifiedAt     time.Time
    LastModifiedBar    int       // bar number of last modification
}

// Before each potential update:
func (s *StopOrderState) ShouldRefresh() bool {
    return s.ModificationCount >= 22  // refresh before hitting hard limit
}

// On refresh (cancel + re-place at same price):
func (s *StopOrderState) Refresh(executor Executor) error {
    err := executor.CancelOrder(s.ZerodhaOrderID)
    if err != nil { return err }
    newOrderID, err := executor.PlaceStopOrder(s.CurrentStopPrice)
    if err != nil { return err }
    s.ZerodhaOrderID = newOrderID
    s.ModificationCount = 0  // fresh budget
    log.Info("STOP_ORDER_REFRESHED", {position, old_id, new_id})
    return nil
}
```

---

## Update Threshold Policy

### Why Not Update on Every Tick

```
Without threshold — 3 problems:
  1. 25 modification budget exhausted in minutes
  2. Zerodha rate limit hit (10 requests/second)
  3. Noise: stop moves 2 points, then moves back — pointless updates

With threshold — only update when meaningful:
  Position protected just as well
  Budget used efficiently
  Fewer API calls = lower rate limit risk
```

### Threshold Rules

```
Rule 1 — Minimum price movement:
  New stop must be better than current stop by >= min_move threshold
  min_move = max(min_points_threshold, atr_fraction × ATR)
  atr_fraction default: 0.5 (half ATR must separate old and new stop)

  Example: ATR = 50 points, atr_fraction = 0.5
  min_move = 25 points
  Current stop: ₹19,300
  New stop would be: ₹19,320 (only 20 points better) → SKIP
  New stop would be: ₹19,330 (30 points better) → UPDATE

Rule 2 — Minimum bar gap:
  Never modify more than once per min_bars_between_updates bars
  default: 2 bars (10 minutes on 5m strategy)
  Guards against rapid-fire updates in volatile bars

Rule 3 — Both rules must pass:
  Price threshold AND bar gap threshold must both be satisfied.
  Either failing alone is enough to skip the update.

Rule 4 — Pre-update budget check:
  Before sending any modification:
    if modification_count >= 22: refresh first, then update
    (cancel+replace, then immediately set new stop price)
```

---

## The 6 Trail Types

### Type 1 — Fixed Percent

```
Logic:
  peak_price = highest price reached since entry (for LONG)
  stop_price = peak_price × (1 - trail_pct / 100)

Example:
  Entry: ₹19,500, trail: 1.5%
  Price rises to ₹19,800 (peak): stop = 19800 × 0.985 = ₹19,503
  Price rises to ₹20,000 (new peak): stop = 20000 × 0.985 = ₹19,700
  Price falls to ₹19,600: stop untouched at ₹19,700 (only moves up)
  Price falls to ₹19,700: STOP HIT → exit

Config:
  "trailing_stop": { "type": "fixed_pct", "trail_pct": 1.5 }

Best for: Simple strategies, equity, predictable volatility
Weakness: Same trail distance in calm and volatile markets
```

### Type 2 — Fixed Points

```
Logic:
  stop_price = peak_price - trail_points

Example:
  Entry: ₹19,500, trail: 100 points
  Peak ₹19,800: stop = ₹19,700
  Peak ₹20,000: stop = ₹19,900

Config:
  "trailing_stop": { "type": "fixed_points", "trail_points": 100 }

Best for: Instruments with stable tick sizes (F&O, commodities)
Weakness: Same fixed distance regardless of volatility regime
```

### Type 3 — ATR-Based (Recommended Default)

```
Logic:
  atr = ATR(period) from candle buffer
  stop_price = peak_price - (atr × atr_multiplier)

Example:
  Entry: ₹19,500, ATR(14) = 80, multiplier = 2.0
  Peak ₹19,800, ATR still 80: stop = 19800 - 160 = ₹19,640
  Market becomes volatile, ATR rises to 120: stop = 19800 - 240 = ₹19,560
  Note: ATR rose → stop is WIDER → protects against being stopped out by noise
  But stop still only moves UP as price rises (never down)

  New peak ₹20,100, ATR = 120: stop = 20100 - 240 = ₹19,860

Config:
  "trailing_stop": { "type": "atr_based", "atr_period": 14, "atr_multiplier": 2.0 }

Best for: All instruments — adapts automatically to volatility
Why it's the default: Wider stop in volatile conditions, tighter in calm conditions
                      Prevents noise-triggered exits while still trailing
```

### Type 4 — Moving Average

```
Logic:
  ma_value = EMA(period) or SMA(period) from candle buffer
  stop_price = ma_value  (stop IS the moving average)
  Exit when price closes BELOW the MA (for LONG)

Example:
  Entry: ₹19,500, EMA(20) = ₹19,400 at entry
  EMA rises to ₹19,700: stop is ₹19,700
  Price closes below EMA(20): → EXIT

Note: This is evaluated on BAR CLOSE, not tick level.
      Exception to the "every tick" rule — MA trail needs confirmed close.

Config:
  "trailing_stop": { "type": "moving_average", "ma_type": "EMA", "ma_period": 20 }

Best for: Trend-following strategies, capturing large moves
Weakness: MA lags price significantly, may give back too much profit
```

### Type 5 — Swing Structure

```
Logic:
  Tracks the lowest swing low (for LONG) in recent price action.
  stop_price = most_recent_swing_low - buffer_points
  Updates when a new higher swing low forms.

Swing low definition:
  A bar where: low[i] < low[i-1] AND low[i] < low[i+1]
  (lower than the bars on both sides)

Example:
  Price makes swing low at ₹19,600 → stop = ₹19,580 (20pt buffer)
  Price rallies, makes new swing low at ₹19,750 → stop = ₹19,730
  Old swing low ₹19,600 is now irrelevant (new swing low is higher)

Note: Only updates on bar close (swing detection requires completed bars)
      Less frequent updates → very budget-friendly

Config:
  "trailing_stop": {
    "type": "swing_structure",
    "lookback_bars": 5,       -- bars each side to confirm swing
    "buffer_points": 20       -- safety buffer below swing low
  }

Best for: Price action strategies, larger timeframes, position trading
```

### Type 6 — Chandelier Exit

```
Logic:
  highest_high = highest high since entry (not just peak close)
  stop_price = highest_high - (atr × chandelier_multiplier)

  The difference from ATR-based: uses highest HIGH (not close) since entry.
  This creates a wider, more forgiving trail that better captures trends.

Example:
  Entry: ₹19,500
  Highest high since entry: ₹20,200
  ATR(22) = 100, multiplier = 3.0
  stop = 20200 - 300 = ₹19,900

Config:
  "trailing_stop": {
    "type": "chandelier",
    "atr_period": 22,
    "chandelier_multiplier": 3.0
  }

Best for: Trend-following, riding large moves, avoiding premature exits
Originally popularised by Chuck LeBeau — widely used in institutional systems
```

---

## Strategy JSON Integration

Trailing stop config lives inside the strategy's `exit` section.

```json
"exit": {
  "priority_order": [
    { "type": "forced" },
    { "type": "risk_breach" },
    {
      "type": "trailing_stop",
      "config": {
        "type": "atr_based",
        "atr_period": 14,
        "atr_multiplier": 2.0,
        "min_bars_between_updates": 2,
        "atr_fraction_threshold": 0.5
      }
    },
    { "type": "take_profit", "value": 3.0, "unit": "percent" },
    { "type": "signal_exit" },
    { "type": "time_exit", "max_bars": 20 }
  ]
}
```

Note: `trailing_stop` and `stop_loss` are mutually exclusive exit types.
If `trailing_stop` is configured, a static `stop_loss` is not used.
The initial stop at entry is calculated from the trail config
(e.g., ATR-based: `entry_price - (ATR × multiplier)`).

---

## Full Lifecycle of a Trailing Stop

```
1. ENTRY FILL CONFIRMED
   Core receives events.order_results (FILLED)

2. INITIAL STOP PLACEMENT
   Core calculates initial stop:
     atr = candle_buffer.ATR(14)
     stop_price = fill_price - (atr × 2.0)  [ATR-based example]
   Core emits: events.position_commands {type: UPDATE_STOP, new_stop: stop_price}
   Executor places GTT stop order at Zerodha
   Zerodha confirms → gtt_order_id stored in Redis position state

3. TICK-BY-TICK MONITORING (Post-Entry Monitor goroutine)
   On every tick for this symbol:
     a. Update peak_price if current_price > peak_price  [for LONG]
     b. Calculate candidate new stop based on trail type
     c. Check threshold rules:
        - candidate_stop > current_stop? (never lower the stop)
        - candidate_stop - current_stop >= min_move? (meaningful improvement)
        - bars_since_last_update >= min_bars_between_updates?
     d. If all pass:
        - Check modification budget (>= 22 → refresh first)
        - Emit events.position_commands {type: UPDATE_STOP}
        - Update Redis: position.current_stop_price, modification_count

4. EXECUTOR RECEIVES POSITION COMMAND
   Reads events.position_commands
   Calls Zerodha: PUT /gtt/{gtt_id}  (modify trigger price)
   On success: emits events.order_results {type: STOP_UPDATED}
   Core updates Redis modification_count

5. STOP TRIGGERED
   Zerodha executes GTT order when price hits stop
   Fill arrives as events.order_results (entry order was the GTT trigger)
   Core receives fill → position CLOSED → exit_reason: trailing_stop

6. AUDIT
   All stop updates written to stop_updates table via DB Writer
   Final trade record written to positions table (closed)
```

---

## Paper Trader Trailing Stop

Paper trader maintains its own stop tracking in memory.
No GTT orders — stop is checked against incoming ticks directly.

```go
type PaperPosition struct {
    EntryPrice    float64
    CurrentStop   float64
    PeakPrice     float64
    TrailConfig   TrailConfig
    ModCount      int  // for parity with live, even though no real limit
}

// On each tick:
func (pp *PaperPosition) OnTick(tick Tick) *ExitSignal {
    // Update peak
    if tick.LastPrice > pp.PeakPrice {
        pp.PeakPrice = tick.LastPrice
    }

    // Check if stop triggered
    if tick.LastPrice <= pp.CurrentStop {
        return &ExitSignal{
            Reason:     "trailing_stop",
            ExitPrice:  tick.LastPrice,
        }
    }

    // Calculate and apply trail update (same logic as live)
    newStop := pp.calculateNewStop(tick)
    if pp.shouldUpdate(newStop) {
        pp.CurrentStop = newStop
        pp.ModCount++
    }
    return nil
}
```

---

## Monitoring Metrics

```
# Stop updates sent (counter)
trading_stop_updates_total{symbol, trail_type, result}
# result: SUCCESS | FAILED | REFRESHED

# Modification count distribution (histogram)
trading_stop_modification_count{strategy_id}

# Stop refreshes (cancel+replace events) (counter — alert if frequent)
trading_stop_refreshes_total{symbol}
# Frequent refreshes = trail updating too aggressively

# Stops triggered by type (counter)
trading_stop_triggered_total{exit_reason}
# exit_reason: trailing_stop | initial_stop | risk_breach
```

---

## Configuration Reference

```yaml
trailing_stop_defaults:
  atr_based:
    atr_period:              14
    atr_multiplier:          2.0
    atr_fraction_threshold:  0.5    # min 0.5× ATR move before updating
    min_bars_between_updates: 2

  fixed_pct:
    trail_pct:               1.5
    min_pct_move_threshold:  0.3    # min 0.3% improvement before updating
    min_bars_between_updates: 2

  chandelier:
    atr_period:              22
    chandelier_multiplier:   3.0
    atr_fraction_threshold:  0.5
    min_bars_between_updates: 3     # chandelier is for larger moves, less frequent

modification_budget:
  refresh_at_count:          22     # cancel+replace before hitting 25 hard limit
  hard_limit:                25     # Zerodha's enforced maximum
```
