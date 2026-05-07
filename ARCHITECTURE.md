# Technical Architecture

Complete technical design of the trading suite. See README.md for product overview.
For detailed specs of each component, see the linked spec files.

**Last updated:** Revised to reflect Go + Compute VM + Cloud Pub/Sub architecture.
Previous Python + Cloud Run design is superseded by this document.

---

## System Overview

```
┌────────────────────────────────────────────────────────────────┐
│  GCP Project (trading-core) — asia-south1 (Mumbai)            │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Compute Engine VM (e2-medium, always-on)                │ │
│  │                                                          │ │
│  │  ├─ tick-receiver   (Go binary) — TrueData WebSocket     │ │
│  │  ├─ core            (Go binary) — strategy engine        │ │
│  │  ├─ executor        (Go binary) — Zerodha / paper trader │ │
│  │  ├─ db-writer       (Go binary) — Pub/Sub → PostgreSQL   │ │
│  │  └─ monitoring      (Go binary) — Prometheus metrics     │ │
│  └──────────────────────────────────────────────────────────┘ │
│                          ↕ Pub/Sub                              │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Cloud Run Services (on-demand, scale to zero)           │ │
│  │                                                          │ │
│  │  ├─ strategy-builder-api   (Go)  — strategy CRUD         │ │
│  │  ├─ backtest-engine        (Go)  — historical simulation  │ │
│  │  ├─ validation-suite       (Go)  — walk-forward, MC       │ │
│  │  ├─ analytics-api          (Go)  — P&L, reporting         │ │
│  │  └─ allocator              (Go)  — daily weight calc      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Data Layer                                              │ │
│  │  ├─ Cloud SQL (PostgreSQL + TimescaleDB extension)       │ │
│  │  ├─ Cloud Memorystore (Redis) — hot state                │ │
│  │  ├─ Cloud Storage (Parquet archives, > 2 years)         │ │
│  │  └─ Cloud Pub/Sub — inter-service messaging              │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Observability                                           │ │
│  │  ├─ Prometheus (metrics scraping)                        │ │
│  │  ├─ Grafana (dashboards — system + trading)              │ │
│  │  ├─ Cloud Logging (structured JSON logs)                 │ │
│  │  └─ Cloud Scheduler (EOD jobs, daily tasks)              │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Frontend                                                │ │
│  │  └─ React SPA — Strategy Builder UI, Analytics Dashboard │ │
│  │     Deployed on Cloud Run (static, scale to zero)        │ │
│  └──────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Component | Technology | Why |
|---|---|---|---|
| **Language** | All services | Go | Performance, concurrency, single binary deployment |
| **Compute** | Live trading binaries | Compute Engine VM (e2-medium) | Always-on, 24/7 uptime, simple ops |
| **Compute** | On-demand services | Cloud Run | Scale to zero, pay per invocation |
| **Messaging** | Inter-service | Cloud Pub/Sub | GCP-native, zero ops, ordering keys, dead letter |
| **Database** | Time-series | TimescaleDB (PostgreSQL extension) | OHLCV, ticks, candles at scale |
| **Database** | Relational | PostgreSQL (same Cloud SQL instance) | Positions, strategies, trades, audit |
| **Cache** | Hot state | Redis (Cloud Memorystore) | Sub-millisecond reads, shared memory layer |
| **Archive** | Historical data | Parquet on Cloud Storage | Compressed columnar, > 2 years data |
| **Secrets** | Credentials | Cloud Secret Manager | API keys, DB passwords, Zerodha tokens |
| **Monitoring** | Metrics | Prometheus | Open standard, Go native client |
| **Monitoring** | Dashboards | Grafana | System + trading dashboards in one |
| **Logging** | Structured logs | Cloud Logging | JSON logs, queryable, GCP-native |
| **Scheduling** | Cron jobs | Cloud Scheduler | EOD jobs, daily allocator, token refresh |
| **Frontend** | Strategy Builder | React SPA | Visual drag-drop strategy builder |
| **Broker** | Live execution | Zerodha Kite API (Go SDK) | Only supported broker — see Zerodha_Spec.md |
| **Data** | Market data | TrueData WebSocket + REST | NSE EQ, NSE F&O, MCX — see TRUEDATA_SPEC.md |

---

## Architecture Decisions Log

Key decisions and the reasoning behind them. Read these before changing any technology choice.

| Decision | Choice | Alternatives Considered | Reason |
|---|---|---|---|
| Language | Go everywhere | Python + Go | Single language = simpler CI/CD, consistent tooling, no IPC between Python and Go services |
| Live trading compute | Compute Engine VM | Cloud Run | Cloud Run cold starts are unacceptable for always-on WebSocket connections and live trading loops |
| On-demand compute | Cloud Run | VM always-on | Backtests and validation run infrequently — paying for idle VMs wastes budget |
| Message bus | Cloud Pub/Sub | Kafka (Confluent) | GCP-native, zero ops, same IAM, equivalent features at this scale. Tick replay handled via TimescaleDB not message bus |
| Database | PostgreSQL + TimescaleDB | ClickHouse, InfluxDB | TimescaleDB gives time-series performance on top of PostgreSQL. One DB engine, not two |
| Hot state | Redis | In-memory only | Core must survive restarts without losing open position state. Redis bridges restart gap |
| Broker | Zerodha only | Multi-broker abstraction | Solo developer, India-only, Zerodha has best API + lowest fees. Abstraction layer (Executor interface) allows adding brokers later |
| Core DB access | Zero (Redis + Pub/Sub only) | Direct PostgreSQL | DB writes in hot path cause latency spikes. All persistence is async via DB Writer Consumer |

---

## Binary Responsibilities

### Always-on (Compute Engine VM)

| Binary | Language | Purpose | Spec |
|---|---|---|---|
| `tick-receiver` | Go | TrueData WebSocket → Pub/Sub | TRUEDATA_SPEC.md |
| `core` | Go | Tick → strategy eval → signals | CORE_ARCHITECTURE.md |
| `executor` | Go | Orders → Zerodha API / Paper Trader | EXECUTION_SPEC.md |
| `db-writer` | Go | Pub/Sub events → PostgreSQL | EXECUTION_SPEC.md |
| `monitoring` | Go | Prometheus metrics exporter | MONITORING.md |

### On-demand (Cloud Run)

| Service | Language | Purpose | Spec |
|---|---|---|---|
| `strategy-builder-api` | Go | Strategy CRUD, config management | STRATEGY_LIFECYCLE.md |
| `backtest-engine` | Go | Historical strategy simulation | PRODUCTS.md |
| `validation-suite` | Go | Walk-forward, Monte Carlo | PRODUCTS.md |
| `analytics-api` | Go | P&L queries, reporting | PRODUCTS.md |
| `allocator` | Go | Daily capital weight calculation | ALLOCATOR_SPEC.md |
| `bootstrap` | Go | One-off: DB → Redis warm-up on cold start | CORE_ARCHITECTURE.md |

### Frontend

| Component | Technology | Purpose |
|---|---|---|
| Strategy Builder UI | React SPA | Visual drag-drop strategy builder |
| Analytics Dashboard | React SPA | P&L, positions, performance charts |

Both served as static files from Cloud Run (Cloud Run serves static files efficiently with zero ops).

---

## Data Flow

### Live Trading (Core Path)

```
TrueData WebSocket
    ↓
