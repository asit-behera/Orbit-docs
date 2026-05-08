# Pulse — Orbit Live Visualization System

**"Watch your system think."**

Pulse is the live visualization layer for Orbit. It makes the invisible visible — every tick, every decision, every trade — rendered as a real-time animation in the browser. It is a pure spectator: read-only, zero-coupling, zero impact on trading performance.

---

## 1. What Is Pulse?

A browser-based visualization that shows the live flow of data and decisions through Orbit's pipeline in real time.

When a tick arrives from TrueData, you see it. When a bar closes and the strategy evaluates conditions, you see each one light up. When the composite score builds across 4 components, you watch it happen. When a pre-trade filter blocks a trade, you see where it stopped. When a fill comes back from Zerodha, the whole system reacts.

It does not control anything. It does not slow anything down. It just watches and shows.

**Why it matters:**
- Most trading systems are black boxes. You trust them blindly.
- Pulse makes the system legible. You understand *why* a trade happened, or didn't.
- It builds intuition over time — patterns in how the system behaves start to feel familiar.
- When something goes wrong, you see it before the logs tell you.
- And it's extraordinary to watch a machine make financial decisions in real time.

---

## 2. Core Design Principle

```
Trading path NEVER waits for Pulse. Ever.
```

The trading system (Tick Receiver, Core Binary, Executor) publishes to Cloud Pub/Sub topics as part of its normal operation. Pulse creates its own subscriptions on those existing topics. The trading system has no knowledge of Pulse and no dependency on it.

If Pulse is offline — the trading system continues without interruption.
If Pulse is slow — it catches up from Pub/Sub's 7-day retention.
If the browser tab is closed — nothing changes upstream.

```
TrueData WebSocket
       ↓
Tick Receiver Binary ──▶ ticks.nse_eq / ticks.nse_fno / ticks.mcx ─────┐
                                                                         │
Core Binary ──▶ events.candles                                           │
           ──▶ events.signals    (Cloud Pub/Sub — 13 existing topics)    │
           ──▶ events.rejections                                          ├──▶ Pulse Service
           ──▶ events.positions                                           │    (subscriber only)
           ──▶ events.orders                                             │         ↓
           ──▶ events.risk                                               │    WebSocket
           ──▶ events.health                                             │         ↓
                                                                         │    Browser animation
Executor Consumer ──▶ events.order_results ──────────────────────────────┘
```

---

## 3. The Name

This service is called **Pulse**.

It is the 10th module in Orbit — but unlike the other 9, it produces nothing. It only observes. Like a pulse on a wrist: it tells you the system is alive and what it's doing, without being the system itself.

---

## 4. Event Architecture

### 4.1 Event Bus: Cloud Pub/Sub

Cloud Pub/Sub is already the message bus for the entire system (PUBSUB_SCHEMA.md). All 13 topics already carry exactly the events Pulse needs. **No new topics. No new event types. No changes to any trading service.**

Pulse creates read-only subscriptions on existing topics:

| Pub/Sub Topic | Pulse Subscription | What It Shows |
|---|---|---|
| `ticks.nse_eq` | `pulse-ticks-eq` | NSE equity tick flow |
| `ticks.nse_fno` | `pulse-ticks-fno` | NSE F&O tick flow (primary) |
| `ticks.mcx` | `pulse-ticks-mcx` | MCX commodity tick flow |
| `events.candles` | `pulse-candles` | Bar completions → triggers strategy eval animation |
| `events.signals` | `pulse-signals` | Signals that passed all checks → order emitted |
| `events.rejections` | `pulse-rejections` | Signals blocked — shows where and why |
| `events.orders` | `pulse-orders` | Orders placed with Zerodha |
| `events.order_results` | `pulse-order-results` | Fill confirmations and rejections |
| `events.positions` | `pulse-positions` | Position opened / updated / closed |
| `events.risk` | `pulse-risk` | Risk warnings, kill switch events |
| `events.health` | `pulse-health` | System health per symbol engine |

Topics Pulse does **not** subscribe to:
- `strategies.config` — config loads, not visual events
- `strategies.commands` — internal commands
- `events.position_commands` — trailing stop update commands (too granular for now)
- `events.executions` — duplicates what `events.order_results` already provides

