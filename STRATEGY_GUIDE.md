# Strategy Building Guide

How to design, build, test, and deploy trading strategies.
Read LEARNING_ROADMAP.md first for market knowledge foundations.
All examples use India instruments — Nifty, BankNifty, RELIANCE, Gold.

---

## Strategy Anatomy

Every strategy has the same structure:

```
Entry Conditions → Signal Generated → Pre-Trade Filters → Order Submitted
                                           ↓
                              Position Opened (with stop + target)
                                           ↓
                         Post-Entry Monitoring (trailing stop, exit rules)
                                           ↓
                                    Position Closed → P&L recorded
```

---

## Step 1: Develop a Hypothesis

Write your hypothesis before touching the UI.

### Template

```
Name: [Strategy Name]
Instrument: [NIFTY-I / RELIANCE / GOLD-I / etc.]
Timeframe: [5m / 15m / 1h / Daily]
Market Regime: [Trending / Ranging / High Vol / Any]

Hypothesis:
"When [CONDITION], price tends to [DIRECTION],
so I will [BUY/SELL] expecting [TARGET] gain within [N bars]"

Example — Nifty Mean Reversion:
"When Nifty futures are oversold (RSI < 30) AND price is below SMA(50),
price tends to revert toward the mean,
so I will BUY 1 lot expecting +2% gain within 5 bars"

Rationale:
- Why should this work? (institutional buying at oversold levels)
- When should it fail? (strong downtrend, news event, expiry day)
- What data would prove/disprove it? (backtest 2022–2025 Nifty futures)
```

### Questions to Answer

1. **What is your edge?** Is there a reason price should move in your direction?
2. **What regime does this work in?** Mean reversion breaks in strong trends. Trend-following fails in ranging markets.
3. **When does it fail?** Every strategy fails in certain conditions. Name them before you discover them live.
4. **What is your risk?** How many ₹ can you lose per trade before the hypothesis is disproved?

---

## Step 2: Build in Strategy Builder UI

### Entry Conditions

Example — NIFTY Mean Reversion:

```
Entry Mode: AND (all conditions must be true)

Condition 1:  RSI(14) < 30          ← oversold
Condition 2:  PRICE close < SMA(50) ← price below average
Condition 3:  VOLUME > AVG_VOLUME(20) ← above average volume (confirmation)

All three must be true on the same bar close.
```

Example — EMA Crossover (Trend Following):

```
Entry Mode: AND

Condition 1:  EMA(9) crosses_above EMA(21)  ← short MA crosses above long MA
Condition 2:  ADX(14) > 20                   ← trend is strong enough to follow
```

Example — Opening Range Breakout (SCORE Mode):

```
Entry Mode: SCORE
Score Threshold: 65

Condition 1:  PRICE close > HIGH_N(2)         weight: 50  ← breaking above range
Condition 2:  VOLUME_RATIO(10) > 1.5          weight: 30  ← volume confirming
Condition 3:  SESSION_MINUTES < 60            weight: 20  ← first hour only

Score of 65+ required to enter. Allows 2/3 conditions without the timing one.
```

### Stop and Target

```
Stop — ATR-based (recommended):
  Type: ATR-based
  Period: 14
  Multiplier: 1.5
  → Stop = entry - (ATR × 1.5)
  
  Example: Entry ₹19,500, ATR = 80
  Stop = ₹19,500 - (80 × 1.5) = ₹19,380
  Risk = ₹120 per unit × 25 lots = ₹3,000

Target — R:R driven (recommended):
  Type: R:R based
  Desired R:R: 2.0
  → Target = entry + (risk × 2.0)
  
  Target = ₹19,500 + (120 × 2.0) = ₹19,740
  Reward = ₹240 per unit × 25 lots = ₹6,000
  R:R = 2.0 ✓
```

### Trailing Stop

```
ATR-based trailing stop:
  Type: ATR-based
  Period: 14
  Multiplier: 2.0
  Min bars between updates: 2
  
  On entry at ₹19,500 with stop at ₹19,380:
  Price rises to ₹19,700 (peak):
    New trail stop = ₹19,700 - (ATR × 2.0) = ₹19,700 - 160 = ₹19,540
    Old stop was ₹19,380 → move up to ₹19,540 ✓
  
  Stop can only move upward. Never back down.
```

### Exit Priority

