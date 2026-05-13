# Strategy Library

**Version:** 2.0  
**Last Updated:** May 2026  
**Scope:** All strategies under consideration — NSE F&O, NSE Equity, MCX Commodities  
**Status:** Reference / Design Phase

This document supersedes TRADING_STRATEGIES.md v1.0.  
It adds Indian market-specific strategies, corrects prioritisation errors,
removes strategies with weak structural edge, and adds realistic expectancy
estimates for every entry.

---

## How to Read This Document

Every strategy entry covers:

- **Core Idea** — The market behaviour being exploited
- **Structural Edge** — Why this works in Indian markets specifically (not a generic explanation)
- **Regime** — When to trade it and when to suppress it
- **Segment & Instrument** — Exactly which symbols this applies to
- **Timeframe** — Which bar interval the strategy runs on
- **Entry Conditions** — Exact, buildable rules
- **Exit Rules** — Stop loss, take profit, signal exit, time exit in priority order
- **Realistic Expectancy** — Honest estimate before backtesting
- **Score Mode Weights** — Pre-designed for when Score Mode is the entry mode
- **Indicators Required** — What must be in the system
- **Buildable Now?** — Current system compatibility
- **Known Failure Modes** — Where it breaks

**On Expectancy:**  
Every strategy includes a realistic expectancy estimate in the form:

```
Expected Win Rate:   X%
Target R:R:          X:1
Expectancy per trade: +X R  (positive = edge exists)

Expectancy = (Win Rate × Avg Win R) − (Loss Rate × Avg Loss R)
Example: 45% win rate, 2:1 R:R
= (0.45 × 2) − (0.55 × 1) = 0.90 − 0.55 = +0.35R per trade
```

A strategy is only worth building if the pre-backtest expectancy estimate is
positive AND the rationale is structural (not coincidental).

---

## Regime-Strategy Matrix

The Scoring Engine uses this matrix to apply regime match scores.
Build strategies that cover all four regime states.

```
Strategy Type       TRENDING   RANGING   HIGH_VOL   NORMAL
────────────────────────────────────────────────────────────
trend_following      1.00       0.20       0.60       0.70
mean_reversion       0.20       1.00       0.30       0.70
breakout             0.80       0.30       0.90       0.60
momentum             0.90       0.20       0.60       0.70
volatility_squeeze   0.50       0.70       0.90       0.60
```

Target coverage:
- TRENDING: 4–5 strategies (ADX Pullback, ORB, OI Continuation, Turtle, EMA Cross)
- RANGING:  3–4 strategies (VWAP Bounce, Gap Fill, RSI+BB, Rubber Band)
- HIGH_VOL: 2–3 strategies (BB Squeeze, Range Expansion, VIX Reversion)
- NORMAL:   2–3 strategies (MACD Turn, Basis Reversion, ADX Pullback)

---

## Implementation Tiers

```
Tier 1 — Build First
  Clean structural edge, fully buildable, Indian market validated in literature.

Tier 2 — Build Next
  Good edge, minor infrastructure gaps or requires more validation.

Tier 3 — After Tier 1+2 Validated
  Requires Score Mode, custom indicator, or more system maturity.

Tier 4 — Infrastructure or Phase 2
  Requires new indicators, currency feed, or options infrastructure.

FILTER — Not a standalone strategy
  Used as a condition gate inside other strategies. Never trade alone.
```

---

## Part 1: NSE F&O Strategies

Primary trading segment. Nifty-I and BankNifty-I are the core instruments.
All intraday positions use MIS product (auto-squareoff 15:15 IST).
Daily strategies use NRML product.

---

### F1 — Opening Range Breakout (ORB)

**Tier:** 1  
**Strategy Type:** breakout  
**Regime:** TRENDING / BREAKOUT  
**Instrument:** NIFTY-I, BANKNIFTY-I  
**Timeframe:** 15m  
**Trade Direction:** Both (long and short)  
**Buildable Now?** ✅ Yes — use `HIGH_N(2)` as ORB high proxy (matches bundled template T03 in STRATEGY_SCHEMA.md). No custom indicator needed.

#### Core Idea

The first 15 minutes after market open (9:15–9:30 AM IST) establish the day's
initial range as overnight positions unwind and institutional participants
establish their directional bias. A breakout above this range with volume
confirmation signals that the dominant intraday direction has been decided.
Entry after the first 15-minute bar closes.

#### Structural Edge in Indian Markets

NSE F&O has the highest liquidity in the first and last 30 minutes of the
session. Institutional order flow is heaviest at open. The first 15-minute
candle absorbs overnight news, FII activity, and SGX Nifty gaps. When price
breaks above the high of this candle, it means buyers have absorbed all the
morning's supply and are willing to pay more. The breakout reflects genuine
directional conviction, not noise. This pattern is the most consistently
documented intraday strategy for Nifty in Indian algo-trading literature.

#### Entry Conditions

```
Pre-conditions (evaluated at 9:30 AM on first 15m bar close):
├─ ORB High = High of first 15m candle (9:15–9:30)
├─ ORB Low  = Low of first 15m candle  (9:15–9:30)
├─ ORB Range = ORB High − ORB Low
├─ ORB Range must be < 0.8% of price    ← wide opens are unpredictable

LONG entry (second 15m bar or any subsequent bar within first 2 hours):
├─ Price closes above ORB High
├─ Volume on breakout bar > AVG_VOLUME(20) × 1.3   ← conviction
├─ INDIA_VIX < 20                                    ← not panic day
├─ SESSION_MINUTES < 120                             ← first 2 hours only

SHORT entry:
├─ Price closes below ORB Low
├─ Volume on breakout bar > AVG_VOLUME(20) × 1.3
├─ INDIA_VIX < 20
├─ SESSION_MINUTES < 120
```

#### Exit Rules (Priority Order)

```
1. Forced Exit        MIS squareoff 15:15 IST
2. Risk Breach        Kill switch / daily loss limit
3. Stop Loss          ATR-based: entry ± (ATR(14) × 1.5)
                      OR below/above ORB Low/High (whichever is tighter)
4. Take Profit        2× risk (R:R = 2:1 minimum)
5. Signal Exit        Price closes back inside the ORB range
6. Time Exit          If no meaningful move within 6 bars → exit
```

#### Realistic Expectancy

```
Expected Win Rate:    48–55%
Target R:R:           2:1
Expectancy per trade: +0.30 to +0.55R
Trades per day:       0–1 (does not fire every day)
Best days:            Gap-up or gap-down open followed by momentum
Worst days:           Flat open → range-bound session → whipsaw
```

#### Score Mode Weights

```
Price closes above ORB High          → 35 pts  (primary signal)
Volume > 1.3× AVG(20)               → 25 pts  (conviction)
INDIA_VIX < 15                       → 20 pts  (ideal conditions)
SESSION_MINUTES < 60                 → 20 pts  (early session premium)

Trade if total ≥ 70 pts
```

#### Known Failure Modes

- Wide ORB range (>1%) — both breakout directions are traps; skip the day
- Flat global markets + no news → ORB fires but reverses immediately
- Expiry Thursday — index can swing both directions; ORB unreliable
- India VIX above 20 — breakouts fail at higher rate in panic conditions

---

### F2 — VWAP Bounce (Mean Reversion)

**Tier:** 1 (after VWAP indicator is built)  
**Strategy Type:** mean_reversion  
**Regime:** RANGING / NORMAL  
**Instrument:** NIFTY-I, BANKNIFTY-I  
**Timeframe:** 5m  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes — VWAP is in the indicator library. Use offset syntax for deviation condition.

