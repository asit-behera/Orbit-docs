# Continuous Contracts Specification

This document defines how we handle futures roll events and construct continuous price series for backtesting and strategy development. It covers the roll detection logic, back-adjustment methodology, storage design, and edge cases specific to NSE F&O and MCX contracts.

---

## 1. The Problem: Why We Need Continuous Contracts

Futures contracts expire. A Nifty futures contract expires on the last Thursday of each month. When you trade Nifty futures continuously over multiple months, you are actually trading a chain of individual contracts: NIFTY25MAYFUT → NIFTY25JUNFUT → NIFTY25JULFUT and so on.

Each contract has its own price history only for its own lifetime. When you stitch them together naively (append one contract's history to the next), you create a problem: the price at the end of one contract and the start of the next are different, creating a visible price gap at every roll date. This gap is called the **roll gap** or **rollover gap**.

**Why roll gaps break backtesting:**

Imagine building a moving average crossover strategy on Nifty futures. On the day NIFTY25MAYFUT expired, it closed at 24,100. NIFTY25JUNFUT opened the next day at 24,200. If you append these naively, your moving average now includes a ₹100 jump that never actually occurred in the market — it was just a contract change. Your strategy will generate false signals at every single roll date. With 12 rolls per year, a 10-year backtest has 120 artificial price jumps.

**The solution:** Construct a **continuous contract** — a single, spliced price series that adjusts historical prices to remove roll gaps. This is the series used for backtesting and strategy signal calculation. The actual current contract (with its real, unadjusted price) is used only for live execution.

---

## 2. Which Instruments Need Continuous Contracts

| Instrument | Roll Frequency | Notes |
|---|---|---|
| Nifty 50 Futures | Weekly (Thursday) | High priority — primary trading instrument |
| BankNifty Futures | Weekly (Wednesday) | High priority |
| FinNifty Futures | Weekly (Tuesday) | Medium priority |
| MidcapNifty Futures | Monthly (last Thursday) | Lower priority |
| Top 100 Stock Futures | Monthly (last Thursday) | As needed |
| Gold Futures (MCX) | Monthly (20th) | High priority for commodity strategies |
| Gold Mini Futures | Monthly (20th) | Same underlying as Gold |
| Silver Futures | Monthly (20th) | High priority |
| Crude Oil Futures | Monthly (20th) | High priority |
| Natural Gas | Monthly (20th) | Medium priority |
| Copper, Zinc, Aluminium | Monthly (20th) | As needed |

Weekly index futures require 52 rolls per year per instrument. This is the most roll-intensive segment we manage.

---

## 3. Roll Detection Logic

A roll event is detected when it is time to transition from the current front-month contract to the next month contract. The trigger is **open interest migration**, not calendar date.

### 3.1 OI Migration Signal

The standard roll signal: when the open interest in the next-month contract exceeds the open interest in the current front-month contract, the market has effectively rolled. Traders have moved their positions forward.

```
Roll condition: OI(next_month) > OI(current_month) for 2 consecutive days
```

We require two consecutive days to avoid acting on single-day anomalies (large block trades can temporarily inflate next-month OI without signaling a true roll).

### 3.2 Calendar Backstop

For cases where OI migration is unclear (thin markets, MCX metals), we use a calendar backstop:

- **NSE index futures:** Roll on the Wednesday before expiry (one trading day before the last Thursday)
- **NSE stock futures:** Roll on the Wednesday of expiry week
- **MCX:** Roll on the 17th of the expiry month (3 days before the 20th expiry), or the preceding trading day

The calendar backstop is a safety net — it overrides the OI signal if a roll has not been detected by the backstop date.

### 3.3 Roll Detection Output

For each instrument, the roll detector produces:
- `roll_date`: The date we consider the roll to have occurred
- `from_contract`: The contract we are rolling out of (e.g., NIFTY25MAYFUT)
- `to_contract`: The contract we are rolling into (e.g., NIFTY25JUNFUT)
- `roll_gap`: The price difference between the two contracts on the roll date (to_contract close − from_contract close)
- `detection_method`: 'oi_migration' or 'calendar_backstop'

These are written to the `futures_roll_calendar` table.

---

## 4. Back-Adjustment Methodology

Once a roll is detected, we must adjust the historical price series to eliminate the roll gap. There are two methods in common use:

### 4.1 Ratio Adjustment (Multiplicative)

Each historical price before a roll is multiplied by the ratio: (price of new contract on roll date) / (price of old contract on roll date).

**Example:**
- NIFTY25MAYFUT closes at 24,100 on roll date
- NIFTY25JUNFUT closes at 24,350 on roll date
- Ratio = 24,350 / 24,100 = 1.01037
- All historical prices in the series (everything before this roll) are multiplied by 1.01037

**Pros:**
- Preserves percentage returns accurately
- A 5% move in the historical series remains a 5% move after adjustment
- Better for percentage-based indicators (RSI, % Bollinger bands)

**Cons:**
- Very old historical prices get distorted significantly (product of all ratios going back years)
- Absolute price levels are meaningless in the adjusted series
- Complex arithmetic

### 4.2 Difference Adjustment (Additive)

Each historical price before a roll has the roll gap subtracted from it (or added, if the new contract is lower).

**Example:**
- NIFTY25MAYFUT closes at 24,100; NIFTY25JUNFUT closes at 24,350
- Roll gap = 24,350 − 24,100 = +250
- All historical prices in the series (everything before this roll) have +250 added to them

**Pros:**
- Absolute price differences (for fixed-point indicators like ATR) remain accurate
- Simpler arithmetic
- Better for absolute indicators (ATR, fixed-point support/resistance)

**Cons:**
- Percentage returns in the historical series are distorted
- Can produce negative prices for commodities with many downward rolls (theoretical issue)

### 4.3 Our Choice: Ratio Adjustment as Default, Difference as Alternate

**Primary series:** Ratio-adjusted. All strategy backtesting, indicator calculation, and signal generation uses the ratio-adjusted series. This is the industry standard for percentage-return-based strategies.

**Secondary series:** Difference-adjusted. Available for strategies that use absolute price-level indicators (ATR-based stops, fixed price targets).

Both series are stored in `continuous_contracts`. The backtest engine allows the user to specify which adjustment type to use per strategy.

---

## 5. Storage Design

### 5.1 continuous_contracts Table

| Field | Purpose |
|---|---|
| date | Trading date |
| symbol_continuous | Continuous symbol identifier (e.g., NIFTY-CONT, GOLD-CONT) |
| underlying | Underlying instrument name (NIFTY, GOLD, etc.) |
| adj_close_ratio | Ratio-adjusted close price |
| adj_open_ratio | Ratio-adjusted open price |
| adj_high_ratio | Ratio-adjusted high price |
| adj_low_ratio | Ratio-adjusted low price |
| adj_close_diff | Difference-adjusted close price |
| adj_open_diff | Difference-adjusted open price |
| adj_high_diff | Difference-adjusted high price |
| adj_low_diff | Difference-adjusted low price |
| raw_close | Unadjusted close price of the front-month contract on this date |
| volume | Volume of front-month contract |
| oi | OI of front-month contract |
| active_contract | Which expiry contract was the front-month on this date (for reference) |
| cumulative_ratio_factor | Product of all ratio adjustments applied up to this date |
| cumulative_diff_factor | Sum of all difference adjustments applied up to this date |

The `cumulative_factor` fields are critical: they allow converting an adjusted price back to its approximate real price at any point in time. This is needed when the strategy generates a signal on the adjusted series but the order must be placed at the actual market price.

### 5.2 futures_roll_calendar Table

| Field | Purpose |
|---|---|
| symbol | Continuous series identifier |
| roll_date | Date the roll occurred or is projected to occur |
| from_contract | Contract rolled out of |
| to_contract | Contract rolled into |
| from_price | Price of from_contract on roll date |
| to_price | Price of to_contract on roll date |
| roll_gap_abs | Absolute gap (to_price − from_price) |
| roll_gap_pct | Percentage gap |
| detection_method | 'oi_migration' or 'calendar_backstop' |
| is_projected | True if this is a future projected roll date, False if historical |
| applied_at | When the back-adjustment was applied to continuous_contracts |

**Projected roll dates:** We pre-populate future roll dates based on the calendar backstop rule. This allows the backtest engine and strategy builder to show "upcoming roll dates" as a reference. Projected dates are recalculated monthly and overwritten when the actual OI-migration-based roll date is detected.

---

## 6. Re-Adjustment on Each New Roll

Every time a new roll is detected, the **entire historical continuous series must be re-adjusted**. This is because each roll appends a new adjustment factor to the cumulative chain — changing the current factor changes all prior prices proportionally.

**This has important implications:**
- The adjusted prices for a symbol 5 years ago will be different today than they were 2 years ago
- Backtests should always be re-run against the latest-adjusted series, not a snapshot
- We store only the current adjusted series (not historical snapshots of adjustment states)
- The `applied_at` timestamp in `futures_roll_calendar` shows when each adjustment was last applied

**How frequently this runs:** Daily, as part of the end-of-day jobs (Job 4 in INGESTION_PIPELINE_SPEC.md). On non-roll days, the job quickly checks for roll conditions and exits. On roll days, it runs the full back-adjustment and logs the event.

---

## 7. Converting Adjusted Signals Back to Real Prices

When a strategy generates an entry signal based on the adjusted continuous series, the live executor needs to know what price to place the order at in the real market.

**Conversion formula:**

For ratio-adjusted series:
```
real_price ≈ adjusted_signal_price / cumulative_ratio_factor
```

For difference-adjusted series:
```
real_price ≈ adjusted_signal_price - cumulative_diff_factor
```

**Important caveat:** This conversion gives the equivalent historical price in today's terms. For a live signal, the execution price is simply the current market price of the active front-month contract. The adjusted series is used for signal generation (is the indicator triggered?), not for price level targeting. The distinction matters:

- A momentum strategy that says "buy when price breaks above the 50-day high" computes the 50-day high on the adjusted series, converts it to today's equivalent real price, and uses that as the entry level.
- A trend-following strategy that says "buy when 10-day SMA crosses above 30-day SMA" only cares that the cross happened — no price level conversion needed.

---

## 8. Edge Cases and Gotchas

### 8.1 Roll During Holiday
If the scheduled roll date falls on an exchange holiday, roll to the next trading day. The `futures_roll_calendar` projected dates always account for the holiday calendar.

### 8.2 Expiry Day Volatility
On expiry day (especially for weekly index contracts), price behaviour around settlement (14:30–15:30 for NSE index) is abnormal. Strategies should be configured to avoid taking new positions during the settlement window. This is a strategy-level parameter, not handled by the continuous contract system.

### 8.3 Early Roll Due to Corporate Action
When a company in Nifty or BankNifty undergoes a major corporate action (rights issue, bonus, merger), futures OI can shift unpredictably. Our OI-migration detector may fire early. This is acceptable — we treat it as a genuine market-driven roll.

### 8.4 MCX Physical Delivery Contracts
For MCX Gold and Silver in their delivery months, OI drops sharply in the last week as traders with physical delivery obligations close or roll. Our 3-day calendar backstop handles this correctly — we roll out 3 days before the 20th, well before delivery pressure peaks.

### 8.5 Negative Crude Oil
In April 2020, WTI crude oil futures went negative on expiry (−$37/barrel). MCX crude did not go negative but had extraordinary volatility. Our ratio adjustment handles this poorly (dividing by a near-zero number produces extreme ratios). We use a floor: if the from_contract price is below ₹100/barrel on roll date, use difference adjustment for that specific roll regardless of the global setting.

### 8.6 Contract Not Yet Listed
Sometimes, when looking ahead, the far-month contract is not yet listed on the exchange (especially for weekly index contracts). Projected roll entries in `futures_roll_calendar` will have `to_contract = NULL` until the exchange lists the contract. The strategy builder must handle this gracefully — if a forward-looking roll entry is incomplete, treat it as unknown rather than raising an error.

---

## 9. Continuous Contracts and Backtesting

The backtest engine reads exclusively from `continuous_contracts`, not from the raw expiry-specific bars in `ohlcv_1min`. This is enforced at the data access layer:

- For instruments with `is_continuous = true` in `instruments_india`: read from `continuous_contracts`
- For instruments with `is_continuous = false` (equities, specific expiry research): read from `ohlcv_1min` or `ohlcv_daily`

**For intraday backtesting (1min/5min bars):** The current `continuous_contracts` table stores daily bars only. For intraday continuous bars, we apply the cumulative adjustment factor from `continuous_contracts` to the raw intraday bars at query time (multiply or add the factor). This is handled by a view or query helper in the backtest engine — the storage layer does not pre-store adjusted intraday bars (too much volume).

---

## 10. Summary: What Gets Built

| Component | Where |
|---|---|
| Roll detection job | Part of Ingestion Pipeline EOD Job 4 |
| Back-adjustment algorithm | Shared library used by both EOD job and backtest engine |
| `continuous_contracts` table | DATA_SCHEMA_INDIA.md |
| `futures_roll_calendar` table | DATA_SCHEMA_INDIA.md |
| Adjusted price → real price converter | Shared utility in Live Executor and Strategy Builder |

---

*See INDIA_MARKETS_SPEC.md for expiry cycle details per instrument.*
*See INGESTION_PIPELINE_SPEC.md for EOD job scheduling.*
*See DATA_SCHEMA_INDIA.md for full table definitions.*
