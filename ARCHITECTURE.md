# Technical Architecture

Complete technical design of the trading suite. See README.md for product overview.

---

## System Overview

```
┌─────────────────────────────────────────────────┐
│          GCP Project (trading-bot)              │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────────────────────────────────┐  │
│  │  Cloud Run Services (8 containers)       │  │
│  │  ├─ data-manager (Python)                │  │
│  │  ├─ strategy-builder (FastAPI)           │  │
│  │  ├─ backtest-engine (Python)             │  │
│  │  ├─ validation-suite (Python)            │  │
│  │  ├─ risk-monitor (Go)                    │  │
│  │  ├─ analytics-api (FastAPI)              │  │
│  │  ├─ paper-trader (Python)                │  │
│  │  └─ live-executor (Go)                   │  │
│  └──────────────────────────────────────────┘  │
│                  ↓                              │
│  ┌──────────────────────────────────────────┐  │
│  │  Shared Infrastructure                   │  │
│  │  ├─ Cloud SQL PostgreSQL                 │  │
│  │  ├─ Cloud Storage (Parquet archives)     │  │
│  │  ├─ Cloud Memorystore Redis              │  │
│  │  ├─ Cloud Secrets Manager                │  │
│  │  └─ Cloud Logging                        │  │
│  └──────────────────────────────────────────┘  │
│                  ↓                              │
│  ┌──────────────────────────────────────────┐  │
│  │  Monitoring & Control                    │  │
│  │  ├─ Prometheus (metrics)                 │  │
│  │  ├─ Grafana (dashboards)                 │  │
│  │  └─ Cloud Scheduler (cron jobs)          │  │
│  └──────────────────────────────────────────┘  │
│                                                  │
└─────────────────────────────────────────────────┘
```

---

## Technology Stack

| Layer | Component | Technology | Why |
|-------|-----------|-----------|-----|
| **Compute** | Services | Cloud Run | Serverless, pay per invocation |
| **Database** | Primary | PostgreSQL + TimescaleDB | ACID + time-series partitioning for tick data |
| **Database** | Archive | Parquet | Compression, columnar queries |
| **Cache** | Session | Redis | In-memory, fast writes |
| **Storage** | Secrets | Google Secret Manager | Native, secure |
| **Monitoring** | Metrics | Prometheus | Open-source, standard |
| **Monitoring** | Visualization | Grafana | Professional, free |
| **Orchestration** | Jobs | Cloud Scheduler | Serverless, GCP-native |
| **Language** | Fast path | Go | Sub-millisecond latency (risk monitor, executor) |
| **Language** | Data | Python | NumPy, Pandas (backtest, validation) |
| **Language** | API | FastAPI | Async, type-safe, fast |
| **Data Feed** | Live + Historical | TrueData Velocity Ultima | NSE EQ, NSE F&O, MCX |
| **Broker** | Execution | Zerodha Kite API | Orders, positions, margin |

---

## Database Schema

### Core Tables

```sql
-- Timeseries data (OHLCV) — legacy table retained for reference
-- India market data is stored in ohlcv_daily, ohlcv_1min (see DATA_SCHEMA_INDIA.md)
CREATE TABLE ohlcv (
    id BIGSERIAL PRIMARY KEY,
    asset_class VARCHAR(20),      -- 'equity', 'futures', 'commodity'
    symbol VARCHAR(20),            -- RELIANCE, NIFTY-I, GOLD-I
    date TIMESTAMP,
    open DECIMAL(12,6),
    high DECIMAL(12,6),
    low DECIMAL(12,6),
    close DECIMAL(12,6),
    volume BIGINT,
    adjusted_close DECIMAL(12,6),
    source VARCHAR(50),            -- 'truedata_api', 'truedata_live'
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    UNIQUE(asset_class, symbol, date, source),
    INDEX idx_symbol_date (symbol, date DESC),
    INDEX idx_date (date DESC),
    INDEX idx_asset_class (asset_class)
);

-- Market instruments
CREATE TABLE instruments (
    symbol VARCHAR(20) PRIMARY KEY,
    name VARCHAR(200),
    asset_class VARCHAR(20),
    exchange VARCHAR(20),          -- NSE, MCX
    active_from DATE,
    active_to DATE,
    delisted BOOLEAN DEFAULT FALSE,
    pip_value DECIMAL(12,6),       -- For forex
    multiplier DECIMAL(12,2),      -- For futures
    data_source VARCHAR(50)
);

-- Data quality tracking
CREATE TABLE data_quality (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(20),
    date DATE,
    asset_class VARCHAR(20),
    gaps INTEGER,
    outliers INTEGER,
    stale BOOLEAN,
    checked_at TIMESTAMP,
    INDEX idx_symbol_date (symbol, checked_at DESC)
);
```

