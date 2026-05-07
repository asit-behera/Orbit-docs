# TrueData Integration Specification

This document defines how our system connects to, subscribes from, and manages the TrueData Velocity data feed. It covers the subscription plan, connection protocol, data format, historical data access, and operational reliability requirements.

---

## 1. Subscription Details

**Plan:** Velocity Ultima
**Segments subscribed:**
- NSE Equity (NSE EQ)
- NSE Futures & Options (NSE F&O)
- MCX (Commodity Futures)

**Add-on:** Additional 400 Symbols (total 400 symbols per segment with multi-segment discount applied)

**Key plan capabilities at Ultima tier:**

| Feature | Velocity Ultima |
|---|---|
| Default Tick History (in feed) | 20 Trading Days |
| Adjusted EOD Daily History | 11+ Years |
| Adjusted 1-Minute History | 1.5 Months |
| Symbol Count (single segment) | 300 |
| Symbol Count (with add-on) | 700 per segment |
| Open Interest as Indicator | Yes |
| Bid/Ask as Indicator | Yes |
| Simultaneous Continuous + Contract Futures | Yes |
| PC Licenses | 3 PCs (any 1 active at a time) |
| After-Market Data | Yes |
| Minimum Internet Speed | 8 Mbps recommended |

**Why Ultima over lower tiers:**
- 20-day tick history means we can recover missed ticks after downtime without requesting a replay API separately
- 11+ years of EOD history is sufficient for robust strategy backtesting
- Simultaneous continuous + contract futures is essential — we need both the rolled continuous series for backtesting and the actual contract for live execution
- 3 PC licenses gives operational flexibility (primary server + backup + development machine)

---

## 2. Connection Architecture

TrueData Velocity delivers live data via a **WebSocket connection**. This is a persistent, full-duplex TCP connection that pushes data to our ingestion service without polling.

```
TrueData Server
      |
      | WebSocket (wss://)
      |
Ingestion Service (our Python service)
      |
      ├── Tick buffer (in-memory, 500ms flush)
      |
      └── TimescaleDB (persistent storage)
```

**Connection endpoint:** TrueData provides a dedicated WebSocket URL upon subscription. This URL is environment-specific and must be stored in Google Secret Manager, never in code or config files.

**Authentication:** TrueData uses username + password authentication at connection time. Credentials are exchanged during the WebSocket handshake. A session token is returned and used for the duration of the session.

**Session persistence:** A single WebSocket session is expected to remain alive for the entire trading day. TrueData does not require reconnection at segment boundaries (e.g., when MCX evening session begins, the same connection continues delivering MCX data).

---

## 3. Subscription Model

After establishing the WebSocket connection, the ingestion service sends subscription requests specifying which symbols to receive data for.

**Subscription granularity:** Per symbol. You subscribe to individual symbols, not segments wholesale.

**What this means operationally:**
- On startup, the service reads our `instruments_india` table to get the active symbol list
- It sends subscription requests for each symbol in batches
- TrueData begins streaming ticks for subscribed symbols immediately
- Symbols that are not subscribed produce no data (important: a missing subscription looks identical to a symbol with no activity)

**Symbol limits per our plan:**
- 700 symbols per segment (300 base + 400 add-on)
- Across 3 segments: up to 2,100 symbol subscriptions total

**Continuous vs. contract subscriptions:**
The Ultima plan supports subscribing to both continuous contract symbols (e.g., `NIFTY-I`) and specific expiry contracts (e.g., `NIFTY25MAYFUT`) simultaneously. Our ingestion service subscribes to both:
- Continuous symbols: used for real-time strategy signal generation (no roll gaps)
- Specific expiry contracts: used for live order execution (you cannot execute on a continuous symbol — the broker needs the actual contract name)

---

## 4. Live Tick Data Format

Each tick message received from TrueData contains the following fields:

