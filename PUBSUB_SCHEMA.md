# Cloud Pub/Sub Schema

Message bus design for the trading system. All inter-service communication flows through Pub/Sub.
No service writes directly to another service. No service reads another service's database.

See CORE_ARCHITECTURE.md for how the Core Binary consumes these topics.
See EXECUTION_SPEC.md for order and execution event schemas.
See RISK_ENGINE_SPEC.md for risk event schemas.

---

## Design Principles

1. **Pub/Sub is a pipe, not a store.** Persistence lives in TimescaleDB and PostgreSQL via the DB Writer Consumer. Do not rely on Pub/Sub retention as an audit trail.
2. **Ordering keys are mandatory** on all tick and position topics. Without them, messages for the same symbol can arrive out of order.
3. **Core never writes to DB directly.** All DB writes are events published to Pub/Sub and consumed by the DB Writer service.
4. **Dead letter topics on all critical topics.** Unprocessable messages must not be silently dropped.

---

## Message Flow Diagram

```
TrueData WebSocket
      │
      ▼
Tick Receiver Binary
      │  publishes to:
      ├──▶ ticks.nse_eq
      ├──▶ ticks.nse_fno
      └──▶ ticks.mcx
                │
                ▼
         Core Binary  ◀────────── strategies.config ◀── Strategy Builder API
                │                 strategies.commands
                │  publishes to:
                ├──▶ events.orders ──────────────▶ Executor Consumer
                │                                       │
                │                                       │  Zerodha API / Paper Trader
                │                                       │
                │   ◀──────── events.order_results ◀───┘
                │   ◀──────── events.position_commands (stop update acks)
                │
                ├──▶ events.position_commands ──▶ Executor Consumer
                │         (trailing stop updates)       │
                │                                       │  Updates GTT at Zerodha
                │
                ├──▶ events.signals     ┐
                ├──▶ events.rejections  │
                ├──▶ events.positions   ├──▶ DB Writer Consumer ──▶ PostgreSQL
                ├──▶ events.candles     │                           TimescaleDB
                ├──▶ events.health      ├──▶ Monitoring Consumer ──▶ Prometheus
                └──▶ events.risk        └──▶ Alerting Consumer  ──▶ Telegram/Email
```

---

## Topic Registry

### Inbound — Core Reads These

| Topic | Publisher | Primary Consumer | Ordering Key |
|---|---|---|---|
| `ticks.nse_eq` | Tick Receiver | Core | symbol |
| `ticks.nse_fno` | Tick Receiver | Core | symbol |
| `ticks.mcx` | Tick Receiver | Core | symbol |
| `strategies.config` | Strategy Builder API | Core | strategy_id |
| `strategies.commands` | Strategy Builder API | Core | strategy_id |

### Outbound — Core Publishes These

| Topic | Publisher | Consumers | Ordering Key |
|---|---|---|---|
| `events.orders` | Core | Executor Consumer | symbol |
| `events.position_commands` | Core | Executor Consumer | position_id |
| `events.signals` | Core | DB Writer, Monitoring | strategy_id |
| `events.rejections` | Core | DB Writer, Alerting | strategy_id |
| `events.positions` | Core | DB Writer, Monitoring, Alerting | symbol |
| `events.candles` | Core | DB Writer | symbol |
| `events.health` | Core | Monitoring | engine_id |
| `events.risk` | Core | DB Writer, Alerting | portfolio |

### Execution Loop — Executor Publishes These

| Topic | Publisher | Consumers | Ordering Key |
|---|---|---|---|
| `events.order_results` | Executor Consumer | Core, DB Writer | order_id |
| `events.executions` | Executor Consumer | DB Writer, Monitoring | symbol |

---

## Subscription Model

Each consumer has its own subscription. Multiple consumers on the same topic each get all messages independently.

```
Topic: ticks.nse_fno
  └─ Subscription: core-fno-consumer        → Core Binary
  └─ Subscription: analytics-fno-consumer   → Future analytics service

Topic: events.positions
  └─ Subscription: dbwriter-positions       → DB Writer Consumer
  └─ Subscription: monitoring-positions     → Monitoring Consumer
  └─ Subscription: alerting-positions       → Alerting Consumer
```

