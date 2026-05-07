# Core Architecture

Design specification for the Core Trading Binary — the heart of the system.
Covers goroutine topology, segment modules, symbol engine, state management, and failure handling.

See PUBSUB_SCHEMA.md for all message schemas.
See EXECUTION_SPEC.md for order flow and executor design.
See RISK_ENGINE_SPEC.md for risk rules and kill switch.
See STRATEGY_SCHEMA.md for strategy JSON format.

---

## Design Principles

1. **Zero DB in Core.** Core never touches PostgreSQL or TimescaleDB directly. All persistence is via Pub/Sub events consumed by the DB Writer service.
2. **Redis for hot state only.** Core reads Redis on startup (positions, candle buffers, strategy configs). Core writes Redis for position state updates. Redis is not a database — it is a fast shared memory layer.
3. **Single responsibility.** Core receives ticks, evaluates strategies, emits events. Nothing else.
4. **Evaluate on closed candles only.** Strategies never evaluate on the current open bar. This guarantees backtest and live behaviour are identical.
5. **One goroutine owns one symbol.** No two goroutines ever write to the same symbol engine state. Eliminates data races without locks in the hot path.
6. **Segment modules are plugins.** Core does not know the difference between a Nifty futures tick and a Gold MCX tick. The segment module handles all instrument-specific logic.

---

## System Overview — Two Binaries

```
┌─────────────────────────────────┐      ┌──────────────────────────────────────────┐
│   Tick Receiver Binary          │      │   Core Binary                            │
│                                 │      │                                          │
│   Single responsibility:        │      │   Single responsibility:                 │
│   TrueData WebSocket            │      │   Receive ticks → evaluate strategies    │
│      → Parse ticks              │ Pub/ │      → emit events                      │
│      → Publish to Pub/Sub       │ Sub  │                                          │
│                                 │ ───▶ │   READS:  Pub/Sub + Redis               │
│   Restarts independently.       │      │   WRITES: Pub/Sub + Redis               │
│   Core is never affected by     │      │   NEVER:  PostgreSQL, TimescaleDB        │
│   TrueData reconnection.        │      │                                          │
└─────────────────────────────────┘      └──────────────────────────────────────────┘
```

---

## Tick Receiver Binary

Minimal binary. Does exactly one thing.

```
Responsibilities:
  Connect to TrueData WebSocket (NSE EQ, NSE F&O, MCX)
  Parse incoming tick JSON
  Publish to correct Pub/Sub topic (ticks.nse_eq / ticks.nse_fno / ticks.mcx)
  Reconnect on disconnect (exponential backoff, max 5 retries then alert)
  Heartbeat: publish sentinel tick every 30s per segment to confirm liveness

Does NOT:
  Store anything
  Process anything
  Know what strategies exist
  Know what Core is doing

Goroutines (minimal):
  1 × WebSocket receiver per segment (3 goroutines for NSE EQ, NSE F&O, MCX)
  1 × Pub/Sub producer (shared across all segments)
  1 × Reconnection watchdog
  1 × Liveness heartbeat emitter
  Total: ~6 goroutines
```

---

