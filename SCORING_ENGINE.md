# Scoring Engine Specification

Two distinct scoring problems solved here:
1. **Score Mode** — intra-strategy signal confidence (weighted conditions within one strategy)
2. **Composite Score** — inter-strategy selection (which strategy wins when multiple signal on the same bar)

See STRATEGY_SCHEMA.md for how Score Mode is defined in the strategy JSON.
See CORE_ARCHITECTURE.md for where scoring runs in the symbol engine goroutine.
See RISK_ENGINE_SPEC.md for risk checks that run after scoring.

---

## Design Principles

1. **Scoring is advisory, risk is mandatory.** A high composite score does not override a risk check failure. Scoring determines which strategy to use. Risk determines whether to trade at all.
2. **Deterministic.** Same bar data + same strategy state = same score. No randomness.
3. **Fail safe.** If any scoring component is unavailable, use defined defaults. Never block a trade silently due to a scoring infrastructure failure — use safe defaults and log a warning.
4. **Transparent.** Every score decision is logged with a full breakdown. You can always know why a strategy was selected or rejected.

---

## Score Decision Tree

The complete scoring flow on each bar close:

```
BAR CLOSES
      │
      ▼
Collect active strategies for this symbol + timeframe
      │
      ▼
Filter: allocator_weight > 0?
  NO  → SUPPRESSED (not eligible, skip)
  YES → continue
      │
      ▼
Evaluate conditions (per strategy):

  AND Mode:                        SCORE Mode:
  All conditions true?             running_score >= score_threshold?
  YES → signal_strength = 1.0     YES → signal_strength = score/max
  NO  → no signal                 NO  → Reject: SCORE_BELOW_THRESHOLD
      │                                 (stage 1 rejection)
      ▼
Any strategies signalled?
  NO  → IDLE, wait next bar
  YES → continue
      │
      ▼
For each signalling strategy, calculate composite score:

  signal_strength    × W1 (0.40)    ← how strongly did conditions fire?
  + win_rate         × W2 (0.30)    ← how has strategy performed recently?
  + allocator_weight × W3 (0.20)    ← how much capital is allocated?
  + regime_match     × W4 (0.10)    ← does regime suit this strategy type?
  = composite_score  [0.0 – 1.0]

  Fallbacks applied if any component unavailable:
    win_rate unavailable    → use backtest seed (or 0.50)
    allocator unavailable   → equal weight (1/n strategies)
    regime unavailable      → 0.50 neutral
    signal_strength = NaN   → HARD REJECT (bug alert)
      │
      ▼
Sort by composite_score descending
Winner = highest score
      │
      ▼
Winner score >= min_composite_threshold (0.60)?
  NO  → Reject: NO_STRATEGY_ABOVE_MIN
        (stage 2 rejection — log all scores)
  YES → continue
      │
      ▼
Check correlated signal cluster (informational only):
  2+ signalling strategies with correlation > 0.80?
  → Log WARNING: CORRELATED_SIGNAL_CLUSTER
  → Still trade winner (not a block)
      │
      ▼
WINNER SELECTED
  Proceed to Pre-Trade Filter Engines
  (Economic Event Filter → R:R Engine → Portfolio Heat)
```

---

## Part 1 — Score Mode (Intra-Strategy)

### What It Is

Score Mode is an alternative to AND logic within a single strategy's entry conditions.
Instead of requiring all conditions to be true simultaneously, each condition contributes
a weighted score. Entry fires when the total score meets or exceeds the threshold.

```
AND Mode (default):
  RSI < 30         → true  ✓
  Price < SMA(50)  → true  ✓
  Volume > Avg(20) → false ✗
  Result: NO SIGNAL (one condition failed)

Score Mode:
  RSI < 30         weight: 40 → met → +40
  Price < SMA(50)  weight: 35 → met → +35
  Volume > Avg(20) weight: 25 → NOT met → +0
  Total: 75 / 100 possible
  Threshold: 70
  Result: SIGNAL (75 >= 70)
```

