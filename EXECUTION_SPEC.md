# Execution Specification

Order lifecycle from signal generation to fill confirmation.
Covers the Executor Consumer binary, Paper Trader, pre/post execution logic, and rejected trade capture.

See PUBSUB_SCHEMA.md for message schemas.
See CORE_ARCHITECTURE.md for how Core generates OrderIntent.
See RISK_ENGINE_SPEC.md for risk rules that gate orders.
See Zerodha_Spec.md for Zerodha API integration details.

-----

## Design Principles

1. **Executor is a separate binary from Core.** Core emits intent. Executor acts on it. Neither knows the other’s internals.
1. **Paper and Live executors are interchangeable.** Same Order payload. Same response contract. Switch via config, not code.
1. **Every rejection is captured.** Whether a trade dies at signal generation or at the broker, the full context is stored. No silent drops.
1. **Stop loss is confirmed before entry is considered placed.** If stop placement fails, the entry is cancelled immediately.
1. **Executor never generates signals.** It only executes what Core tells it to. All trading logic lives in Core.

-----

## System Overview

```
Core Binary
  │
  │  (signal passes all checks)
  │
  ▼
events.orders (Pub/Sub)
  │
  ▼
Executor Consumer Binary
  ├── execution_mode = "paper"  →  Paper Trader (in-process)
  └── execution_mode = "live"   →  Zerodha Kite API
  │
  ▼
events.order_results (Pub/Sub)
  │
  ├─→ Core (reads fill confirmation, updates position state)
  └─→ DB Writer (persists execution record)
```

-----

## Rejection Pipeline — All 6 Stages

A trade can be rejected at six distinct points. Each stage captures different context.
All rejections are published to `events.rejections` (Pub/Sub) and persisted by DB Writer.

```
[1] Signal Generation        Core — conditions not met, score below threshold
         ↓
[2] Strategy Selection       Core — outscored by another strategy, no strategy above min threshold
         ↓
[3] Risk Check               Core — daily loss limit, margin insufficient, outside trade window,
                                    max open positions exceeded, kill switch active
         ↓
[4] Order Validation         Core — segment module rejects (invalid lot size, expiry block,
                                    instrument not tradeable, MCX delivery block)
         ↓
[5] Executor Pre-flight      Executor — final check before API call (balance recheck,
                                        duplicate order guard, broker session invalid)
         ↓
[6] Broker Rejection         Executor — Zerodha rejects (insufficient funds,
                                        symbol circuit breaker, market closed, API error)
```

Stages 1–4 happen inside Core before any message is published to `events.orders`.
Stages 5–6 happen inside the Executor Consumer after reading from `events.orders`.

### Rejection Reasons Reference

```
Stage 1 — Signal Generation:
  CONDITIONS_NOT_MET         All conditions failed (AND mode)
  SCORE_BELOW_THRESHOLD      Score mode: weighted score < score_threshold

Stage 2 — Strategy Selection:
  OUTSCORED                  Another strategy had higher composite score
  NO_STRATEGY_ABOVE_MIN      Best composite score < min_composite_threshold
  ALL_STRATEGIES_SUPPRESSED  All strategies have allocator_weight = 0

Stage 3 — Risk Check:
  DAILY_LOSS_LIMIT_REACHED   Daily P&L < -daily_loss_limit
  DAILY_LOSS_LIMIT_APPROACHING  Within 90% of limit — warning only, not a block
  MAX_POSITIONS_EXCEEDED     Open positions >= max_open_positions
  MARGIN_INSUFFICIENT        Available margin < required for this order
  OUTSIDE_TRADE_WINDOW       Signal generated outside risk.trade_window
  KILL_SWITCH_ACTIVE         Kill switch level >= 2 (no new entries)
  ENGINE_RECOVERING          Engine in RECOVERING state (no new entries)
  POSITION_ALREADY_OPEN      Symbol already has open position, engine should not reach here

Stage 4 — Order Validation:
  INVALID_LOT_SIZE           Calculated quantity not a multiple of lot size
  EXPIRY_DAY_BLOCK           Strategy has avoid_expiry_day = true, today is expiry
  MCX_DELIVERY_BLOCK         MCX contract expires in < 3 days, physical delivery risk
  INSTRUMENT_NOT_TRADEABLE   Symbol suspended, circuit breaker, or delisted
  OUTSIDE_SEGMENT_HOURS      MCX evening session check, pre-market check

Stage 5 — Executor Pre-flight:
  DUPLICATE_ORDER_GUARD      Same symbol + strategy + direction already has pending order
  BROKER_SESSION_INVALID     Zerodha access token expired or invalid
  BALANCE_RECHECK_FAILED     Zerodha balance lower than Core's cached value

Stage 6 — Broker Rejection:
  ZERODHA_INSUFFICIENT_FUNDS   Zerodha reports insufficient funds
  ZERODHA_CIRCUIT_BREAKER      Symbol hit circuit breaker after order was sent
  ZERODHA_MARKET_CLOSED        Market closed (holiday, early close, session ended)
  ZERODHA_RATE_LIMIT           API rate limit hit
  ZERODHA_API_ERROR            Generic Zerodha API error (with error code captured)
  ORDER_TIMEOUT                Order not filled within timeout window
```