```
Priority order (first triggered wins):
1. Forced         (MIS squareoff 15:15, expiry day, MCX delivery)
2. Risk breach    (daily loss limit, kill switch)
3. Trailing stop  (GTT at Zerodha, moves with price)
4. Take profit    (hits R:R target)
5. Signal exit    (entry conditions reverse)
6. Time exit      (max 20 bars elapsed)
```

---

## Step 3: Backtest

Set the backtest parameters:

```
Date range:  January 2022 – December 2025  (minimum 3 years)
Symbol:      NIFTY-I (continuous contract)
Timeframe:   5m
Slippage:    0.05%
Brokerage:   ₹20 per order (₹40 per round trip)
STT:         0.05% of sell turnover (F&O futures)
Initial capital: ₹5,00,000
```

**Check the results make sense:**

```
Sharpe ratio:     > 1.0              (risk-adjusted return worth the effort)
Max drawdown:     < 30%             (would you have quit at -20%? Be honest.)
Win rate:         30–70%            (outside this range = suspicious)
Profit factor:    > 1.5             (total wins / total losses)
Total trades:     > 50              (need statistical significance)
Avg R:R achieved: > 1.2             (are exits working as intended?)

Nifty mean reversion rough benchmarks:
  Win rate: 40–55% is realistic
  Avg win: ₹6,000–10,000 per trade (2–3 lots)
  Avg loss: ₹3,000–5,000 per trade
  Monthly trades: 10–25
```

**Red flags in backtest results:**

```
Win rate > 80%:   likely overfitted — too many conditions
Sharpe > 3.0:     suspicious — may be curve-fitted
< 30 trades:      not enough data to trust
Max DD = 0%:      simulation error — check code
P&L perfectly smooth: look-ahead bias in code
```

---

## Step 4: Validate

After passing backtest, run the Validation Suite:

```
Walk-Forward Analysis:
  Splits 4 years into 5 chunks
  Tests in-sample vs out-of-sample
  Example:
    Train 2022–2023, test 2023Q1 → Sharpe 1.2 vs 0.9 ✓ (OOS ≥ 70% of IS)
    Train 2022–2023H1, test 2023H2 → ...
  All 5 folds must pass

Monte Carlo (1,000 simulations):
  Randomises trade sequence and adds ±0.1% noise
  Result: "95th percentile max drawdown = 28%"
  If worst-case drawdown > 40% → CAUTION

Verdict: PASS / CAUTION / FAIL
  PASS:    proceed to paper trading
  CAUTION: review which folds failed, consider tightening rules
  FAIL:    back to Step 1 — strategy not robust
```

---

## Step 5: Paper Trading (Minimum 2 Weeks)

```
Purpose: confirm strategy works on live TrueData ticks, not just historical data

What changes from backtest:
  Ticks are messier than clean historical bars
  Slippage may differ from assumed
  TrueData occasionally sends duplicate or late ticks
  Real-world events (RBI meetings, budget) not in backtest

Watch for:
  Paper Sharpe within 20% of backtest Sharpe → acceptable
  Paper Sharpe < 50% of backtest Sharpe → investigate before going live

Paper trading P&L examples (Nifty, 1 lot, 5m):
  Good day:  3 trades, +₹6,000 net
  Bad day:   2 trades, -₹3,500 net
  Average:   1–2 trades, +₹1,500–2,500 net

After 2 weeks of paper, review:
  Was the strategy pattern actually happening in live market?
  Were signals firing at expected frequency?
  Were stop losses being hit more than expected?
```

---

## Step 6: Go Live (Small Capital First)

**Promotion checklist before switching to live:**

```
Strategy readiness:
  ✓ Passed backtest (Sharpe ≥ 1.0, DD < 30%, 50+ trades)
  ✓ Passed validation suite (PASS verdict)
  ✓ 2+ weeks paper trading with acceptable divergence
  ✓ Reviewed paper trade list manually — signals look sensible

System readiness:
  ✓ Kill switch tested (fires at correct drawdown thresholds)
  ✓ MIS squareoff tested in paper (positions close at 15:15)
  ✓ Trailing stop updating in Grafana dashboard
  ✓ Telegram alerts firing (at least one test alert received)
  ✓ Emergency stop tested (POST /emergency/stop-all in paper mode)
  ✓ Zerodha GTT order placed manually — confirmed it works

Capital for first live trade:
  Minimum: enough for 1 lot + 50% margin buffer
  Nifty (1 lot = 25 units): SPAN ~₹1,12,000 + buffer → ₹1,50,000
  BankNifty (1 lot = 15 units): SPAN ~₹50,000 + buffer → ₹75,000
  Start with 1 strategy, 1 symbol, 1 lot only
```