### 4.2 Tick Sampling

`ticks.*` topics fire for every tick from TrueData — up to 1,000+ per second across all symbols at market open. Pulse Service applies sampling before forwarding to the browser.

```
Watched symbols (strategies currently active on this symbol):
  → Sample at max 5 ticks/sec per symbol
  → Show as fast-moving particles on the Relay node

All other symbols:
  → Sample at 1 tick/2 seconds per symbol (heartbeat only)
  → Show as a background tick rate counter, not individual particles

Bar completions (events.candles):
  → Always forwarded, never sampled
  → These are the primary triggers for strategy evaluation animations

Sampling is applied inside Pulse Service only.
Tick Receiver and Core are not involved.
```

### 4.3 Pre-existing Message Richness

The existing Pub/Sub schemas already carry everything the visualization needs. No schema changes required.

**`events.rejections` is particularly rich — it powers three panels at once:**
```json
{
  "rejection_stage": "risk_check",
  "rejection_reason": "daily_loss_limit_reached",
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
    "conditions_met": ["RSI", "PRICE_vs_SMA", "VOLUME"],
    "conditions_failed": []
  },
  "risk_context": {
    "daily_pnl_at_rejection": -18500,
    "daily_loss_limit": -18000
  },
  "market_context": {
    "india_vix": 14.8,
    "regime": "trending"
  }
}
```

This single message drives the conditions panel, the score breakdown panel, and the rejection highlight — with no additions needed.

---

## 5. The Full Pipeline — What Pulse Visualizes

Pulse visualizes every stage of the pre-trade pipeline, not just tick → trade:

```
[Tick Receiver]
    ↓ ticks.*
[Relay] — tick particles flow continuously
    ↓ events.candles (bar closes)
[Forge] — conditions evaluate one by one
    ↓ signal fires (or: SUPPRESSED — particle stops, grey)
[Score] — 4-component composite score builds visually
    ↓ score ≥ 0.60 (or: NO_STRATEGY_ABOVE_MIN — particle stops, amber)
[Event Filter] — Economic Event Filter check
    ↓ pass (or: EVENT_TOO_CLOSE — particle stops, amber)
[R:R] — ATR stop calculated, R:R ratio checked
    ↓ pass (or: RR_BELOW_MINIMUM — particle stops, amber)
[Heat] — Portfolio Heat Check
    ↓ pass (or: PORTFOLIO_TOO_HOT — particle stops, amber)
[Sentinel] — Risk rules: daily limit, margin, kill switch
    ↓ approved (or: RISK_BLOCKED — particle stops, red)
[Gravity] — Position sizing applied
    ↓ events.orders
[Thrust] — Order submitted to Zerodha
    ↓ events.order_results
[Zerodha] — Fill confirmed
    ↓ events.positions
[Position Live] — Running position, trailing stop active
```

When a trade is blocked at any stage, the particle stops there and the reason is shown. This is the system explaining itself.

---

## 6. Pulse Service

A Go binary. Consistent with the rest of the Orbit stack. Runs on the same Compute Engine VM as the other always-on processes (tick-receiver, core, db-writer, executor).

### 6.1 Responsibilities