-----

## Order States

```
INTENT      Core has decided to trade, OrderIntent created internally
    ↓
PENDING     Published to events.orders, Executor has consumed it
    ↓
SUBMITTED   Executor has called Zerodha API, broker_order_id received
    ↓
FILLED      Full fill confirmed (filled_qty == requested_qty)
PARTIAL     Partial fill (filled_qty < requested_qty, remainder pending)
REJECTED    Broker rejected before any fill
CANCELLED   Order cancelled by system (timeout, emergency stop)
TIMEOUT     No fill within timeout window, order cancelled
```

-----

## Executor Consumer Binary

### Responsibilities

```
1. Subscribe to events.orders (Pub/Sub)
2. Pre-flight check (Stage 5)
3. Route to Paper Trader or Zerodha based on execution_mode
4. Track order until filled, rejected, or timed out
5. Publish result to events.order_results
6. Publish execution record to events.executions
7. Handle partial fills
8. Handle Zerodha callback / polling for fill status
```

### Executor Interface (Paper and Live implement this)

```go
type Executor interface {
    // Submit an order. Returns broker_order_id or error.
    Submit(order Order) (string, error)

    // Get current status of a submitted order.
    Status(brokerOrderID string) (OrderStatus, error)

    // Cancel a pending order.
    Cancel(brokerOrderID string) error

    // Get current account balance and available margin.
    AccountState() (AccountState, error)

    // Name of this executor (for logging).
    Name() string  // "zerodha_live" | "paper_trader"
}
```

### Order Processing Flow

```
1. Read order from events.orders

2. Pre-flight check (Stage 5):
   a. Is broker session valid? (Redis: last token refresh time)
   b. Duplicate order guard: is there already a pending order for this symbol + strategy?
   c. Balance recheck: executor.AccountState() — compare to Core's cached margin
   If any fail → publish Rejection (Stage 5) to events.rejections → ack message → return

3. Log order as PENDING
   (Redis: pending_orders:{order_id} = order JSON)

4. Submit to executor:
   brokerOrderID, err := executor.Submit(order)
   If err → publish Rejection (Stage 6) → mark REJECTED → return

5. Mark order as SUBMITTED
   (Redis: pending_orders:{order_id} = order JSON with broker_order_id)

6. Monitor for fill (poll or callback depending on execution_mode):
   Start fill monitor goroutine (see Fill Monitoring below)

7. On fill confirmation:
   Calculate slippage and latency
   Publish to events.order_results
   Publish to events.executions
   Clear from Redis pending_orders
   Ack Pub/Sub message
```

### Fill Monitoring

```
Paper Trader:
  Fill is synchronous — Paper Trader returns fill immediately on Submit()
  No polling needed

Zerodha Live:
  Zerodha is asynchronous — Submit() returns broker_order_id
  Must poll or use Zerodha postback (webhook) for fill confirmation

  Strategy 1 — Polling (simpler, lower ops):
    Poll Zerodha GET /orders/{order_id} every 500ms
    Timeout after order_timeout_seconds (default: 30s for market orders)

  Strategy 2 — Postback (faster, more complex):
    Register Zerodha postback URL in Kite Connect settings
    Zerodha POSTs fill confirmation to Executor's webhook endpoint
    Executor reconciles with pending_orders in Redis

  Recommendation: Start with polling. Add postback in Phase 2 if needed.
  For 5m candle strategies, 500ms polling is fast enough.
```

