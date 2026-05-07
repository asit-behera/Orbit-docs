# Ingestion Pipeline Specification

This document defines the design of the data ingestion service that connects to TrueData, receives live tick data, and writes it to our TimescaleDB database. It covers the full service lifecycle from pre-market startup through post-market shutdown, including data validation, bar aggregation, and end-of-day jobs.

---

## 1. Service Overview

The ingestion service is a **long-running Python process** that operates continuously from pre-market startup (08:55 IST) to post-market shutdown (23:35 IST on weekdays). It is the single point of entry for all live market data into our system.

**What it does:**
- Maintains a persistent WebSocket connection to TrueData
- Subscribes to all active instruments from the `instruments_india` table
- Receives, validates, and buffers incoming ticks
- Flushes ticks to TimescaleDB every 500 milliseconds
- Aggregates ticks into 1-minute OHLCV bars in real-time
- Monitors its own health and reconnects on failure
- Runs end-of-day jobs after market close

**What it does not do:**
- Generate trading signals (that is the Strategy Builder and Backtest Engine)
- Place orders (that is the Live Executor)
- Serve data to other services directly (other services read from the database)

**Why not Cloud Run:** Cloud Run is serverless — it spins up on request and shuts down after inactivity. A WebSocket feed requires a persistent, always-on process. This service runs on a small dedicated Compute Engine VM (e2-small is sufficient: 2 vCPUs, 2 GB RAM).

---

## 2. Service Lifecycle

### 2.1 Pre-Market Startup (08:55 IST)

This phase happens before any market opens. Sequence:

```
1. Read TrueData credentials from Google Secret Manager
2. Load active instrument list from instruments_india table
   - Filter: is_active = true
   - Include: all segments (NSE EQ, NSE F&O, MCX)
   - Include: both continuous AND specific expiry contracts for derivatives
3. Refresh instruments_india from exchange symbol master files
   - NSE bhavcopy and symbol master (available by 08:30 IST)
   - MCX symbol master
   - Update lot sizes, tick sizes, new expiries
4. Check market_holidays table for today
   - If NSE holiday: skip NSE subscriptions
   - If MCX holiday: skip MCX subscriptions
   - If both: log and exit (no markets open today)
5. Establish WebSocket connection to TrueData
6. Authenticate
7. Send subscription requests for all active symbols (batched)
8. Wait for subscription confirmations
9. Log: "Ingestion service ready. Subscribed to N symbols."
10. Begin receiving ticks
```

Startup must complete before 09:00 IST (5 minutes before MCX opens) to ensure no ticks are missed from MCX morning session open.

### 2.2 Market Hours (09:00 – 23:30 IST)

Normal operation. Three concurrent loops run in parallel:

**Loop A — Tick Receiver (continuous):**
Receives tick messages from TrueData WebSocket. Each tick is:
1. Parsed from TrueData's message format
2. Validated (see Section 4)
3. Written to an in-memory tick buffer
4. Logged to a local ring buffer for replay detection

**Loop B — Tick Flusher (every 500ms):**
Every 500 milliseconds:
1. Drain the in-memory tick buffer
2. Deduplicate within the batch (same symbol + timestamp + sequence = discard)
3. Bulk-insert into `ticks` table (upsert on conflict)
4. Clear the buffer
5. Update Redis: `last_tick_time:{symbol}` → current timestamp (used by risk monitor and paper trader for stale data detection)

**Loop C — Bar Aggregator (every minute at :00 seconds):**
At each minute boundary:
1. Query ticks from the previous minute window for all active symbols
2. Aggregate into OHLCV bar (open = first tick LTP, high = max, low = min, close = last tick LTP, volume = sum of LTQ)
3. Calculate VWAP for the bar
4. Write to `ohlcv_1min` (upsert — bars may be updated if late ticks arrive)
5. Mark previous bar as `is_complete = true`

**Loop D — Health Monitor (every 10 seconds):**
1. Check last heartbeat time from TrueData
2. If no heartbeat for 10 seconds: trigger reconnection (see Section 5)
3. Check tick receive rate: if rate drops below expected minimum for active market hours, log a warning
4. Emit health metrics to Prometheus

### 2.3 Session Transitions

**NSE Pre-Open (09:00–09:15):**
Ticks arrive from TrueData but are tagged `is_pre_open = true`. They are stored in `ticks` but are NOT included in bar aggregation. No strategy signals should be generated from pre-open data.

**NSE Market Open (09:15):**
The first bar of the day begins. Bar aggregator starts including ticks in OHLCV aggregation.

**NSE Market Close (15:30):**
The service continues running for MCX. NSE ticks stop arriving naturally. The 15:30 bar is completed and marked as the last NSE bar of the day. After-market data (if any) is tagged separately.