### Strategy Tables

```sql
-- Strategy definitions
CREATE TABLE strategies (
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    version VARCHAR(10),
    asset_class VARCHAR(20),       -- 'stock', 'forex', 'all'
    definition JSONB,              -- Entire strategy logic
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    created_by VARCHAR(100),
    status VARCHAR(20),            -- 'draft', 'validated', 'live', 'disabled'
    INDEX idx_status (status)
);

-- Strategy parameters
CREATE TABLE strategy_parameters (
    id SERIAL PRIMARY KEY,
    strategy_id UUID REFERENCES strategies(id),
    param_name VARCHAR(100),
    param_type VARCHAR(50),        -- 'integer', 'decimal', 'string'
    min_value DECIMAL,
    max_value DECIMAL,
    step DECIMAL,
    optimizable BOOLEAN,
    default_value VARCHAR(100)
);
```

### Trading Tables

```sql
-- All trades (backtest + live)
CREATE TABLE trades (
    id UUID PRIMARY KEY,
    backtest_id UUID,              -- NULL if live trade
    strategy_id UUID REFERENCES strategies(id),
    asset_class VARCHAR(20),
    symbol VARCHAR(20),
    action VARCHAR(10),            -- 'BUY', 'SELL'
    qty DECIMAL,
    entry_price DECIMAL(12,6),
    entry_time TIMESTAMP,
    exit_price DECIMAL(12,6),
    exit_time TIMESTAMP,
    pnl DECIMAL,
    pnl_pct DECIMAL,
    slippage DECIMAL,
    commission DECIMAL,
    hold_bars INTEGER,
    hold_hours DECIMAL,
    created_at TIMESTAMP,
    INDEX idx_symbol (symbol),
    INDEX idx_strategy (strategy_id),
    INDEX idx_date (entry_time DESC)
);

-- Current positions
CREATE TABLE positions (
    id UUID PRIMARY KEY,
    strategy_id UUID REFERENCES strategies(id),
    asset_class VARCHAR(20),
    symbol VARCHAR(20),
    entry_price DECIMAL(12,6),
    entry_date TIMESTAMP,
    qty DECIMAL,
    current_price DECIMAL(12,6),
    unrealized_pnl DECIMAL,
    position_size_pct DECIMAL,
    status VARCHAR(20),            -- 'OPEN', 'CLOSED'
    updated_at TIMESTAMP,
    INDEX idx_symbol (symbol),
    INDEX idx_status (status)
);

-- Equity curve
CREATE TABLE equity_curve (
    date DATE PRIMARY KEY,
    equity DECIMAL NOT NULL,
    cash DECIMAL,
    positions_value DECIMAL,
    daily_pnl DECIMAL,
    daily_return_pct DECIMAL,
    cumulative_return_pct DECIMAL,
    drawdown_pct DECIMAL,
    created_at TIMESTAMP
);

-- Backtest runs
CREATE TABLE backtest_runs (
    id UUID PRIMARY KEY,
    strategy_id UUID REFERENCES strategies(id),
    strategy_version VARCHAR(10),
    asset_class VARCHAR(20),
    date_from DATE,
    date_to DATE,
    parameters JSONB,
    sharpe_ratio DECIMAL,
    max_drawdown DECIMAL,
    win_rate DECIMAL,
    profit_factor DECIMAL,
    trades_count INTEGER,
    avg_trade_pnl DECIMAL,
    created_at TIMESTAMP,
    INDEX idx_strategy (strategy_id),
    INDEX idx_created (created_at DESC)
);
```

### Risk & Monitoring