#### Core Idea

VWAP (Volume Weighted Average Price) is the primary institutional benchmark
for intraday execution. When price deviates significantly from VWAP and then
shows a reversal candle, the weight of institutional order flow pulls it back.
VWAP is recalculated from market open each day — it is a daily anchored
indicator, not a rolling average.

#### Structural Edge in Indian Markets

Every large institution — mutual funds, FIIs, proprietary desks — uses VWAP
as their execution benchmark. Orders are executed to achieve "VWAP or better."
When price deviates far from VWAP, it creates a mechanical pull: participants
who need to fill orders at VWAP add buying (if below) or selling (if above)
pressure. This is not a pattern — it is a structural consequence of how
institutional execution mandates work. It is the strongest intraday mean
reversion edge available on Indian index futures.

#### Entry Conditions

```
LONG (price below VWAP):
├─ PRICE close < VWAP offset: -0.5%      ← price is 0.5%+ below VWAP
│   { "indicator": "VWAP", "offset": -0.5, "offset_type": "percent" }
├─ Current bar closes above prior bar's close  ← reversal candle
├─ RSI(14) < 45                          ← confirms oversold context
├─ INDIA_VIX < 20                        ← avoid panic conditions
├─ SESSION_MINUTES between 45 and 240    ← avoid first 45m and last hour

SHORT (price above VWAP):
├─ PRICE close > VWAP offset: +0.5%
│   { "indicator": "VWAP", "offset": 0.5, "offset_type": "percent" }
├─ Current bar closes below prior bar's close
├─ RSI(14) > 55
├─ INDIA_VIX < 20
├─ SESSION_MINUTES between 45 and 240
```

#### Exit Rules

```
1. Forced Exit        15:15 IST squareoff
2. Risk Breach        Kill switch
3. Stop Loss          1× ATR(14) beyond entry in loss direction
4. Take Profit        When price crosses VWAP (the target = VWAP)
5. Signal Exit        Price extends further from VWAP (deviation widens)
6. Time Exit          8 bars max — if no reversion, thesis is wrong
```

#### Realistic Expectancy

```
Expected Win Rate:    52–60%
Target R:R:           1.5:1 (target is VWAP, stop is ATR-based)
Expectancy per trade: +0.30 to +0.50R
Trades per day:       1–3 opportunities in ranging sessions
Best sessions:        Slow, range-bound days with no major news
Worst sessions:       Trending days — VWAP continuously moves away
```

#### Score Mode Weights

```
Price deviation > 0.5% from VWAP           → 40 pts  (core condition)
  (use VWAP offset: ±0.5, offset_type: percent)
RSI confirms direction                  → 25 pts  (momentum alignment)
INDIA_VIX < 15                          → 20 pts  (low fear)
Volume below average (quiet pullback)   → 15 pts  (not aggressive selling)

Trade if total ≥ 65 pts
```

#### Known Failure Modes

- Trending days: VWAP moves continuously — deviation never reverts, stops hit repeatedly
- Major news events: Price can stay far from VWAP for the entire session
- First 45 minutes: VWAP itself is unstable early in session; deviations misleading
- BankNifty in banking crisis: VWAP deviation can extend aggressively

---

### F3 — ADX Pullback to SMA

**Tier:** 1  
**Strategy Type:** momentum  
**Regime:** TRENDING  
**Instrument:** NIFTY-I, BANKNIFTY-I, Stock Futures  
**Timeframe:** 15m  
**Trade Direction:** Long (or short in downtrend)  
**Buildable Now?** ✅ Yes

#### Core Idea

In a confirmed strong trend (ADX > 25), institutional buyers have predefined
re-entry levels — typically the 20-day or 50-day moving average. Each pullback
to the SMA during a strong trend is absorbed by this institutional buying, and
the trend resumes. Entry is taken when price touches the SMA and shows a
reversal bar, with trend strength confirmed by ADX.

#### Structural Edge in Indian Markets

Institutional mandates (mutual fund portfolios, ETF rebalancing, insurance funds)
require them to be invested in trending instruments above their moving averages.
When Nifty dips to SMA(20) in a strong uptrend, systematic buy orders from
these mandates create a floor. This is not a coincidence — it reflects the
actual portfolio management rules of the largest market participants.

#### Entry Conditions

```
LONG:
├─ ADX(14) > 25                         ← strong trend confirmed
├─ DI_PLUS > DI_MINUS                   ← bullish direction
├─ Price touches SMA(20) (within 0.3%)  ← at the mean
├─ RSI(14) between 40–55               ← pullback, not reversal
├─ Volume < AVG_VOLUME(20)             ← quiet pullback (not panic selling)
├─ Bar closes above SMA(20)            ← did not break below

SHORT (mirror conditions with DI_MINUS > DI_PLUS)
```

#### Exit Rules

```
1. Forced Exit        15:15 IST squareoff
2. Risk Breach        Kill switch
3. Stop Loss          Below SMA(50) OR ATR(14) × 1.5 below entry
4. Take Profit        Previous swing high OR 2× risk
5. Trail Stop         Move stop to SMA(20) once +2% in profit
6. Signal Exit        ADX drops below 20 (trend ending) OR DI crosses
7. Time Exit          10 bars max
```

#### Realistic Expectancy

```
Expected Win Rate:    52–60%
Target R:R:           1.8:1
Expectancy per trade: +0.35 to +0.48R
Trades per week:      2–5 (depends on trend strength)
Best conditions:      ADX > 35, clean trend with regular pullbacks
Worst conditions:     ADX declining, choppy oscillation around SMA
```

#### Score Mode Weights

```
ADX(14) > 25                           → 30 pts
DI+ > DI-                              → 20 pts
Price within 0.3% of SMA(20)           → 25 pts
RSI between 40–55                      → 15 pts
Volume < AVG(20)                       → 10 pts

Trade if total ≥ 75 pts
```

#### Known Failure Modes

- ADX is lagging — high ADX can persist into a trend reversal
- SMA(20) acts as support until it breaks; when it breaks on high volume, exit immediately
- Earnings or major events during pullback can accelerate the move — check event calendar

---

### F4 — Open Interest Buildup Continuation

**Tier:** 1  
**Strategy Type:** trend_following  
**Regime:** TRENDING  
**Instrument:** NIFTY-I, BANKNIFTY-I (F&O only — OI data not available in EQ)  
**Timeframe:** 15m  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (OI_CHANGE indicator exists in schema)

#### Core Idea

Open Interest (OI) represents the total number of outstanding futures contracts.
Rising price accompanied by rising OI indicates new money is entering the
market — participants are opening fresh long positions, not just short-covering.
This is a trend continuation signal with genuine institutional backing.
Falling OI on a price rise = short covering only = weaker signal.

#### Structural Edge in Indian Markets

OI data is publicly available and tracked obsessively by Indian institutional
traders. It is a primary confirmation tool in F&O markets. When OI rises
alongside price, it means:
- Bulls are confident enough to open new contracts (not just existing shorts closing)
- The trend has committed capital behind it
- Large traders are positioned for further movement

This is an F&O-exclusive edge — EQ strategies cannot access OI data.
Using it is a structural advantage of trading futures over equity.

#### Entry Conditions

