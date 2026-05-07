# Options Trading System — Phase 2 Design Reference

**Status:** Deferred. Do not implement until Phase 1 (equity + futures + commodity) is stable and profitable.  
**Target Market:** NSE F&O — Index options (Nifty, BankNifty) and select stock options.  
**Why deferred:** Options are a categorically different system. The Phase 1 architecture (OHLCV + directional signals) is insufficient. A new set of data pipelines, pricing models, and risk components must be designed from scratch.

---

## 1. Why Options Need a Separate System

The Phase 1 system is built around a core assumption: **price moves in a direction, you profit from that direction.** Options break this assumption entirely.

With options, you can be right on direction and still lose money because of:

- **Theta decay:** An option loses value every single day just by existing. A 5-day hold in a futures strategy costs nothing in theta. The same hold in a long option position costs real money even if price doesn't move.
- **IV crush:** Implied Volatility (IV) can collapse after an anticipated event (earnings, RBI policy, budget). You buy a Nifty call before RBI announcement, direction is correct, but IV drops 30% after the event — your option still loses value.
- **Non-linear P&L:** An option's value doesn't move 1:1 with the underlying. It moves based on delta (which itself changes as price moves — gamma). A strategy that works with a fixed stop-loss in futures is not directly portable to options.
- **Time-bounded:** Every option has an expiry. A Phase 1 mean reversion strategy can hold a position for 2 weeks without structural cost. An options strategy holding for 2 weeks is fighting theta every day.

These are not edge cases — they are the fundamental nature of options. Any system that treats options like futures will lose money systematically.

---

## 2. What Options Do Offer (When Used Correctly)

Options are not inherently worse — they are different. When designed around their nature, they offer:

- **Defined risk:** A long option's maximum loss is the premium paid. Unlike futures, there is no scenario where a long option loses more than what you paid. This is genuinely useful for high-conviction directional bets around events.
- **Asymmetric payoff:** A well-structured options position can return 3x–10x on the premium if the move is large enough, while losing only 1x if wrong.
- **Volatility trading:** You can profit from volatility itself — not just direction. Selling options when IV is high (and IV tends to mean-revert) is a consistent edge if managed properly.
- **Hedging:** Options can hedge an existing futures portfolio at defined cost. A portfolio of Nifty futures can be hedged with puts during uncertain periods.

The consistent money in options for a systematic trader is typically on the **selling side** (premium collection), not the buying side. But selling options requires proper Greeks management and robust margin handling — which is why it belongs in Phase 2.

---

## 3. What a Phase 2 Options System Requires

This section documents what must be built. It does not exist yet.

### 3.1 Data: Options Chain

Phase 1 only ingests OHLCV bars. Options require the full option chain per expiry — every strike, both calls and puts, at every snapshot in time.

**What's needed:**
- Live option chain data from TrueData (available in Ultima plan for NSE F&O)
- Fields per strike: LTP, IV, delta, gamma, theta, vega, OI, volume, bid, ask
- Historical option chain snapshots for backtesting (this is the hard part — historical option chain data is expensive and hard to get for India)
- IV surface: a matrix of IVs across strikes and expiries at each point in time

**Key challenge:** Historical options chain data for India is not freely available. TrueData provides live options data but historical chain data (needed for backtesting) requires either a separate data vendor (OptionSoft, NSE data feed) or building your own archive from Day 1 of Phase 1 live running.

> **Practical implication:** Start archiving live options chain snapshots from Day 1 of Phase 1, even if you don't use them. By the time Phase 2 starts, you'll have 6–12 months of historical chain data to backtest with.

### 3.2 Pricing: Black-Scholes + Local Volatility

Options pricing requires an analytical model, not just historical price patterns.

**Components needed:**
- Black-Scholes model for theoretical option price given (spot, strike, expiry, IV, risk-free rate)
- Greeks calculator: delta, gamma, theta, vega, rho per position
- IV calculator: back-solve IV from market price using Newton-Raphson
- IV surface interpolator: estimate IV for any strike/expiry combination
- Historical volatility calculator: realized vol vs. implied vol spread (the "vol premium" — this is where edge comes from in selling strategies)

### 3.3 Strategy Types Suitable for Systematic Trading

Not all options strategies are backtestable or systematic. These are the ones that work in a rule-based system:

| Strategy | Description | Edge Source | Complexity |
|---|---|---|---|
| Short Strangle | Sell OTM call + put | IV premium (sell high IV, buy back lower) | Medium |
| Iron Condor | Short strangle + long wings (defined risk) | IV premium with bounded loss | Medium |
| Calendar Spread | Sell near-month, buy far-month | Theta differential | High |
| Covered Call | Hold futures/equity, sell call | Premium income on range-bound | Low |
| Protective Put | Hold futures, buy put | Portfolio hedge | Low |
| Long Straddle | Buy ATM call + put | Event volatility play | Medium |

**Avoid for Phase 2:** Naked short puts/calls (unlimited risk), complex multi-leg exotic structures.

**Best starting point for Phase 2:** Short Strangles on Nifty weekly options — sell OTM call and put, collect premium, manage if price moves against you. This is the most common retail systematic options strategy in India.

### 3.4 Risk: Greeks-Aware Position Sizing

Phase 1 risk is simple: `position_size = (2% of capital) / (entry_price - stop_loss)`.

Options risk cannot use this formula. A position must be sized based on:

