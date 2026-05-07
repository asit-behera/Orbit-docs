# Strategy Building Guide

How to design, build, test, and deploy trading strategies. Read LEARNING_ROADMAP.md first for market knowledge.

---

## Strategy Anatomy

Every strategy has these components:

```
Entry Conditions  ──┐
                    ├─→ Signal Generated ──→ Position Sizing ──→ Order Submitted
Exit Conditions   ──┤
                    └─→ (How many shares/lots?)

Risk Rules        ──→ (Stop loss, take profit, time exit, etc.)
```

---

## Step 1: Develop a Hypothesis

**Before building anything, write your hypothesis clearly:**

### Template

```
Name: [Strategy Name]

Market Regime: [Trending / Ranging / All]

Hypothesis:
"When [CONDITION], price tends to [MOVE], 
so I will [ACTION] expecting [OUTCOME]"

Example:
"When price falls below SMA(50) AND RSI < 30,
price tends to bounce back up,
so I will BUY and hold 5 bars expecting +2% gain"

Rationale:
- Why should this work? [Explain the logic]
- When should it fail? [Identify risks]
- What data would prove/disprove it? [Testing plan]
```

### Questions to Answer

1. **What's your edge?**
   - Is this something most traders miss?
   - Or are you just jumping on a crowded trade?

2. **When does it work?**
   - Trending markets? (momentum strategies)
   - Ranging markets? (mean reversion)
   - High volatility? (breakouts)
   - Low volatility? (range trading)

3. **When does it fail?**
   - Opposite market regime?
   - After earnings? (for equities)
   - Central bank news? (for forex)
   - Market crashes? (correlation breakdown)

4. **What's your risk?**
   - How much can you lose per trade?
   - How many trades until you're confident?
   - What's the max drawdown you'll tolerate?

---

## Step 2: Build in Strategy Builder UI

### Entry Conditions

The UI shows a visual rule builder:

```
[Entry Conditions]

Condition 1:
├─ Indicator: [Price ▼]
├─ Comparison: [< ▼]  (>, <, ==, !=, >=, <=)
├─ Value: [SMA(50) ▼]
└─ [+ AND] [+ OR]

Condition 2:
├─ Indicator: [RSI ▼]
├─ Comparison: [< ▼]
├─ Value: [30]
└─ [X Remove]

Condition 3:
├─ Indicator: [Volume ▼]
├─ Comparison: [> ▼]
├─ Value: [Avg(20) ▼]
```

**Available Conditions:**
```
Price-based:
├─ Price > SMA(period)
├─ Price < Bollinger Band (upper/middle/lower)
├─ Price at 52-week high/low

Indicator-based:
├─ RSI > X or RSI < X
├─ MACD > Signal or MACD < Signal
├─ Stochastic > X

Volume-based:
├─ Volume > Avg(period)
├─ Volume spike (> 2x normal)

Time-based:
├─ Only trade 9:30-14:00 (avoid close)
├─ Skip first 30 min (avoid opening volatility)
├─ Skip days around earnings
```

**Logic:**
```
All conditions must be true (AND logic):
├─ Price < SMA(50)
├─ AND RSI < 30
├─ AND Volume > Avg(20)
└─ → ENTRY SIGNAL
```

### Exit Conditions

```
[Exit Conditions]

Exit Rule 1: Take Profit
├─ Type: [Percent ▼]  [Pips] [Amount $]
├─ Value: [2.0]
└─ Description: Exit 100% at +2%

Exit Rule 2: Stop Loss
├─ Type: [Percent ▼]
├─ Value: [1.0]
└─ Description: Exit 100% at -1%

Exit Rule 3: Time Exit
├─ Maximum hold: [5] bars/candles
└─ Exit if not already closed

Exit Rule 4 (Optional): Exit Signal
├─ Opposite of entry? [Yes/No ▼]
└─ OR: RSI > 70 (manual exit condition)
```

**Common Patterns:**
```
Simple (All or Nothing):
├─ +2% TP, -1% SL, 5-bar max

Partial Profit Taking:
├─ 50% at +2%
├─ 25% at +3%
├─ 25% trailing stop at +2%

Breakeven Stop:
├─ Move SL to entry after +1% gain
├─ Protects against losses after initial win
```

### Position Sizing