```
LONG:
├─ Price closes above previous bar's close    ← price rising
├─ OI_CHANGE(5) > 0                          ← OI building over last 5 bars
├─ OI_CHANGE(1) > 0                          ← OI also rising on this specific bar
├─ ADX(14) > 20                              ← some trend direction present
├─ INDIA_VIX < 22                            ← not extreme fear
├─ Volume > AVG_VOLUME(10)                   ← activity confirming

SHORT (mirror — price falling, OI rising = fresh shorts being opened):
├─ Price closes below previous bar's close
├─ OI_CHANGE(5) > 0
├─ OI_CHANGE(1) > 0
├─ ADX(14) > 20
├─ INDIA_VIX < 22
```

#### Exit Rules

```
1. Forced Exit        15:15 IST squareoff
2. Risk Breach        Kill switch
3. Stop Loss          ATR(14) × 1.5 below entry
4. Take Profit        2.5× risk
5. Signal Exit        OI starts declining while price still rising
                      (=short covering, trend weakening)
6. Time Exit          8 bars max
```

#### Realistic Expectancy

```
Expected Win Rate:    50–58%
Target R:R:           2.5:1
Expectancy per trade: +0.40 to +0.60R
Trades per week:      3–6 (requires active trending sessions)
Best conditions:      Trending market with FII buying visible in OI data
Worst conditions:     Expiry week (OI artificially inflated by unwinding)
```

#### Score Mode Weights

```
Price bar closes higher                → 25 pts
OI_CHANGE(5) > 0 (trend buildup)       → 30 pts
OI_CHANGE(1) > 0 (immediate bar)       → 20 pts
ADX(14) > 25                           → 15 pts
Volume above average                   → 10 pts

Trade if total ≥ 70 pts
```

#### Known Failure Modes

- Expiry week: OI artificially moves as contracts roll — signal is unreliable in final 2 days
- OI data has a small lag on TrueData feed (~30 seconds behind price)
- Short covering rally: price rises + OI falls = NOT this setup. Check OI direction carefully.
- Short squeeze: in extreme HIGH_VOL, OI rising + price rising can be a blow-off top, not continuation

---

### F5 — Gap Fill

**Tier:** 2  
**Strategy Type:** mean_reversion  
**Regime:** RANGING / NORMAL  
**Instrument:** NIFTY-I, BANKNIFTY-I  
**Timeframe:** 5m  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes

#### Core Idea