### Order Timeout Handling

```
Market Orders:
  Timeout: 30 seconds
  On timeout: order should be filled (market orders fill almost instantly)
              if NOT filled after 30s → something is wrong
              → Cancel order at Zerodha
              → Publish Rejection (TIMEOUT)
              → Alert operator

Limit Orders:
  Timeout: configurable per strategy (default: 1 bar = timeframe duration)
  On timeout: normal — price may not have reached limit
              → Cancel order at Zerodha
              → Publish Rejection (ORDER_TIMEOUT)
              → Log as information (not an alert)

Stop Loss Orders (GTT):
  No timeout — GTT orders persist until triggered or manually cancelled
  Monitored separately by Position Watchdog
```

### Partial Fill Handling

```
Partial fill received (filled_qty < requested_qty):

  Option A — Accept partial, adjust position:
    Enter position with filled_qty
    Cancel remaining unfilled quantity
    Log: PARTIAL_FILL_ACCEPTED
    Strategy sizing may be off — Risk Engine logs mismatch

  Option B — Cancel and retry:
    Cancel unfilled remainder
    Re-submit for remaining quantity as new order
    Risk: price may have moved, second fill at worse price

  Policy: Use Option A for market orders (partial fill of a market order is unusual
          and means market conditions are extreme — don't chase)
          Use Option B for limit orders (price is the priority, not immediacy)
```

-----

## Pre-Execution Checks Detail (Stages 1–4, Inside Core)

These run inline in the symbol engine goroutine before any message is published.
No DB calls. No network calls. Pure in-memory checks using Redis-loaded state.

### Stage 1 — Signal Generation

```
AND Mode:
  For each condition in entry.conditions tree:
    Evaluate condition against current candle buffer
    If any node fails → signal = false
    Record which conditions passed/failed (for rejection log)

  If all pass → signal = true, strength = 1.0

Score Mode:
  For each condition in entry.conditions tree:
    Evaluate condition
    If passes → add weight to running total
  score = running_total / max_possible_weight
  If score < entry.score_threshold → signal = false
  Record score per condition (for rejection log)
```

### Stage 2 — Strategy Selection

```
Collect all strategies that generated signal for this symbol + timeframe
If none → no action (not a rejection, just no signal)

For each signalling strategy:
  Calculate composite score:
    signal_strength_component  = signal.strength × 0.40
    win_rate_component         = smoothed_win_rate(strategy) × 0.30
    allocator_weight_component = allocator_weight(strategy) × 0.20
    regime_match_component     = regime_fit(strategy, current_regime) × 0.10
    composite = sum of above

Sort by composite score descending
Winner = highest score

If winner composite < min_composite_threshold:
  → Emit Rejection: NO_STRATEGY_ABOVE_MIN
  → Include: all strategy scores in rejection context
  → Return

Winner strategy selected → proceed to Stage 3
```

### Stage 3 — Risk Check

```
Check order (all checks are in-memory against Redis-loaded risk state):

  daily_pnl = redis.Get("state:risk").daily_pnl
  If daily_pnl <= -daily_loss_limit:
    → Emit Rejection: DAILY_LOSS_LIMIT_REACHED → return

  open_positions_count = redis.Get("state:positions").count
  If open_positions_count >= strategy.risk.max_open_positions:
    → Emit Rejection: MAX_POSITIONS_EXCEEDED → return

  required_margin = segment_module.MarginRequired(symbol, lots, price)
  available_margin = redis.Get("state:risk").available_margin
  If available_margin < required_margin:
    → Emit Rejection: MARGIN_INSUFFICIENT → return

  current_time = time.Now().In(IST)
  If current_time < trade_window.start OR current_time > trade_window.end:
    → Emit Rejection: OUTSIDE_TRADE_WINDOW → return

  kill_switch_level = redis.Get("state:risk").kill_switch_level
  If kill_switch_level >= 2:
    → Emit Rejection: KILL_SWITCH_ACTIVE → return

  All passed → proceed to Stage 4
```