---

## Topic Configuration

```
Retention:          7 days (maximum — sufficient since DB Writer persists everything)
Ack deadline:       60 seconds (Core processes ticks fast, but allow for restart lag)
Dead letter:        enabled on all critical topics, max delivery attempts: 5
Ordering:           enabled (ordering keys defined per topic above)
Message retention:  after ack, messages retained 10 minutes (allows redelivery on partial failures)
```

### Dead Letter Topics

| Source Topic | Dead Letter Topic |
|---|---|
| `ticks.nse_eq` | `ticks.nse_eq.dead` |
| `ticks.nse_fno` | `ticks.nse_fno.dead` |
| `ticks.mcx` | `ticks.mcx.dead` |
| `events.orders` | `events.orders.dead` |
| `events.positions` | `events.positions.dead` |

Dead letter topics are monitored. Any message landing in a dead letter topic triggers an ALERT.

---

## Message Schemas

### 1. Tick Message (`ticks.*`)

Published by: Tick Receiver Binary
One message per tick received from TrueData WebSocket.

```json
{
  "schema_version": "1.0",
  "symbol": "NIFTY-I",
  "exchange": "NSE",
  "segment": "FNO",
  "timestamp": "2026-05-07T09:15:00.123+05:30",
  "received_at": "2026-05-07T09:15:00.125+05:30",
  "last_price": 19503.50,
  "open": 19480.00,
  "high": 19510.00,
  "low": 19475.00,
  "close": 19503.50,
  "volume": 12500,
  "oi": 8750000,
  "bid": 19503.00,
  "ask": 19504.00,
  "sequence_id": 100234567
}
```

**Ordering key:** `symbol` (e.g., `NIFTY-I`)
**Why:** Guarantees all ticks for a symbol arrive in the order TrueData sent them.

---

### 2. Strategy Config Message (`strategies.config`)

Published by: Strategy Builder API when a strategy is created, updated, or promoted.
Core loads or reloads the strategy on receipt.

```json
{
  "schema_version": "1.0",
  "event_type": "STRATEGY_LOADED",
  "strategy_id": "strat_nifty_mean_rev",
  "version": "1.1.0",
  "status": "paper",
  "published_at": "2026-05-07T08:00:00+05:30",
  "definition": {
    "instrument": { "symbol": "NIFTY-I", "exchange": "NSE", "segment": "FNO" },
    "execution": { "timeframe": "5m", "trade_direction": "long", "mode": "paper" },
    "entry": { "...": "full strategy JSON as per STRATEGY_SCHEMA.md" },
    "exit": { "...": "..." },
    "position_sizing": { "...": "..." },
    "risk": { "...": "..." },
    "parameters": { "...": "..." }
  }
}
```

**event_type values:**
- `STRATEGY_LOADED` — new strategy or new version, load into engine
- `STRATEGY_DEACTIVATED` — remove from active pool, do not generate new signals
- `STRATEGY_MODE_CHANGED` — paper → live or live → paper, update execution mode

**Ordering key:** `strategy_id`

---

### 3. Strategy Command Message (`strategies.commands`)

Published by: Strategy Builder API for hot commands that do not change strategy definition.

```json
{
  "schema_version": "1.0",
  "command": "ACTIVATE",
  "strategy_id": "strat_nifty_mean_rev",
  "version": "1.1.0",
  "issued_at": "2026-05-07T09:00:00+05:30",
  "issued_by": "api"
}
```

**command values:**
- `ACTIVATE` — start generating signals
- `DEACTIVATE` — stop generating signals, do not close open positions
- `EMERGENCY_DEACTIVATE` — stop signals AND close open positions immediately

**Ordering key:** `strategy_id`

---

### 4. Order Message (`events.orders`)

Published by: Core when a signal passes all checks and is ready for execution.
Consumed by: Executor Consumer which calls Zerodha API.