| Field | Description | Available In |
|---|---|---|
| Symbol | TrueData symbol string | All |
| Timestamp | Event time (IST, millisecond precision) | All |
| LTP | Last Traded Price | All |
| LTQ | Last Traded Quantity | All |
| Volume | Cumulative day volume at this tick | All |
| Open | Day open price | All |
| High | Day high price so far | All |
| Low | Day low price so far | All |
| Close | Previous day close price | All |
| ATP | Average Traded Price (VWAP) | All |
| OI | Open Interest | F&O, MCX only |
| OI Change | Change in OI from previous day | F&O, MCX only |
| Bid Price | Best bid | Ultima only |
| Ask Price | Best ask | Ultima only |
| Bid Qty | Quantity at best bid | Ultima only |
| Ask Qty | Quantity at best ask | Ultima only |

**Timestamp precision:** TrueData timestamps are in milliseconds. This matters for tick-level strategies. However, the exchange itself operates on a 100ms event cycle for NSE (ticks are batched in 100ms windows by the exchange before being published). MCX has a similar model. True microsecond-level tick data is not available in India at retail/semi-institutional level.

**OI field behavior:** OI is updated on every trade in F&O and MCX. Unlike price, OI does not tick on every quote change — it only changes when a new contract is opened or an existing one is closed.

---

## 5. Historical Data Access

TrueData provides two mechanisms for accessing historical data:

### 5.1 REST API for Historical OHLCV
Available at Ultima tier: pull historical bars via HTTP GET requests.

**What is available:**
- Daily (EOD) bars: 11+ years of history
- 1-minute bars: ~1.5 months of history
- Other intraday intervals (5min, 15min, 30min, 60min): Derived from 1-minute bars

**Usage:** This is our Day 1 backfill source. On initial setup, we make bulk API calls to pull:
- 11+ years of daily bars for all symbols → stored in `ohlcv_daily`
- 1.5 months of 1-minute bars → stored in `ohlcv_1min`

After the initial backfill, we never use the historical API for daily data again — our own database is authoritative. We may use it occasionally for gap fills if our ingestion service was down.

**Rate limits:** TrueData has API rate limits on historical calls. Bulk backfill must be done with deliberate throttling — requests per second, not requests per millisecond. The exact limit should be confirmed with TrueData support, but a safe assumption is 10 requests/second maximum.

### 5.2 In-Feed Tick Replay (20-Day Window)
The Ultima plan includes 20 trading days of tick history accessible through the feed itself. If our ingestion service was offline for a day, we can request a replay of missed ticks for any subscribed symbol within the 20-day window.

This is a recovery mechanism, not a backtesting mechanism. It allows us to fill gaps in our tick store without a separate API call, but it delivers the data at the same rate as live ticks, not instantly.

---

## 6. Data Quality Characteristics

Understanding TrueData's known data quality traits helps us build the right validation logic.

