# Data Schema — India Markets

Database design for storing tick data, OHLCV bars, open interest, instruments, and continuous contracts for NSE EQ, NSE F&O, and MCX. This extends the existing PostgreSQL schema described in ARCHITECTURE.md.

---

## 1. Why TimescaleDB

The existing architecture uses plain PostgreSQL. For Indian market data, we extend it with the **TimescaleDB extension** — not a new database, not a new server, just an extension installed on the existing PostgreSQL instance.

**The problem with plain PostgreSQL for tick data:**

A single active trading day generates approximately 50–100 million ticks across all subscribed symbols. Over 6 months, this grows to 6–12 billion rows in a single table. Standard PostgreSQL tables degrade severely at this scale — query times on indexed timestamp lookups go from milliseconds to seconds, and table maintenance (vacuuming, autovacuum) becomes a background burden.

**What TimescaleDB adds:**

TimescaleDB automatically partitions time-series tables into time-based chunks (called hypertables). Each chunk covers a fixed time window (we use 1 day for ticks, 1 week for bars). The database then:
- Only scans relevant time chunks for any given query (instead of the full table)
- Compresses old chunks (achieving 90–95% storage reduction on tick data)
- Maintains standard PostgreSQL SQL interface — no query language changes
- Runs on the same PostgreSQL instance — no additional infrastructure

**What does not change:**
- All existing tables in ARCHITECTURE.md remain unchanged
- Same Cloud SQL PostgreSQL instance
- Same connection strings, same ORM, same everything for non-time-series tables
- Only the new India market tables are TimescaleDB hypertables

---

## 2. Table Inventory

| Table | Type | Purpose |
|---|---|---|
| `instruments_india` | Regular | Master list of all tradeable symbols with metadata |
| `ticks` | Hypertable | Raw tick data from TrueData |
| `ohlcv_1min` | Hypertable | 1-minute aggregated OHLCV bars |
| `ohlcv_5min` | Hypertable | 5-minute bars (derived from 1min) |
| `ohlcv_15min` | Hypertable | 15-minute bars (derived from 1min) |
| `ohlcv_daily` | Regular | End-of-day bars (backfilled 11+ years) |
| `open_interest` | Hypertable | OI snapshots for F&O and MCX |
| `continuous_contracts` | Regular | Roll-adjusted continuous price series |
| `futures_roll_calendar` | Regular | Historical and projected roll dates |
| `market_holidays` | Regular | Per-exchange holiday list |
| `data_gaps` | Regular | Log of detected gaps and outages |
| `india_vix` | Regular | India VIX daily values |

---

## 3. Table Designs

### 3.1 instruments_india

The master reference table. Every symbol we ingest or trade must have a row here. This table is the authoritative source for lot sizes, tick sizes, expiry dates, and symbol name mappings.

**Fields:**

| Field | Purpose |
|---|---|
| symbol_truedata | Symbol string as used by TrueData (used for subscriptions) |
| symbol_exchange | Symbol string as used by the exchange (used for order placement) |
| exchange | NSE or MCX |
| segment | EQ, FNO, or MCX |
| instrument_type | EQ (equity), FUT (future), OPT (option — for reference only) |
| underlying | Parent symbol (e.g., NIFTY is underlying of NIFTY25MAYFUT) |
| expiry_date | Expiry date for derivatives; null for equity |
| lot_size | Minimum tradeable quantity; critical for position sizing |
| tick_size | Minimum price movement (e.g., 0.05 for Nifty) |
| price_multiplier | Multiplier for P&L calculation (usually 1, but differs for some MCX) |
| is_continuous | True if this is a rolled continuous contract symbol |
| is_active | False if expired or delisted; old rows are kept for backtest integrity |
| circuit_limit_pct | Price band for equities (5, 10, or 20) |
| margin_pct_approx | Approximate SPAN margin as % of contract value (for sizing estimates) |
| physical_delivery_risk | True for MCX contracts that can go to delivery |
| last_updated | When this row was last refreshed from exchange symbol master |

**Update frequency:** NSE publishes a symbol master file daily before market open (bhavcopy). MCX does the same. The instruments table should be refreshed daily at 08:30 IST as part of pre-market startup.

**Why keep expired contracts:** Backtesting requires knowing the exact lot size and tick size that was in effect on a historical date. Lot sizes change — Nifty's lot was 75 until SEBI changed it to 25 in 2024. If we delete expired contracts, backtests on historical data will use wrong lot sizes.

---

### 3.2 ticks

The raw tick store. Every tick received from TrueData is written here.

**Fields:**

