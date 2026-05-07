# Learning Roadmap: Financial Markets for Strategy Building

Before you code or build strategies, you need foundational knowledge about markets. This roadmap is **not optional**—strategies built without this foundation will fail.

## Timeline: 2-3 Months of Active Learning

**Goal:** Understand *why* markets move, *how* to measure it, and *what* patterns matter.

---

## Phase 1: Market Fundamentals (2-3 weeks)

### 1.1 How Markets Work

**What to learn:**
- What is a stock? What is a share?
- Market structure: exchanges, brokers, order types
- Price discovery: bid, ask, spread
- Volume, liquidity, market hours

**Resources:**
- Investopedia: "Stock Market Basics" series
- Khan Academy: "Finance and Capital Markets" (first 3 hours)
- Book: *The Intelligent Investor* by Benjamin Graham (Chapter 1-2 only)

**Key concepts to understand:**
```
Bid: $150.00 (buyer willing to pay)
Ask: $150.10 (seller willing to sell)
Spread: $0.10 (profit for broker/market maker)

Volume: 10M shares traded today
Liquidity: How easy to enter/exit
Order types: Market (instant), Limit (wait for price)
```

**Time investment:** 6 hours  
**Quiz yourself:** Can you explain bid-ask spread to a friend?

---

### 1.2 Equities Basics

**What to learn:**
- Stock splits, dividends, adjustments
- Market cap, P/E ratio, earnings
- Bull markets vs. bear markets
- Common pitfalls for retail traders

**Resources:**
- Investopedia: "How to Read Stock Charts"
- YouTube: "Stock Market for Beginners" (Pick a 20-min video)
- Paper: *A Random Walk Down Wall Street* by Burton Malkiel (Chapters 1-3)

**Time investment:** 4 hours  
**Quiz yourself:** What's the difference between market cap and stock price?

---

### 1.3 Forex Basics (If Trading Forex)

**What to learn:**
- Currency pairs: what EURUSD means
- Pips, lots, leverage
- 24/5 trading, no centralized exchange
- Cross-rate relationships

**Resources:**
- OANDA Academy: Forex 101 (free, 2 hours)
- Investopedia: "Currency Pairs Explained"

**Key concepts:**
```
EURUSD = 1.1050 (1 EUR = 1.1050 USD)
Pip = 0.0001 (smallest unit)
Micro lot = 1,000 units
Leverage = 10x (control $100k with $10k)
Margin = Collateral required to trade
```

**Time investment:** 3 hours  
**Quiz yourself:** What's the difference between trading stocks vs. forex?

---

## Phase 2: Technical Analysis (3-4 weeks)

### 2.1 Reading Charts

**What to learn:**
- Candlestick charts: OHLC (Open, High, Low, Close)
- Bar patterns, wicks, shadows
- Support and resistance levels
- Trends: uptrend, downtrend, range

**Resources:**
- Investopedia: "Candlestick Chart Patterns"
- YouTube: "Chart Reading 101" (1 hour)
- Book excerpt: *Technical Analysis from A to Z* by Steven Achelis (Intro only)

**Practice:**
- Look at 5-10 real stocks on TradingView (free)
- Identify: uptrends, downtrends, support levels
- Don't trade yet—just observe

**Time investment:** 5 hours  
**Quiz yourself:** Can you identify support and resistance on a chart?

---

### 2.2 Moving Averages (SMA, EMA)

**What to learn:**
- Simple Moving Average (SMA): 20, 50, 200-day
- Exponential Moving Average (EMA): weights recent data
- Crossovers: signals?
- Lag: why moving averages are behind price

**Resources:**
- Investopedia: "Moving Averages"
- YouTube: "SMA vs EMA explained" (30 min)

**Key insight:**
```
SMA(50) = average price of last 50 days
If price > SMA(50): uptrend (often)
If price < SMA(50): downtrend (often)
But: moving averages lag price changes
```

**Practice:**
- Plot 20, 50, 200-day moving averages on charts
- Notice: lagging effect
- Notice: false signals in choppy markets

**Time investment:** 3 hours  
**Quiz yourself:** When are moving averages useful? When do they fail?

---

### 2.3 Momentum Indicators

**What to learn:**
- RSI (Relative Strength Index): overbought/oversold
- MACD: trend + momentum
- Volume: confirmation of moves
- Why these don't predict price