### Why Score Mode Exists

In real markets, not every indicator aligns perfectly at once.
A strong RSI oversold reading with price well below SMA is a valid signal,
even if volume has not confirmed yet. AND mode would miss this.

Score Mode allows partial confirmation — more realistic for how traders actually think.
Conceived as "neural network layers for trading" — each condition is a weighted neuron,
the threshold is the activation function.

### Score Mode Calculation

```
For each condition node in the entry.conditions tree:
  Evaluate the condition against the candle buffer
  If condition is met:
    running_score += condition.weight
  Else:
    running_score += 0

max_possible_score = sum of all condition weights in the tree
signal_strength = running_score / max_possible_score

If running_score >= entry.score_threshold:
  signal = true
  signal_strength = running_score / max_possible_score  [0.0 to 1.0]
Else:
  signal = false
  emit Rejection: SCORE_BELOW_THRESHOLD
  include: {running_score, threshold, max_possible_score, per_condition_breakdown}
```

### Nested Conditions in Score Mode

For AND/OR parent nodes containing multiple children, the parent node's weight
is allocated based on how many children are satisfied.

```
Entry tree example:

AND (root — must be satisfied for scoring to begin)
├── Comparison: RSI < 30          weight: 40
└── OR (confirmation group)        weight: 60
    ├── Comparison: Price < SMA(50)  weight: 35
    └── Comparison: Volume > Avg(20) weight: 25

Evaluation — all met:
  RSI < 30: true → +40
  OR group: Price true OR Volume true → OR is true → full weight: +60
  Total: 100 / 100

Evaluation — volume missing:
  RSI < 30: true → +40
  OR group: Price true → OR still true → +60
  Total: 100 / 100 (OR only needs one child)

Evaluation — price and volume both missing:
  RSI < 30: true → +40
  OR group: both false → OR is false → +0
  Total: 40 / 100 (below threshold of 70) → NO SIGNAL
```

### Score Mode Validation (at Strategy Load)

```
Validated when strategy is compiled into Core:

  Rule 1 — All weights must be > 0:
    Any condition with weight = 0 → reject: INVALID_SCORE_WEIGHT

  Rule 2 — score_threshold must be <= max_possible_score:
    If threshold > max_possible_score: strategy can never trigger → reject

  Rule 3 — score_threshold floor warning:
    If score_threshold < max_possible_score × 0.40:
      Log WARNING: SCORE_THRESHOLD_LOW
      Do not reject — warn only. Operator may intentionally want a low threshold.

  Rule 4 — Dominant condition warning:
    If any single condition weight > max_possible_score × 0.70:
      Log WARNING: DOMINANT_CONDITION
      The strategy is effectively AND mode with a weak secondary condition.
      Not invalid — just worth knowing.
```

---

## Part 2 — Composite Score (Inter-Strategy Selection)

### When It Runs

After condition evaluation, if multiple strategies signal on the same symbol +
timeframe + bar close, the Composite Score determines which one to trade.

```
Bar closes — NIFTY-I, 5m, 09:20

Active strategies on NIFTY-I/5m:
  Strategy A: Mean Reversion v1.1  → signal_strength = 1.0  (AND, all met)
  Strategy B: Supertrend v2.0      → signal_strength = 0.78  (Score, 78/100)
  Strategy C: ORB v1.0             → no signal (conditions not met — excluded)

Composite Score calculated for A and B only.
Winner selected. C is ignored.
```

### The Four Components

```
Composite Score =
  (Signal Strength    × W1) +
  (Recent Win Rate    × W2) +
  (Allocator Weight   × W3) +
  (Regime Match       × W4)

Default weights: W1=0.40, W2=0.30, W3=0.20, W4=0.10
Sum must equal 1.0. Normalised automatically if not (see Edge Case 8).
```

---

### Component 1 — Signal Strength (W1 = 0.40)