**MCX Morning to Evening Transition (17:00):**
MCX has a brief gap at 17:00 as it transitions sessions. This is expected. The data gap logger is suppressed for a 5-minute window around 17:00 IST for MCX symbols to avoid false gap alerts.

**MCX Evening Close (23:30):**
Last MCX ticks arrive. Final bars are completed. End-of-day jobs begin (see Section 6).

### 2.4 Post-Market Shutdown (after 23:35 IST)

After markets close:
1. Run end-of-day jobs (Section 6)
2. Flush any remaining tick buffer
3. Close WebSocket connection gracefully
4. Log daily summary (symbols received, tick count, gap count, any errors)
5. Process exits cleanly

The VM itself stays running 24/7. The process is managed by a systemd service that restarts it automatically if it crashes, and is scheduled via Cloud Scheduler to start fresh each morning.

---

## 3. Subscription Management

### 3.1 What We Subscribe To

For each active instrument in `instruments_india`:
- **NSE EQ:** All equity symbols we intend to trade or use as universe
- **NSE F&O:** Both near-month and next-month expiry contracts for index futures + continuous contract symbols (`NIFTY-I`, `BANKNIFTY-I`)
- **MCX:** Near-month contracts for all active commodities + continuous contract symbols (`GOLD-I`, `CRUDEOIL-I`)

### 3.2 Symbol Count Budget

Our Ultima plan allows 700 symbols per segment. Rough allocation:

| Segment | Allocation |
|---|---|
| NSE EQ | ~300 symbols (Nifty 500 universe) |
| NSE F&O | ~150 symbols (50 stock futures × 3 expiries + index futures + continuous) |
| MCX | ~50 symbols (all liquid commodities across near + next expiry + continuous) |

This leaves headroom for adding new instruments without hitting limits.

### 3.3 Dynamic Subscription Updates

When the instrument list changes (new expiry contracts become active, old ones expire), the service handles it without restart:
- On each pre-market startup: subscription list is re-derived from `instruments_india`
- New symbols are subscribed on the fly
- Expired contract symbols are unsubscribed to free up the symbol count budget

---

## 4. Data Validation

Every tick passes through a validation pipeline before being written to the database. Validation is fast (microseconds per tick) — it does not block the data flow.

### 4.1 Duplicate Detection
- Check: (symbol, timestamp, source_sequence) already seen in the last 60-second ring buffer
- Action if duplicate: set `is_duplicate = true`, still write to DB (for audit trail), but exclude from bar aggregation

### 4.2 Price Outlier Detection
- Check: LTP is more than 20% away from the previous close for that symbol
- Action: flag the tick, write to DB, log a warning, do NOT include in bar aggregation
- Exception: if a circuit breaker event has been detected (price at circuit limit), suspend this check for that symbol

### 4.3 Stale Tick Detection
- Check: LTP and volume are identical to the previous tick for the same symbol AND timestamp difference is more than 5 seconds
- Action: flag as potential stale data, write to DB, emit a warning
- Note: during pre-open and illiquid MCX early-morning periods, this check is relaxed

### 4.4 Volume Consistency
- Check: Cumulative volume in current tick is less than cumulative volume in the previous tick for the same symbol and trading day
- Action: This should never happen (volume can only increase). If it does, it is a feed error. Flag and log. Do not update the bar's volume with a lower value.

### 4.5 OI Spike Detection
- Check: OI changes by more than 50% in a single tick compared to the previous OI reading
- Action: Flag for review, still write. OI spikes occasionally happen at expiry during physical settlement but should be rare intraday.

### 4.6 Circuit Breaker Recognition
- Check: LTP equals the upper circuit limit or lower circuit limit for the symbol (from `instruments_india.circuit_limit_pct`)
- Action: Log a circuit_halt event in `data_gaps` with resolution = 'circuit_halt'. Do not treat as a data error. Some strategies may use circuit hits as signals.

### 4.7 Pre-Open Tag
- Check: Timestamp is between 09:00:00 and 09:14:59 IST for NSE symbols
- Action: Set `is_pre_open = true`. Exclude from bar aggregation entirely.

---

## 5. Reconnection Protocol

Reconnection is triggered by: no heartbeat for 10 seconds, WebSocket close frame received, or any unhandled exception in the tick receiver loop.

### Reconnection Sequence:
1. Stop all loops except the health monitor
2. Log disconnection event with timestamp
3. Attempt reconnection with exponential backoff (5s → 10s → 20s → 40s → 60s, then every 60s)
4. On successful reconnection: re-authenticate, re-subscribe all symbols
5. Request tick replay for the gap period (if within 20-day window):
   - For each subscribed symbol: request ticks from `last_received_tick_time` to `now`
   - TrueData delivers replay at live-feed rate
   - Replay ticks are tagged with source = 'replay'