```
[Position Sizing]

Model: [Volatility-Adjusted ▼]
├─ Fixed Percentage: Risk X% per trade
├─ Volatility-Adjusted: Scale size by volatility
├─ Kelly Criterion: Mathematical optimal
├─ Risk-Based: Fix risk amount, adjust size

Configuration:
├─ Base Size: [2.0]%  (of account per trade)
├─ Lookback: [30] days (for volatility calc)
├─ Max Position: [5.0]%  (don't exceed this)
├─ Leverage (forex only): [1x ▼]

Preview:
$100k account, 15% volatility:
├─ Without adjustment: $2,000 position (2%)
├─ With adjustment: $1,200 position (1.2%, smaller due to high vol)
└─ Logic: Don't size up in volatile markets
```

**Why Position Sizing Matters:**
```
Bad sizing:
├─ Same position size regardless of risk
├─ One bad trade = massive loss
└─ Can wipe out years of profits

Good sizing:
├─ Adjust size based on stop distance
├─ Each trade risks same amount
└─ Many small losses < few big wins = profit
```

### Parameters (For Optimization)

```
[Optimizable Parameters]

Parameter 1: SMA Period
├─ Type: Integer
├─ Range: 20 to 100
├─ Step: 10
├─ Default: 50
├─ Optimizable: ✓ YES

Parameter 2: RSI Threshold
├─ Type: Integer
├─ Range: 20 to 40
├─ Step: 5
├─ Default: 30
├─ Optimizable: ✓ YES

Parameter 3: Take Profit %
├─ Type: Decimal
├─ Range: 0.5 to 5.0
├─ Step: 0.5
├─ Default: 2.0
├─ Optimizable: ☐ NO (keep fixed)

Parameter 4: Stop Loss %
├─ Type: Decimal
├─ Range: 0.5 to 2.0
├─ Step: 0.5
├─ Default: 1.0
├─ Optimizable: ☐ NO (keep fixed)
```

**Which Parameters to Optimize:**
```
GOOD (low overfitting risk):
├─ Entry indicator periods (20-100)
├─ Entry thresholds (RSI 20-40)
├─ These change gradually across regimes

BAD (high overfitting risk):
├─ Exit parameters (TP%, SL%)
├─ Hold periods (why specific 5 bars vs 6?)
├─ These often curve-fit to past data
```

---

## Step 3: Quick Backtest

### Run Initial Test

```
[Backtest Configuration]

Strategy: Mean Reversion v1
Asset: [Equities ▼]  [Forex]  [Crypto]
Symbols: [AAPL]  [+ Add more]

Data Period:
├─ From: [2015-01-01]
├─ To: [2023-12-31]

Parameters (use defaults):
├─ SMA Period: 50
├─ RSI Threshold: 30

Execution Realism:
├─ Slippage: [0.02%] [Adaptive ▼]
├─ Commission: [$1 per trade]
├─ Leverage: [1x]

[RUN BACKTEST]  (takes ~30 seconds)
```

### Interpret Results

```
[Backtest Results: Mean Reversion v1]

Key Metrics:
├─ Total Return: 47.3%
├─ Sharpe Ratio: 1.23 ← Good (>1.0)
├─ Max Drawdown: -12.4% ← Acceptable
├─ Win Rate: 52% ← Realistic (>50%)
├─ Profit Factor: 1.85 ← Good (>1.5)
└─ Trades: 247 ← Enough data

What These Mean:
├─ Sharpe 1.23: Return relative to volatility (good)
├─ Max DD -12.4%: Worst peak-to-trough loss
├─ Win rate 52%: 52% of trades profitable
├─ Profit factor 1.85: Total wins / total losses
```