```sql
-- Position snapshots
CREATE TABLE position_snapshots (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP,
    portfolio_json JSONB,
    total_equity DECIMAL,
    total_pnl DECIMAL,
    drawdown_pct DECIMAL,
    margin_used_pct DECIMAL,
    correlation_max DECIMAL,
    INDEX idx_timestamp (timestamp DESC)
);

-- Risk events
CREATE TABLE risk_events (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP,
    event_type VARCHAR(50),        -- 'DRAWDOWN_ALERT', 'MARGIN_WARNING', etc.
    severity VARCHAR(20),          -- 'WARNING', 'CRITICAL'
    action_taken VARCHAR(100),
    details JSONB,
    INDEX idx_timestamp (timestamp DESC),
    INDEX idx_severity (severity)
);

-- Validation results
CREATE TABLE validation_results (
    id UUID PRIMARY KEY,
    backtest_id UUID,
    validation_type VARCHAR(50),   -- 'walk_forward', 'monte_carlo', 'regime'
    result JSONB,
    passed BOOLEAN,
    created_at TIMESTAMP,
    INDEX idx_backtest (backtest_id),
    INDEX idx_passed (passed)
);
```

---

## API Design

### Data Manager

```
GET /v1/ohlcv
  ?symbol=AAPL&from=2023-01-01&to=2023-12-31&source=yahoo
  Response: {
    "data": [{"date": "2023-01-01", "open": 150.2, ...}],
    "metadata": {"gaps": [], "adjustments": []}
  }

GET /v1/quality/report
  ?symbol=AAPL&from=2023-01-01
  Response: {"symbol": "AAPL", "missing_bars": 0, "outliers": 2}

POST /v1/refresh
  Start daily data refresh job
```

### Backtesting Engine

```
POST /v1/backtest
  {
    "strategy_id": "uuid",
    "parameters": {"sma_period": 50},
    "data": {"symbols": ["AAPL"], "from": "2015-01-01"},
    "execution": {"slippage_model": "adaptive"}
  }
  Response: {"backtest_id": "uuid", "status": "queued"}

GET /v1/backtest/{id}/results
  Response: {"metrics": {...}, "trades": [...], "equity_curve": [...]}

GET /v1/backtest/{id}/status
  Response: {"status": "running", "progress": 65}
```

### Validation Suite

```
POST /v1/validate
  {"backtest_id": "uuid", "validation_types": ["walk_forward", "monte_carlo"]}
  Response: {"validation_id": "uuid"}

GET /v1/validate/{id}/results
  Response: {
    "walk_forward": {"avg_degradation": -0.45, "status": "FAIL"},
    "monte_carlo": {"original_sharpe": 1.23, "robustness": "MEDIUM"}
  }
```

### Risk Monitor

```
GET /v1/risk/status
  Response: {
    "portfolio_pnl": 1240,
    "drawdown": -0.082,
    "positions": [...],
    "alerts": [...]
  }

POST /v1/risk/position-size
  {"strategy_id": "uuid", "signal": {"action": "BUY", "symbol": "AAPL"}}
  Response: {"approved_size": 0.025, "reasoning": "..."}
```

### Analytics API

```
GET /v1/analytics/summary?window=30d
  Response: {"pnl": 8350, "sharpe": 1.45, "win_rate": 0.53}

GET /v1/analytics/equity-curve?from=2025-04-03&to=2025-05-03
  Response: {"data": [{"date": "2025-04-03", "equity": 100000}]}

GET /v1/analytics/trades?limit=50
  Response: {"trades": [...], "total": 247}
```

---

## Data Flow

### Backtest Workflow

```
1. User creates strategy in UI
   → Strategy definition stored as JSON in DB

2. User clicks "Backtest"
   → POST /v1/backtest with strategy_id + parameters

3. Backtest service:
   ├─ Fetch strategy definition from DB
   ├─ Fetch historical data from Data Manager
   ├─ Run event-driven simulation (bar by bar)
   ├─ Calculate metrics
   └─ Store trades + equity curve in DB

4. User views results
   → GET /v1/backtest/{id}/results returns stored data
```

### Validation Workflow

```
1. Backtest complete with results in DB

2. User clicks "Validate"
   → POST /v1/validate with backtest_id

3. Validation service:
   ├─ Walk-forward analysis (run backtests on time-split data)
   ├─ Monte Carlo (randomize trade order N times)
   ├─ Regime analysis (performance breakdown)
   └─ Store results in DB

4. User sees validation verdict
   → Pass/fail signal for deployment
```

### Live Trading Workflow