## Core Binary — Full Goroutine Topology

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Core Binary                                                                 │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Pub/Sub Consumers (3 goroutines — one per segment topic)           │    │
│  │  ticks.nse_eq / ticks.nse_fno / ticks.mcx                          │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │ tick messages                                │
│  ┌────────────────────────────▼────────────────────────────────────────┐    │
│  │  Tick Dispatcher (1 goroutine)                                      │    │
│  │  Routes each tick to the correct symbol's channel                   │    │
│  │  map[symbol] → chan Tick (buffered, 1000 capacity)                  │    │
│  └──────────┬────────────┬────────────┬─────────────┬──────────────────┘    │
│             │            │            │             │                        │
│      ┌──────▼──┐  ┌──────▼──┐  ┌─────▼───┐  ┌─────▼───┐                   │
│      │Symbol   │  │Symbol   │  │Symbol   │  │Symbol   │  ... ×100          │
│      │Engine   │  │Engine   │  │Engine   │  │Engine   │                    │
│      │NIFTY-I  │  │RELIANCE │  │GOLD-I   │  │BANKNIFTY│                    │
│      │Supervisor│  │Supervisor│  │Supervisor│  │Supervisor│                   │
│      └──────┬──┘  └──────┬──┘  └─────┬───┘  └─────┬───┘                   │
│             └────────────┴────────────┴─────────────┘                       │
│                               │ Order + Event messages                       │
│  ┌────────────────────────────▼────────────────────────────────────────┐    │
│  │  Order Processor (1 goroutine)                                      │    │
│  │  Final risk gate → routes to events.orders (Pub/Sub)               │    │
│  └────────────────────────────┬────────────────────────────────────────┘    │
│                               │                                              │
│  ┌────────────────────────────▼────────────────────────────────────────┐    │
│  │  Event Emitter (1 goroutine)                                        │    │
│  │  Batches all outbound Pub/Sub publishes (signals, candles, health)  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Strategy Registry Watcher (1 goroutine)                            │    │
│  │  Subscribes to strategies.config + strategies.commands              │    │
│  │  Hot-loads strategy changes into all symbol engines                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Health Monitor (1 goroutine)                                       │    │
│  │  Checks heartbeat timestamps every 10s                              │    │
│  │  Triggers supervisor restart on stall detection                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Position Watchdog (1 goroutine)                                    │    │
│  │  Reads all open positions every 30s                                 │    │
│  │  Emergency exit if stop loss breached + engine unhealthy            │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  API Server (1 goroutine + 1 per active request, short-lived)       │    │
│  │  Strategy management, position queries, config updates              │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Post-Entry Monitor (1 goroutine per open position)                 │    │
│  │  Spawned by symbol engine on fill confirmation                      │    │
│  │  Runs on every tick (not bar close) for the open position           │    │
│  │  Evaluates: trailing stop threshold, exit rule checks               │    │
│  │  Emits: events.position_commands (stop updates)                     │    │
│  │  Terminates: when position closes                                   │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                              │
│  Total goroutines at rest (100 symbols): ~115                               │
│  Total goroutines at rest (700 symbols): ~720                               │
│  Open positions add: 1 goroutine each (Post-Entry Monitor)                 │
│  Memory at 700 symbols: ~6 MB for goroutine stacks (negligible)            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Full Pre-Trade and Post-Trade Pipeline

The complete flow from tick arrival to position management.
This is the most important single diagram in the system.