When Nifty opens with a gap (above or below the previous session's close),
there is a mean-reversion tendency to fill that gap — partially or fully —
within the session. Gaps smaller than 1.5% have a historically high fill rate
(~70%). The logic: overnight news is frequently over-discounted at open,
and institutional participants fade the gap to achieve better execution prices.

#### Structural Edge in Indian Markets

Indian markets are heavily influenced by overnight global cues (SGX Nifty,
US markets, Asian markets). At 9:15 AM, the market gaps to price in overnight
events. However, if those events are already priced into SGX Nifty (which trades
overnight), the gap at open is often a second pricing of the same information —
meaning the open is overextended. This creates a mechanical reversion tendency.
Small gaps (< 1.5%) are especially reliable because they represent noise rather
than structural information.

#### Entry Conditions

```
Pre-condition (evaluated at 9:30 AM):
├─ Gap = Open Price − Previous Day's Close Price
├─ Gap % = Gap / Previous Close × 100
├─ |Gap %| must be between 0.3% and 1.5%  ← too small = no trade, too big = dangerous

GAP-UP FADE (short):
├─ Gap is positive (opened above previous close)
├─ First 15m candle closes below its open (bearish open)
├─ Price is below VWAP at 9:30 entry check
├─ SESSION_MINUTES < 60                   ← gap fill happens early or not at all
├─ INDIA_VIX < 18                         ← not panic conditions

GAP-DOWN FADE (long):
├─ Gap is negative (opened below previous close)
├─ First 15m candle closes above its open (bullish open)
├─ Price is above VWAP at 9:30
├─ SESSION_MINUTES < 60
├─ INDIA_VIX < 18
```

#### Exit Rules

```
1. Forced Exit        15:15 IST squareoff
2. Risk Breach        Kill switch
3. Stop Loss          If gap extends by 0.3% beyond open price
                      (gap is widening, not filling — thesis broken)
4. Take Profit        Previous close price (gap is fully filled)
   Partial TP:        50% at halfway point, 50% at full fill
5. Time Exit          If gap not 50% filled by 11:00 AM → exit (won't fill today)
```

#### Realistic Expectancy

```
Expected Win Rate:    55–65%  (best of any mean-reversion strategy here)
Target R:R:           1.5:1
Expectancy per trade: +0.40 to +0.65R
Frequency:            3–4 qualifying gap days per week
Best conditions:      0.5–1.0% gap with quiet global overnight session
Worst conditions:     Gap caused by genuine new information (RBI surprise, war event)
```

#### Score Mode Weights

```
Gap % between 0.3–1.0%                → 35 pts  (sweet spot)
First 15m bar reverses gap direction  → 30 pts  (early confirmation)
INDIA_VIX < 15                         → 20 pts  (calm conditions)
Volume below average at open           → 15 pts  (low urgency = gap fills)

Trade if total ≥ 65 pts
```

#### Known Failure Modes

- Genuine information gaps (RBI rate surprise, major geopolitical event) do not fill
- Large gaps > 1.5% have lower fill rate and larger stop required — avoid
- BankNifty on banking news: gap can extend aggressively before filling
- Avoid on expiry days — gap behavior is distorted by options unwinding

---

### F6 — India VIX Mean Reversion

**Tier:** 2  
**Strategy Type:** mean_reversion  
**Regime:** HIGH_VOL → NORMAL (transition)  
**Instrument:** NIFTY-I  
**Timeframe:** Daily  
**Trade Direction:** Long only (long Nifty when fear peaks)  
**Buildable Now?** ✅ Yes (INDIA_VIX indicator exists)

#### Core Idea

India VIX measures the expected volatility of Nifty over the next 30 days,
derived from Nifty options prices. When VIX spikes sharply and then turns
down (first declining daily bar after a spike above a threshold), it signals
that fear has peaked. Markets historically rally as volatility contracts.
This is an inverse VIX play — long the index when fear is highest and
just beginning to reverse.

#### Structural Edge in Indian Markets

Options market makers become sellers of volatility when VIX spikes — they
sell expensive options and delta-hedge by buying the underlying. This creates
mechanical buying pressure in Nifty futures when VIX reverses. Additionally,
retail participants who panic-sold at the VIX spike become reluctant buyers
as VIX falls, adding further demand. The structural sellers (options writers
hedging) and the behavioural buyers (panic fading) compound the move.

#### Entry Conditions

```
LONG:
├─ INDIA_VIX crossed above 20 in the last 5 bars     ← spike occurred
├─ INDIA_VIX today < INDIA_VIX yesterday              ← first declining bar
├─ INDIA_VIX > 18 currently                           ← still elevated (not false signal)
├─ NIFTY-I price not below SMA(200)                   ← not in structural bear market
├─ No major scheduled event in next 2 days            ← via economic event filter
```

#### Exit Rules

```
1. Risk Breach        Kill switch
2. Stop Loss          If INDIA_VIX rises further (+10% from entry day VIX)
                      OR Nifty drops below entry day's low
3. Take Profit        When INDIA_VIX returns below 16 (fear normalized)
4. Time Exit          10 trading days max — if VIX still elevated, exit
```

#### Realistic Expectancy

```
Expected Win Rate:    58–68%
Target R:R:           2:1
Expectancy per trade: +0.45 to +0.60R
Frequency:            8–15 qualifying setups per year (rare but powerful)
Best conditions:      Panic caused by global events, not domestic fundamentals
Worst conditions:     Genuine structural bear market (VIX stays high for months)
```

#### Known Failure Modes

- COVID-type events: VIX stays above 50 for weeks — multiple false signals
- Structural bear markets (2008, 2020): VIX reverts slowly, capital destroyed on early entries
- Rate decision surprises: VIX spike followed by continuation, not reversion
- Must be combined with SMA(200) filter — do not trade if Nifty is in downtrend

---

### F7 — Expiry Week Momentum

**Tier:** 3  
**Strategy Type:** momentum  
**Regime:** TRENDING  
**Instrument:** NIFTY-I (weekly expiry, specifically)  
**Timeframe:** 15m  
**Trade Direction:** Directional bias based on weekly trend  
**Buildable Now?** ✅ Yes (requires expiry-aware calendar integration)

#### Core Idea

On Tuesday and Wednesday of weekly expiry week, short sellers begin covering
their positions before Thursday's settlement. This creates systematic buying
pressure in Nifty futures. Additionally, options sellers who are profitable
from time decay defend their positions, adding to the directional momentum.
Entry is taken in the direction of the week's trend on the two days before
expiry, with reduced position size.

#### Structural Edge in Indian Markets

Indian weekly options are among the most heavily traded in the world. The
expiry-week unwinding is mechanical — short-sellers must cover by Thursday.
This is not a behavioural pattern — it is a consequence of the contract
settlement structure. The FSP (Final Settlement Price) is the average of
the index from 14:30–15:30 on Thursday, which further incentivises
participants to manage positions in the preceding two days.

#### Entry Conditions

```
Pre-condition:
├─ Today is Tuesday or Wednesday of expiry week
├─ Nifty is trending for the week (≥ 1% move from Monday's open)
├─ ADX(14) > 20 on 1-hour chart

LONG (week is up):
├─ Price > Weekly open price
├─ EMA(9) > EMA(21) on 15m
├─ OI_CHANGE(5) > 0                     ← fresh longs being added
├─ SESSION_MINUTES between 60 and 180   ← mid-morning, not open or close

SHORT (week is down): mirror conditions
```

#### Exit Rules

```
1. Forced Exit        15:15 IST squareoff each day
2. Risk Breach        Kill switch
3. Stop Loss          ATR(14) × 2 (wider stop — expiry week is volatile)
4. Take Profit        2× risk
5. Time Exit          Do not carry overnight on expiry week
```

#### Realistic Expectancy

```
Expected Win Rate:    50–58%
Target R:R:           2:1
Expectancy per trade: +0.25 to +0.40R
Frequency:            2–4 qualifying setups per month (weekly expiry)
Best conditions:      Clear trend week with strong FII positioning
Worst conditions:     Range-bound expiry week — no directional conviction
```

#### Known Failure Modes

- If the week's trend reverses sharply on Tuesday — the expiry effect reverses too
- Do NOT trade expiry Thursday itself — FSP averaging creates erratic price action
- High India VIX during expiry week amplifies both gains and losses significantly
- Budget week expiry: volatile beyond normal parameters — skip

---

### F8 — BankNifty Relative Strength vs Nifty

**Tier:** 3  
**Strategy Type:** momentum  
**Regime:** TRENDING  
**Instrument:** BANKNIFTY-I  
**Timeframe:** 15m  
**Trade Direction:** Long BankNifty when banking sector leads  
**Buildable Now?** ⚠️ Requires relative strength indicator (ratio of two symbols)

#### Core Idea

Banking is the largest sector in Nifty (30%+ weight). When BankNifty is
outperforming Nifty by a meaningful margin during the session, it reflects
genuine institutional allocation into banking — the market's most liquid
and heavily-traded sector. Long BankNifty when it is leading captures the
sector momentum with index liquidity.

#### Structural Edge in Indian Markets

FII flows into India disproportionately enter through banking stocks (most
liquid, largest market cap). When FIIs are net buyers, banking leads.
When banking leads, the Nifty tends to follow. The relationship is:
banking strength → broad market strength. Trading BankNifty directly
captures the leading sector rather than the lagging average.

#### Entry Conditions

```
Requires a cross-symbol ratio comparison (infrastructure item):
├─ BankNifty / Nifty ratio has increased by > 0.3% in current session
├─ BankNifty price > VWAP (BankNifty above institutional reference)
├─ Nifty is also positive on the day (broad market not collapsing)
├─ ADX on BankNifty > 22
├─ SESSION_MINUTES between 60 and 180
```

#### Realistic Expectancy

```
Expected Win Rate:    50–55%
Target R:R:           1.8:1
Expectancy per trade: +0.25 to +0.35R
Note: Needs cross-symbol ratio infrastructure before this is buildable
```

#### Known Failure Modes

- Banking crisis: BankNifty can lead to the downside dramatically (wider stops needed)
- RBI policy surprise: banking reacts violently before broader market catches up
- PS Bank vs private bank divergence can distort BankNifty momentum signals

---

### F9 — Futures Basis Mean Reversion

**Tier:** 3  
**Strategy Type:** mean_reversion  
**Regime:** RANGING / NORMAL  
**Instrument:** NIFTY-I  
**Timeframe:** 1h  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (BASIS indicator exists in schema)

#### Core Idea

Basis = Futures Price − Spot Price. In normal conditions, futures trade at a
small premium (contango) due to cost of carry. When basis goes abnormally wide
(futures far above spot) or negative (backwardation), arbitrageurs enter to
capture the spread — selling the expensive side and buying the cheap side.
This mechanical arbitrage pulls the basis back to fair value. The strategy
trades the basis reversion itself via the futures contract.

#### Structural Edge in Indian Markets

Cash-futures arbitrage desks at large institutions trade this constantly.
When basis deviates beyond 0.3% from theoretical fair value (cost of carry),
it represents an arbitrage opportunity that large desks exploit systematically.
Their execution creates a mechanical reversion force. The strategy rides that
institutional arbitrage execution.

#### Entry Conditions

```
LONG Futures (basis too negative — futures too cheap):
├─ BASIS < -(0.3%)                          ← futures at abnormal discount to spot
├─ BASIS has been declining for 3+ bars     ← not just one anomaly bar
├─ INDIA_VIX < 20                           ← not panic conditions
├─ Days to expiry > 5                       ← near expiry, basis behaves differently

SHORT Futures (basis too positive — futures too expensive):
├─ BASIS > 0.5%                             ← unusually wide premium
├─ BASIS has been expanding for 3+ bars
├─ INDIA_VIX < 20
├─ Days to expiry > 5
```

#### Realistic Expectancy

```
Expected Win Rate:    58–65%
Target R:R:           1.5:1
Expectancy per trade: +0.35 to +0.50R
Frequency:            Low — 2–4 qualifying setups per week
Best conditions:      Calm RANGING sessions, no major news
```

#### Known Failure Modes

- Near expiry (< 5 days), basis converges mechanically — signals unreliable
- Heavy FII buying or selling creates sustained basis deviation that does not revert quickly
- Cost of carry changes with interest rates — recalibrate fair value quarterly

---

## Part 2: NSE Equity Strategies

These strategies operate on individual large-cap NSE stocks using CNC product
(delivery, no intraday squareoff constraint). Longer hold periods (days to weeks).
Use the NSE EQ segment. Only Nifty 500 universe.

---

### E1 — 52-Week High Breakout with Volume

**Tier:** 2  
**Strategy Type:** breakout  
**Regime:** TRENDING  
**Instrument:** NSE EQ — Nifty 500 universe (large-cap only)  
**Timeframe:** Daily  
**Trade Direction:** Long only  
**Buildable Now?** ✅ Yes  
**Product:** CNC (delivery — multi-day hold)

#### Core Idea

When a stock breaks above its 52-week high on above-average volume, it enters
price discovery — there are no overhead sellers who bought at higher prices.
All historical holders are in profit. The only direction of resistance is
from new sellers entering at new highs, which tends to be lighter than the
accumulated selling pressure at prior highs.

#### Structural Edge in Indian Markets

Mutual funds and institutional investors have mandates to hold stocks in uptrends
above their 52-week highs. When a stock makes a new 52-week high, it triggers:
- Buy signals in institutional momentum screening systems
- Removal from "potential sell" watch lists (no longer underwater)
- Media attention and retail FOMO at new highs

These combine to create genuine demand. The breakout is self-reinforcing in
the short term. This has empirical backing in momentum literature (Jegadeesh
& Titman) and is specifically applicable to the Indian large-cap universe.

#### Entry Conditions

```
Daily bar conditions:
├─ Price breaks above 52W_HIGH                       ← dedicated 52-week high indicator
├─ Volume on breakout day > AVG_VOLUME(50) × 1.5    ← institutional confirmation
├─ Price > SMA(200)                                  ← in long-term uptrend
├─ ADX(14) > 20                                      ← some trend present
├─ INDIA_VIX < 20                                    ← not panic market
├─ Avoid: breakout on earnings day (event-driven, not structural)
```

#### Exit Rules

```
1. Stop Loss          Below most recent swing low OR 7% below entry
                      (whichever is tighter)
2. Take Profit        No fixed target — trail stop to capture trend
3. Trail Stop         Move to SMA(50) once +10% in profit
4. Signal Exit        ADX drops below 20 for 3 consecutive days
5. Time Exit          30 trading days max if no meaningful move
```

#### Realistic Expectancy

```
Expected Win Rate:    38–48%  (many breakouts fail — lower win rate is expected)
Target R:R:           3:1 minimum (trailing approach)
Expectancy per trade: +0.40 to +0.60R
Hold Period:          5–30 trading days
Best conditions:      Bull market phase, Nifty above SMA(200)
Worst conditions:     Bear market — 52w highs are rare and fail quickly
```

#### Score Mode Weights

```
Price breaks 52-week high                → 30 pts
Volume > 1.5× AVG(50)                    → 30 pts
Price > SMA(200)                         → 25 pts
ADX(14) > 20                             → 15 pts

Trade if total ≥ 80 pts  (strict threshold — quality over quantity)
```

#### Known Failure Modes

- Breakout in a weak broad market (Nifty in downtrend): 52w high breakouts fail at 70%+ rate
- Low-float / operator-driven stocks: volume spikes are manipulation, not institutional
- Must limit to Nifty 500 universe — smaller stocks have insufficient liquidity

---

### E2 — NR7 (Narrow Range 7) with Trend Filter

**Tier:** 2  
**Strategy Type:** breakout  
**Regime:** BREAKOUT / TRENDING  
**Instrument:** NSE EQ large-cap, NIFTY-I  
**Timeframe:** Daily  
**Trade Direction:** In direction of trend filter  
**Buildable Now?** ✅ Yes (ATR proxy)

#### Core Idea

NR7 identifies the day with the narrowest range (High − Low) over the last
7 bars. Narrow range = compressed volatility = energy coiling. The next day
or shortly after typically sees a directional expansion. The pattern does not
predict direction — it predicts expansion. The trend filter determines which
direction to trade.

#### Structural Edge

Volatility mean-reverts. After extended periods of compression, the market
resolves directionally. This principle is universal and well-documented across
decades and markets (Toby Crabel, Larry Connors). The structural reason:
participants who have been waiting for a move commit when the range finally
breaks, creating the expansion.

#### Entry Conditions

```
Daily:
├─ ATR(7) < ATR(14)                        ← volatility contracting (NR7 proxy)
├─ ATR(14) < ATR(30)                       ← broader contraction confirmed
├─ Price > SMA(50)                         ← trend filter (long bias only if above)
├─ SMA(50) slope is positive               ← uptrend context
├─ Enter on break of NR7 high next day:
    Price > (NR7 bar High + small buffer)  ← breakout trigger

SHORT version: Price < SMA(50), enter on break below NR7 Low
```

#### Exit Rules

```
1. Stop Loss          Below NR7 Low (or above NR7 High for shorts)
2. Take Profit        2× NR7 range above entry
3. Time Exit          3–4 bars max (expansion happens quickly or not at all)
4. Signal Exit        Fails to follow through on breakout bar
```

#### Realistic Expectancy

```
Expected Win Rate:    44–52%
Target R:R:           2:1
Expectancy per trade: +0.28 to +0.42R
Frequency:            2–4 setups per week across instrument universe
Best conditions:      Preceded by clear trend, NR7 is a brief pause
Worst conditions:     Sideways, directionless market — NR7 fires in both directions
```

#### Known Failure Modes

- ATR proxy is less precise than true NR7 (High-Low comparison) — occasional false reads
- In strong downtrends, NR7 from the short side produces larger, faster moves
- Multiple consecutive NR days can occur — wait for the ATR proxy to confirm

---

### E3 — RSI + Lower Bollinger Band Touch

**Tier:** 2  
**Strategy Type:** mean_reversion  
**Regime:** RANGING  
**Instrument:** NSE EQ large-cap, NIFTY-I  
**Timeframe:** Daily  
**Trade Direction:** Long only (oversold bounce)  
**Buildable Now?** ✅ Yes

#### Core Idea

When a stock touches or breaks below the lower Bollinger Band AND RSI is
simultaneously below 30, the instrument is statistically oversold on two
independent measures. The probability of a mean-reversion bounce toward
the middle band (SMA20) is elevated. This is a conservative, multi-confirmation
mean reversion setup.

#### Structural Edge

Bollinger Bands define statistically unusual price levels (2 standard deviations).
RSI below 30 confirms the sell-off has been rapid. The combination of statistical
extremity (BB) plus momentum exhaustion (RSI) creates a setup where both the
magnitude and pace of decline suggest overextension. Institutional buy programs
(portfolio rebalancing, value buyers) tend to activate at these levels.

#### Entry Conditions

```
Daily:
├─ RSI(14) < 30                             ← oversold
├─ Price closes at or below BB_LOWER(20, 2) ← statistical extreme
├─ Price > SMA(200)                         ← not in structural downtrend
├─ INDIA_VIX < 22                           ← not panic environment
├─ Volume on down day above average         ← capitulation volume is positive sign
```

#### Exit Rules

```
1. Stop Loss          3% below entry (delivery position)
2. Take Profit        Middle Bollinger Band (SMA20) — the natural mean
3. Signal Exit        RSI rises above 50 (momentum restored)
4. Time Exit          15 trading days max
```

#### Realistic Expectancy

```
Expected Win Rate:    55–65%
Target R:R:           1.5:1 (SMA20 is often close — modest targets)
Expectancy per trade: +0.35 to +0.55R
Best conditions:      Ranging market, stock in established consolidation band
Worst conditions:     Trending down: RSI < 30 can persist; BB lower can be broken repeatedly
```

#### Known Failure Modes

- BankNifty or banking stocks during RBI crisis: RSI < 30 can reach 10 and stay there
- Do NOT use in downtrending instruments where price is below SMA(200)
- Earnings miss: stock can gap down through all statistical bounds — check event calendar

---

### E4 — Rubber Band (RSI-2 Mean Reversion)

**Tier:** 2  
**Strategy Type:** mean_reversion  
**Regime:** RANGING  
**Instrument:** NSE EQ large-cap (Nifty 100 universe preferred)  
**Timeframe:** Daily  
**Trade Direction:** Long only  
**Buildable Now?** ✅ Yes (RSI period is configurable)

#### Core Idea

RSI(2) — a 2-period RSI — is extremely sensitive to short-term price moves.
When RSI(2) drops below 10, the stock has had an unusually rapid 2-day decline.
The rubber band thesis: the sharper the snap down, the sharper the rebound.
Entry is taken when RSI(2) < 10 with the stock still above SMA(200).
Exit when RSI(2) rises above 65 (normalised momentum).

#### Structural Edge

RSI(2) < 10 represents roughly the bottom 5% of 2-day price velocity.
The structural reason for reversion: in large-cap stocks above the SMA(200),
institutional buyers are pre-programmed to add at extreme short-term weakness.
The 2-period window avoids the lag issue of RSI(14) and provides more
immediate entry signals with shorter expected hold times.

#### Entry Conditions

```
Daily:
├─ RSI(2) < 10                           ← extreme short-term oversold
├─ Price > SMA(200)                      ← in long-term uptrend
├─ Price > SMA(50)                       ← in medium-term uptrend
├─ Today's close < Yesterday's close     ← still declining (enter on weakness)
```

#### Exit Rules

```
1. Stop Loss          Closes below SMA(200)
2. Take Profit        RSI(2) rises above 65 (momentum restored)
3. Time Exit          5 days max (rubber band snaps fast or thesis is wrong)
```

#### Realistic Expectancy

```
Expected Win Rate:    60–70%  (short hold period reduces variance)
Target R:R:           1.3:1
Expectancy per trade: +0.35 to +0.55R
Hold Period:          1–4 days
Frequency:            3–6 setups per week across full Nifty 100 universe
Best conditions:      Mild pullback in uptrend, no news catalyst
Worst conditions:     Trending down stocks — high RSI(2) readings won't materialise
```

#### Known Failure Modes

- Works only on uptrending stocks — strictly enforce SMA(200) filter
- Earnings announcements during hold: gap risk significant
- Not suitable for volatile stocks with 5–10% daily moves (use wider stops or skip)

---

### E5 — Golden Cross (Regime Filter, Not Standalone)

**Classification:** FILTER — not a tradeable strategy  
**Use as:** Entry gate condition in trend-following strategies

The Golden Cross (SMA50 crossing above SMA200) is too lagging and too widely
known to have standalone edge. It belongs as a regime filter inside other
strategies — confirming the stock is in a long-term uptrend — not as an
entry signal itself. Reclassified from TRADING_STRATEGIES.md v1.0.

**Correct usage:** Add `SMA(50) > SMA(200)` as a condition in E1, E2, and E4.

---

### E6 — VCP (Volatility Contraction Pattern)

**Tier:** 4  
**Strategy Type:** breakout  
**Regime:** TRENDING  
**Instrument:** NSE EQ — growth stocks with strong fundamentals  
**Timeframe:** Daily (multi-week pattern)  
**Buildable Now?** ⚠️ No — requires multi-stage custom indicator

#### Core Idea

After a significant uptrend, a stock consolidates in a series of progressively
tighter price swings with drying volume. Each contraction stage is smaller than
the previous. When price breaks out of the final contraction on strong volume,
the move is sharp and sustained because sellers have been exhausted by the
long consolidation.

#### Why It's Tier 4

VCP requires detecting multiple contraction stages algorithmically — each swing
must be ≤ 50% of the prior swing in range. This is not achievable with the
current indicator library. It requires a custom multi-stage pattern detector.
Additionally, VCP's documented edge is primarily in US growth stocks.
Its applicability to Indian markets requires independent validation — the
institutional accumulation mechanism assumes a level of fundamental research
coverage that may not exist for mid-cap Indian stocks.

**Build after:** Score Mode is live AND a custom pattern detection indicator
is added to the Strategy Builder.

---

### E7 — Bull Flag

**Tier:** 4  
**Strategy Type:** momentum  
**Regime:** TRENDING  
**Buildable Now?** ⚠️ No — requires pole detection

Pole detection (identifying a sharp 5–10% move in 3–5 bars) is not available
in the current indicator set. Build after the system supports percentage move
detection over N bars. Without pole detection, you cannot distinguish a genuine
bull flag from a random consolidation.

---

### E8 — Turtle / Donchian Channel Breakout

**Tier:** 3 (MCX first, then Equity)  
**Strategy Type:** trend_following  
**Regime:** TRENDING  
**Instrument:** MCX Gold, Crude Oil (primary); NSE EQ large-cap (secondary)  
**Timeframe:** Daily  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (HIGH_N / LOW_N indicators)

See MCX section for primary spec. Turtle/Donchian has better structural
edge on commodities than equities because commodity markets have structural
hedgers (producers and consumers) who create predictable directional flows
that trend-following captures.

---

## Part 3: MCX Commodity Strategies

MCX operates in two sessions: morning (09:00–17:00) and evening (17:00–23:30).
Most Indian algo-trading systems ignore the evening session entirely.
It is a significant untapped opportunity for Indian market participants.

---

### M1 — MCX Gold Evening Momentum

**Tier:** 2  
**Strategy Type:** trend_following  
**Regime:** TRENDING  
**Instrument:** GOLD-I (MCX)  
**Timeframe:** 15m  
**Session:** Evening only (17:00–23:00 IST)  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (SESSION_MINUTES can filter for evening session)

#### Core Idea

During the MCX evening session, MCX Gold tracks COMEX Gold (the international
benchmark trading on CME in Chicago) almost directly. When COMEX Gold has been
trending in a clear direction for 2+ hours during the London-New York overlap
(which corresponds to 17:00–21:00 IST), MCX Gold follows. MCX is a price
taker — it follows international gold, it does not lead it.

#### Structural Edge in Indian Markets

MCX Gold is denominated in INR but derived from COMEX Gold prices in USD,
converted at the USD/INR rate. During the evening session, the active global
gold market (COMEX) is the price discovery venue. Indian participants are
essentially hedgers and arbitrageurs following the international price.
When COMEX is in a clear trend, the trend will continue through the MCX
evening session until COMEX closes. This is a carry of international
momentum into the Indian evening session — a structural, not coincidental, edge.

#### Entry Conditions

```
Evening session entry (after 17:30, minimum 15 minutes into evening session):
├─ SESSION_MINUTES > 30 (post 17:30 IST)
├─ SESSION_MINUTES < 330 (before 22:30 IST — leave buffer before 23:30 close)
├─ ADX(14) on GOLD-I 15m > 22            ← trend present on MCX
├─ EMA(9) > EMA(21) on 15m              ← short-term momentum (LONG)
├─ Last 3 bars all closed in same direction ← momentum confirmation

SHORT version: EMA(9) < EMA(21), last 3 bars declining
```

#### Exit Rules

```
1. Forced Exit        23:00 IST (30 minutes before MCX close — avoid thin market)
2. Risk Breach        Kill switch
3. Stop Loss          ATR(14) × 1.5
4. Take Profit        2.5× risk
5. Signal Exit        EMA(9) crosses against the trade
6. Time Exit          12 bars (3 hours) max
```

#### Realistic Expectancy

```
Expected Win Rate:    50–58%
Target R:R:           2.5:1
Expectancy per trade: +0.40 to +0.60R
Frequency:            3–5 qualifying evenings per week
Best sessions:        London-NY overlap hours (17:30–21:00 IST) during trend days
Worst sessions:       COMEX news event → whipsaw → no clear direction
```

#### Score Mode Weights

```
ADX(14) > 25                            → 30 pts
EMA(9) vs EMA(21) aligned               → 25 pts
3 consecutive bars in same direction    → 25 pts
Volume above evening session average    → 20 pts

Trade if total ≥ 70 pts
```

#### Known Failure Modes

- Fed minutes / FOMC releases (IST evening time): gold can whipsaw violently
- USD/INR moves: sharp INR move can distort MCX price independent of COMEX
- Last 30 minutes (23:00–23:30): liquidity drops sharply — widen stops or don't trade
- MCX delivery periods: Gold near delivery can behave idiosyncratically

---

### M2 — Crude Oil Event Momentum

**Tier:** 3  
**Strategy Type:** breakout  
**Regime:** HIGH_VOL  
**Instrument:** CRUDEOIL-I (MCX)  
**Timeframe:** 15m  
**Session:** Evening  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (Economic Event Filter already handles EIA/API dates)

#### Core Idea

US crude oil inventory data (API on Tuesday evenings ~22:30 IST, EIA on
Wednesday evenings ~20:00 IST) consistently moves crude oil prices.
Unlike gap-fill strategies where the gap fades, crude oil gaps on inventory
data tend to extend — the data is genuinely new information about supply.
Post-release momentum follows the gap direction for 1–3 hours.

#### Structural Edge

Inventory data is a genuine fundamental signal about crude supply/demand.
Participants who trade around this data are informed — they are not fading
the move but extending it as they process the implications. The momentum
after EIA/API releases in crude oil is one of the most consistent
event-driven patterns in commodity markets globally.

#### Entry Conditions

```
Evening of API Tuesday or EIA Wednesday:
├─ Data has been released (SESSION_MINUTES past event time)
├─ Price has moved > 0.8% in one direction post-release
├─ Volume in first 2 bars post-release > 3× normal
├─ ADX on 15m rising (not yet extended)

Enter in direction of the move.
```

#### Exit Rules

```
1. Forced Exit        23:00 IST
2. Stop Loss          Pre-release price level (if price returns to pre-release = thesis broken)
3. Take Profit        2× the size of the initial post-release move
4. Time Exit          8 bars (2 hours) after event
```

#### Realistic Expectancy

```
Expected Win Rate:    55–65%  (event-driven momentum has higher win rate)
Target R:R:           2:1
Expectancy per trade: +0.45 to +0.65R
Frequency:            2 setups per week (Tuesday + Wednesday)
Best conditions:      Large unexpected drawdown or build in inventories
Worst conditions:     Data release near market expectation → no clear move
```

#### Known Failure Modes

- Revised data or unexpected secondary announcement can reverse initial move
- Only valid for ~2 hours post-release; after that, other factors dominate
- OPEC decisions near same period can override inventory data signal

---

### M3 — Gold/INR Correlation Play

**Tier:** 4  
**Strategy Type:** trend_following  
**Regime:** TRENDING  
**Instrument:** GOLD-I (MCX)  
**Timeframe:** 1h  
**Trade Direction:** Long Gold on INR weakness  
**Buildable Now?** ❌ Requires USD/INR exchange rate feed

#### Core Idea

MCX Gold price (INR/10g) = COMEX Gold price (USD/oz) × USD/INR rate × conversion factor.
When INR depreciates sharply (USD/INR rises), MCX Gold automatically rises
mechanically — even if COMEX Gold is flat. A 1% INR depreciation adds
approximately 1% to MCX Gold price with no change in international gold.
This creates a clean, quantifiable entry signal: buy MCX Gold when INR
depreciation is significant and COMEX is not declining.

#### Structural Edge

This is not a pattern — it is an arithmetic relationship. The structural
edge is the delay between INR depreciation and MCX Gold's reaction, plus
the fact that retail participants miss this relationship entirely and
are surprised by MCX Gold rising even when international gold is flat.

**Requires:** USD/INR rate feed integrated into the system. Deferred to
Tier 4 until currency data infrastructure is available.

---

### M4 — Turtle / Donchian Channel Breakout (MCX)

**Tier:** 3  
**Strategy Type:** trend_following  
**Regime:** TRENDING  
**Instrument:** GOLD-I, CRUDEOIL-I, SILVER-I (MCX)  
**Timeframe:** Daily  
**Trade Direction:** Both  
**Buildable Now?** ✅ Yes (HIGH_N / LOW_N indicators)

#### Core Idea

The original Turtle Trading system: buy when price breaks above the highest
high of the last N bars; sell when price breaks below the lowest low of
the last N bars. No indicators — pure price structure. Trend-following
at its most structural form. Developed originally for commodities and
remains most applicable to commodities today.

#### Structural Edge in Indian Markets

Commodity markets have genuine structural producers (gold mining companies,
oil producers) and consumers (jewellery manufacturers, refiners) who hedge
their exposure at fixed prices. This creates predictable directional pressure
that persists — miners selling forward above cost of production, consumers
buying dips below replacement cost. Trend-following captures the sustained
directional flow created by this hedger activity.

#### Entry Conditions

```
Daily:
├─ Price breaks above HIGH_N(20)  ← new 20-bar high
├─ Volume > AVG_VOLUME(20)        ← participation
├─ Not within 5 days of MCX expiry ← avoid expiry distortion

SHORT: Price breaks below LOW_N(20), mirror conditions
```

#### Exit Rules

```
1. Stop Loss          LOW_N(10) for longs (10-bar low = initial stop)
2. Trail Stop         Move stop to LOW_N(10) as new highs are made
3. Signal Exit        Price breaks below LOW_N(10) (Turtle system exit)
4. Time Exit          30 days max
```

#### Realistic Expectancy

```
Expected Win Rate:    35–45%  (trend-following accepts low win rate for large wins)
Target R:R:           4:1 minimum (needs large wins to compensate low win rate)
Expectancy per trade: +0.40 to +0.80R (high variance, some trades are very large winners)
Best conditions:      Sustained commodity trends (gold bull run, oil cycle)
Worst conditions:     Range-bound commodities — many false breakouts
```

#### Known Failure Modes

- Range-bound markets destroy the system: many small losses
- MCX expiry and roll: price can temporarily spike through N-bar high on expiry — false signal
- The system only works if you take every signal — selective application destroys the edge

---

## Part 4: Removed and Reclassified Strategies

These strategies appeared in TRADING_STRATEGIES.md v1.0 and have been removed
or reclassified. The reason is documented for each.

---

### Inside Bar — Removed

**Reason:** No structural edge. Inside bars occur constantly on every instrument
and timeframe. The claimed "institutional positioning" explanation is a
post-hoc rationalisation, not a structural cause. Testing will show this
produces slightly better than random results before costs and slightly worse
than random after costs. Removed entirely.

---

### Golden Cross (standalone) — Reclassified to Filter

**Reason:** Too lagging. By the time SMA(50) crosses SMA(200), 15–30% of the
move has already occurred. Too widely known to have standalone edge. Useful
only as a condition gate inside other strategies. See E5 above.

---

### MACD Histogram Turn — Demoted to Tier 3

**Reason:** Not removed — the edge is real — but the entry timing is
problematic. By the time the histogram has turned for 2 consecutive bars,
you are entering late with a wide stop, chasing a move that is partially over.
R:R in practice is significantly worse than the spec suggests. Promote to
active strategy only after validating entry timing specifically on Indian data.

---

## Part 5: Strategy Coverage Summary

Coverage of the four regime states:

```
TRENDING regime:
  F1 — ORB (breakout)                     ← Tier 1
  F3 — ADX Pullback (momentum)            ← Tier 1
  F4 — OI Buildup (trend_following)       ← Tier 1
  F7 — Expiry Week Momentum               ← Tier 3
  F8 — BankNifty RS                       ← Tier 3
  E1 — 52-Week High Breakout              ← Tier 2
  E2 — NR7 (trend filter version)         ← Tier 2
  M1 — Gold Evening Momentum              ← Tier 2
  M4 — Turtle/Donchian (MCX)              ← Tier 3

RANGING regime:
  F2 — VWAP Bounce (mean_reversion)       ← Tier 1
  F5 — Gap Fill (mean_reversion)          ← Tier 2
  F9 — Basis Mean Reversion               ← Tier 3
  E3 — RSI + Lower BB                     ← Tier 2
  E4 — Rubber Band (RSI-2)                ← Tier 2

HIGH_VOL regime:
  F6 — India VIX Mean Reversion           ← Tier 2
  E2 — NR7 (breakout version)             ← Tier 2
  M2 — Crude Oil Event Momentum           ← Tier 3

NORMAL regime:
  F3 — ADX Pullback                       ← Tier 1 (also works in NORMAL)
  F5 — Gap Fill                           ← Tier 2 (also works in NORMAL)
  E4 — Rubber Band                        ← Tier 2 (also works in NORMAL)
```

---

## Part 6: Universal Entry Gates

These are not strategies. They are conditions that apply to ALL strategies
before any signal is evaluated. They are implemented via the Economic Event
Filter and Risk Guard — not inside strategy conditions.

```
Gate 1: INDIA_VIX
  INDIA_VIX < 20 for all new entries (configurable per strategy)
  INDIA_VIX < 25 hard block for all intraday strategies
  Why: Above 20, spreads widen, slippage increases, stops get hit more
       frequently. Strategy edge degrades in high-VIX environments.

Gate 2: Market Hours
  SESSION_MINUTES > 15 (avoid first 15 minutes for non-ORB strategies)
  SESSION_MINUTES < 255 (no new entries after 13:30 for 15m intraday)
  Why: First 15 minutes have abnormal spreads. Late entries have insufficient
       time to reach target before squareoff.

Gate 3: Expiry Day
  avoid_expiry_day flag in strategy risk config
  Why: Expiry Thursdays have distorted price action from options unwinding.
       Most strategies perform significantly worse on expiry day.

Gate 4: Economic Events
  Handled by Economic Event Filter (RR_ENGINE_SPEC.md)
  30 min pre-event, 15 min post-event block
  Why: Price action near announcements is not driven by technical patterns.

Gate 5: Minimum Liquidity
  Volume must exceed a minimum threshold at entry time
  Why: Low liquidity = wide spread = slippage exceeds strategy expectancy
```

---

## Part 7: Indicators Required by System

Indicators marked (NEEDS BUILD) must be added to the Strategy Builder
before the corresponding strategies can be built.

```
Already in system:
  RSI, MACD, MACD_SIGNAL, MACD_HIST, BB_UPPER, BB_LOWER, BB_WIDTH, BB_PCT
  ATR, HIST_VOL, STOCH_K, STOCH_D, CCI, ROC, OBV
  ADX, DI_PLUS, DI_MINUS, SUPERTREND_DIR, SUPERTREND
  EMA, SMA, VWAP, AVG_VOLUME, VOLUME, VOLUME_RATIO
  INDIA_VIX, OI, OI_CHANGE, BASIS
  SESSION_MINUTES, BAR_NUMBER, HIGH_N, LOW_N, 52W_HIGH, 52W_LOW
  PRICE (open, high, low, close, vwap), PREV_PRICE

  Note on VWAP deviation:
    No separate VWAP_DEVIATION indicator needed.
    Use offset syntax: { "indicator": "VWAP", "offset": -0.5, "offset_type": "percent" }
    This handles "price is X% below VWAP" natively.

  Note on ORB (Opening Range Breakout):
    No dedicated ORB_HIGH / ORB_LOW indicators needed.
    Use HIGH_N(2) as proxy for ORB high (high of first 2 bars = 9:15 + 9:30).
    Bundled template T03 already implements this approach.

Needs Build (PRIORITY ORDER):
  1. GAP_PCT           Gap % from previous close — required for F5 (Gap Fill)
                       Can approximate with PREV_PRICE offset but a dedicated
                       indicator is cleaner. Medium priority.

  2. USD/INR RATE      External currency feed — required for M3 (Gold/INR)
                       Tier 4 only. Low priority until M3 is scheduled.

  3. CROSS_SYMBOL_RATIO  Ratio of two symbols (BankNifty/Nifty)
                         Required for F8 (BankNifty RS). Complex infrastructure.
                         Tier 4 only.
```

---

## Part 8: Recommended Build Order

```
Phase 1 — Foundation Strategies (Build and Paper Trade First)

  Priority 1: ORB on NIFTY-I (15m)
    → Use HIGH_N(2) as ORB proxy — fully buildable today
    → Clone bundled template T03 as starting point
    → Most documented, cleanest structural edge for Indian indices

  Priority 2: ADX Pullback on NIFTY-I (15m)
    → Fully buildable today, no missing indicators
    → Start here immediately — no dependencies

  Priority 3: VWAP Bounce on NIFTY-I (5m)
    → Fully buildable today — VWAP is in the indicator library
    → Use VWAP offset syntax for deviation condition
    → Clone bundled template T04 as starting point

Phase 2 — Expand Segment Coverage

  Priority 4: OI Buildup on NIFTY-I / BANKNIFTY-I (15m)
  Priority 5: Gap Fill on NIFTY-I (5m)
  Priority 6: Gold Evening Momentum on GOLD-I (15m)

Phase 3 — Equity and Mean Reversion

  Priority 7: 52-Week High Breakout — NSE EQ universe
  Priority 8: NR7 — NSE EQ + NIFTY-I Daily
  Priority 9: RSI + Lower BB — NSE EQ
  Priority 10: Rubber Band (RSI-2) — NSE EQ

Phase 4 — Regime-Specific and Advanced

  Priority 11: India VIX Mean Reversion
  Priority 12: Expiry Week Momentum
  Priority 13: Turtle/Donchian — MCX
  Priority 14: Basis Mean Reversion
  Priority 15: Crude Oil Event Momentum

Phase 5 — Score Mode and Custom Indicators

  Priority 16: VCP (full implementation)
  Priority 17: Bull Flag (with pole detection)
  Priority 18: BankNifty RS (with cross-symbol ratio)
  Priority 19: Gold/INR Correlation (with currency feed)
```

---

*End of Document*

---

**Related Files:**  
`STRATEGY_SCHEMA.md` — Strategy JSON definition format  
`SCORING_ENGINE.md` — Composite score and regime selection  
`STRATEGY_GUIDE.md` — How to build strategies in the UI  
`ALPHA_FIRST.md` — Strategy validation philosophy and statistical requirements  
`RR_ENGINE_SPEC.md` — Pre-trade filters (event, R:R, heat)  
`INDIA_MARKETS_SPEC.md` — Segment-specific rules and constraints