6. Resume normal operation
7. Log reconnection with gap duration and symbols affected
8. Write a `data_gaps` row for the outage period

### What happens to bar aggregation during a gap:
- Any bar that was being built at disconnection time is marked incomplete
- When replay arrives, incomplete bars are re-aggregated with the replayed ticks
- If no replay is available (gap > 20 days, or TrueData does not have replay for that symbol), the bar is marked incomplete permanently

---

## 6. End-of-Day Jobs

These run sequentially after MCX closes (23:30 IST). Total expected runtime: 15–30 minutes.

### Job 1: EOD Bar Finalization
- For every symbol, mark the last bar of the day as `is_complete = true`
- Calculate daily OHLCV from the full day's 1-minute bars and write to `ohlcv_daily`
- Compare our computed daily OHLCV with TrueData's reference daily bar (sanity check — if more than 0.5% discrepancy, flag for review)

### Job 2: Data Gap Report
- For each symbol, compare expected tick timestamps (every ~100ms during market hours) against actual tick count
- Identify any minutes with zero ticks during market hours (excluding pre-open and known circuit halts)
- Write all identified gaps to `data_gaps` table
- Emit a daily gap summary metric to Prometheus

### Job 3: OI EOD Snapshot
- For all F&O and MCX symbols, write end-of-day OI values to `open_interest` with source = 'eod'
- This ensures backtesting always has clean EOD OI even if intraday ticks had gaps

### Job 4: Continuous Contract Update
- Run the roll detection logic (see CONTINUOUS_CONTRACTS_SPEC.md)
- If a roll is detected, trigger the back-adjustment update for the affected symbol
- Write updated continuous price series to `continuous_contracts`

### Job 5: Instruments Master Refresh
- Download fresh NSE bhavcopy for the day
- Download MCX symbol master
- Update `instruments_india` with any new expiries added or expired contracts marked inactive
- Log any lot size changes (these are rare but important)

### Job 6: TimescaleDB Compression
- Compress chunks older than 7 days in `ticks`
- Compress chunks older than 30 days in `ohlcv_1min`
- Log compression ratios (expected: 85–95%)

### Job 7: Archival Check
- Identify chunks older than 90 days in `ticks` and older than 2 years in `ohlcv_1min`
- Export these chunks to Parquet files on GCS
- Delete the exported chunks from TimescaleDB
- Update archive manifest (a simple table tracking which dates are in Parquet)

---

## 7. Performance Targets

| Metric | Target |
|---|---|
| Tick processing latency (receive to buffer) | < 5ms |
| Tick flush latency (buffer to DB) | < 50ms per batch |
| Tick throughput (peak market open) | 10,000 ticks/second |
| Bar aggregation latency (after minute close) | < 200ms |
| Memory usage (in-memory tick buffer) | < 500 MB |
| Reconnection time | < 60 seconds |
| Pre-market startup time | < 5 minutes |
| EOD job total runtime | < 30 minutes |

---

## 8. Monitoring and Alerting

The ingestion service emits Prometheus metrics that are visible in Grafana.

| Metric | Alert Threshold |
|---|---|
| ticks_received_per_minute | Alert if < 100 during NSE market hours |
| websocket_connected | Alert if 0 for more than 60 seconds during market hours |
| tick_flush_lag_ms | Alert if > 2000ms (2 seconds) |
| symbols_subscribed | Alert if drops below 90% of expected count |
| gap_count_today | Alert if > 5 gaps per symbol per day |
| eod_jobs_completed | Alert if any EOD job fails or takes > 60 minutes |

---

## 9. Operational Runbook Summary

| Situation | Action |
|---|---|
| Service crashes during market hours | systemd auto-restarts; replays gap on reconnect |
| VM goes down | Cloud Monitoring alert; restart VM; replay available for up to 20 days |
| TrueData is down | Log, retry; check TrueData status page; nothing we can do except wait |
| Gap in data after reconnect | Run manual gap fill using TrueData historical API for bars; tick-level may be irrecoverable |
| Lot size change in instruments master | Daily refresh catches it; all live strategies must re-validate sizing |
| New expiry contract added | Daily instruments refresh subscribes it automatically |
| Expiry day (monthly/weekly) | Increased volatility around 15:30; close-to-expiry contracts will stop ticking at settlement |

---

*See TRUEDATA_SPEC.md for WebSocket connection details.*
*See DATA_SCHEMA_INDIA.md for database table definitions.*
*See CONTINUOUS_CONTRACTS_SPEC.md for roll detection and adjustment.*