tick-receiver binary
    ↓ Pub/Sub (ticks.nse_eq / ticks.nse_fno / ticks.mcx)
core binary
    ├─ Aggregates ticks → candles (ring buffer)
    ├─ Evaluates strategies on bar close
    ├─ Scoring Engine selects best strategy
    ├─ Risk Engine gates the order
    ↓ Pub/Sub (events.orders)
executor binary
    ├─ Pre-flight checks
    ├─ Calls Zerodha Kite API (or Paper Trader)
    ↓ Pub/Sub (events.order_results + events.executions)
core binary (reads fill confirmation, updates Redis position state)
db-writer binary (persists everything to PostgreSQL)
```

### Strategy Development Path

```
User (Strategy Builder UI)
    ↓ HTTPS
strategy-builder-api (Cloud Run)
    ↓ PostgreSQL
backtest-engine (Cloud Run, triggered on demand)
    ↓ TimescaleDB (historical OHLCV)
validation-suite (Cloud Run)
    ↓ PostgreSQL (results)
strategy-builder-api (status → VALIDATED)
    ↓ User promotes to PAPER
core binary (loads strategy via Pub/Sub strategies.config topic)
    ↓ Paper trading live
executor binary (Paper Trader mode)
    ↓ User reviews, promotes to LIVE
core binary (switches execution_mode to live)
executor binary (Zerodha mode)
```

### EOD Job Path (Cloud Scheduler → Cloud Run)

```
18:30 IST — allocator runs
19:00 IST — backfill any missing candles
19:30 IST — roll detection (CONTINUOUS_CONTRACTS_SPEC.md)
20:00 IST — analytics refresh (performance snapshots)
08:30 IST — symbol master refresh (instruments_india table)
08:45 IST — Zerodha token refresh (TOTP automation)
```

---

## Service Communication

```
Core ↔ Strategy Builder:
  Strategy Builder writes strategy JSON to PostgreSQL
  Publishes strategies.config event to Pub/Sub
  Core reads from Pub/Sub, hot-loads strategy

Core ↔ Executor:
  Core publishes events.orders to Pub/Sub
  Executor reads, executes, publishes events.order_results
  Core reads fill confirmation from events.order_results

Core ↔ Risk Engine:
  Risk Engine is INSIDE Core (not a separate service)
  Shares Redis state:risk with Portfolio Risk Monitor goroutine

Core ↔ Allocator:
  Allocator writes weights to Redis daily
  Core reads weights from Redis on each composite score calculation

All persistence:
  Via Pub/Sub → DB Writer Consumer → PostgreSQL/TimescaleDB
  Core never touches database directly
```

---

## Spec File Map

| Topic | Spec File |
|---|---|
| Cloud Pub/Sub topics and message schemas | PUBSUB_SCHEMA.md |
| Core binary goroutine model | CORE_ARCHITECTURE.md |
| Order flow, executor, paper trader | EXECUTION_SPEC.md |
| Risk rules, kill switch, position sizing | RISK_ENGINE_SPEC.md |
| Composite scoring, Score Mode | SCORING_ENGINE.md |
| Strategy JSON format, indicator library | STRATEGY_SCHEMA.md |
| Strategy promotion, versioning, lifecycle | STRATEGY_LIFECYCLE.md |
| GCP deployment, costs, CI/CD | DEPLOYMENT.md |
| Monitoring, Grafana dashboards, alerts | MONITORING.md |
| TrueData WebSocket integration | TRUEDATA_SPEC.md |
| Zerodha Kite API integration | Zerodha_Spec.md |
| NSE/MCX instrument specifics | INDIA_MARKETS_SPEC.md |
| TimescaleDB schema | DATA_SCHEMA_INDIA.md |
| Futures continuous contracts | CONTINUOUS_CONTRACTS_SPEC.md |
| Ingestion pipeline EOD jobs | INGESTION_PIPELINE_SPEC.md |
| Capital allocation | ALLOCATOR_SPEC.md |