```
1. Risk Monitor (runs continuously):
   ├─ Update position prices every tick
   ├─ Calculate metrics (drawdown, correlation)
   ├─ Check rules (margin, drawdown limits)
   ├─ Store snapshots in DB

2. Strategy Engine (runs on each bar/candle):
   ├─ Calculate indicators
   ├─ Generate signal
   ├─ Call Risk Monitor for position sizing
   └─ Pass order to Execution Manager

3. Execution Manager:
   ├─ Pre-flight checks (risk, balance)
   ├─ Submit to broker
   ├─ Track fills
   ├─ Update positions
   └─ Store audit trail in Kafka (immutable)

4. Analytics Dashboard:
   ├─ Query positions from DB
   ├─ Stream updates via WebSocket
   ├─ Display to user in Grafana
```

---

## Service Interaction

```
Strategy Builder
     ↓ (strategy.json)
Backtesting Engine ←── Data Manager (OHLCV)
     ↓ (backtest results)
Validation Suite
     ↓ (validation results)
Risk Monitor
     ↓
Paper Trading ←────── Analytics API
     ↓                        ↑
Live Executor ───────────────┴──→ Grafana
```

---

## Deployment Architecture

### GCP Services Used

| Service | Purpose | Cost |
|---------|---------|------|
| Cloud Run | Execute services | ~$0.000025/req |
| Cloud SQL | PostgreSQL | $6-10/month |
| Cloud Storage | Parquet archives | $0.02/GB/month |
| Cloud Memorystore | Redis cache | $0 (if < 1GB) |
| Secret Manager | Credentials | Free |
| Cloud Logging | Logs | Free (5GB/month) |
| Cloud Scheduler | Cron jobs | ~$0.10/month |
| Cloud Monitoring | Metrics | ~$5-10/month |

**Total:** ~$25-50/month

### Containerization

Each service = 1 Docker container:

```dockerfile
# Example: backtest-engine/Dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY . .
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Deployed via:
```bash
gcloud run deploy backtest-engine \
  --image gcr.io/trading-bot/backtest-engine \
  --region us-central1 \
  --set-env-vars DB_URL=cloudsql:...
```

---

## Scaling Strategy

### Phase 1: Single Machine (MVP)
- All services on Cloud Run (same region)
- PostgreSQL: db-f1-micro
- Redis: 1GB
- Backtest: Sequential (1 at a time)

### Phase 2: Distributed Backesting
- Ray cluster for parameter grid search
- 10x faster parameter sweeps
- Same database

### Phase 3: Multi-Region
- Replicate to multiple GCP regions
- Failover capacity
- Lower latency

---

## Monitoring & Observability

### Prometheus Metrics (Exposed by each service)

```yaml
# Example metrics
data_quality_score: 98.5%
data_ingestion_latency_seconds: 180
backtest_duration_seconds: 45
backtest_sharpe_ratio: 1.23
portfolio_drawdown_pct: -8.2
margin_used_percent: 65
risk_events_total: 5
execution_latency_ms: 1200
slippage_distribution: [histogram]
```

### Grafana Dashboards

See [MONITORING.md](./MONITORING.md) for dashboard specifications.

---

## Security

### Secrets Management
```bash
# Store in Google Secret Manager
gcloud secrets create broker-api-key
gcloud secrets create db-password
gcloud secrets create jwt-secret

# Services read via:
export BROKER_API_KEY=$(gcloud secrets versions access latest --secret=broker-api-key)
```

### Authentication
- JWT tokens for API access
- API key for external services
- Cloud IAM for GCP resources

### Audit Trail
- All trades logged to Cloud Logging
- Immutable record via Kafka topics
- Encrypted at rest

---

## Development Environment

### Local Development (Docker Compose)

```yaml
version: '3.8'
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_PASSWORD: dev_pass
    ports:
      - "5432:5432"
  
  redis:
    image: redis:7
    ports:
      - "6379:6379"
  
  data-manager:
    build: ./services/data-manager
    ports:
      - "8001:8000"
    environment:
      DATABASE_URL: postgresql://...
  
  prometheus:
    image: prom/prometheus:latest
    ports:
      - "9090:9090"
  
  grafana:
    image: grafana/grafana:latest
    ports:
      - "3000:3000"
    environment:
      GF_SECURITY_ADMIN_PASSWORD: admin
```

Run locally: `docker-compose up`

---

## Next Steps

1. See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed setup
2. See [PRODUCTS.md](./PRODUCTS.md) for product specifications
3. See [MONITORING.md](./MONITORING.md) for dashboard setup