### Stage 4 — Order Validation (Segment Module)

```
  violations = segment_module.PreTradeChecks(order, portfolio)
  If len(violations) > 0:
    → Emit Rejection with first violation reason → return

  Examples of what PreTradeChecks catches:
    FuturesModule:  is today expiry day AND strategy.avoid_expiry_day = true?
    CommodityModule: is contract within 3 days of expiry? (physical delivery risk)
    EquityModule:   is symbol in upper/lower circuit band?

  All passed → publish to events.orders → done
```

-----

## Post-Execution Metrics

After every fill (paper or live), the Executor calculates and records:

### Slippage

```
Signal slippage:
  signal_slippage = filled_price - signal_price
  signal_slippage_pct = signal_slippage / signal_price × 100

  signal_price = the bar's close price that triggered the signal
  filled_price = actual execution price from broker

  For market orders: slippage is usually 0.01–0.1% in liquid instruments
  For limit orders: slippage = 0 if filled at limit, else timeout (not filled)

Market impact (for larger positions):
  For 1 lot of Nifty (25 units): negligible impact
  For 10+ lots: may move the market slightly — monitor average slippage trend

Slippage tracking:
  Per strategy, rolling 50 trades
  Alert if slippage > backtest_assumed_slippage × 2.0
  This signals that backtest assumptions are no longer valid
```

### Latency

```
Components measured:
  signal_to_order_ms    = order_published_time - bar_close_time
                          (Core processing time)
  order_to_submit_ms    = submit_time - order_published_time
                          (Pub/Sub consumer + pre-flight)
  submit_to_fill_ms     = fill_time - submit_time
                          (Zerodha processing + network)
  total_latency_ms      = fill_time - bar_close_time

Expected latencies:
  signal_to_order_ms:   3–15ms   (Pub/Sub + Core eval)
  order_to_submit_ms:   5–20ms   (Pub/Sub consumer + pre-flight)
  submit_to_fill_ms:    50–200ms (Zerodha API round-trip)
  total:                60–235ms

For 5m candle strategies: 235ms total is irrelevant (bar = 300,000ms)
Alert threshold: total_latency_ms > 2,000ms (something is wrong)
```

### Execution Quality Score

```
Per trade:
  quality_score = 1.0 - (|slippage_pct| / max_acceptable_slippage_pct)
  Clamped to [0.0, 1.0]

  max_acceptable_slippage_pct is set per strategy (default: 0.1%)
  quality_score = 1.0 → perfect fill
  quality_score = 0.0 → slippage at maximum acceptable

Rolling average per strategy:
  If rolling avg quality_score < 0.70 over last 20 trades:
    → Alert: EXECUTION_QUALITY_DEGRADED
    → Review: market conditions, time of day, lot sizes
```

-----

## Paper Trader

Implements the Executor interface. Runs inside the Executor Consumer binary.
Selected when execution_mode = “paper” on the order.

### Fill Simulation

```go
func (pt *PaperTrader) Submit(order Order) (string, error) {
    // Generate a synthetic broker order ID
    brokerOrderID := "PAPER-" + uuid.New().String()

    // Get current market price from Redis (last tick for this symbol)
    currentPrice := pt.redis.GetLastPrice(order.Symbol)

    // Simulate fill based on order type
    var fillPrice float64
    switch order.OrderType {
    case "MARKET":
        // Instant fill with slippage
        slippage := pt.config.SlippagePct / 100 * currentPrice
        if order.Direction == "BUY" {
            fillPrice = currentPrice + slippage  // pay slightly more
        } else {
            fillPrice = currentPrice - slippage  // receive slightly less
        }

    case "LIMIT":
        // Check if limit price is achievable at current market
        if order.Direction == "BUY" && currentPrice <= order.LimitPrice {
            fillPrice = order.LimitPrice
        } else if order.Direction == "SELL" && currentPrice >= order.LimitPrice {
            fillPrice = order.LimitPrice
        } else {
            // Price not reached — return pending, monitor in background
            pt.pendingLimitOrders[brokerOrderID] = order
            return brokerOrderID, nil
        }
    }

    // Simulate network latency (realistic: 50–200ms)
    latency := pt.config.BaseLatencyMs + rand.Intn(pt.config.LatencyJitterMs)
    time.Sleep(time.Duration(latency) * time.Millisecond)

    // Record fill
    pt.recordFill(brokerOrderID, order, fillPrice)
    return brokerOrderID, nil
}
```

