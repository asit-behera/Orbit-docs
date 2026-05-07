# India Markets Specification

Reference document covering the structure, rules, and characteristics of the three market segments we trade: NSE Equity, NSE F&O, and MCX. This is foundational context required before building any data ingestion, strategy, or execution component targeting Indian markets.

---

## 1. Why Indian Markets Are Different

Most algorithmic trading literature and open-source tooling is built around US markets (NYSE, NASDAQ, CME). Indian markets share many structural similarities but differ in ways that will break assumptions if not understood upfront.

Key differences that affect our system:

- **Lot-based trading:** You cannot buy 1 share of a futures contract. Every F&O and MCX instrument trades in fixed lot sizes. Position sizing must always respect lot boundaries.
- **Weekly + monthly expiry coexistence:** Index options/futures expire weekly (every Thursday), while stock futures expire monthly (last Thursday). A strategy backtest that ignores roll dates will have severe look-ahead bias.
- **MCX evening session:** Commodity markets trade until 23:30 IST on weekdays, and until 17:00 IST on days before MCX-mandated holidays. This is a hard operational requirement — the ingestion service cannot shut down at 15:30.
- **T+1 settlement:** NSE moved to T+1 settlement for equities in 2023. This affects cash availability calculations for equity strategies.
- **Price bands (circuit filters):** Individual stocks have daily price movement limits (typically ±5%, ±10%, or ±20%). Hitting a circuit breaker halts trading in that symbol. Our data validation must distinguish a circuit halt from a data gap.
- **SEBI margin framework (SPAN + Exposure):** F&O and MCX margins are calculated using a SPAN model. Margin requirements change intraday based on volatility. This is critical for position sizing in live trading.

---

## 2. Segment Overview

### 2.1 NSE Equity (NSE EQ)

**What it is:** The cash equity market on the National Stock Exchange. Stocks are bought and delivered (T+1 settlement). No leverage on delivery trades; intraday leverage is broker-dependent.

**What we trade:** Primarily large-cap NSE stocks and index ETFs for mean reversion and momentum strategies. The equity segment is also used as a reference universe for identifying which stocks have active F&O contracts.

**Key facts:**
- Over 2,000 actively traded symbols
- Nifty 50, Nifty 500, and sector indices as benchmarks
- Indices themselves cannot be traded directly in EQ — they are traded via F&O or ETFs
- Intraday squareoff deadline: 15:15 IST (most brokers auto-square off open MIS positions)
- No shorting on delivery; shorting only available intraday or via F&O

**Settlement:**
- T+1: Trades on Monday settle on Tuesday
- Pay-in / Pay-out happens through the clearing corporation (NSCCL)

**Circuit Breakers:**
- Individual stocks: ±5%, ±10%, or ±20% bands assigned by exchange
- Market-wide: Nifty/Sensex drops of 10%, 15%, or 20% trigger 45-minute, 1-hour-45-minute, or rest-of-day halts respectively
- Our data validation layer must flag circuit hits as a special event, not a data error

---

### 2.2 NSE F&O (Futures & Options)

**What it is:** Derivatives market on NSE. We trade futures only (not options — theta decay is a structural disadvantage we choose to avoid).

> **Options deferred to Phase 2.**  
> Options require a fundamentally different system — theta decay management, IV surface modeling, Greeks-aware position sizing, and options chain data beyond OHLCV. See [OPTIONS.md](./OPTIONS.md) for the full future design.

**Instruments we focus on:**

| Instrument | Type | Expiry Cycle | Lot Size | Notes |
|---|---|---|---|---|
| Nifty 50 Futures | Index Future | Weekly (Thu) + Monthly | 25 | Most liquid index future |
| BankNifty Futures | Index Future | Weekly (Wed) + Monthly | 15 | High volatility, high volume |
| FinNifty Futures | Index Future | Weekly (Tue) + Monthly | 40 | Financial sector index |
| MidcapNifty Futures | Index Future | Monthly | 75 | Lower liquidity |
| Stock Futures | Single Stock Future | Monthly (last Thu) | Varies | Top ~200 stocks have F&O |

