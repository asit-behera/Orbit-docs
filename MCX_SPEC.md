# MCX Specification

Reference document for the Multi Commodity Exchange (MCX) segment. Covers all tradeable instruments, physical delivery rules, USD exposure mechanics, margin structure, evening session behaviour, and holiday calendar specifics.

The Go implementation of MCX trading rules lives in `SEGMENT_MODULES.md` (CommodityModule). This document is the authoritative source for *why* those rules exist and what the business/market context behind them is.

---

## 1. Exchange Overview

MCX (Multi Commodity Exchange of India) is India's largest commodity derivatives exchange by volume. It is regulated by SEBI (since 2015, when FMC was merged into SEBI). All contracts on MCX are futures — there are no equity-style cash contracts.

Key differences from NSE:

| Dimension | NSE F&O | MCX |
|---|---|---|
| Regulator | SEBI | SEBI |
| Settlement | Cash-settled (index) / Physical (some stocks) | Cash or Physical depending on contract |
| Trading hours | 09:15 – 15:30 IST | 09:00 – 23:30 IST |
| Expiry rule | Last Thursday of month / weekly Thu | 20th of expiry month (or prior trading day) |
| Price driver | Company fundamentals + macro | International benchmarks × INR/USD |
| Holiday calendar | NSE list | MCX list (partially overlapping) |
| Margin model | SPAN + Exposure | SPAN + Exposure (different parameters) |

---

## 2. Tradeable Instruments

### 2.1 Precious Metals

#### Gold (GOLD / GOLD-I continuous)

| Field | Value |
|---|---|
| Lot size | 1 kg |
| Quote unit | Per 10 grams |
| Tick size | ₹1 per 10 grams |
| Physical delivery | Yes — 995 purity gold bars |
| Delivery centres | Ahmedabad, Mumbai, Delhi, Chennai, Hyderabad, Kolkata |
| International benchmark | COMEX Gold (GC) |
| Expiry | 20th of expiry month |
| Active months | February, April, June, August, October, December |
| Typical margin | 4–6% of contract value |

**Delivery risk:** Gold contracts that are not closed before the tender period (3 days before expiry) can result in physical delivery obligation. 1 kg of gold at current prices is approximately ₹70–80 lakh. This is a real financial and logistical risk. **Hard block: close all Gold positions at least 3 days before expiry.**

#### Gold Mini (GOLDM / GOLDM-I continuous)

| Field | Value |
|---|---|
| Lot size | 100 grams |
| Quote unit | Per 10 grams |
| Tick size | ₹1 per 10 grams |
| Physical delivery | Yes — same as Gold but smaller |
| Notes | Lower margin, more accessible for smaller accounts |

#### Silver (SILVER / SILVER-I continuous)

| Field | Value |
|---|---|
| Lot size | 30 kg |
| Quote unit | Per kg |
| Tick size | ₹1 per kg |
| Physical delivery | Yes — 999 purity silver bars |
| International benchmark | COMEX Silver (SI) |
| Expiry | 20th of expiry month |
| Active months | March, May, July, September, December |
| Typical margin | 5–8% of contract value |

**Delivery risk:** 30 kg of silver at current prices is approximately ₹2.5–3 lakh per lot. Delivery involves certified vault storage. **Hard block: close all Silver positions at least 3 days before expiry.**

#### Silver Mini (SILVERM / SILVERM-I continuous)

| Field | Value |
|---|---|
| Lot size | 5 kg |
| Quote unit | Per kg |
| Tick size | ₹1 per kg |
| Physical delivery | Yes |
| Notes | Lower margin entry point for silver trading |

---

### 2.2 Energy

#### Crude Oil (CRUDEOIL / CRUDEOIL-I continuous)

| Field | Value |
|---|---|
| Lot size | 100 barrels |
| Quote unit | Per barrel (in INR) |
| Tick size | ₹1 per barrel |
| Physical delivery | No — cash settled |
| International benchmark | NYMEX WTI Crude (CL) |
| Expiry | 20th of expiry month (or prior trading day) |
| Active months | All months |
| Typical margin | 5–8% of contract value |
| USD sensitivity | High — MCX Crude = NYMEX WTI × USD/INR |