**Resources:**
- Investopedia: "RSI Indicator"
- YouTube: "MACD Explained" (20 min)
- Article: "Why Indicators Fail" (search online)

**Key insight:**
```
RSI > 70 = Overbought (potential pullback)
RSI < 30 = Oversold (potential bounce)
BUT: Overbought ≠ "sell now"
And: Oversold ≠ "buy now"
Confirmation needed from price action.
```

**Practice:**
- Add RSI to your charts
- Watch for RSI extremes
- Do they lead to reversals? Not always.

**Time investment:** 4 hours  
**Quiz yourself:** What does RSI actually measure?

---

### 2.4 Volatility (Important!)

**What to learn:**
- Volatility: how much price moves
- High volatility: big swings, higher risk
- Low volatility: choppy range, less opportunity
- ATR (Average True Range): measure volatility
- Volatility regimes: calm vs. chaos

**Resources:**
- Investopedia: "Volatility"
- CBOE VIX Index: watch for 1 week
- Book excerpt: *Market Wizards* by Jack Schwager (interview on volatility)

**Key insight:**
```
High volatility:
├─ Bigger moves (+/-)
├─ Higher drawdowns
├─ Harder to time entries

Low volatility:
├─ Small moves
├─ Tight stops needed
├─ More false signals
```

**Practice:**
- Calculate 30-day volatility on 5 stocks
- Notice: volatility changes over time
- Notice: volatility spikes on bad news

**Time investment:** 3 hours  
**Quiz yourself:** How does volatility affect position sizing?

---

## Phase 3: Trading Concepts (3-4 weeks)

### 3.1 Edges and Probability

**What to learn:**
- What is an "edge"? (Positive expectancy)
- Win rate vs. risk/reward ratio
- Expected value calculation
- Luck vs. skill: sample size matters

**Resources:**
- Book: *Market Wizards* by Jack Schwager (Ch. 1-2)
- Article: "The Trader's Advantage" (search online)
- Paper: Read about "gamblers' ruin" concept

**Key insight:**
```
Win rate = 40% is fine IF risk/reward > 2:1
Example:
├─ 40% win rate
├─ Avg win: $1,000
├─ Avg loss: -$400
├─ Expected value per trade: $240 profit

This beats 60% win rate with bad R/R:
├─ 60% win rate
├─ Avg win: $500
├─ Avg loss: -$600
├─ Expected value: -$60 loss per trade
```

**Time investment:** 4 hours  
**Quiz yourself:** Why doesn't high win rate guarantee profit?

---

### 3.2 Risk Management (CRITICAL)

**What to learn:**
- Position sizing: how much to risk per trade
- Kelly Criterion: mathematical optimal sizing
- Stop losses: hard rules, not emotions
- Drawdown: worst peak-to-trough loss
- Leverage: risk amplifier

**Resources:**
- Book: *The Definitive Guide to Position Sizing* by Van Tharp
- Article: "Risk of Ruin" (search online)
- Paper: "The Kelly Criterion in Gambling and Investing"

**Key insight:**
```
Rule: Risk only 1-2% of capital per trade
Example ($100k account):
├─ 2% risk = $2,000 max loss per trade
├─ If stop loss is $1 away
├─ Position size = $2,000 / $1 = 2,000 shares

Leverage:
├─ 1x leverage: $100k controls $100k (safe)
├─ 2x leverage: $100k controls $200k (risky)
├─ 10x leverage: $100k controls $1M (very risky, forex)
```

**Time investment:** 5 hours  
**Quiz yourself:** What position size for a 2% drawdown limit?

---

### 3.3 Market Regimes

**What to learn:**
- Trending markets: work for trend followers
- Ranging markets: work for mean reversion
- Volatile markets: kill everything
- Regime changes: why strategies die
- How to detect regimes

**Resources:**
- Article: "Trading in Trending vs. Range-Bound Markets"
- YouTube: "Market Regimes Explained" (15 min)
- TradingView: Plot ADX (trend strength indicator)

**Key insight:**
```
Trending market (ADX > 25):
├─ Buy dips in uptrend
├─ Sell rallies in downtrend
├─ Moving average strategies work

Ranging market (ADX < 20):
├─ Buy support, sell resistance
├─ Mean reversion works
├─ Trend-following dies

Volatile market:
├─ Everything breaks
├─ Stop losses get hit
├─ Wide stops = bigger losses
```