1. Subscribe to 11 Pub/Sub topics via dedicated `pulse-*` subscriptions
2. Apply tick sampling (Section 4.2)
3. Enrich messages with animation metadata
4. Maintain in-memory state snapshot (active strategies, open positions, today's P&L, health)
5. Broadcast enriched events to all browser clients via WebSocket
6. Serve the Pulse browser app as static files
7. On new browser connection: send `STATE_SNAPSHOT` immediately

### 6.2 Enriched Event Format

Before forwarding to browser, Pulse adds display metadata:

```json
{
  "id": "uuid",
  "ts": 1715234567890,
  "source_topic": "events.signals",
  "node": "forge",
  "node_display": "Forge",
  "node_color": "#FFD93D",
  "type": "SIGNAL_GENERATED",
  "symbol": "NIFTY-I",
  "segment": "NSE_FNO",
  "payload": { "...original message fields..." },
  "animation": {
    "hint": "signal_flash",
    "from_node": "forge",
    "to_node": "score",
    "intensity": "high",
    "label": "BUY · NIFTY-I",
    "color": "#6BCB77"
  }
}
```

The `animation` object is the only thing the browser needs to decide how to render. Business logic stays in the service.

### 6.3 Animation Hints

| Hint | Triggered By | Visual |
|---|---|---|
| `tick_flow` | Tick (sampled) | Tiny fast particle through Relay |
| `bar_close` | `events.candles` | Relay → Forge particle, OHLCV on hover |
| `condition_light` | `conditions_snapshot` in signals/rejections | Condition row lights up, staggered |
| `score_build` | `scoring` in signals/rejections | Score bars fill component by component |
| `signal_flash` | `events.signals` | Bright flash at Forge, streak toward Score |
| `filter_pass` | Implied by next-stage event | Node flashes green briefly |
| `filter_block` | `events.rejections` by stage | Particle stops, amber glow, reason label |
| `risk_block` | `events.rejections` stage = `risk_check` | Red pulse at Sentinel |
| `order_launch` | `events.orders` | Bold gold particle from Thrust → Zerodha |
| `fill_celebration` | `events.order_results` FILLED | Full trade moment sequence (Section 7.4) |
| `order_rejected` | `events.order_results` REJECTED | Red X at Zerodha |
| `position_update` | `events.positions` POSITION_UPDATED | Stop line moves on position card |
| `position_closed` | `events.positions` POSITION_CLOSED | Exit card, P&L flash |
| `risk_warning` | `events.risk` level = WARNING | Sentinel pulses amber |
| `kill_switch` | `events.risk` level = EMERGENCY | Full halt visual (Section 7.5) |
| `engine_stalled` | `events.health` status = STALLED | Relay dims, stall indicator |
| `regime_shift` | `events.risk` regime change | Canvas ambient color transitions (Section 7.6) |

### 6.4 State Snapshot on Connect

```json
{
  "type": "STATE_SNAPSHOT",
  "active_strategies": [
    { "id": "strat_nifty_mean_rev", "name": "Nifty Mean Reversion", "mode": "paper", "symbol": "NIFTY-I" }
  ],
  "open_positions": [
    { "symbol": "NIFTY-I", "direction": "BUY", "entry_price": 19503.50, "unrealized_pnl": 1240 }
  ],
  "today_pnl": 3750,
  "today_trades": 3,
  "system_health": {
    "tick_receiver": "HEALTHY",
    "core": "HEALTHY",
    "executor": "HEALTHY"
  },
  "current_regime": "trending",
  "kill_switch_level": 0
}
```

The browser is immediately meaningful even if opened mid-session.

---

## 7. Visual Design

### 7.1 Layout

Full-screen canvas. Pipeline runs left to right, reflecting actual data flow:

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                     │
│  [TrueData] ──▶ [ RELAY ] ──▶ [ FORGE ] ──▶ [ SCORE ]             │
│                                   │             │                   │
│                            conditions      4-component              │
│                               panel        score panel              │
│                                                 │                   │
│                   [ EVENT FILTER ] ──▶ [ R:R ] ──▶ [ HEAT ]       │
│                                                        │            │
│                              [ SENTINEL ] ──▶ [ GRAVITY ]          │
│                                                    │                │
│                          [ THRUST ] ──────▶ [Zerodha]              │
│                                                                     │
│  ┌──────────────────────┐         active position card             │
│  │  LENS (side panel)   │                                           │
│  │  Today P&L           │                                           │
│  │  Trade count         │                                           │
│  │  Equity mini-chart   │                                           │
│  └──────────────────────┘                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 7.2 Node Visual States

| State | Visual |
|---|---|
| `idle` | Dim glow, slow 4s pulse |
| `active` | Bright, sharp, fast 1s pulse |
| `processing` | Rotating ring |
| `passed` | Green flood, fades in 500ms |
| `blocked` | Amber or red tint + reason label |
| `offline` | Dark, greyed, dashed border |

### 7.3 The Conditions Panel

Triggered by any message containing `conditions_snapshot`.

A panel slides out beside the Forge node. Each row lights up with a 150ms stagger:

```
NIFTY-I · Nifty Mean Reversion · Bar 11:32
──────────────────────────────────────────
  ◉ RSI(14) < 35           28.4   ✓
  ◉ Close > SMA(50)        24510  ✓
  ◉ Volume > 20d avg       1.4×   ✓
──────────────────────────────────────────
  → SIGNAL: BUY
```

Green = met. Red = failed (remaining rows grey out instantly). If all pass, panel transitions to Score panel.

### 7.4 The Score Panel

Triggered by any message containing `scoring` fields.

```
Composite Score  ████████░░  0.734  ✓ above 0.60
──────────────────────────────────────────────────
  Signal Strength    ████████░░   0.85  × 0.40
  Win Rate           ██████░░░░   0.62  × 0.30
  Allocator Weight   ███░░░░░░░   0.30  × 0.20
  Regime Match       █████████░   0.90  × 0.10
```

Each bar animates in with a 200ms stagger. Composite total animates last. Green if ≥ 0.60, amber if below.

### 7.5 The Trade Moment

When `events.order_results` arrives with `result = FILLED`:

```
0ms    → Fill particle explodes at Zerodha node
200ms  → Thrust floods green (profit) or red (loss)
400ms  → P&L delta floats up: "+₹9,751" fades over 2s
600ms  → Trade card slides in from right:
           NIFTY-I  BUY  1 lot
           Entry 19503.50 → Exit 19893.57
           Hold  45 min · 9 bars
           Slip  0.50 pts
           P&L   +₹9,751 (+2.0%)
1200ms → Equity mini-chart in Lens redraws with new data point
2500ms → System returns to idle
```

Everything in Pulse builds toward this moment.

### 7.6 The Kill Switch

When `events.risk` arrives with `level = EMERGENCY`:

```
All particles freeze
Nodes dim to near-black over 800ms
Bold red "HALT" appears center screen
Sentinel glows red permanently
Kill switch level badge shows: Level 1 / 2 / 3 / 4
Reason text: "Daily loss limit reached"
No new particles spawn
```

No animation flourishes. Dark and still. This is serious.

When lifted: nodes brighten over 2 seconds. System resumes.

### 7.7 Regime Shifts

Canvas ambient color transitions slowly (4 seconds) when regime changes:

| Regime | Ambient |
|---|---|
| `trending` | Deep navy, warm undertone |
| `ranging` | Deep navy, cool grey undertone |
| `high_volatility` | Deep navy, slow amber pulse |

Peripheral. Slow. Your eye learns it over time.

### 7.8 Rejection Display

When a particle stops at a pre-trade filter:

| Stage | Node | Color | Example Label |
|---|---|---|---|
| `score_below_threshold` | Score | Amber | "Score 0.42 < 0.60" |
| `no_strategy_above_min` | Score | Amber | "No strategy qualified" |
| `event_too_close` | Event Filter | Amber | "RBI MPC in 22 min" |
| `post_event_cooldown` | Event Filter | Amber | "Cooling down 8 min" |
| `rr_below_minimum` | R:R | Amber | "R:R 1.2 < 1.5" |
| `portfolio_too_hot` | Heat | Amber | "6.1% capital at risk" |
| `daily_loss_limit_reached` | Sentinel | Red | "₹18,500 / ₹18,000 limit" |
| `kill_switch_active` | Sentinel | Red | "Kill switch Level 2" |
| `margin_insufficient` | Sentinel | Red | "Margin required ₹95k" |

Fades after 3 seconds. Amber = informational. Red = serious.

### 7.9 Color Reference

| Module | Color |
|---|---|
| Relay | `#FF6B6B` |
| Forge | `#FFD93D` |
| Score | `#4D96FF` |
| Event Filter | `#80DEEA` |
| R:R | `#6BCB77` |
| Heat | `#FFB347` |
| Sentinel | `#FF6FC8` |
| Gravity | `#A5D6A7` |
| Thrust | `#FF9A3C` |
| Lens | `#B39DDB` |
| Zerodha (external) | `#387ED1` |
| Background | `#050510` radial gradient |

---

## 8. Modes

**Live** — Real events from Pub/Sub, sampled and animated as they happen.

**Replay** — Scrub through past events using Pub/Sub's 7-day retention. Watch a past session unfold. Understand exactly why a specific trade did or didn't happen.

**Demo** — Synthetic event generator, no backend needed. Fires realistic tick, bar, condition, score, filter, order, and fill events on a realistic schedule. Build this first — it lets you develop the entire browser app without waiting for market hours.

---

## 9. Implementation Plan

### Phase 1 — Pub/Sub Subscriptions (half a day)

Create 11 `pulse-*` subscriptions in GCP. No code changes to any trading service. This is the entire integration work.

```bash
gcloud pubsub subscriptions create pulse-ticks-fno \
  --topic=ticks.nse_fno \
  --ack-deadline=60 \
  --message-retention-duration=1h \
  --project=trading-core
# repeat for remaining 10 topics
```

### Phase 2 — Pulse Service, Go Binary (3–4 days)

```
pulse/
  ├── main.go          Entry point, config, signal handling
  ├── subscriber.go    Pub/Sub consumer (11 subscriptions)
  ├── sampler.go       Tick sampling logic
  ├── enricher.go      Animation hint generation from raw messages
  ├── state.go         In-memory state snapshot
  ├── hub.go           WebSocket hub — broadcast to all clients
  ├── handler.go       HTTP: WebSocket upgrade + static file server
  └── static/          Browser app bundle
```

Key dependency: `cloud.google.com/go/pubsub` — already used by Core and Executor, no new library.

### Phase 3 — Demo Mode Generator (1–2 days)

Standalone Go goroutine that fires synthetic events on a realistic IST schedule. Bypasses Pub/Sub subscriber in Demo Mode. Build before Phase 4.

### Phase 4 — Browser App, React (6–8 days)

```
pulse-ui/
  ├── App.jsx
  ├── components/
  │   ├── Pipeline.jsx          Full pipeline canvas
  │   ├── Node.jsx              Node with 5 visual states
  │   ├── Particle.jsx          Animated particle system
  │   ├── ConditionsPanel.jsx   Staggered condition eval
  │   ├── ScorePanel.jsx        4-component score bars
  │   ├── TradeCard.jsx         Fill confirmation card
  │   ├── RejectionTag.jsx      Inline rejection display
  │   ├── KillSwitch.jsx        Full-screen halt overlay
  │   └── LensPanel.jsx         P&L sidebar
  ├── hooks/
  │   ├── useWebSocket.js       Connection + reconnect
  │   └── usePipelineState.js   Live state from snapshot + events
  └── animations/
      └── particles.js          Particle physics + lifecycle
```

**Total: ~12–15 days. Build order: 1 → 2 → 3 → 4.**

---

## 10. Deployment

Pulse runs on the existing Compute Engine VM alongside other always-on binaries:

```
VM: trading-core (e2-medium, asia-south1)
  ├── tick-receiver    (systemd)
  ├── core             (systemd)
  ├── db-writer        (systemd)
  ├── executor         (systemd)
  └── pulse            (systemd)  ← new
```

```
PORT=8090
GCP_PROJECT=trading-core
MODE=live
TICK_SAMPLE_RATE_WATCHED=5
TICK_SAMPLE_RATE_OTHER=0.5
```

Accessible at `http://[VM_INTERNAL_IP]:8090` behind the same firewall rules as Grafana.

**Additional cost: ~₹0/month.** New Pub/Sub subscriptions read already-paid-for messages. No new GCP resources.

---

## 11. Future Ideas

- **Trailing stop visualization** — show stop price moving as position runs. Requires subscribing to `events.position_commands`.
- **Parallel strategy lanes** — when 3+ strategies run simultaneously, show parallel pipelines merging at Sentinel.
- **Sound design** — subtle audio for fills and risk events. Opt-in toggle.
- **Mobile companion** — stripped to: trade moment + kill switch alert only.

---

*Part of Orbit — the personal automated trading system for Indian markets.*
*Pulse is built last. Everything else must work first.*
