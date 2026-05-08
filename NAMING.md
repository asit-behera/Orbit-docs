# Orbit — Naming System

The system is called **Orbit**. Every module, service, and internal engine has a name that reflects what it does — not what it is technically called in a spec document.

This file is the single source of truth for all names. When writing docs, code comments, UI labels, or talking about the system, use these names.

---

## The System

| Name | What It Is |
|---|---|
| **Orbit** | The complete personal trading system. Everything in this repo. |

The name reflects what the system does: each module revolves around the core, each one dependent on the others, moving in defined paths. No module acts alone.

---

## The 10 Modules

### Production Modules (Phases 0–4)

| # | Name | Technical Service | Role |
|---|---|---|---|
| 1 | **Relay** | Tick Receiver Binary | Receives live market data from TrueData and publishes to the pipeline |
| 2 | **Forge** | Strategy Builder API + UI | Where strategies are built, configured, and deployed |
| 3 | **Epoch** | Backtest Engine | Tests strategies against years of historical data |
| 4 | **Prism** | Validation Suite | Separates real edge from backtesting luck |
| 5 | **Sentinel** | Risk Engine (inside Core) | Guards the system — position sizing, drawdown limits, kill switch |
| 6 | **Lens** | Analytics API + Grafana | Shows what's happening — P&L, equity curve, trade history |
| 7 | **Phantom** | Paper Executor | Simulates live trading with real market conditions, no capital at risk |
| 8 | **Thrust** | Live Executor | Executes real orders via Zerodha Kite API |
| 9 | **Gravity** | Capital Allocator | Distributes capital across strategies based on regime and performance |
| 10 | **Pulse** | Pulse Service + Browser App | Live visualization — watches the system and shows it in real time |

### Why Each Name

**Relay** — A relay station receives a signal and passes it on faithfully, without altering it. That is exactly what this binary does: receive a TrueData tick and publish it to Pub/Sub. It transforms nothing, decides nothing.

**Forge** — A forge is where raw material is shaped into something useful. Strategies start as ideas; Forge gives them structure, logic, and form. The drag-drop builder is the hammer. The strategy JSON is what comes out.

**Epoch** — An epoch is a span of time — specifically one defined by a notable event or period. The backtest engine works by replaying historical epochs: it steps through past markets bar by bar, as if living in that time. Epoch is also a term used in machine learning for a training pass — appropriate for a system that learns what works.

**Prism** — A prism separates white light into its components. The validation suite does the same to a backtest result: it separates the signal (real edge) from the noise (luck). Walk-forward analysis and Monte Carlo are the refractions.

**Sentinel** — A sentinel is a guard posted to watch and warn. Sentinel never sleeps. It runs continuously, checks every signal against risk rules, escalates through four kill switch levels, and protects capital when things go wrong. It is the system's immune response.

**Lens** — A lens brings distant or unclear things into focus. The analytics dashboard takes raw trade data — P&L, Sharpe ratio, win rate, equity curve — and makes it readable. It does not generate information, it clarifies it.

**Phantom** — A phantom is present but not real. Paper trading feels exactly like live trading — the same pipeline, the same conditions, the same execution path — but no capital moves. Phantom trades leave no financial trace.

**Thrust** — Thrust is force applied in a direction. When a signal has passed every check and capital has been allocated, Thrust is the mechanism that converts intent into action: a real order, sent to a real broker, with real money behind it.

**Gravity** — Gravity pulls mass toward mass. The allocator pulls capital toward what performs — strategies that are working in the current regime attract more weight. When a strategy degrades, gravity shifts away from it. It is invisible but always present.

**Pulse** — A pulse is the observable heartbeat of a living system. Pulse does not trade, does not decide, does not store. It watches everything and makes it visible in real time. Like checking a patient's pulse: it tells you the system is alive and how it's doing, without being the system itself.

---

## Internal Pipeline Nodes

These are not separate services — they are named stages inside the Core Binary that appear as distinct nodes in Pulse's visualization. They have names so they can be referred to clearly in docs, logs, and the UI.

| Name | Stage | What It Does |
|---|---|---|
| **Score** | Composite Scoring Engine | Calculates a 4-component score to select the best strategy when multiple signal simultaneously |
| **Filter** | Economic Event Filter | Blocks entries during scheduled high-volatility events (RBI MPC, Budget, FOMC) |
| **RR** | R:R Engine | Calculates ATR-based stop, dynamic target, and verifies minimum 1.5 R:R before proceeding |
| **Heat** | Portfolio Heat Check | Checks if total capital at risk across all open positions is within the 6% ceiling |

These four nodes sit between signal generation and order emission. They are part of Sentinel's broader role but operate as distinct, named checks.

---

## External Dependencies

These are third-party services that Orbit integrates with. They are not part of Orbit and do not get Orbit names — they are referred to by their actual names.

| External Service | Role in Orbit |
|---|---|
| **TrueData** | Market data provider — feeds Relay |
| **Zerodha** | Broker — receives orders from Thrust |
| **GCP Cloud Pub/Sub** | Message bus between all modules |
| **TimescaleDB** | Time-series database for tick and OHLCV data |
| **PostgreSQL** | Relational database for strategies, trades, positions |
| **Redis** | Hot state cache for Core (positions, candle buffers, kill switch) |
| **Prometheus** | Metrics collection |
| **Grafana** | Dashboard renderer for Lens |
| **Telegram** | Alert delivery channel |

---

## Naming Rules

When writing code, docs, UI labels, or talking about the system:

1. **Use the Orbit name, not the technical name.** Write "Relay" not "tick-receiver-binary". Write "Thrust" not "live-executor".

2. **The system is Orbit, always capitalized.** Not "orbit", not "the system", not "the trading suite".

3. **Modules are capitalized.** Relay, Forge, Epoch — always with a capital letter.

4. **Internal nodes are capitalized.** Score, Filter, RR, Heat — same rule.

5. **External services keep their real names.** Zerodha, TrueData, GCP — never rename third parties.

6. **Binary and service names in code stay technical.** The Go binary can be named `tick-receiver` in the Dockerfile and systemd config. The Orbit name lives in documentation, UI, and conversation.

---

## Quick Reference

```
Orbit
  ├── Relay       ← market data in
  ├── Forge       ← strategy design
  ├── Epoch       ← historical testing
  ├── Prism       ← validation
  ├── Sentinel    ← risk + kill switch
  │     ├── Score     (internal: composite scoring)
  │     ├── Filter    (internal: economic event filter)
  │     ├── RR        (internal: R:R check)
  │     └── Heat      (internal: portfolio heat check)
  ├── Lens        ← analytics + dashboards
  ├── Phantom     ← paper trading
  ├── Gravity     ← capital allocation
  ├── Thrust      ← live execution
  └── Pulse       ← live visualization
```

---

*Last updated: May 2026*