---

## India Strategy Examples

### Example 1 — Nifty Mean Reversion (5m, FNO)

```
Hypothesis: Nifty oversold conditions on 5m bars tend to revert within the session.

Entry (AND mode):
  RSI(14) < 30
  PRICE close < SMA(50)
  VOLUME > AVG_VOLUME(20)

Stop:  ATR(14) × 1.5 below entry
Target: 2.0 R:R from stop
Trail: ATR(14) × 2.0 chandelier exit

Risk:  1% of capital (≈ ₹5,000 on ₹5L account)
Trade window: 09:30–14:30 (avoid last hour volatility)
Avoid expiry Thursdays: YES

Typical trade:
  Entry: ₹19,500 (1 lot = 25 units)
  Stop: ₹19,380 (₹120 below, risk ₹3,000)
  Target: ₹19,740 (₹240 above, reward ₹6,000)
  R:R: 2.0
```

### Example 2 — EMA Crossover Trend (5m, FNO)

```
Entry (AND mode):
  EMA(9) crosses_above EMA(21)
  ADX(14) > 20

Stop:  ATR(14) × 1.5
Target: 2.0 R:R
Trail: ATR(14) × 2.0

Avoid: avoid_expiry_day = true
Best in: trending markets (ADX filter ensures this)
```

### Example 3 — ORB on Nifty (15m, FNO)

```
Entry (SCORE mode, threshold 65):
  PRICE close > HIGH_N(2)    weight: 50
  VOLUME_RATIO(10) > 1.5     weight: 30
  SESSION_MINUTES < 60       weight: 20

Trade window: 09:30–11:00 only
Stop: ATR(14) × 2.0 (wider stop for breakouts)
Target: 3.0 R:R (breakouts can run far)
```

### Example 4 — Donchian Breakout on Gold (1h, MCX)

```
Entry (AND mode):
  PRICE close > HIGH_N(20)   ← 20-period high breakout
  VOLUME > AVG_VOLUME(10)

Stop: ATR(14) × 2.0
Target: 3.0 R:R
MCX delivery block: 3 days before expiry (automatic)
Trade window: 09:00–22:00 (avoids last 30 min)
```

---

## Common Mistakes

```
1. Optimising exit parameters
   Don't optimise take_profit_pct or stop_loss_pct.
   They overfit immediately. Use ATR-based exits instead.

2. Ignoring lot sizes
   Nifty = 25 units per lot. BankNifty = 15. Gold = 100g.
   Position sizing must respect lot boundaries.
   Can't buy 0.5 lots.

3. Trading on expiry Thursday without testing it
   Expiry days have wildly different behaviour.
   Set avoid_expiry_day = true until you've specifically tested expiry.

4. Ignoring India VIX
   VIX > 20 changes how mean reversion strategies behave.
   The scoring engine automatically penalises mean reversion in high-VIX.
   But understand WHY before overriding.

5. Going live too fast
   Paper trading for 2 weeks feels slow.
   But 2 weeks is only ~20–30 trades for a 5m strategy.
   That's not enough to know if the strategy works.
   Run paper for a full month if possible.

6. Starting with too much capital
   1 lot of Nifty requires ~₹1.2L margin.
   Don't deploy ₹5L to a single strategy on day 1.
   Start with 1 lot, verify the system works, then scale.
```

---

## Strategy Improvement (Ongoing)

After each month of live trading, review:

```
From Grafana → Strategy Performance dashboard:
  Is live win rate within 20% of backtest win rate?
  Is average R:R achieved close to target R:R?
  Are stop losses being hit at expected frequency?
  Are trailing stops triggering too early or too late?

From Analytics → Rejection Analysis:
  What % of signals are being blocked by risk rules?
  Are any rejection reasons dominating?
  Would blocked trades have been profitable? (enrichment data)

From Trade list (manual review monthly):
  Look at the 5 worst trades — what happened?
  Look at 5 missed signals — were they good setups?
  Is the strategy misfiring on any specific day/time?
```