```
AND mode:   all conditions met → 1.0  (binary)
Score mode: running_score / max_possible_score

Range: [0.0, 1.0]
Always available. No fallback needed.
```

---

### Component 2 — Recent Win Rate (W2 = 0.30)

Win rate of this strategy over its last N completed trades (paper + live combined).

#### Base Calculation

```
rolling_window = 50 trades (configurable)
win_rate = profitable_trades_in_window / total_trades_in_window
"Profitable" = net_pnl_inr > 0 after brokerage and STT
```

#### Laplace Smoothing (Small Sample Fix)

```
Raw 3 wins from 3 trades = 100%. Statistically meaningless.

Smoothed rate (applied when total_trades < 20):
  α = 5
  smoothed_wr = (wins + α) / (total_trades + 2α)

  3W, 0L:   (3+5)/(3+10)   = 0.615   not 1.0
  10W, 5L:  (10+5)/(15+10) = 0.600
  20W, 15L: (20+5)/(35+10) = 0.556   converging
  50W, 30L: raw = 0.625 (smoothing not applied, total >= 20)
```

#### Cold Start Seeding

```
New strategy — 0 trades. Win rate undefined.

Initial seed = backtest_win_rate (from strategy.backtest_results)
If no backtest: seed = 0.50 (neutral prior) + log WARNING: NO_BACKTEST_SEED

Decay toward actual over first 30 live trades:
  n = completed live trades (0 to 30)
  effective_wr = (backtest_wr × (30 - n) + actual_wr × n) / 30

At n=0:  100% backtest seed
At n=15: 50% backtest, 50% actual
At n=30: 100% actual (with smoothing if < 20 trades)
```

#### Stale Data Guard

```
Only trades from last 90 days count toward win rate.
Trades older than 90 days are excluded.

If < 5 trades in 90-day window:
  Fall back to smoothed rate with seed prior
  Log INFO: WIN_RATE_WINDOW_SPARSE
```

---

### Component 3 — Allocator Weight (W3 = 0.20)

```
Source: Redis state:risk (written daily by Allocator at 18:30)
Value:  fraction of portfolio allocated to this strategy (0.0 to 1.0)

Normalised for scoring:
  normalised = strategy_weight / max_weight_across_active_strategies

  Strategy A: weight 0.30, max = 0.40 → normalised = 0.75
  Strategy B: weight 0.40, max = 0.40 → normalised = 1.00
  Strategy C: weight 0.00             → SUPPRESSED (see Edge Case 4)

Fallback (weights unavailable):
  Use equal weight: 1.0 / n_active_strategies
  Log WARNING: ALLOCATOR_WEIGHTS_UNAVAILABLE
```

---

### Component 4 — Regime Match (W4 = 0.10)

How well the current market regime suits this strategy's type.

#### Regime Classification

```
Source: Redis state:risk.regime (updated every 30 min by Portfolio Risk Monitor)

TRENDING:   ADX(14) Nifty-I 5m > 25
RANGING:    ADX(14) Nifty-I 5m < 20
HIGH_VOL:   India VIX > 20          (overrides TRENDING/RANGING)
NORMAL:     ADX 20-25, VIX <= 20    (transitional)
```

#### Match Scores by Strategy Type

```
Strategy Type       TRENDING   RANGING   HIGH_VOL   NORMAL
────────────────────────────────────────────────────────────
trend_following      1.00       0.20       0.60       0.70
mean_reversion       0.20       1.00       0.30       0.70
breakout             0.80       0.30       0.90       0.60
momentum             0.90       0.20       0.60       0.70
volatility_squeeze   0.50       0.70       0.90       0.60

strategy_type is set in strategy JSON: execution.strategy_type
Default if not set: momentum (conservative assumption)
```

#### Regime Fallback

```
If regime data unavailable or stale > 30 min:
  regime_match = 0.50 (neutral — no boost, no penalty)
  Log WARNING: REGIME_DATA_UNAVAILABLE
  Do NOT block trade.
```

---

### Full Calculation Example