**Lot sizes are set by SEBI/NSE and change periodically.** Always read lot size from the instruments master file, never hardcode it.

**Expiry cycle explained:**
- Near month: Current month contract (most volume)
- Mid month: Next month contract
- Far month: Month after that
- When near month expires, mid becomes near, far becomes mid, and a new far is introduced

**For index futures specifically:** Weekly contracts expire every Thursday. On expiry day, the contract settles at the final settlement price (FSP), which is the average of the underlying index from 14:30 to 15:30. Volume migrates to the next week's contract on Wednesday afternoon.

**Open Interest (OI):** This is the total number of outstanding contracts. It is a primary indicator we track. Rising price + rising OI = strong trend. Rising price + falling OI = short covering (weaker signal). OI data is only available in F&O and MCX, not in EQ.

**Settlement:** Cash-settled. No physical delivery of anything. On expiry, the profit/loss is credited/debited based on final settlement price.

---

### 2.3 MCX (Multi Commodity Exchange)

**What it is:** India's primary commodity derivatives exchange. We trade commodity futures only.

**Instruments we focus on:**

| Instrument | Lot Size | Unit | Notes |
|---|---|---|---|
| Gold | 1 kg | Per 10 grams | Most liquid commodity in India |
| Gold Mini | 100 grams | Per 10 grams | Lower margin requirement |
| Silver | 30 kg | Per kg | High volatility |
| Silver Mini | 5 kg | Per kg | More accessible |
| Crude Oil | 100 barrels | Per barrel | Tracks international crude |
| Natural Gas | 1250 mmBtu | Per mmBtu | Volatile, event-driven |
| Copper | 2.5 MT | Per kg | Industrial metal |
| Zinc | 5 MT | Per kg | Industrial metal |
| Aluminium | 5 MT | Per kg | Lower volatility |

**Expiry:** MCX commodity futures expire on the 20th of the expiry month (or the preceding trading day if 20th is a holiday). This is different from NSE's last-Thursday rule. Gold and Silver have both main and mini contracts.

**International price linkage:** MCX commodity prices are heavily influenced by international benchmark prices (COMEX for metals, NYMEX for energy). The MCX price = International price × USD/INR exchange rate ± premium/discount. This means INR/USD movements affect MCX strategies even if you are not explicitly trading forex.

**Extended trading hours:** MCX operates in two sessions:
- Morning session: 09:00 – 17:00 IST
- Evening session: 17:00 – 23:30 IST (tracks international markets)
- On the day before MCX-specified holidays: Trading ends at 17:00 only

**Physical delivery risk:** Some MCX contracts (especially Gold and Silver near expiry) can go into physical delivery if not closed. Our live executor must have a hard rule: close all MCX positions at least 3 days before expiry if they are in-the-money and in the far contract. We do not want physical delivery of 1 kg of gold.

---

## 3. Trading Hours Reference

| Segment | Pre-Open | Market Open | Market Close | Notes |
|---|---|---|---|---|
| NSE EQ | 09:00 – 09:15 | 09:15 | 15:30 | Pre-open is call auction |
| NSE F&O | N/A | 09:15 | 15:30 | |
| MCX (Morning) | N/A | 09:00 | 17:00 | |
| MCX (Evening) | N/A | 17:00 | 23:30 | Weekdays only |
| MCX (Holiday eve) | N/A | 09:00 | 17:00 | No evening session |

All times are IST (UTC+5:30).

The pre-open session for NSE EQ (09:00–09:15) is a call auction. Prices during this window are indicative, not executable. Our ingestion service should tag pre-open ticks separately and not use them for strategy signal generation.

---

## 4. Holiday Calendar

NSE and MCX maintain separate holiday lists. They overlap significantly but not completely. MCX may be open on days NSE is closed (e.g., certain regional holidays) and vice versa.