```
TICK ARRIVES (from Pub/Sub)
        │
        ▼
CANDLE AGGREGATION
  Symbol Engine: update open candle OHLCV
  Bar closed? ──NO──▶ (nothing more — wait for next tick)
        │YES
        ▼
STRATEGY EVALUATION (on closed bar)
  Evaluate all active strategies for this symbol + timeframe
  Any signals? ──NO──▶ (idle — wait for next bar)
        │YES
        ▼
STRATEGY SELECTION
  Calculate composite score for each signalling strategy
  (Signal Strength × 0.4) + (Win Rate × 0.3) +
  (Allocator Weight × 0.2) + (Regime Match × 0.1)
  Winner above min_threshold? ──NO──▶ Rejection: NO_STRATEGY_ABOVE_MIN
        │YES
        ▼
OPEN POSITION CHECK
  Symbol already has open position?
  ──YES──▶ Evaluate ONLY locked strategy exit rules (skip all below)
        │NO
        ▼
PRE-TRADE FILTER ENGINES
  ┌──────────────────────────────────────────────────────────┐
  │  [1] Economic Event Filter                               │
  │      Event within buffer window? → Reject: EVENT_TOO_CLOSE
  │                                                          │
  │  [2] R:R Engine                                          │
  │      Calculate stop price (ATR or fixed %)               │
  │      Calculate target price (R:R driven or fixed %)      │
  │      rr_ratio = reward / risk                            │
  │      rr_ratio < min_rr? → Reject: RR_BELOW_THRESHOLD    │
  │                                                          │
  │  [3] Portfolio Heat Check                                │
  │      projected_heat = current + new trade heat           │
  │      projected_heat > max_heat? → try reduce lots        │
  │      still > max? → Reject: PORTFOLIO_HEAT_EXCEEDED      │
  └──────────────────────────────────────────────────────────┘
        │ALL PASS
        ▼
RISK CHECK GATE (Stage 3)
  Daily loss limit reached? → Reject: DAILY_LOSS_LIMIT_REACHED
  Kill switch level >= 2?   → Reject: KILL_SWITCH_ACTIVE
  Margin insufficient?      → Reject: MARGIN_INSUFFICIENT
  Outside trade window?     → Reject: OUTSIDE_TRADE_WINDOW
        │ALL PASS
        ▼
ORDER VALIDATION (Stage 4 — Segment Module)
  Expiry day block, MCX delivery block, circuit breaker, lot size
        │ALL PASS
        ▼
ORDER INTENT EMITTED
  → events.orders (Pub/Sub)
  → Symbol engine state: WAITING_FOR_FILL
        │
        ▼
EXECUTOR CONSUMER
  Pre-flight check (Stage 5)
  Calls Zerodha API or Paper Trader
        │
        ▼
FILL CONFIRMED
  → events.order_results (Pub/Sub)
  → Core receives fill confirmation
  → Position opened in Redis
  → Initial stop placed at Zerodha (GTT)
  → Symbol engine state: POSITION_OPEN
  → Post-Entry Monitor goroutine SPAWNED
        │
        ▼
POST-ENTRY MONITORING (every tick, per open position)
  ┌──────────────────────────────────────────────────────────┐
  │  Trailing Stop Engine (tick-level)                       │
  │    Update peak_price on each tick                        │
  │    Calculate candidate new stop                          │
  │    Threshold check: meaningful improvement?              │
  │    Bar gap check: min bars since last update?            │
  │    Budget check: mod_count >= 22 → refresh first         │
  │    IF ALL PASS:                                          │
  │      Emit: events.position_commands {UPDATE_STOP}        │
  │      Executor updates GTT at Zerodha                     │
  │                                                          │
  │  Exit Rule Monitor (bar close only)                      │
  │    Evaluate locked strategy's exit rules in priority:    │
  │    forced → risk_breach → trailing_stop →                │
  │    take_profit → signal_exit → time_exit                 │
  │    Exit triggered?                                       │
  │      Emit: events.orders (close order)                   │
  │      Executor calls Zerodha → close position             │
  └──────────────────────────────────────────────────────────┘
        │EXIT CONFIRMED
        ▼
POSITION CLOSED
  → events.positions (POSITION_CLOSED with P&L)
  → Redis position state cleared
  → Symbol engine state: IDLE
  → Post-Entry Monitor goroutine terminates
  → Strategy unlocked (available for next signal)
  → Trade written to TRADE_INTELLIGENCE_SPEC tables
```

---

## Segment Modules

Core has no knowledge of instrument-specific rules. Every segment-specific behaviour is
encapsulated behind the SegmentModule interface. Modules are registered at startup based
on the `enabled_segments` config.

```go
type SegmentModule interface {
    // Identity
    Name()    string  // "equity" | "futures" | "commodity" | "options"
    Segment() string  // "NSE_EQ" | "NSE_FNO" | "MCX"

    // Market hours
    MarketOpen()      time.Time
    MarketClose()     time.Time
    IsMarketOpen()    bool
    IsExpiryDay(t time.Time, symbol string) bool
    ForcedExitTime()  time.Time  // 15:15 IST for MIS, 23:00 for MCX

    // Instrument rules
    LotSize(symbol string)              int
    TickSize(symbol string)             float64
    MarginRequired(symbol string, qty int, price float64) float64
    OrderProduct(intraday bool)         string  // "MIS" | "NRML" | "CNC"

    // Expiry handling (futures/commodity — returns nil for equity)
    RollRequired(symbol string, t time.Time)    bool
    ActiveContract(symbol string)               string

    // Validation
    ValidateOrder(o Order)                      error
    ValidateInstrument(symbol string)           error

    // Risk rules specific to this segment
    PreTradeChecks(o Order, portfolio Portfolio) []RiskViolation
}
```

### Module Implementations