**What TrueData does well:**
- Very low latency (reported 15 seconds ahead of Zerodha's datafeed based on testing)
- Clean EOD adjustment for splits and dividends on the daily series
- Reliable OI data for F&O and MCX
- Consistent symbol naming across historical and live feeds

**Known limitations and gotchas:**
- **Duplicate ticks:** On reconnection or replay, TrueData may deliver duplicate ticks for the same symbol+timestamp. Our ingestion service must deduplicate on (symbol, timestamp) before writing to the database.
- **Stale ticks during illiquid periods:** For low-volume stocks or MCX metals during early morning, TrueData may repeat the last tick rather than sending nothing. A repeated tick (same LTP, same timestamp +1ms) should be filtered.
- **Pre-open session noise:** During the 09:00–09:15 NSE pre-open call auction, prices are indicative. TrueData sends these ticks with a pre-open flag. These should be stored but excluded from strategy signal calculations.
- **MCX session transition:** At 17:00, when MCX transitions from morning to evening session, there may be a brief gap in ticks (1–3 minutes). This is normal exchange behavior and should not trigger a stale data alert.
- **Holiday data:** On exchange holidays, TrueData sends no data. Our ingestion service should not interpret this as a connectivity failure.

---

## 7. Reconnection and Reliability

The WebSocket connection will drop occasionally. Reasons include: network instability, TrueData server maintenance, our server restart, and cloud provider network events.

**Expected reconnection behavior:**

```
Connection drops
      ↓
Ingestion service detects disconnect (no heartbeat for 10 seconds)
      ↓
Attempt reconnection (exponential backoff: 5s, 10s, 20s, 40s, max 60s)
      ↓
Re-authenticate with TrueData
      ↓
Re-subscribe all symbols from instruments_india table
      ↓
Request tick replay for gap period (if within 20-day window)
      ↓
Resume normal operation, log the gap event
```

**Key design decision:** Re-subscription must be driven by the database (instruments_india table), not a hardcoded list. This ensures that if symbols were added or removed while the service was reconnecting, the subscription list is always current.

**Gap tracking:** Every disconnect event must be logged with start time, end time, and list of affected symbols. This is used downstream by the data quality checker to flag gaps in the tick store.

---

## 8. Operational Requirements

**Startup time:** The ingestion service should be ready to receive ticks by 08:55 IST (20 minutes before NSE EQ open, 5 minutes before MCX open). This gives time for connection establishment, authentication, and subscription confirmations.

**Shutdown time:** The service should remain running until 23:35 IST on weekdays to capture the full MCX evening session close. On MCX holiday eves, it can shut down at 17:05.

**Heartbeat monitoring:** TrueData sends heartbeat messages on the WebSocket connection at regular intervals. Our service must monitor heartbeat receipt. If no heartbeat is received for 10 seconds, treat as a disconnect and initiate reconnection.

**Memory management:** At peak, TrueData may deliver 5,000–10,000 ticks per second across all subscribed symbols during market open. The tick buffer in memory must be sized accordingly and flushed to the database frequently enough to prevent memory buildup. A 500ms flush interval is the target.

**Credentials rotation:** TrueData credentials should be rotatable without service restart. The service reads credentials from Secret Manager at startup and on each reconnection attempt. If credentials change mid-day (emergency rotation), the service will pick them up on the next reconnection.

---

## 9. Integration with Existing Architecture

TrueData replaces Yahoo Finance and Alpaca as the primary data source. The rest of the system remains unchanged.

| Component | Change Required |
|---|---|
| Data Manager | Add TrueData as a new source adapter |
| Strategy Builder | No change (reads from DB, not feed directly) |
| Backtest Engine | No change (reads from DB) |
| Risk Monitor | No change |
| Live Executor | Must use actual contract symbol (not continuous) for order placement |
| OANDA | Remains for forex data if forex strategies are added later |

**The ingestion service is a new standalone service**, separate from the existing Data Manager. It runs as a long-lived process (not Cloud Run — Cloud Run is serverless and not suitable for persistent WebSocket connections). It runs on a small dedicated VM (Cloud Compute e2-micro or similar).

---

## 10. Cost Reference

| Item | Monthly | Annual |
|---|---|---|
| Velocity Ultima — NSE EQ | ₹2,795.83 | — |
| Velocity Ultima — NSE F&O | ₹2,795.83 | — |
| Velocity Ultima — MCX | ₹2,795.83 | — |
| Additional 400 Symbols | ₹1,998.00 | — |
| **Total (verify with TrueData)** | **~₹10,385** | **~₹1,10,000** |

Loyalty discounts apply: -2.5% at 13 months continuous, -10% at 36 months. Lock in the 36-month rate once the system is proven in production.

---

*See INDIA_MARKETS_SPEC.md for segment and instrument details.*
*See INGESTION_PIPELINE_SPEC.md for service design.*
*See DATA_SCHEMA_INDIA.md for storage design.*