| Field | Purpose |
|---|---|
| time | Event timestamp (millisecond precision, IST) — **partition key** |
| symbol | TrueData symbol string |
| ltp | Last traded price |
| ltq | Last traded quantity |
| volume | Cumulative day volume at this tick |
| oi | Open interest (null for EQ) |
| bid | Best bid price (Ultima plan provides this) |
| ask | Best ask price (Ultima plan provides this) |
| day_open | Day open price |
| day_high | Day high so far |
| day_low | Day low so far |
| prev_close | Previous day close |
| atp | Average traded price (VWAP) |
| is_pre_open | True if tick is from 09:00–09:15 pre-open session |
| is_duplicate | True if this tick was flagged as a duplicate on ingestion |
| source_sequence | Sequence number from TrueData (for ordering within same millisecond) |

**Hypertable configuration:**
- Chunk interval: 1 day (one partition per calendar day)
- Compression: Enabled after 7 days (ticks older than 7 days are compressed)
- Retention in hot store: 90 days (compressed chunks beyond 90 days are moved to Parquet archive)
- Primary index: (time, symbol) — covers the most common query pattern: "give me all ticks for NIFTY-I from 09:15 to 10:00 today"
- Secondary index: (symbol, time) — covers symbol-first lookups

**Why 90-day hot retention:** Strategy signal generation and same-day monitoring need fast tick access. Beyond 90 days, tick-level data is primarily needed for microstructure research, which can tolerate Parquet retrieval latency.

**Duplicate handling:** The ingestion service may deliver duplicate ticks on reconnection. The database uses an upsert pattern (INSERT ... ON CONFLICT DO NOTHING) on the (symbol, time, source_sequence) composite key. The `is_duplicate` field is set by the ingestion service before writing, not enforced at DB level.

---

### 3.3 ohlcv_1min

1-minute OHLCV bars aggregated from raw ticks. This is the primary resolution for intraday strategy backtesting and signal generation.

**Fields:**

| Field | Purpose |
|---|---|
| time | Bar open time (e.g., 09:15:00 for the 09:15 bar) — partition key |
| symbol | Symbol string |
| open | First tick LTP of the minute |
| high | Max LTP during the minute |
| low | Min LTP during the minute |
| close | Last tick LTP of the minute |
| volume | Sum of LTQ during the minute |
| oi | OI at bar close (null for EQ) |
| oi_change | OI change during the bar (null for EQ) |
| vwap | Volume-weighted average price for the bar |
| tick_count | Number of ticks in this bar (data quality indicator — very low = illiquid) |
| is_complete | False if bar is still forming (current minute); True once the minute closes |
| source | 'live' (from tick aggregation) or 'truedata_api' (backfilled from TrueData historical API) |

**Aggregation trigger:** The ingestion service runs a bar-close job every minute at :00 seconds. It aggregates all ticks from the previous minute window and writes/updates the completed bar.

**Hypertable configuration:**
- Chunk interval: 1 week
- Compression: After 30 days
- Retention: 2 years in hot store; older data to Parquet

**Bar alignment convention:** All bars are aligned to exchange market open.
- NSE: First bar is 09:15–09:16 (opens at 09:15:00, closes at 09:15:59)
- MCX: First bar is 09:00–09:01
- Pre-open ticks (09:00–09:15 for NSE) are NOT included in any bar

---

### 3.4 ohlcv_5min and ohlcv_15min

Derived from `ohlcv_1min` by aggregating 5 or 15 consecutive 1-minute bars. These are not stored as separate hypertables but as **continuous aggregates** — a TimescaleDB feature where a materialized view is kept up to date automatically as new 1-minute data arrives.

This means:
- We never manually compute 5min or 15min bars
- Querying `ohlcv_5min` is as fast as querying a regular table
- The view refreshes in near real-time (within 1 minute of the underlying 1min bar being written)

**Retention:** Same as ohlcv_1min (2 years hot).

---

### 3.5 ohlcv_daily

End-of-day OHLCV bars. This is our deepest historical data source — 11+ years backfilled from TrueData on Day 1.

**Fields:**

| Field | Purpose |
|---|---|
| date | Trading date (not timestamp) |
| symbol | Symbol string |
| open | Day open |
| high | Day high |
| low | Day low |
| close | Day close |
| volume | Total day volume |
| oi | End-of-day open interest |
| adj_close | Dividend/split adjusted close (provided by TrueData) |
| adj_factor | Cumulative adjustment factor applied to this date |
| deliverable_qty | Quantity taken to delivery (NSE EQ only, from bhavcopy) |
| deliverable_pct | Deliverable as % of total volume (quality of volume signal) |
| source | 'truedata_api' or 'live' |