**EquityModule (NSE_EQ)**
```
LotSize:        reads from instruments_india table (via Redis cache)
OrderProduct:   CNC for overnight, MIS for intraday
ForcedExit:     15:15 IST (MIS orders)
IsExpiryDay:    always false
RollRequired:   always false
PreTradeChecks: circuit breaker check, upper/lower price band check
```

**FuturesModule (NSE_FNO)**
```
LotSize:        reads from instruments_india (changes on contract rollover)
OrderProduct:   MIS for intraday, NRML for overnight
ForcedExit:     15:25 IST (MIS), last Thursday of month (expiry)
IsExpiryDay:    true on monthly/weekly expiry Thursdays
RollRequired:   true when OI migration detected (see CONTINUOUS_CONTRACTS_SPEC.md)
PreTradeChecks: SPAN margin check, expiry proximity check (warn if < 3 days)
MarginRequired: SPAN + Exposure margin from instruments table
```

**CommodityModule (MCX)**
```
LotSize:        reads from instruments_india (Gold 100g, Silver 30kg, Crude 100 bbl)
OrderProduct:   MIS for intraday, NRML for overnight
ForcedExit:     23:00 IST (MCX evening session closes 23:30, exit at 23:00)
IsExpiryDay:    true on MCX contract expiry date
RollRequired:   true on OI migration
PreTradeChecks: physical delivery check (HARD BLOCK if < 3 days to expiry),
                INR conversion check for USD-denominated commodities
MarketClose:    23:30 IST (not 15:30 — MCX has evening session)
```

**OptionsModule (NSE_FNO) — Phase 2, scaffolded only**
```
Status:         NOT ACTIVE in Phase 1
Interface:      implemented (returns ErrNotImplemented on all calls)
Activation:     change config options.enabled = true
```

---

## Symbol Engine

One goroutine per active symbol. Owns all state for that symbol exclusively.
No other goroutine ever writes to a symbol engine's state.

### Internal Structure

```go
type SymbolEngine struct {
    // Identity
    Symbol  string
    Module  SegmentModule

    // Candle buffers — one per timeframe this symbol's strategies use
    Buffers map[string]*CandleBuffer  // "5m" → buffer, "15m" → buffer

    // Current open candle (not yet closed — never used for signals)
    OpenCandles map[string]*Candle

    // Strategy management
    Registry   *StrategyRegistry  // shared, RLock on read
    ActivePos  *Position          // nil if no open position
    LockedStrat *StrategyConfig   // non-nil only during open position

    // Output channels (written by this engine, read by Order Processor)
    OrderChan  chan<- OrderIntent
    EventChan  chan<- Event

    // Supervision
    Heartbeat  chan<- Heartbeat
    Status     EngineStatus  // HEALTHY | RECOVERING | STALLED | HALTED

    // State
    RestartCount int
    LastBarClose time.Time
}
```

### Candle Buffer (Ring Buffer)

```go
type CandleBuffer struct {
    candles  []Candle   // fixed-size circular array
    head     int        // index of most recently written candle
    size     int        // number of candles currently in buffer (up to capacity)
    capacity int        // fixed at startup, never changes
}

// Get(0) = most recently closed candle (LIFO — most recent first)
// Get(1) = candle before that
// Get(n) = n candles ago
func (b *CandleBuffer) Get(n int) (Candle, bool) {
    if n >= b.size { return Candle{}, false }
    idx := (b.head - n + b.capacity) % b.capacity
    return b.candles[idx], true
}

// Push adds a newly closed candle. Overwrites oldest if at capacity.
func (b *CandleBuffer) Push(c Candle) {
    b.head = (b.head + 1) % b.capacity
    b.candles[b.head] = c
    if b.size < b.capacity { b.size++ }
}
```

**Capacity rule:**
```
capacity = max(all indicator periods used across all strategies on this symbol) + 50

Example:
  Strategy A uses SMA(200), RSI(14)
  Strategy B uses EMA(50), MACD(26,12)
  max period = 200
  capacity = 250

Memory per symbol (250 candles × ~120 bytes): ~30KB
Memory for 100 symbols: ~3MB — negligible
```

### Tick Processing Loop