### Portfolio Tracking

```
Paper Trader maintains its own portfolio state in memory + Redis.
This is independent of Core's position state.

Portfolio state:
  cash_balance:        starting capital - deployed margin
  open_positions:      map[symbol] → PaperPosition
  closed_trades:       []ClosedTrade (last 200, ring buffer)
  cumulative_pnl:      total realised P&L
  session_id:          UUID per paper trading session

Redis keys:
  paper:portfolio:{session_id}       → current portfolio state
  paper:trades:{session_id}          → trade history
  paper:session:{session_id}:status  → RUNNING | PAUSED | STOPPED

Paper portfolio is initialised from strategy.paper_initial_capital
(configured per strategy, default: ₹5,00,000)
```

### Paper vs Backtest Comparison

```
After each paper trade closes, compute:

  backtest_metrics = strategy.backtest_results  (loaded from Redis/DB)
  paper_metrics    = rolling metrics over last N paper trades

  Metrics compared:
    win_rate:          |paper_win_rate - backtest_win_rate| / backtest_win_rate
    avg_slippage:      |paper_avg_slippage - backtest_assumed_slippage|
    sharpe_ratio:      rolling Sharpe over paper trades

  Alert if any metric drifts > 20% from backtest:
    PAPER_BACKTEST_DIVERGENCE → investigate before promoting to live
```

### Slippage Config for Paper Trader

```yaml
paper_trader:
  base_slippage_pct: 0.05       # 0.05% base slippage on market orders
  nse_fno_slippage_pct: 0.03    # Futures are more liquid, tighter spread
  mcx_slippage_pct: 0.08        # Commodities slightly wider spread
  base_latency_ms: 80           # Simulate realistic network latency
  latency_jitter_ms: 120        # Random jitter up to +120ms
```

-----

## Stop Loss Placement Protocol

This applies to both Paper Trader and Live Executor.
Stop loss is treated as a mandatory order, not optional risk management.

```
On entry fill confirmation:

  1. Calculate stop loss price:
     stop_price = fill_price - (fill_price × stop_loss_pct / 100)  [for LONG]
     stop_price = fill_price + (fill_price × stop_loss_pct / 100)  [for SHORT]

  2. Submit stop loss order to broker:
     Live:  Zerodha GTT (Good Till Triggered) order
     Paper: Register in PaperTrader.pendingStopOrders map

  3. Wait for stop loss confirmation (live only):
     Timeout: 5 seconds
     If not confirmed within 5s:
       → Cancel entry position at market immediately
       → Publish: STOP_PLACEMENT_FAILED
       → Alert: CRITICAL
       → Do NOT hold a position without a stop

  4. Only after stop loss confirmed:
     → Publish POSITION_OPENED to events.positions
     → Update Redis position state
     → Core marks engine as POSITION_OPEN

Rule: Stop loss price can only move toward current price (tighten).
      Stop loss can NEVER be widened once placed.
      This rule is enforced in code — no API endpoint allows widening a stop.
```

-----

## Emergency Stop

Triggered by:

- Kill switch Level 3 (portfolio drawdown > 15%)
- Kill switch Level 4 (manual trigger from dashboard)
- API: `POST /control/emergency-shutdown`

```
Emergency stop sequence:

  1. Core publishes EMERGENCY_STOP_INITIATED to events.risk
  2. Executor Consumer reads emergency stop command
  3. For each open position:
     a. Cancel any pending limit orders
     b. Submit market SELL (or BUY_TO_CLOSE) order
     c. Wait for fill confirmation (timeout: 10 seconds per position)
     d. If timeout: log EMERGENCY_EXIT_TIMEOUT, continue to next position
  4. After all positions processed:
     a. Publish EMERGENCY_STOP_COMPLETE to events.risk
     b. Update Redis: kill_switch_level = 4
     c. All symbol engines enter HALTED state — no new orders accepted
  5. Target: all positions closed within 30 seconds

Note: Emergency stop fires market orders regardless of price.
      Slippage on emergency exits is expected and acceptable.
      Capital preservation > execution quality during emergency.
```