**Sources:**
- NSE publishes its annual holiday list at the start of each year on nseindia.com
- MCX publishes its list on mcxindia.com
- TrueData also maintains this and will stop sending data on exchange holidays

**Our system must:**
- Maintain a `market_holidays` table in the database with per-exchange holiday entries
- Refresh this table at the start of each calendar year
- Use it to determine whether the ingestion service should start on a given day
- Use it in backtesting to skip non-trading days correctly

**Practical note:** On budget days (Union Budget, typically February 1), NSE remains open for full trading. This is a common gotcha — budget day is not a holiday but is an extremely high-volatility day that can cause circuit breakers.

---

## 5. Key Concepts for Strategy Building

### 5.1 India VIX
India VIX is NSE's volatility index, analogous to CBOE VIX. It measures the expected volatility of Nifty over the next 30 days derived from Nifty options prices. We use it as a regime indicator:
- VIX < 15: Low volatility, trending market
- VIX 15–20: Normal conditions
- VIX > 20: Elevated fear, mean reversion strategies tend to outperform
- VIX > 30: Extreme fear, reduce position sizes

India VIX data is available from NSE and through TrueData.

### 5.2 Futures Basis
Basis = Futures Price − Spot Price. In normal conditions (contango), futures trade at a premium to spot due to cost of carry. When basis narrows sharply or goes negative (backwardation), it signals strong directional conviction. This is a useful indicator for index futures strategies.

### 5.3 Put-Call Ratio (PCR)
The ratio of total open interest in put options to call options. PCR > 1.2 indicates bearish sentiment; PCR < 0.8 indicates bullish extremes that often precede reversals. Useful as a contrarian filter. PCR data comes from NSE F&O option chain data.

### 5.4 FII/DII Activity
Foreign Institutional Investors (FII) and Domestic Institutional Investors (DII) publish their net buy/sell data daily. Sustained FII selling is a reliable bearish indicator for Indian markets. We do not trade this signal directly but use it for regime classification.

---

## 6. Symbol Naming Conventions

TrueData uses a specific symbol format that differs from NSE's official format. Understanding this is critical to avoid symbol lookup errors.

**NSE Equity:** Simple ticker (e.g., `RELIANCE`, `INFY`, `HDFCBANK`)

**NSE F&O:**
- Index futures: `NIFTY`, `BANKNIFTY` with expiry suffix
- TrueData format: `NIFTY-I` (continuous near-month), `NIFTY-II` (next month), or full expiry date format
- Stock futures: `RELIANCE-FUT` or with expiry date

**MCX:**
- Metal: `GOLD`, `GOLDM` (mini), `SILVER`, `SILVERM`
- Energy: `CRUDEOIL`, `NATURALGAS`
- TrueData continuous: `GOLD-I`, `CRUDEOIL-I`

**Our instruments_india table must store both the TrueData symbol format and the exchange-native symbol.** Symbol mismatch is one of the most common bugs in Indian market systems.

---

## 7. What This Means for Our System

| Implication | Affected Component |
|---|---|
| Lot sizes must be read from instruments table, never hardcoded | Strategy Builder, Risk Monitor, Live Executor |
| Roll dates must be known in advance to avoid expiry-day gaps | Continuous Contracts, Backtest Engine |
| MCX evening session requires ingestion service to run till 23:30 | Ingestion Pipeline |
| Circuit breakers must be flagged, not treated as missing data | Data Validation |
| Holiday calendars per exchange must be maintained separately | Ingestion Pipeline, Backtest Engine |
| OI data is segment-specific (F&O and MCX only) | Data Schema |
| Physical delivery risk on MCX requires hard position close rules | Live Executor |
| India VIX is a regime indicator, not a tradeable instrument | Strategy Builder, Allocator |

---

*See TRUEDATA_SPEC.md for data provider details.*
*See DATA_SCHEMA_INDIA.md for database design.*
*See CONTINUOUS_CONTRACTS_SPEC.md for futures roll handling.*