```
For each tick received on symbol's channel:

  1. Update open candle (OHLCV in memory — never used for signals)
  2. Check if bar has closed (current_time >= open_candle.close_time)

  If bar NOT closed:
    → Nothing more to do. Return.

  If bar CLOSED:
    3. Finalise closed candle (close price = last tick price)
    4. Push to ring buffer
    5. Publish candle to events.candles (via Event Emitter)
    6. Update heartbeat timestamp

    If engine status == RECOVERING:
      → Increment bars-since-recovery counter
      → If counter >= recovery_threshold (2 bars): set status = HEALTHY
      → Do NOT evaluate strategies yet. Return.

    7. Evaluate strategies (see Strategy Evaluation below)
    8. If signal generated → Strategy Selector → Order Processor
```

**Why evaluate on bar close only:**
```
If you evaluate on the open (live) candle:
  Indicator X triggers at 09:17:30
  Indicator X reverses at 09:19:45
  Bar closes at 09:20 with indicator X NOT triggered

  Live system: traded at 09:17:30
  Backtest:    never saw a signal (evaluates on closed bars)
  → Backtest/live divergence → strategy appears to work in backtest but not live

Evaluating only on closed candles guarantees identical behaviour.
```

### Strategy Evaluation

```
On each bar close (engine is HEALTHY):

  1. Collect all active strategies for this symbol + timeframe
     (from StrategyRegistry — RLock, nanoseconds)

  2. If open position exists:
     → Evaluate ONLY the locked strategy's exit rules
     → If exit triggered: emit OrderIntent (SELL/BUY_TO_CLOSE)
     → Return. No entry evaluation.

  3. If no open position (IDLE state):
     → Evaluate all active strategies
     → Filter: only strategies that generated a signal
     → If none: return
     → Calculate composite score for each signalling strategy
     → Select highest score above min_composite_threshold
     → If none above threshold: emit Rejection event, return
     → Pass to Risk Engine check (inline, no DB call)
     → If risk check fails: emit Rejection event, return
     → Emit OrderIntent → Order Processor
     → Set engine state: WAITING_FOR_FILL
```

---

## Symbol Engine Supervisor

Every symbol engine runs inside a supervisor loop. The supervisor handles all failure modes.

### Failure Modes and Handling

```
Mode 1 — Panic (nil pointer, index out of bounds):
  Go's guarantee: panic in goroutine X does not affect goroutine Y
  Supervisor uses recover() to catch panic
  Logs: symbol, panic message, stack trace
  Restarts engine with state recovery

Mode 2 — Silent Exit (channel closed, context cancelled):
  Supervisor detects exit via goroutine return
  If context is Done: normal shutdown, do not restart
  If context is NOT Done: unexpected exit → restart with state recovery

Mode 3 — Stall (goroutine alive but frozen):
  Engine writes heartbeat every 5 seconds
  Health Monitor checks all heartbeats every 10 seconds
  If heartbeat age > 30 seconds → stall detected
  Health Monitor cancels engine's context → forces exit
  Supervisor detects exit → restarts with state recovery

Mode 4 — Data Corruption (running but bad state):
  Detected via: indicator values outside valid range (RSI > 100, negative ATR)
  Or: candle sequence error (bar close_time < previous bar close_time)
  Engine self-detects → logs CORRUPTION_DETECTED → exits cleanly
  Supervisor restarts with full state recovery from Redis
```

### Restart Lifecycle

```
Attempt 1:  restart immediately
Attempt 2:  wait 5 seconds
Attempt 3:  wait 30 seconds
Attempt 4:  wait 2 minutes
Attempt 5+: HALT — set engine status = HALTED
            Emit events.health with status = HALTED
            Alert operator
            Do not restart automatically
            Requires manual intervention via API: POST /engines/{symbol}/restart

Why halt at 5 attempts?
  Repeated failure = systemic problem (bad data, memory issue, strategy bug)
  Blind restart loop makes things worse
  Open positions are protected by Position Watchdog (see below)
  Human review required before resuming
```

### Supervisor Structure