-----

## Broker Connection Handling

### Zerodha Session Disconnect (Mid-Trade)

A Zerodha API session can drop while positions are open. This is the most
dangerous failure mode — open positions with no monitoring.

```
Detection:
  Executor polls Zerodha GET /orders every 500ms during active positions.
  If 3 consecutive poll failures: session considered lost.

  Also: Kite WebSocket (order updates) disconnects trigger immediate detection.

Response sequence:
  1. Log: BROKER_SESSION_LOST
  2. Alert: CRITICAL — immediate notification
  3. Attempt re-authentication:
     a. Refresh Zerodha access token (from Cloud Secret Manager)
     b. Retry connection — up to 3 attempts, 10 second backoff each
  4. If reconnected within 2 minutes:
     a. Fetch current order book from Zerodha GET /orders
     b. Reconcile with Redis pending_orders state
     c. For any position with no GTT stop found at Zerodha:
        → Re-submit stop loss order immediately
        → Log: STOP_ORDER_RESUBMITTED_AFTER_RECONNECT
     d. Resume normal operation, log BROKER_SESSION_RESTORED
  5. If reconnected after 2+ minutes:
     a. Fetch all open positions from Zerodha
     b. Compare against Redis state:positions
     c. Any discrepancy → alert operator, do NOT auto-reconcile
        (Price may have moved significantly — human decision required)
  6. If cannot reconnect after 3 attempts (30+ seconds):
     a. Cannot place market close orders — broker is unreachable
     b. Log: BROKER_UNREACHABLE
     c. Alert: CRITICAL with all open position details
     d. Operator must act manually via Zerodha console
     e. System enters HALTED state — no new orders until session restored

Hard rule: Never assume a position is safe without GTT stop confirmation at Zerodha.
           If you cannot verify the stop exists: treat it as unprotected.
```

### GTT Stop Order Monitoring

GTT orders persist at Zerodha independently. They can disappear due to:

- Zerodha system issues
- Manual cancellation (accidental)
- Symbol corporate actions

```
GTT Watchdog (runs every 60 seconds, part of Executor):

  For each open position in Redis state:positions:
    1. Fetch associated GTT order ID (stored in Redis: positions:{id}:gtt_id)
    2. Call Zerodha GET /gtt/{gtt_id}
    3. If GTT status = ACTIVE: continue (normal)
    4. If GTT status = TRIGGERED: position was stopped out → process fill
    5. If GTT not found or status = CANCELLED:
       → Log: GTT_ORDER_MISSING {symbol, strategy_id, gtt_id}
       → Immediately re-submit stop loss order at original stop price
       → If re-submission fails: Alert CRITICAL, mark position as UNPROTECTED
       → Log: STOP_ORDER_RESUBMITTED or STOP_RESUBMISSION_FAILED

  If STOP_RESUBMISSION_FAILED:
    → Alert operator with position details
    → Executor does NOT auto-close position (price may be fine, don't panic sell)
    → Operator must decide: close manually or wait for stop to be re-submitted
    → After 5 minutes with no GTT: auto-close at market, log FORCED_CLOSE_UNPROTECTED

Paper Trader:
  GTT monitoring not needed — pendingStopOrders map is in-process.
  Paper stops are checked on every tick — they cannot disappear.
```

-----

All rejections (all 6 stages) are published to `events.rejections` and persisted by DB Writer.
Stored in PostgreSQL `rejected_trades` table with full context.