```
NIFTY-I / 5m / 09:20 bar close

Strategy A — Mean Reversion v1.1:
  Signal strength:   1.0   (AND mode, all conditions met)
  Win rate:          0.62  (31/50 trades, raw — >= 20 trades)
  Alloc weight:      0.75  (0.30 / 0.40 normalised)
  Regime match:      0.20  (TRENDING, mean_reversion type)

  Score = (1.0×0.40) + (0.62×0.30) + (0.75×0.20) + (0.20×0.10)
        = 0.400 + 0.186 + 0.150 + 0.020
        = 0.756

Strategy B — Supertrend v2.0:
  Signal strength:   0.78  (78/100, Score mode)
  Win rate:          0.53  (smoothed: (8+5)/(15+10) = 0.520, < 20 trades)
  Alloc weight:      1.00  (0.40 / 0.40 normalised)
  Regime match:      1.00  (TRENDING, trend_following type)

  Score = (0.78×0.40) + (0.52×0.30) + (1.0×0.20) + (1.0×0.10)
        = 0.312 + 0.156 + 0.200 + 0.100
        = 0.768

Winner: Strategy B (0.768 > 0.756)
Min threshold check: 0.768 >= 0.60 ✓ → proceed to risk check
```

---

## Edge Case Handling — All 12 Cases

### 1 — Cold Start (Zero Trades)
Seed from backtest win rate. Decay to actual over 30 live trades. Covered above.

### 2 — Small Sample Bias
Laplace smoothing (α=5) when total_trades < 20. Covered above.

### 3 — Regime Change Mid-Session

```
Regime re-evaluated every 30 minutes. Redis updated immediately.
Next composite score calculation uses updated regime automatically.
Running open position is NOT affected — locked to entry-time strategy.
No special handling needed. The component naturally self-updates.
```

### 4 — Strategy Allocator Weight = 0

```
Hard rule: If allocator_weight = 0 → strategy is SUPPRESSED.
No signal evaluation. No composite score. Excluded from selection pool.
Check happens in StrategyRegistry.GetForSymbol() before any scoring.
Log: STRATEGY_SUPPRESSED {strategy_id, reason: allocator_weight_zero}
```

### 5 — Only One Strategy Signals, Below Threshold

```
Single strategy scores 0.45. Threshold = 0.60.
Decision: DO NOT TRADE.

Threshold is absolute. Not relative to competition.
Sitting out is a valid outcome.
Emit Rejection: NO_STRATEGY_ABOVE_MIN
{best_score: 0.45, threshold: 0.60, strategy_id: "strat_a"}
```

### 6 — Multiple Strategies Signal (Correlation Risk)

```
3 strategies signal on same bar.
Pick highest composite score (normal path).

Additional check:
If >= 2 signalling strategies have P&L correlation > 0.80:
  Log WARNING: CORRELATED_SIGNAL_CLUSTER
  {strategies: ["A","B"], correlation: 0.83}
Still trade the winner. Warning is for post-hoc review only.
Allocator handles long-term concentration via its correlation penalties.
```

### 7 — Scoring Component Returns Invalid Value

```
signal_strength = NaN or Inf:
  → HARD REJECT: INVALID_SIGNAL_STRENGTH (this is a bug, alert immediately)

win_rate unavailable:
  → Use cold start seed (backtest win rate or 0.50)
  → Log WARNING: WIN_RATE_UNAVAILABLE_USING_SEED

allocator_weight unavailable:
  → Use equal weight (1/n strategies)
  → Log WARNING: ALLOCATOR_WEIGHTS_UNAVAILABLE

regime_match unavailable:
  → Use 0.50 (neutral)
  → Log WARNING: REGIME_DATA_UNAVAILABLE

Rule: Only signal_strength = NaN/Inf is a hard reject.
      All other component failures use safe defaults + warning log.
      Trade is never silently blocked due to scoring infrastructure failure.
```

### 8 — Score Weights Don't Sum to 1.0