**USD exposure note:** A 1% move in USD/INR with no change in NYMEX WTI still moves MCX Crude by approximately 1%. Strategies on Crude Oil carry implicit forex exposure.

#### Natural Gas (NATURALGAS / NATURALGAS-I continuous)

| Field | Value |
|---|---|
| Lot size | 1250 mmBtu |
| Quote unit | Per mmBtu (in INR) |
| Tick size | ₹0.10 per mmBtu |
| Physical delivery | No — cash settled |
| International benchmark | NYMEX Henry Hub Natural Gas (NG) |
| Expiry | 25th of preceding month (unique expiry rule) |
| Active months | All months |
| Typical margin | 6–10% of contract value — very volatile |
| USD sensitivity | High |

**Volatility note:** Natural Gas is the most volatile instrument we trade. ATR-based position sizing is mandatory. Intraday moves of 3–5% are common; on inventory report days (US EIA weekly), moves of 8–12% occur.

---

### 2.3 Base Metals

#### Copper (COPPER / COPPER-I continuous)

| Field | Value |
|---|---|
| Lot size | 2.5 MT (metric tonnes) |
| Quote unit | Per kg |
| Tick size | ₹0.05 per kg |
| Physical delivery | Yes — Grade A copper cathodes |
| International benchmark | LME Copper |
| Expiry | Last day of expiry month |
| Active months | All months |
| Typical margin | 4–6% |
| USD sensitivity | Moderate — LME is USD-denominated |

#### Zinc (ZINC / ZINC-I continuous)

| Field | Value |
|---|---|
| Lot size | 5 MT |
| Quote unit | Per kg |
| Tick size | ₹0.05 per kg |
| Physical delivery | Yes |
| International benchmark | LME Zinc |
| Expiry | Last day of expiry month |
| Typical margin | 4–6% |

#### Aluminium (ALUMINIUM / ALUMINIUM-I continuous)

| Field | Value |
|---|---|
| Lot size | 5 MT |
| Quote unit | Per kg |
| Tick size | ₹0.05 per kg |
| Physical delivery | Yes |
| International benchmark | LME Aluminium |
| Expiry | Last day of expiry month |
| Typical margin | 3–5% — lower volatility than other metals |

---

## 3. Physical Delivery — Rules and Risk Management

Physical delivery is the most operationally significant risk in the MCX segment. The following rules are non-negotiable.

### 3.1 Which Contracts Have Delivery Risk

| Instrument | Delivery Risk | Delivery Unit |
|---|---|---|
| Gold | **HIGH** | 1 kg gold bar (995 purity) |
| Gold Mini | **MEDIUM** | 100g gold bar |
| Silver | **HIGH** | 30 kg silver bar (999 purity) |
| Silver Mini | **MEDIUM** | 5 kg silver bar |
| Copper | **MEDIUM** | 2.5 MT copper cathode |
| Zinc | **LOW** | 5 MT zinc ingot |
| Aluminium | **LOW** | 5 MT aluminium ingot |
| Crude Oil | **NONE** | Cash settled |
| Natural Gas | **NONE** | Cash settled |

### 3.2 Tender Period

The tender period begins 3 trading days before the contract expiry date. Once a position enters the tender period, it may be marked for delivery by the exchange. Closing a position after tender period begins still requires paying delivery charges.

**Our rule: Close all positions with physical delivery risk at least 3 trading days before expiry. This is enforced as HARD_IRREVOCABLE in CommodityModule.PreTradeChecks.**

### 3.3 Delivery Margin

During the tender period, exchanges impose additional delivery margins (often 15–25% of contract value on top of regular SPAN margins). This means margin requirements can spike 3–4× in the last few days before expiry. Even if we intended to close the position, if margin spikes first, we could receive a margin call. The 3-day hard block prevents this.

### 3.4 How the Hard Block Works