```
Table: rejected_trades
Columns:
  rejection_id          UUID, primary key
  timestamp             TIMESTAMPTZ, indexed
  symbol                VARCHAR(30), indexed
  exchange              VARCHAR(10)
  segment               VARCHAR(10)
  strategy_id           VARCHAR(100), indexed
  strategy_version      VARCHAR(20)
  rejection_stage       INTEGER (1–6), indexed
  rejection_reason      VARCHAR(100), indexed
  direction             VARCHAR(10)  -- BUY | SELL
  timeframe             VARCHAR(10)
  bar_close_time        TIMESTAMPTZ
  scoring_json          JSONB  -- all 4 score components + composite
  conditions_json       JSONB  -- per-condition values at rejection time
  risk_context_json     JSONB  -- daily pnl, margin, open positions at rejection time
  market_context_json   JSONB  -- India VIX, regime, session
  what_happened_after   JSONB  -- populated later: price movement after rejection
                                  (batch job runs nightly: "would this have been profitable?")

Indexes:
  (symbol, timestamp DESC)
  (strategy_id, timestamp DESC)
  (rejection_stage, rejection_reason)
  (timestamp DESC)  -- time-range queries
```

### What Happened After (Nightly Batch Job)

```
Purpose: Tag each rejection with what price actually did after the signal.
This allows future analysis of "good rejections" vs "bad rejections."

Runs nightly as part of EOD jobs:
  For each rejection from today:
    Look up OHLCV data for that symbol starting from bar_close_time
    Calculate:
      price_1bar_after   = close price 1 bar after rejection
      price_5bars_after  = close price 5 bars after rejection
      price_20bars_after = close price 20 bars after rejection
      would_have_profited = true if direction was correct (BUY and price went up, etc.)
      max_favourable_excursion = max profit that could have been captured
      max_adverse_excursion    = max loss that would have been incurred

    Update rejected_trades.what_happened_after with this data

Use cases:
  "My risk check rejected 150 trades this month.
   How many would actually have been profitable?"
  → SELECT COUNT(*) WHERE rejection_stage = 3 AND would_have_profited = true
  → If > 40%: risk rules may be too conservative, review thresholds

  "My score threshold rejected 80 trades.
   What was the average profit missed?"
  → SELECT AVG(max_favourable_excursion) WHERE rejection_stage = 2
```

-----

## Execution Record (Completed Trades)

All completed trades (filled + closed) are published to `events.executions` and
persisted by DB Writer in the `trades` table.

```
Table: trades
Columns:
  trade_id              UUID, primary key
  position_id           UUID (links to positions table)
  symbol                VARCHAR(30), indexed
  strategy_id           VARCHAR(100), indexed
  strategy_version      VARCHAR(20)
  direction             VARCHAR(10)
  lots                  INTEGER
  quantity              INTEGER
  entry_price           DECIMAL(12,4)
  exit_price            DECIMAL(12,4)
  entry_time            TIMESTAMPTZ, indexed
  exit_time             TIMESTAMPTZ
  exit_reason           VARCHAR(50)  -- stop_loss | take_profit | time_exit | signal_exit | forced | emergency
  realized_pnl_inr      DECIMAL(12,2)
  realized_pnl_pct      DECIMAL(8,4)
  brokerage_inr         DECIMAL(10,2)
  stt_inr               DECIMAL(10,2)
  net_pnl_inr           DECIMAL(12,2)  -- realized_pnl - brokerage - stt
  entry_slippage_pts    DECIMAL(8,4)
  exit_slippage_pts     DECIMAL(8,4)
  total_latency_ms      INTEGER
  execution_mode        VARCHAR(10)  -- paper | live
  composite_score_entry DECIMAL(6,4)  -- score that selected this strategy
  hold_bars             INTEGER
  hold_minutes          INTEGER
```

-----

## API Endpoints (Executor Consumer)

Internal only — accessible within GCP VPC on port 8081.

```
Order Management:
  GET  /orders/pending           → list all pending orders
  GET  /orders/{order_id}        → specific order status
  POST /orders/{order_id}/cancel → cancel pending order

Execution Stats:
  GET  /stats/slippage           → rolling slippage stats per strategy
  GET  /stats/latency            → rolling latency breakdown
  GET  /stats/fills              → fill rate, partial fill rate, timeout rate

Paper Trader:
  GET  /paper/portfolio          → current paper portfolio state
  GET  /paper/trades             → paper trade history
  POST /paper/reset              → reset paper portfolio (new session)

Emergency:
  POST /emergency/stop-all       → close all open positions at market
```

-----

*Next: RISK_ENGINE_SPEC.md — kill switch, drawdown rules, SPAN margin, position sizing.*