**Red Flags (Don't Deploy):**
```
❌ Sharpe < 0.5  → Not enough return for risk
❌ Win Rate < 40%  → Something's wrong
❌ Max DD > 30%  → Too risky
❌ Trades < 50  → Not enough data
❌ Profit Factor < 1.2  → Barely breaking even
```

---

## Step 4: Validate (Walk-Forward + Monte Carlo)

### Run Validation

Click: [VALIDATE]

```
[Validation Running...]

Walk-Forward Analysis:
├─ Train 2015-2019, Test 2020: ✓ Complete
├─ Train 2015-2020, Test 2021: ✓ Complete
├─ Train 2015-2021, Test 2022: ✓ Complete

Monte Carlo (1000 simulations):
├─ 350/1000 sims complete

Estimated time: 3 minutes remaining
```

### Interpret Validation Results

```
[Validation Results]

Walk-Forward Degradation:
├─ Train Sharpe: 1.45 | Test Sharpe: 0.92 → -37%
├─ Train Sharpe: 1.23 | Test Sharpe: 0.58 → -53%
├─ Avg Degradation: -45%
└─ Verdict: ⚠️ HIGH OVERFITTING

What This Means:
├─ Backtest (same data): Sharpe 1.23
├─ Out-of-sample (new data): Sharpe 0.68
├─ Reason: Strategy was optimized to 2015-2019 noise
└─ Action: Too risky to trade live

Monte Carlo Robustness:
├─ Original Sharpe: 1.23
├─ MC distribution: 0.98 ± 0.35 (std dev)
├─ Percentile 5: 0.45 (worst case)
├─ Percentile 95: 1.51 (best case)
└─ Verdict: MEDIUM (drops under randomization)

Regime Analysis:
├─ Trending markets: Sharpe 1.8 ✓ GOOD
├─ Ranging markets: Sharpe 0.2 ⚠️ BAD
├─ Volatile markets: Sharpe -0.3 ❌ TERRIBLE
└─ Recommendation: Only trade in uptrends

Overall Verdict: ⚠️ CAUTION - High overfitting detected
```

### What to Do If Validation Fails

**If walk-forward shows degradation:**
```
Original hypothesis: "RSI < 30 bounces work everywhere"
Reality: "Only work in 2015-2019"

Fix options:
1. Add filter: Only trade in trending markets (ADX > 25)
2. Simplify: Remove RSI, just use price below SMA
3. Different timeframe: Try weekly instead of daily
4. Different symbol: Works on AAPL but not MSFT

Then re-validate on fresh data
```

**If regime analysis shows regime-dependency:**
```
Strategy only works in trending markets.

Fix:
├─ Calculate ADX (trend strength)
├─ Only generate signals when ADX > 25
├─ Skip signals in ranging markets

Retest → Should see more consistent OOS results
```

---

## Step 5: Paper Trading (2-4 Weeks)

### Deploy to Paper

```
[Deploy Strategy: Mean Reversion v1]

Validation Verdict: ✓ PASSED (after modifications)

Target: [☑ Paper Trading] [☐ Live Trading]

Paper Configuration:
├─ Initial Capital: [$100,000]
├─ Duration: [2 weeks]
├─ Auto-graduate to live: [Never - Manual decision]

[START PAPER TRADING]
```

### Monitor Paper Trading

```
[Paper Trading Dashboard: Mean Reversion v1]

Status: RUNNING (8 days)

Performance:
├─ Backtest Sharpe: 1.23
├─ Paper Sharpe (8d): 1.18
├─ Difference: -4% ✓ OK (within tolerance)

Backtest vs Paper Comparison:
Metric              Backtest  Paper   Diff
─────────────────────────────────
Avg slippage        $1.20     $1.08   -10%
Avg fills/day       2.3       2.1     -9%
Win rate            52%       54%     +2%
Sharpe              1.23      1.18    -4%

Status: ✓ MATCHING - Ready to review for live

Recent Trades:
2025-05-03 14:30 - BUY AAPL @ 152.30, current 152.50 (+$20)
2025-05-03 13:15 - SELL MSFT @ 310.50, closed +$120
2025-05-02 16:45 - BUY GOOGL @ 139.80, closed -$50
```

### Decision Criteria for Live

Go live only if:
```
✓ Backtest Sharpe > 1.0
✓ Paper trading running 2+ weeks
✓ Paper results within 10% of backtest
✓ No major slippage surprises
✓ You understand why trades happen
✓ You can watch it daily (first month)
✓ Risk management understood (max position, max DD)
✓ Comfortable with max loss scenario
```

---

## Step 6: Live Trading

### Deploy to Live (Small)

```
[Deploy to Live: Mean Reversion v1]

⚠️  WARNING: REAL MONEY ⚠️

Risk Acknowledgment:
☑ I understand this is real money
☑ Strategy may lose money
☑ Past performance ≠ future
☑ Max loss tolerance: $1,000

Starting Capital: [$5,000]
  ↑ Start small! Don't risk account on 1 strategy.

Position Limits:
├─ Max per trade: 2% of capital
├─ Max portfolio: 5% in any symbol
├─ Max margin used: 70%

Safety Limits:
├─ Daily loss limit: $500 (pause if hit)
├─ Drawdown limit: 10% (close half)
├─ Drawdown limit: 15% (close all)

[GO LIVE NOW]
```

### Monitor Live

```
[Live Trading: Mean Reversion v1]

Status: ✓ RUNNING (3 days)

P&L: +$340 (6.8% on $5k)

Trades Today:
├─ 14:35 - BUY AAPL @ 152.30, current 152.50 (+$20)
├─ 13:15 - SELL MSFT @ 310.50, closed +$120

Slippage Average: $1.15 (vs backtest $1.20)
Fills: All market orders filled instantly

Backtest vs Live (3-day comparison):
├─ Backtest (historical): Sharpe 1.23
├─ Live (3 days): Sharpe 1.80
├─ Note: Too early to judge, only 3 days

[PAUSE] [CLOSE POSITION] [REDUCE SIZE] [DETAILS]
```

---

## Strategy Improvement

### After 1 Month of Live Trading

Review:
```
[Review: Mean Reversion v1 - 1 Month Live]

Performance:
├─ Live P&L: +$1,240 (24.8% on $5k, annualized ~297%)
├─ Live Sharpe: 1.45 ← Exceeding backtest!
├─ Win rate: 56%
├─ Max DD: -3.2% (within tolerance)

Observations:
1. Live slippage averaged $1.08 (vs $1.20 backtest) ✓ Better
2. Fills faster than expected (market impact lower)
3. No regime surprises (stuck to uptrend)
4. Risk management worked (never hit daily loss limit)

Next Steps:
├─ Scale: Increase initial capital from $5k to $15k
├─ Add signals: Momentum in uptrend also looks good
├─ Diversify: Trade 5 stocks instead of just AAPL

OR

├─ Something Broke? Re-validate.
├─ Market changed? Run backtest on recent data.
└─ Strategy diverged? Add new signal filter.
```

---

## Common Strategy Patterns

### Pattern 1: Mean Reversion (Easiest to Build)

```
Hypothesis: Prices bounce back from extremes

Entry:
├─ Price falls below SMA(50)
├─ AND RSI < 30
├─ AND Volume above average

Exit:
├─ +2% profit
├─ -1% loss
├─ 5 bars max

Best In: Ranging, low-trending markets
Worst In: Strong uptrends
```

### Pattern 2: Momentum (Moderate Difficulty)

```
Hypothesis: Strong moves continue for a while

Entry:
├─ Price > SMA(50)
├─ AND price > 20-day high
├─ AND volume > average

Exit:
├─ +3% profit
├─ -2% loss
├─ 10 bars max

Best In: Trending, bull markets
Worst In: Choppy ranges
```

### Pattern 3: Trend Following (Hard to Get Right)

```
Hypothesis: Trends persist longer than we expect

Entry:
├─ Price breaks above 50-day high
├─ Confirmation: Volume or MACD

Exit:
├─ Trailing stop (e.g., 3% below highest price)
├─ Or: RSI extreme reversal

Best In: Strong, sustained trends
Worst In: Whipsaws in ranges
```

---

## Checklist Before Going Live

- [ ] Hypothesis is clear and testable
- [ ] Backtest passes (Sharpe > 1.0)
- [ ] Validation passes (walk-forward, MC, regimes)
- [ ] Paper trading 2+ weeks
- [ ] Paper results match backtest ± 10%
- [ ] You've read strategy rules 10 times
- [ ] You understand max loss scenario
- [ ] Position sizing rules understood
- [ ] You can check daily first month
- [ ] Emergency stops configured
- [ ] Risk limits set in platform
- [ ] Broker API working smoothly

---

## Next Steps

1. Complete learning roadmap (LEARNING_ROADMAP.md)
2. Follow development timeline (ROADMAP.md)
3. Deploy infrastructure (DEPLOYMENT.md)
4. Build first strategy using these steps
5. Validate thoroughly before live trading