```
CommodityModule.PreTradeChecks():
  daysToExpiry = instrument.ExpiryDate - today
  
  if instrument.HasPhysicalDelivery AND daysToExpiry <= 3:
    return HARD_IRREVOCABLE violation: "MCX_DELIVERY_BLOCK"
    // Cannot open new positions
    // Existing positions: Core's MIS squareoff goroutine handles forced close
    // No config, API, or operator action can bypass this
```

The hard block applies to **opening new positions only**. The `HandleExpiry()` method handles closing existing positions that are within the tender period.

---

## 4. USD Exposure and INR Conversion

### 4.1 Why MCX Prices Carry USD Risk

MCX commodity prices are derived from international benchmarks priced in USD:

```
MCX Gold Price (INR) ≈ COMEX Gold Price (USD/troy oz)
                        × (troy oz per 10g conversion)
                        × USD/INR rate
                        ± India import premium/discount
```

This means a strategy on MCX Gold is implicitly:
- Long Gold (in USD terms)
- Long USD/INR (since INR weakness increases MCX prices)

A Gold position that is flat on COMEX will still show P&L if INR moves.

### 4.2 Impact on Strategy Design

Strategies built purely on MCX price action implicitly include USD/INR exposure. This is a feature, not a bug — MCX Gold is one of the most reliable USD/INR proxies in Indian markets.

However, strategies that simultaneously hold MCX Crude + MCX Gold + USDINR forex positions have **compounded USD exposure**. The Risk Engine and Allocator should be aware of this correlation.

**Current system handling:** The `instruments_india` table has a `price_multiplier` field and a flag for USD-denominated contracts. The CommodityModule uses this for margin calculations. Explicit USD correlation tracking is a future enhancement.

### 4.3 INR Conversion for P&L

When calculating realised P&L for MCX energy and metals:
```
P&L (INR) = (Exit Price - Entry Price) × Lot Size × price_multiplier
```

No separate currency conversion step is needed — MCX prices are already quoted in INR. The USD exposure is baked into the price itself.

---

## 5. Trading Hours and Session Rules

### 5.1 Session Structure

```
Morning Session:   09:00 – 17:00 IST
Evening Session:   17:00 – 23:30 IST
Holiday Eve:       09:00 – 17:00 IST (no evening session)
```

The evening session is the primary session for energy and metals because it overlaps with European and US market hours. Natural Gas, Crude Oil, and Gold see their highest MCX volumes between 18:00–23:00 IST when NYMEX and COMEX are active.

### 5.2 Forced Exit Time

```
Regular trading day:  23:00 IST (30 minutes before close)
Holiday eve:          16:30 IST (30 minutes before early close)
```

The 30-minute buffer before close protects against thin end-of-session liquidity and prevents orders from being rejected due to market close timing.

### 5.3 Holiday Eve Detection

MCX defines its own list of "holiday eves" — days when the evening session is cancelled. These are typically the day before a major national holiday. This list is separate from the exchange holiday list (days when MCX is fully closed).

**Example:** If December 25th is a full MCX holiday, December 24th is a holiday eve — evening session ends at 17:00 on the 24th.

Our `market_holidays` table has a `trading_session` field that captures this:
- `FULL` — exchange is closed
- `MUHURAT` — special NSE Diwali session (NSE-specific)
- `EARLY_CLOSE_MCX` — MCX holiday eve, close at 17:00

The ingestion service and CommodityModule both read this table to determine correct closing times.

### 5.4 Implications for the Ingestion Service

The ingestion service runs from 08:55 IST to 23:35 IST on regular trading days. For NSE-only days where MCX is closed, the ingestion service can stop at 15:35 IST. The service startup logic checks both exchange calendars independently.

---

## 6. Margin Structure

### 6.1 SPAN + Exposure Model

MCX uses the same SPAN + Exposure margin model as NSE F&O, but with different parameters calibrated to commodity volatility.