```json
{
  "schema_version": "1.0",
  "order_id": "ord_uuid_v4",
  "symbol": "NIFTY-I",
  "exchange": "NSE",
  "segment": "FNO",
  "direction": "BUY",
  "order_type": "MARKET",
  "quantity": 25,
  "lot_size": 25,
  "lots": 1,
  "limit_price": null,
  "execution_mode": "paper",
  "order_product": "MIS",
  "strategy_id": "strat_nifty_mean_rev",
  "strategy_version": "1.1.0",
  "position_id": "pos_uuid_v4",
  "signal_timestamp": "2026-05-07T09:20:00+05:30",
  "order_timestamp": "2026-05-07T09:20:00.050+05:30",
  "composite_score": 0.934,
  "risk_approved": true
}
```

**Ordering key:** `symbol`

---

### 4b. Position Command Message (`events.position_commands`)

Published by: Core Post-Entry Monitor goroutine.
Consumed by: Executor Consumer to update GTT stop orders at Zerodha.
This is the "management channel" — used for all position modifications after entry.

```json
{
  "schema_version": "1.0",
  "command_id": "cmd_uuid_v4",
  "timestamp": "2026-05-07T10:35:00+05:30",
  "position_id": "pos_uuid_v4",
  "symbol": "NIFTY-I",
  "strategy_id": "strat_nifty_mean_rev",
  "strategy_version": "1.1.0",
  "execution_mode": "paper",

  "command_type": "UPDATE_STOP",

  "stop_update": {
    "old_stop_price": 19380.00,
    "new_stop_price": 19420.00,
    "stop_moved_by_points": 40.0,
    "trail_type": "atr_based",
    "current_atr": 80.0,
    "modification_count": 7,
    "requires_refresh": false
  }
}
```

**command_type values:**

| Type | Purpose | Fields Used |
|---|---|---|
| `UPDATE_STOP` | Move trailing stop to new price | `stop_update` |
| `REFRESH_STOP` | Cancel + re-place stop (mod count ≥ 22) | `stop_update` |
| `PARTIAL_CLOSE` | Close X% of position at market | `partial_close` |
| `CANCEL_PENDING` | Cancel a pending limit order | `order_id` |

**`PARTIAL_CLOSE` payload:**
```json
{
  "command_type": "PARTIAL_CLOSE",
  "partial_close": {
    "close_pct": 50,
    "reason": "TAKE_PARTIAL_PROFIT"
  }
}
```

**Ordering key:** `position_id`
Why position_id (not symbol): commands for the same position must execute in order.
Multiple positions on different symbols can have concurrent commands safely.

---

### 5. Signal Message (`events.signals`)

Published by: Core for every signal generated — whether traded or not.

Used by DB Writer for analytics and strategy performance tracking.

```json
{
  "schema_version": "1.0",
  "signal_id": "sig_uuid_v4",
  "symbol": "NIFTY-I",
  "strategy_id": "strat_nifty_mean_rev",
  "strategy_version": "1.1.0",
  "direction": "BUY",
  "timeframe": "5m",
  "bar_close_time": "2026-05-07T09:20:00+05:30",
  "signal_time": "2026-05-07T09:20:00.012+05:30",
  "entry_mode": "AND",
  "conditions_snapshot": {
    "RSI_14": 27.3,
    "SMA_50": 19480.0,
    "PRICE_close": 19450.0,
    "conditions_met": ["RSI", "PRICE_vs_SMA", "VOLUME"],
    "conditions_failed": [],
    "score": 100
  },
  "composite_score": 0.934,
  "acted_upon": true,
  "order_id": "ord_uuid_v4"
}
```

**Ordering key:** `strategy_id`

---

### 6. Rejection Message (`events.rejections`)

Published by: Core when a signal is generated but not acted upon at any stage.
Full context captured for future analysis. See EXECUTION_SPEC.md for rejection stages.