```go
func RunSupervisedEngine(ctx context.Context, symbol string, deps EngineDeps) {
    restartCount := 0
    backoffs := []time.Duration{0, 5*time.Second, 30*time.Second, 2*time.Minute}

    for {
        // Apply backoff
        if restartCount > 0 {
            delay := backoffs[min(restartCount-1, len(backoffs)-1)]
            select {
            case <-time.After(delay):
            case <-ctx.Done():
                return  // graceful shutdown
            }
        }

        // Check halt threshold
        if restartCount >= 5 {
            deps.EventChan <- HaltedEvent{Symbol: symbol}
            deps.AlertChan <- Alert{Level: CRITICAL, Message: "Engine halted after 5 restarts"}
            return  // exit supervisor, engine is halted
        }

        // Run engine with panic recovery
        err := runEngineWithRecovery(ctx, symbol, deps, restartCount)

        // Check if shutdown was requested
        select {
        case <-ctx.Done():
            return
        default:
        }

        // Unexpected exit — increment and loop
        restartCount++
        deps.EventChan <- RestartEvent{Symbol: symbol, Attempt: restartCount, Reason: err}
    }
}
```

---

## State Management

### What Lives in Redis

```
Key: state:positions
Value: JSON map of all open positions
TTL: none (permanent until closed)
Written by: DB Writer Consumer (authoritative source)
            Core (optimistic writes for speed — DB Writer reconciles)
Read by: Core on startup, Position Watchdog

Key: state:candles:{symbol}:{timeframe}
Value: JSON array of last 250 closed candles
TTL: 48 hours
Written by: DB Writer Consumer (writes from TimescaleDB on request)
Read by: Core on symbol engine startup

Key: state:strategies
Value: JSON map of all active strategy configs
TTL: none
Written by: Strategy Builder API (on every save/activate)
Read by: Core Strategy Registry Watcher

Key: state:risk
Value: JSON — daily P&L, open positions count, margin used
TTL: 24 hours (refreshed each trading day at open)
Written by: Core (position updates), Risk Engine
Read by: Core (for inline risk checks)
```

### Startup Sequence (Redis Only — No DB)

```
Step 1: Load active strategies
  Redis.Get("state:strategies")
  → Build StrategyRegistry in memory
  → If Redis miss: call Strategy Builder API GET /strategies/active
  → Strategy Builder API reads from PostgreSQL, returns JSON, Core loads it

Step 2: Load open positions
  Redis.Get("state:positions")
  → For each open position: reconstruct PositionState
  → Match to locked strategy version
  → If Redis miss: call internal bootstrap endpoint (see Cold Start below)

Step 3: Load candle buffers for each active symbol
  For each symbol in active strategies:
    Redis.Get("state:candles:{symbol}:{timeframe}")
    → Rebuild CandleBuffer from stored candles
    → If Redis miss: DB Writer fetches last 250 candles from TimescaleDB, writes to Redis
    → Core waits (with timeout) for Redis to be populated

Step 4: Load risk state
  Redis.Get("state:risk")
  → Populate daily P&L, margin used
  → If Redis miss: start fresh (beginning of day or first run)

Step 5: Mark all engines as RECOVERING
  No entry signals until RECOVERING state clears (2 bars per engine)

Step 6: Subscribe to Pub/Sub topics
  Begin consuming ticks — normal operation
```

### Cold Start (Redis Completely Empty)

Redis can be empty on first-ever deployment or after a Redis flush.

```
Bootstrap Service (separate, one-off process):
  1. Read all active strategies from PostgreSQL
     → Write to Redis state:strategies

  2. Read all open positions from PostgreSQL
     → Write to Redis state:positions

  3. For each active symbol:
     → Query TimescaleDB: last 250 candles per timeframe
     → Write to Redis state:candles:{symbol}:{timeframe}

  4. Write empty risk state
     → Write to Redis state:risk

  5. Signal Core to proceed (via Redis key: bootstrap:complete = true)

Core waits at startup for bootstrap:complete before proceeding.
Bootstrap Service is a separate Go binary, runs once, exits.
Not part of Core binary.
```

---

## Position Watchdog

Runs independently of all symbol engines. Safety net for open positions.