**Why a regular table (not hypertable):** Daily bars have very low insert volume (one row per symbol per day) and queries are typically full-history range scans for backtesting. TimescaleDB's partitioning adds overhead without benefit at this volume.

**Adjustment notes:** TrueData provides adjusted close prices for splits and dividends. We store both raw OHLCV and the adjusted close separately. The backtest engine must use adjusted prices for signal calculation but raw prices for execution price estimation.

---

### 3.6 open_interest

OI deserves its own table rather than just being a field on OHLCV. OI changes on every trade in F&O and MCX, so its time series is as dense as tick data and carries independent analytical value.

**Fields:**

| Field | Purpose |
|---|---|
| time | Timestamp of OI reading — partition key |
| symbol | Symbol |
| oi | Absolute OI value (number of open contracts) |
| oi_change | Change from previous reading |
| pcr | Put-call ratio at this timestamp (for index symbols, derived from option chain) |
| source | 'tick' (from live feed) or 'eod' (from bhavcopy) |

**Practical use:** We primarily query OI in two ways:
1. End-of-day OI for backtesting (from the `eod` source rows)
2. Intraday OI trend for live signal confirmation (reading from `tick` source rows)

---

### 3.7 market_holidays

| Field | Purpose |
|---|---|
| date | Holiday date |
| exchange | NSE or MCX |
| description | Holiday name (e.g., "Diwali Laxmi Puja") |
| trading_session | FULL (no trading) or MUHURAT (special evening session on Diwali) |
| year | Calendar year (for easy filtering) |

**Note on Muhurat Trading:** Diwali has a special ~1-hour evening trading session called Muhurat Trading on NSE. This is a real trading session but at unusual hours (typically 18:00–19:15 IST). Our ingestion service must handle this as an edge case.

---

### 3.8 data_gaps

A log of every detected gap in our data store. Written by the data quality checker that runs at end of day.

| Field | Purpose |
|---|---|
| symbol | Affected symbol |
| gap_start | Timestamp where data stops |
| gap_end | Timestamp where data resumes |
| gap_duration_minutes | Computed duration |
| resolution | 'replayed' (recovered from TrueData replay), 'permanent' (irrecoverable), 'holiday' (expected), 'circuit_halt' (circuit breaker event) |
| table_affected | ticks, ohlcv_1min, etc. |
| notes | Additional context |

---

## 4. Storage Estimates

These are approximate projections to inform infrastructure sizing.

| Data Type | Daily Volume | 1-Year Total | Compressed |
|---|---|---|---|
| Ticks (all segments, 700 symbols) | ~2 GB/day | ~500 GB | ~30 GB |
| ohlcv_1min | ~50 MB/day | ~18 GB | ~2 GB |
| ohlcv_daily | ~5 MB/day | ~2 GB | ~500 MB |
| open_interest | ~200 MB/day | ~70 GB | ~5 GB |

**Total compressed hot store (1 year):** ~40 GB
**Total uncompressed:** ~600 GB

Given these numbers, a 100 GB Cloud SQL instance is sufficient for 2 years of hot data. Anything beyond 90 days for ticks goes to compressed chunks, and beyond 2 years goes to Parquet on GCS.

---

## 5. Archival Policy

| Table | Hot (TimescaleDB) | Archive (Parquet on GCS) |
|---|---|---|
| ticks | 90 days | Beyond 90 days |
| ohlcv_1min | 2 years | Beyond 2 years |
| ohlcv_5min / 15min | 2 years | Recomputable from 1min |
| ohlcv_daily | Forever (low volume) | Never needed |
| open_interest (intraday) | 90 days | Beyond 90 days |
| open_interest (EOD) | Forever | Never needed |

Archival is run by a Cloud Scheduler job at 02:00 IST, after markets are closed and TimescaleDB compression has run.

---

## 6. Impact on Existing ARCHITECTURE.md

The existing `ohlcv` table in ARCHITECTURE.md remains for US market data (Yahoo, Alpaca, OANDA). India market data is stored in the separate `ticks`, `ohlcv_1min`, and `ohlcv_daily` tables described here. This separation is intentional — the schemas have different fields (OI, lot size context, etc.) and different access patterns.

The `instruments` table in ARCHITECTURE.md is also kept separate from `instruments_india`. The new table has India-specific fields (lot size, circuit limit, physical delivery flag) that don't apply to US equities or forex.

---

*See INGESTION_PIPELINE_SPEC.md for how data flows into these tables.*
*See CONTINUOUS_CONTRACTS_SPEC.md for the continuous_contracts and futures_roll_calendar tables.*