```
Total Margin = SPAN Margin + Exposure Margin

SPAN Margin:     Risk-based, calculated by MCX's SPAN algorithm
                 Accounts for price risk, volatility, and scenario-based losses
                 
Exposure Margin: Additional buffer — typically 1–5% of contract value
                 Set by MCX, may vary by commodity
```

Typical ranges (approximate, subject to change):

| Instrument | SPAN (% of value) | Exposure (% of value) | Total |
|---|---|---|---|
| Gold | 3–4% | 1% | 4–5% |
| Silver | 4–5% | 2% | 6–7% |
| Crude Oil | 4–6% | 2% | 6–8% |
| Natural Gas | 5–8% | 3% | 8–11% |
| Copper | 3–4% | 1% | 4–5% |
| Zinc | 3–4% | 1% | 4–5% |

### 6.2 Intraday Margin Refresh

MCX updates margin requirements intraday, typically at 12:30 IST and on significant price moves. The ingestion service triggers a margin refresh job at 12:30 IST, which updates the `instruments_india` table and Redis cache.

If a position is open and margins increase intraday (common during high-volatility events), the Risk Engine checks available margin on each new order. The existing open position is not auto-squared unless the broker issues a margin call — that is handled by Zerodha's own systems.

---

## 7. Holiday Calendar

MCX publishes its annual holiday list independently from NSE. The two lists overlap significantly (national holidays) but diverge on:

- Some NSE holidays are not MCX holidays (e.g., certain regional bank holidays)
- Some MCX holidays are not NSE holidays (rare, but occurs)
- MCX has holiday eves (early close at 17:00) that NSE does not

**Sources:**
- MCX official: `mcxindia.com/market-data/holiday-calendar`
- Updated annually in January
- TrueData also reflects holiday closures (no ticks on closed days)

**Our system:**
- `market_holidays` table has a per-exchange `exchange` field
- MCX holiday eves are stored as separate rows with `trading_session = 'EARLY_CLOSE_MCX'`
- Refreshed manually at start of each calendar year + spot-checked mid-year

---

## 8. Continuous Contracts for MCX

MCX contracts roll on the 20th of the expiry month (or prior trading day). This differs from NSE F&O's last-Thursday roll. The continuous contract construction follows the same OI-migration method described in `CONTINUOUS_CONTRACTS_SPEC.md`, with one difference:

**Roll trigger for MCX:** Volume and OI typically migrate from the front-month to next-month contract around the 15th–18th of the expiry month (3–5 days before the 20th). The OI-migration detection in the continuous contracts job handles this correctly — no special MCX-specific logic is needed.

**Commodity-specific quirk:** Natural Gas expiry is the 25th of the *preceding* month (not the expiry month). For example, the January Natural Gas contract expires on December 25th. The `instruments_india` table stores the correct expiry date per contract — the continuous contract logic uses that date, not a computed rule.

---

## 9. What This Means for Our System

| Implication | Affected Component |
|---|---|
| Physical delivery block is HARD_IRREVOCABLE | CommodityModule.PreTradeChecks |
| Evening session requires ingestion service until 23:35 IST | Ingestion Pipeline |
| Forced exit at 23:00 IST (30min buffer) | CommodityModule.ForcedExitTime |
| Holiday eve ends evening session at 17:00 | CommodityModule.MarketClose + market_holidays table |
| MCX margin changes intraday | Instruments refresh job at 12:30 IST |
| USD exposure is implicit in all MCX energy + metals | Risk Engine, Allocator correlation tracking (future) |
| Natural Gas expiry is 25th of preceding month | instruments_india expiry_date field |
| Lot sizes and tick sizes are instrument-specific | Always read from instruments_india, never hardcode |
| Delivery margins spike 3–4× in tender period | 3-day hard block prevents margin call risk |

---

*See SEGMENT_MODULES.md for Go implementation of CommodityModule.*
*See DATA_SCHEMA_INDIA.md for instruments_india table design.*
*See CONTINUOUS_CONTRACTS_SPEC.md for roll handling.*
*See INGESTION_PIPELINE_SPEC.md for session lifecycle management.*