- **Delta:** Net directional exposure of the portfolio. A portfolio with delta = +50 moves like holding 50 Nifty futures.
- **Gamma:** Rate of change of delta. High gamma = delta changes rapidly with price moves = requires frequent rehedging.
- **Vega:** Sensitivity to IV changes. A high-vega portfolio loses if IV drops (bad for long options, good for short options).
- **Theta:** Daily time decay. A positive-theta portfolio makes money every day (short options); negative-theta loses every day (long options).
- **Max loss:** For defined-risk strategies (iron condor, spreads), max loss is calculable. For short strangles, max loss is large but bounded by practical exit rules.

**Greeks targets for a short-premium portfolio:**
```
Portfolio delta: < ±50 (net-neutral directional)
Portfolio vega:  < −2000 (short vol, not excessively)
Portfolio theta: +500 to +2000 per day (collecting ₹500–₹2000/day in time decay)
Max loss per position: < 5% of capital
```

### 3.5 Execution: Different Order Types

Options execution has quirks that futures execution doesn't:

- **Slippage is much higher.** Bid-ask spreads on OTM options can be ₹2–₹10 on a ₹20 option (10–50%). Backtests must use realistic bid-ask, not mid-price.
- **Limit orders are essential.** Market orders in illiquid strikes get filled at terrible prices. The execution engine must use limit orders with a maximum acceptable fill price.
- **Leg risk:** Multi-leg strategies (strangle, iron condor) have leg execution risk — one leg fills, the other doesn't. Need simultaneous leg execution or explicit handling of partial fills.
- **Assignment risk:** Although NSE options are cash-settled at expiry, near-expiry behavior (especially weekly contracts in the last 30 minutes) requires the executor to have hard rules for closing positions before settlement.

---

## 4. Data Archiving Action — Start Now in Phase 1

Even though options trading is Phase 2, one action should happen in Phase 1:

**Archive live options chain snapshots starting from Day 1 of live trading.**

TrueData Ultima provides live options chain data. The ingestion service should take a snapshot of the Nifty and BankNifty option chains at 09:15, 12:00, and 15:25 IST daily and write them to a dedicated `options_chain_snapshots` table or directly to Parquet on GCS.

Schema for each snapshot:

| Field | Description |
|---|---|
| snapshot_time | Timestamp of snapshot |
| underlying | NIFTY or BANKNIFTY |
| expiry_date | Which expiry |
| strike | Strike price |
| option_type | CE or PE |
| ltp | Last traded price |
| iv | Implied volatility (compute from LTP using Black-Scholes) |
| delta | Greeks (compute from IV) |
| gamma | |
| theta | |
| vega | |
| oi | Open interest |
| volume | Day volume |
| bid | Best bid |
| ask | Best ask |

This costs almost nothing to store (3 snapshots × ~500 strikes × 2 expiries × 2 underlyings = ~6,000 rows/day). After 12 months, you'll have a meaningful historical dataset to backtest Phase 2 strategies.

---

## 5. Prerequisites Before Starting Phase 2

Do not start Phase 2 options work until:

- [ ] Phase 1 is live-trading profitably for at least 6 months
- [ ] You have 6+ months of archived options chain data
- [ ] You understand options pricing intuitively (read: *Options, Futures, and Other Derivatives* by John Hull)
- [ ] You have studied at least 2 systematic options strategies with real backtest data
- [ ] The Phase 1 risk monitor has been extended to support Greeks-based position sizing
- [ ] You have reviewed SEBI's options margin framework (SPAN for short options is substantially higher than futures margin)

---

## 6. Recommended Learning Before Phase 2

**Books:**
1. *Options, Futures, and Other Derivatives* — John Hull (the definitive textbook)
2. *The Volatility Surface* — Jim Gatheral (IV modeling)
3. *Dynamic Hedging* — Nassim Taleb (practical Greeks management)
4. *Positional Option Trading* — Euan Sinclair (systematic approach)

**Key concepts to master:**
- Black-Scholes pricing formula and its assumptions
- What IV represents and why it mean-reverts
- The volatility risk premium (why selling options has a statistical edge)
- Greeks interdependencies (why gamma and theta always conflict)
- SEBI SPAN margin calculation for short options

---

## 7. Phase 2 System Components (Future Design)

When Phase 2 begins, these components need to be designed and built:

| Component | Description | Depends On |
|---|---|---|
| Options Chain Ingestion | Live chain snapshots from TrueData | Phase 1 ingestion service |
| IV Calculator | Back-solve IV from market price | Black-Scholes implementation |
| Greeks Engine | Compute delta/gamma/theta/vega per position | IV Calculator |
| Options Backtest Engine | Bar-by-bar simulation using historical chain data | Historical chain archive |
| Greeks-Aware Risk Monitor | Position sizing based on portfolio Greeks | Greeks Engine |
| Options Strategy Builder | Define strategies using Greeks targets, not just price | Greeks Engine |
| Leg Execution Handler | Manage multi-leg order placement and partial fills | Zerodha Kite API |

None of these exist in Phase 1 and none should be built until Phase 1 is stable.

---

*Phase 1 scope: NSE Equity · NSE Futures · MCX Commodity.*  
*Options: Phase 2. Revisit after 6 months of profitable Phase 1 live trading.*  
*See INDIA_MARKETS_SPEC.md for F&O market structure reference.*  
*See TRUEDATA_SPEC.md for options chain data availability.*