```
Every 30 seconds:
  1. Read all open positions from Redis
  2. For each open position:
     a. Get current price from Redis (last tick for that symbol)
     b. Check if stop loss has been breached:
           current_price <= position.stop_loss_price (for LONG)
           current_price >= position.stop_loss_price (for SHORT)
     c. Get engine health status for that symbol
     d. If stop loss breached AND engine status != HEALTHY:
           → Emit emergency exit OrderIntent directly to Order Processor
           → Log: WATCHDOG_EMERGENCY_EXIT
           → Alert: CRITICAL

Note: Watchdog does NOT fire if engine is HEALTHY.
      Symbol engine handles its own exits when healthy.
      Watchdog is only the safety net for engine failure scenarios.

Watchdog does NOT:
  Generate entry signals
  Modify strategy state
  Write to DB
  It only reads and emits emergency exits
```

---

## Hot Strategy Loading

Strategies can be loaded, updated, and deactivated without restarting Core.

```go
type StrategyRegistry struct {
    mu         sync.RWMutex
    strategies map[string]*CompiledStrategy  // strategy_id:version → compiled
    bySymbol   map[string][]string           // symbol → []strategy_id:version
}

// Hot load (called by Strategy Registry Watcher on new message)
func (r *StrategyRegistry) Load(def StrategyDefinition) error {
    compiled, err := CompileStrategy(def)  // parse AST, validate, build evaluator tree
    if err != nil { return err }

    r.mu.Lock()
    defer r.mu.Unlock()
    key := def.ID + ":" + def.Version
    r.strategies[key] = compiled
    r.bySymbol[def.Instrument.Symbol] = append(r.bySymbol[def.Instrument.Symbol], key)
    return nil
}

// Hot deactivate (called on STRATEGY_DEACTIVATED command)
func (r *StrategyRegistry) Deactivate(strategyID string) {
    r.mu.Lock()
    defer r.mu.Unlock()
    // Mark as inactive — symbol engines skip inactive strategies
    // Do NOT remove — open positions may still reference this strategy for exits
    if s, ok := r.strategies[strategyID]; ok {
        s.Active = false
    }
}

// Symbol engines read with RLock — hundreds of goroutines, zero contention
func (r *StrategyRegistry) GetForSymbol(symbol string) []*CompiledStrategy {
    r.mu.RLock()
    defer r.mu.RUnlock()
    var result []*CompiledStrategy
    for _, key := range r.bySymbol[symbol] {
        if s := r.strategies[key]; s != nil && s.Active {
            result = append(result, s)
        }
    }
    return result
}
```

**sync.RWMutex guarantees:** Any number of symbol engine goroutines can read simultaneously.
Only the rare strategy load/deactivate operation briefly takes a write lock.
The hot path (tick processing → strategy read) is never blocked.

---

## Graceful Shutdown

```
Shutdown trigger:
  SIGTERM / SIGINT received by Core process
  OR: API call POST /control/shutdown

Shutdown sequence:
  1. Cancel root context (propagates to all goroutines)
  2. Stop accepting new ticks (Pub/Sub consumers stop polling)
  3. Wait for all symbol engines to finish current bar evaluation (timeout: 5s)
  4. Wait for Order Processor to drain order channel (timeout: 10s)
  5. Wait for Event Emitter to flush pending events (timeout: 10s)
  6. Write final position state to Redis
  7. Emit shutdown event to events.health
  8. Exit

Open position policy on shutdown:
  If shutdown is graceful (SIGTERM): do NOT close positions
    → Positions remain open with stop losses at Zerodha (GTT orders)
    → Core will reload positions on next startup
  If shutdown is emergency (API: POST /control/emergency-shutdown):
    → Close all open positions at market before shutdown
    → Wait for fill confirmations (timeout: 30s)
    → Then proceed with graceful sequence
```

---

## Back-Pressure Handling