```
Config: W1=0.50, W2=0.40, W3=0.30 → sum = 1.20

On config load:
  Normalise: Wi = Wi / sum(all weights)
  W1 = 0.417, W2 = 0.333, W3 = 0.250, W4 = 0.000
  Log WARNING: SCORE_WEIGHTS_NORMALISED {original, normalised}

Never silently accept invalid weights.
Always log normalisation so operator sees the effective weights being used.
```

### 9 — Stale Win Rate

```
90-day rolling window. Trades older than 90 days excluded.
If < 5 trades in window: fall back to smoothed prior.
Covered in Component 2 above.
```

### 10 — Min Composite Threshold Too Low

```
Threshold floor: 0.40. Cannot be set below this.

On config load:
  If min_composite_threshold < 0.40:
    Override to 0.40
    Log WARNING: THRESHOLD_FLOOR_APPLIED {original: 0.20, effective: 0.40}

Config is not hidden. Override is logged clearly.
Operator can see the floor was applied and update config if needed.
```

### 11 — Simultaneous Signals at Same Microsecond

```
Two symbol engines write to Order channel at same instant:

Different symbols: Not a problem. Order Processor handles FIFO. Both proceed.

Same symbol: Impossible by design. One goroutine owns one symbol engine.
             No concurrent writes to same symbol state. Cannot occur.
```

### 12 — High Score But Risk Check Fails

```
Strategy A scores 0.93. Daily loss limit was just hit.
Decision: RISK WINS. DO NOT TRADE.

Scoring = which strategy to use.
Risk    = whether to trade at all.
Independent gates. Both must pass.

Do NOT cascade to Strategy B.
Do NOT lower risk threshold because strategy scored high.
Log: RISK_GATE_BLOCKED {strategy_id, composite_score: 0.93,
     risk_reason: DAILY_LOSS_LIMIT_REACHED}
```

---

## Score Decision Log

Every composite score calculation is fully logged — whether traded or not.
Published to events.signals (traded) or events.rejections (not traded).

```json
{
  "score_breakdown": {
    "signal_strength":   { "value": 1.0,  "component": 0.400 },
    "recent_win_rate":   { "raw": 0.62, "smoothed": false,
                           "trades_in_window": 50, "seeded": false,
                           "value": 0.62, "component": 0.186 },
    "allocator_weight":  { "raw": 0.30, "normalised": 0.75,
                           "value": 0.75, "component": 0.150 },
    "regime_match":      { "regime": "TRENDING",
                           "strategy_type": "mean_reversion",
                           "value": 0.20, "component": 0.020 },
    "composite_score":   0.756,
    "min_threshold":     0.60,
    "passed_threshold":  true,
    "weights_used":      { "W1": 0.40, "W2": 0.30, "W3": 0.20, "W4": 0.10 },
    "fallbacks_used":    [],
    "warnings":          []
  }
}
```

---

## Scoring Configuration

```yaml
scoring:
  weights:
    signal_strength:  0.40
    recent_win_rate:  0.30
    allocator_weight: 0.20
    regime_match:     0.10

  min_composite_threshold: 0.60
  threshold_floor:          0.40

  win_rate:
    rolling_window_trades:   50
    stale_window_days:       90
    sparse_threshold:         5
    laplace_alpha:            5
    cold_start_decay_trades: 30

  regime:
    recalc_interval_minutes: 30
    stale_threshold_minutes:  5

  correlation_cluster_warning: 0.80
```

---

## Promotion Transfer (Paper → Live)

```
When strategy promotes from paper to live:
  paper_win_rate → used as live win rate seed (better than backtest seed)
  paper_trade_count >= 30 → cold start decay completes immediately
  paper_trade_count < 30  → continue decay in live using paper trades as base

Transfer is automatic on STRATEGY_MODE_CHANGED event.
No manual intervention required.
```

---

*Next: STRATEGY_SCHEMA.md — strategy JSON format, AST condition tree, indicator library, Score Mode schema.*