**Practice:**
- Plot ADX on 5 charts
- Notice: ADX changes over time
- Notice: Strategies that work in trends fail in ranges

**Time investment:** 3 hours  
**Quiz yourself:** How would you detect current regime?

---

### 3.4 Correlation and Diversification

**What to learn:**
- Correlation: do assets move together?
- Diversification: reduce portfolio risk
- Hedging: opposite positions reduce exposure
- Correlation breakdown: when hedges fail

**Resources:**
- Investopedia: "Correlation"
- Article: "Portfolio Correlation During Crashes"
- Paper: "Diversification Doesn't Always Work" (search online)

**Key insight:**
```
Correlation = 1.0: Move perfectly together
Correlation = 0.0: No relationship
Correlation = -1.0: Move opposite

Example:
├─ AAPL + MSFT: 0.85 (high, both tech)
├─ AAPL + EWY (Korea ETF): 0.30 (low)
├─ Bonds + Stocks: Often -0.2 to 0.3 (good hedge)

But: In crashes, correlation → 1.0 (everything falls)
```

**Time investment:** 3 hours  
**Quiz yourself:** How would you check if two strategies overlap?

---

## Phase 4: Strategy Research (2-3 weeks)

### 4.1 Reading Trading Research

**What to learn:**
- How to evaluate trading papers
- Red flags: backtesting bias, overfitting
- Legitimate research: walkforward validation, out-of-sample tests
- Where to find research

**Resources:**
- SSRN.com: Free trading research papers
- Papers: Start with "Mean Reversion in Stock Prices" (Fama)
- Blog: Quantpedia.com (strategy summaries)

**Key insight:**
```
Backtested strategy on same data it was optimized on:
└─ Usually overfitted, won't work forward

Same strategy validated on new data:
└─ More trustworthy

Academic papers:
├─ Often assume zero costs
├─ Don't account for slippage
├─ Still valuable for ideas
```

**Practice:**
- Read 3 academic papers on trading
- For each: identify the edge, the validation method, potential flaws

**Time investment:** 5 hours  
**Quiz yourself:** How would you spot overfitting in research?

---

### 4.2 Common Trading Strategies

**What to learn:**
- Momentum: buy strength, sell weakness
- Mean reversion: buy weakness, sell strength
- Trend following: follow the trend
- Pair trading: long/short correlated assets
- Arbitrage: price discrepancies (hard for retail)

**Resources:**
- Book: *Algorithmic Trading* by Ernie Chan (Chapters 2-5)
- Quantpedia.com: Strategy library
- YouTube: "Trading Strategies Explained" (1-2 hours)

**Key insight:**
```
Momentum:
├─ Assumption: Winners continue winning
├─ Works in: Trending markets
├─ Breaks: When momentum fades

Mean Reversion:
├─ Assumption: Extremes revert to average
├─ Works in: Ranging markets
├─ Breaks: During trends (loses lots)

Trend Following:
├─ Assumption: Trends persist
├─ Works in: Trending markets
├─ Breaks: In ranges (whipsawed)
```

**Time investment:** 4 hours  
**Quiz yourself:** Which strategy works best in trending markets?

---

### 4.3 Pitfalls to Avoid

**What to learn:**
- Overfitting: optimizing to noise, not signal
- Survivorship bias: ignoring failed companies
- Look-ahead bias: using future data accidentally
- Curve fitting: too many parameters
- Regime change: market structure shifts

**Resources:**
- Article: "Top 10 Backtesting Mistakes"
- Paper: "Pitfalls in Algorithmic Trading"
- Book: *The Intelligent Asset Allocator* by William Bernstein (Ch. 7)

**Key insight:**
```
Overfitting example:
├─ Optimize SMA period: 10, 11, 12, 13... 100
├─ Test all on same historical data
├─ Find: period 47 has 60% win rate
├─ Go live: 30% win rate
├─ Reason: Period 47 was noise-fit, not signal

Solution:
├─ Use out-of-sample data
├─ Use walk-forward validation
├─ Keep it simple (fewer parameters)
```