```
Symbol tick channel capacity: 1,000 ticks per symbol

Normal operation:
  Dispatcher writes tick → symbol engine reads immediately
  Channel depth stays near 0

Back-pressure scenario (engine processing slowly):
  Channel fills up
  At 800/1000 (80%): Health Monitor logs WARNING, emits alert
  At 1000/1000:      Channel is full — dispatcher DROPS the tick
                     Logs: TICK_DROPPED {symbol, timestamp, channel_depth}
                     Increments drop counter

Why drop instead of block?
  Blocking the dispatcher would back-pressure ALL symbols, not just the slow one
  One slow symbol should not affect Nifty, BankNifty, etc.
  For 5m candle strategies: occasional tick drop does not affect OHLCV correctness
    (we care about open, high, low, close — not every single tick)
  High tick count in a bar is still accurate (last tick before bar close = correct close price)

Tick drop policy:
  Drop count > 10 in 1 minute: WARNING alert
  Drop count > 100 in 1 minute: engine considered unhealthy, supervisor triggered
```

---

## API Server (Internal Control)

Runs inside Core binary on port 8080. Only accessible within GCP VPC.
Not exposed to the internet.

```
Strategy Management:
  GET    /strategies                    → list all active strategies
  POST   /strategies/reload             → trigger reload from Redis
  POST   /strategies/{id}/activate      → activate strategy
  POST   /strategies/{id}/deactivate    → deactivate strategy (no position close)

Position Queries:
  GET    /positions                     → all open positions
  GET    /positions/{symbol}            → position for specific symbol
  POST   /positions/{id}/close          → manually close a position at market

Engine Management:
  GET    /engines                       → status of all symbol engines
  GET    /engines/{symbol}              → specific engine status + metrics
  POST   /engines/{symbol}/restart      → manually restart a halted engine
  POST   /engines/{symbol}/recover      → force engine to re-run state recovery

Risk Control:
  GET    /risk/status                   → current portfolio risk state
  POST   /risk/kill-switch              → trigger emergency shutdown of all positions

System Control:
  GET    /health                        → system health (liveness probe for GCP)
  POST   /control/shutdown              → graceful shutdown
  POST   /control/emergency-shutdown    → close all positions + shutdown
```

---

## Configuration

Loaded at startup from environment variables and GCP Secret Manager.
No config reloads without restart (except strategies which are hot-loaded via Pub/Sub).

```yaml
core:
  enabled_segments:
    - equity
    - futures
    - commodity
    # - options  ← Phase 2, leave commented

pubsub:
  project_id: trading-core
  subscription_nse_eq:  core-nse-eq-sub
  subscription_nse_fno: core-nse-fno-sub
  subscription_mcx:     core-mcx-sub
  subscription_strategies: core-strategies-sub

redis:
  address: 10.0.0.5:6379  # Cloud Memorystore internal IP
  db: 0

engine:
  tick_channel_capacity: 1000
  candle_buffer_capacity: 250
  heartbeat_interval_sec: 5
  stall_threshold_sec: 30
  max_restarts_before_halt: 5
  recovery_bars_required: 2

risk:
  min_composite_score_threshold: 0.60
  daily_loss_limit_inr: 18000

watchdog:
  check_interval_sec: 30

api:
  port: 8080
  shutdown_timeout_sec: 30
```

---

## Performance Characteristics

```
Tick processing latency (Pub/Sub → signal decision):
  Pub/Sub consumer read:       1–5ms   (network)
  Tick parse + dispatch:       <1µs
  Symbol engine tick update:   <1µs    (OHLCV state update)
  Bar close evaluation:        <50µs   (indicator math + condition tree)
  Order emit to Pub/Sub:       1–5ms
  Total (non-bar tick):        2–10ms
  Total (bar close + signal):  3–15ms

CPU utilisation at 100 symbols, 5m candles:
  Tick processing:     ~0.1% per vCPU
  Bar evaluations:     ~0.01% per vCPU
  Pub/Sub overhead:    ~0.5% per vCPU
  Total Core load:     <2% on e2-medium (2 vCPU)

Memory footprint:
  Goroutine stacks (115 goroutines): ~1MB
  Candle buffers (100 symbols):      ~3MB
  Strategy registry:                 ~5MB
  Pub/Sub client buffers:            ~10MB
  Total Core RSS:                    ~25–50MB
```

---

*Next: EXECUTION_SPEC.md — order flow, executor consumer, paper trader, rejected trades.*