```json
{
  "schema_version": "1.0",
  "rejection_id": "rej_uuid_v4",
  "timestamp": "2026-05-07T09:25:00+05:30",
  "symbol": "NIFTY-I",
  "strategy_id": "strat_nifty_mean_rev",
  "strategy_version": "1.1.0",
  "rejection_stage": "risk_check",
  "rejection_reason": "daily_loss_limit_reached",
  "signal": {
    "direction": "BUY",
    "timeframe": "5m",
    "bar_close_time": "2026-05-07T09:25:00+05:30"
  },
  "scoring": {
    "signal_strength": 0.85,
    "win_rate_component": 0.62,
    "allocator_weight_component": 0.30,
    "regime_match_component": 0.90,
    "composite_score": 0.734,
    "threshold": 0.60,
    "passed_threshold": true
  },
  "conditions_snapshot": {
    "RSI_14": 27.3,
    "SMA_50": 19480.0,
    "PRICE_close": 19450.0,
    "conditions_met": ["RSI", "PRICE_vs_SMA", "VOLUME"],
    "conditions_failed": []
  },
  "risk_context": {
    "daily_pnl_at_rejection": -18500,
    "daily_loss_limit": -18000,
    "open_positions": 0,
    "available_margin": 95000
  },
  "market_context": {
    "india_vix": 14.8,
    "regime": "trending",
    "session": "regular"
  }
}
```

**Ordering key:** `strategy_id`

---

### 7. Position Message (`events.positions`)

Published by: Core on every position lifecycle event.

```json
{
  "schema_version": "1.0",
  "event_type": "POSITION_OPENED",
  "position_id": "pos_uuid_v4",
  "symbol": "NIFTY-I",
  "exchange": "NSE",
  "segment": "FNO",
  "strategy_id": "strat_nifty_mean_rev",
  "strategy_version": "1.1.0",
  "direction": "BUY",
  "lots": 1,
  "quantity": 25,
  "entry_price": 19503.50,
  "entry_time": "2026-05-07T09:20:00+05:30",
  "stop_loss_price": 19308.47,
  "take_profit_price": 19893.57,
  "execution_mode": "paper",
  "timestamp": "2026-05-07T09:20:00.250+05:30"
}
```

**event_type values:**
- `POSITION_OPENED` — new position entered
- `POSITION_UPDATED` — stop loss moved, take profit adjusted
- `POSITION_CLOSED` — position exited (includes exit reason and final P&L)

**POSITION_CLOSED additional fields:**
```json
{
  "exit_price": 19893.57,
  "exit_time": "2026-05-07T10:05:00+05:30",
  "exit_reason": "take_profit",
  "realized_pnl": 9751.75,
  "realized_pnl_pct": 2.0,
  "hold_duration_bars": 9,
  "hold_duration_minutes": 45,
  "slippage": 0.50
}
```

**Ordering key:** `symbol`

---

### 8. Candle Message (`events.candles`)

Published by: Core on every bar close. DB Writer persists to TimescaleDB.

```json
{
  "schema_version": "1.0",
  "symbol": "NIFTY-I",
  "exchange": "NSE",
  "segment": "FNO",
  "timeframe": "5m",
  "open_time": "2026-05-07T09:15:00+05:30",
  "close_time": "2026-05-07T09:20:00+05:30",
  "open": 19480.00,
  "high": 19510.00,
  "low": 19475.00,
  "close": 19503.50,
  "volume": 125000,
  "oi": 8750000,
  "tick_count": 847
}
```

**Ordering key:** `symbol`

---

### 9. Health Message (`events.health`)

Published by: Core every 5 seconds per symbol engine. Monitoring Consumer tracks stalls.

```json
{
  "schema_version": "1.0",
  "engine_id": "NIFTY-I_5m",
  "symbol": "NIFTY-I",
  "timeframe": "5m",
  "status": "HEALTHY",
  "timestamp": "2026-05-07T09:25:00+05:30",
  "ticks_processed_last_5s": 243,
  "last_bar_close": "2026-05-07T09:25:00+05:30",
  "open_position": true,
  "position_id": "pos_uuid_v4",
  "candle_buffer_size": 200,
  "restart_count": 0
}
```

**status values:** `HEALTHY` | `RECOVERING` | `STALLED` | `HALTED`

**Ordering key:** `engine_id`

---

### 10. Risk Event Message (`events.risk`)

Published by: Core when any risk rule is triggered.