**Time investment:** 3 hours  
**Quiz yourself:** How would you test if your strategy is overfit?

---

## Phase 5: Building Your First Strategy (2 weeks)

### 5.1 Strategy Idea Generation

**What to learn:**
- How to spot patterns worth testing
- Develop testable hypotheses
- Separate hunches from edge
- Validate ideas quickly

**Resources:**
- Book: *A Manual for Trading with the Odds* by Ernie Chan
- Blog posts on strategy ideas you find

**Exercise:**
```
Pick one of these and develop hypothesis:

1. "RSI < 30 often leads to bounces"
   Hypothesis: Buy RSI < 30, sell 5 bars later
   
2. "Price bounces from 50-day moving average"
   Hypothesis: Buy price 2% below SMA(50)
   
3. "High volume days lead to reversals"
   Hypothesis: Buy if volume > 2x avg, close < open

For each:
├─ Write it out clearly
├─ Identify what you'd test
├─ Note potential issues
└─ Plan validation approach
```

**Time investment:** 3 hours  
**Quiz yourself:** Can you write a clear trading hypothesis?

---

### 5.2 First Strategy: Mean Reversion (Simplest)

**Why mean reversion?**
- Easiest to understand
- Easiest to test
- Easiest to validate

**The logic:**
```
Entry:
├─ Price < SMA(50)
├─ RSI < 30
├─ Volume above average

Exit:
├─ Take profit: +2%
├─ Stop loss: -1%
├─ Time exit: 5 bars max
```

**Your task:**
1. Write this down clearly
2. In our Strategy Builder UI: drag-drop this logic
3. Backtest on AAPL 2015-2023
4. Check results (expect Sharpe 0.5-1.5)
5. Run validation (walk-forward)
6. If it survives validation: paper trade 2 weeks
7. If live results match paper: consider going live

**Time investment:** 2 hours  
**Quiz yourself:** Can you articulate your strategy in 3 sentences?

---

## Phase 6: Ongoing Learning (Concurrent)

### 6.1 Market Monitoring

While you're building:
- Watch markets daily (1 hour/day)
- Notice: How do prices move?
- Notice: What surprises you?
- Track: Your assumptions vs. reality

**Resources:**
- TradingView: Free charts
- Yahoo Finance: Free data
- CNBC: Market news

### 6.2 Reading List (Ongoing)

**Must Read (In Order):**
1. *A Random Walk Down Wall Street* by Burton Malkiel
2. *Market Wizards* by Jack Schwager
3. *The Intelligent Investor* by Benjamin Graham
4. *Fooled by Randomness* by Nassim Taleb
5. *Trading for a Living* by Alexander Elder

**Should Read:**
- *Algorithmic Trading* by Ernie Chan
- *Reminiscences of a Stock Operator* by Edwin Lefèvre
- Papers on SSRN (as interest grows)

**Time investment:** 30-60 min/week reading

---

## Summary: Knowledge Checklist

Before building your first real strategy:

- [ ] Understand bid-ask spreads, market structure
- [ ] Can read candlestick charts
- [ ] Know what moving averages do (and their lag)
- [ ] Understand RSI, MACD, volatility basics
- [ ] Can calculate position size from risk
- [ ] Know difference: trending vs. ranging markets
- [ ] Can identify support/resistance on charts
- [ ] Understand overfitting and how to test for it
- [ ] Have read at least 2 books from "Must Read" list
- [ ] Can articulate your strategy in 3 sentences

---

## Timeline Summary

```
Week 1-3:     Market fundamentals + equities basics
Week 4-7:     Technical analysis (SMA, RSI, MACD, volatility)
Week 8-10:    Risk management + market regimes
Week 11-12:   Strategy research + common patterns
Week 13-14:   Build + backtest first strategy
Ongoing:      Paper trading, live trading, learning
```

**Total time investment:** 2-3 months of active learning  
**Payoff:** You'll understand why trades fail and how to fix them

---

## Next Steps

After this learning phase:
1. Read [STRATEGY_GUIDE.md](./STRATEGY_GUIDE.md) to build in UI
2. Follow [ROADMAP.md](./ROADMAP.md) for development phases
3. Backtest rigorously before paper trading

**Remember:** No shortcuts. A trader who understands markets builds profitable strategies. A trader who doesn't understand them blows accounts.