```json
{
  "schema_version": "1.0",
  "event_id": "risk_uuid_v4",
  "timestamp": "2026-05-07T11:30:00+05:30",
  "risk_level": "WARNING",
  "rule_triggered": "daily_loss_limit_approaching",
  "portfolio_pnl": -16200,
  "daily_loss_limit": -18000,
  "pct_of_limit_used": 90.0,
  "action_taken": "NONE",
  "action_recommended": "REDUCE_POSITION_SIZES",
  "strategies_affected": ["strat_nifty_mean_rev", "strat_banknifty_breakout"]
}
```

**risk_level values:** `INFO` | `WARNING` | `CRITICAL` | `EMERGENCY`

**Ordering key:** `portfolio` (constant — all risk events are portfolio-level)

---

### 11. Order Result Message (`events.order_results`)

Published by: Executor Consumer after calling Zerodha API.
Core reads this to update position state.

```json
{
  "schema_version": "1.0",
  "order_id": "ord_uuid_v4",
  "position_id": "pos_uuid_v4",
  "symbol": "NIFTY-I",
  "result": "FILLED",
  "zerodha_order_id": "240507000012345",
  "filled_price": 19504.00,
  "filled_quantity": 25,
  "fill_timestamp": "2026-05-07T09:20:00.312+05:30",
  "latency_signal_to_fill_ms": 312,
  "slippage_points": 0.50,
  "brokerage": 20.00,
  "stt": 14.63,
  "execution_mode": "paper"
}
```

**result values:** `FILLED` | `PARTIAL_FILL` | `REJECTED` | `CANCELLED` | `TIMEOUT`

**Ordering key:** `order_id`

---

## Ordering Key Reference

| Topic | Ordering Key | Why |
|---|---|---|
| `ticks.*` | symbol | Ticks for same symbol must be in order |
| `strategies.config` | strategy_id | Version updates must apply in sequence |
| `strategies.commands` | strategy_id | Commands on same strategy must be ordered |
| `events.orders` | symbol | Orders for same symbol must be sequenced |
| `events.signals` | strategy_id | Signal history must be chronological per strategy |
| `events.rejections` | strategy_id | Rejection history must be chronological |
| `events.positions` | symbol | Position lifecycle must be ordered |
| `events.candles` | symbol | Candles must arrive in bar order |
| `events.health` | engine_id | Heartbeats must be ordered per engine |
| `events.risk` | portfolio | Risk events must be sequenced |
| `events.order_results` | order_id | Fill events must be ordered per order |
| `events.executions` | symbol | Execution records ordered per symbol |

---

## GCP Configuration

```
Project:      trading-core (existing GCP project)
Region:       asia-south1 (Mumbai — lowest latency to NSE/MCX)
Schema:       JSON (all topics use JSON schemas above)
Encoding:     UTF-8

Topic naming convention:
  {domain}.{entity}           for primary topics   (ticks.nse_eq)
  {domain}.{entity}.dead      for dead letter      (ticks.nse_eq.dead)

Subscription naming convention:
  {consumer}-{entity}         (core-nse-eq, dbwriter-positions)
```

---

## Schema Versioning

All messages carry `schema_version`. When a schema changes:

```
Minor change (add optional field):
  Bump schema_version to "1.1"
  All consumers must handle missing fields gracefully
  No coordination needed

Breaking change (remove field, change type):
  Create new topic version: ticks.nse_eq.v2
  Run old and new topics in parallel during migration
  Switch consumers one at a time
  Deprecate old topic after all consumers migrated
```

---

## Cost Estimate

```
Tick volume:    100 symbols × 50 ticks/sec × 23,400 sec/day = ~117M ticks/day
Message size:   ~500 bytes per tick message
Daily data:     ~58.5 GB ticks + ~5 GB events = ~63 GB/day

Monthly (22 trading days):
  Data volume:  ~1,386 GB
  Free tier:    10 GB
  Billable:     ~1,376 GB × ₹3.20/GB = ~₹4,400/month

Note: This is the upper bound assuming 100 symbols all ticking at 50/sec continuously.
      Actual volume is lower (ticks cluster at market hours, not all symbols always active).
      Realistic estimate: ₹2,000–3,000/month.

Within ₹10k/month budget.
```

---

*Next: CORE_ARCHITECTURE.md — how Core consumes these topics and processes ticks.*
