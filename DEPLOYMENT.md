# Deployment

GCP infrastructure, cost breakdown, CI/CD pipeline, and operational runbook.
Everything needed to go from zero to a running system.

See ARCHITECTURE.md for why each technology was chosen.
See MONITORING.md for post-deployment observability setup.

---

## GCP Project Setup

```
Project ID:   trading-core
Region:       asia-south1  (Mumbai — closest to NSE/MCX servers)
Zone:         asia-south1-a

Why Mumbai?
  NSE co-location is in Mumbai BKC.
  Lower round-trip to Zerodha API (Zerodha is also Mumbai-based).
  TrueData servers are India-based.
  Every millisecond of latency reduction matters at execution time.
```

---

## Resource Inventory

### Compute Engine VM (Always-On)

```
Machine type:  e2-medium  (2 vCPU, 4 GB RAM)
OS:            Ubuntu 24.04 LTS
Disk:          50 GB SSD boot disk
Preemptible:   NO — live trading cannot be interrupted
Static IP:     YES — Zerodha API whitelist requires fixed IP

Cost (sustained use discount applied):
  e2-medium:  ~₹1,950/month
  50 GB SSD:  ~₹450/month
  Static IP:  ~₹400/month
  Total VM:   ~₹2,800/month

Binaries running on VM (managed by systemd):
  tick-receiver.service
  core.service
  executor.service
  db-writer.service
  monitoring.service
  grafana.service       (Grafana runs on VM, not Cloud Run)
  prometheus.service    (Prometheus runs on VM)
```

### Cloud SQL (PostgreSQL + TimescaleDB)

```
Tier:          db-f1-micro  (1 vCPU, 614 MB RAM) — sufficient for single user
Storage:       100 GB SSD (auto-expand enabled)
Availability:  Single zone (not HA — cost saving, acceptable for personal use)
Backups:       Automated daily, retained 7 days
PostgreSQL:    16 with TimescaleDB extension enabled

Cost:
  db-f1-micro:  ~₹1,200/month
  100 GB SSD:   ~₹1,700/month
  Total SQL:    ~₹2,900/month

Connection:
  VM connects via private IP (VPC internal)
  Cloud Run services connect via Cloud SQL Auth Proxy
  No public IP on database
```

### Cloud Memorystore (Redis)

```
Tier:      Basic (no replication — single user, low risk tolerance)
Size:      1 GB  (strategy configs, candle buffers, positions, risk state)
Version:   Redis 7.0

Cost:      ~₹500/month

Memory breakdown at 100 symbols:
  Candle buffers (250 candles × 100 symbols × 2 timeframes): ~60 MB
  Strategy configs (100 strategies × 10 KB avg):             ~1 MB
  Position state (max 10 open positions × 2 KB):             ~0.02 MB
  Risk state:                                                 ~0.1 MB
  TrueData last-tick cache (100 symbols):                     ~0.5 MB
  Total:                                                      ~62 MB
  Buffer for growth:                                         ~938 MB
  1 GB is comfortable.
```

### Cloud Pub/Sub

```
Topics:      12 primary + 5 dead letter (see PUBSUB_SCHEMA.md)
Region:      asia-south1

Cost estimate:
  Tick volume: ~200 GB/month (100 symbols, realistic tick rate)
  Event volume: ~5 GB/month
  Total: ~205 GB/month
  Free tier: 10 GB
  Billable: ~195 GB × ₹3.20/GB = ~₹624/month

  Realistic: ₹500–800/month
```

### Cloud Storage (Parquet Archive)

```
Bucket:    trading-core-archive
Class:     Nearline (accessed < once/month — historical backtests)
Location:  asia-south1

Cost:
  Storage:   ₹0.80/GB/month
  At 100 GB: ~₹80/month
  At 500 GB: ~₹400/month
  Start:     ~₹100/month (grows slowly)
```

### Cloud Run (On-Demand Services)

```
Services:    strategy-builder-api, backtest-engine, validation-suite,
             analytics-api, allocator, bootstrap, frontend
Memory:      512 MB each (sufficient for Go services)
CPU:         1 vCPU each
Min instances: 0 (scale to zero when not in use)

Cost:
  Free tier: 2M requests/month, 360,000 GB-seconds/month
  For personal use (you are the only user): likely stays within free tier
  Estimate: ₹0–200/month
```

### Cloud Secret Manager

```
Secrets stored:
  TRUEDATA_API_KEY
  TRUEDATA_API_SECRET
  ZERODHA_API_KEY
  ZERODHA_API_SECRET
  ZERODHA_TOTP_SECRET      (for automated daily login)
  DB_PASSWORD
  REDIS_AUTH_STRING
  GRAFANA_ADMIN_PASSWORD

Cost: ₹6/secret/month × 8 secrets = ₹48/month (negligible)
```

### Cloud Scheduler

```
Jobs (see INGESTION_PIPELINE_SPEC.md for full job specs):
  zerodha-token-refresh     08:45 IST weekdays
  symbol-master-refresh     08:30 IST weekdays
  allocator-run             18:30 IST weekdays
  candle-backfill           19:00 IST weekdays
  roll-detection            19:30 IST weekdays
  analytics-refresh         20:00 IST weekdays
  archive-old-ticks         01:00 IST weekends

Cost: ₹10/job/month × 7 = ₹70/month (negligible)
```

### Cloud Monitoring + Logging

```
Cloud Logging:  free tier 50 GB/month — sufficient for personal use
Cloud Monitoring: basic metrics free

Grafana and Prometheus run ON the VM (not as managed services).
This saves ~₹2,000/month vs Managed Grafana.
```

---

## Total Monthly Cost

```
┌──────────────────────────────────────────────┐
│  Resource              Monthly Cost (₹)      │
├──────────────────────────────────────────────┤
│  Compute Engine VM     ₹2,800                │
│  Cloud SQL             ₹2,900                │
│  Cloud Memorystore     ₹500                  │
│  Cloud Pub/Sub         ₹700                  │
│  Cloud Storage         ₹100                  │
│  Cloud Run             ₹100                  │
│  Secret Manager        ₹50                   │
│  Cloud Scheduler       ₹70                   │
│  Logging / Monitoring  ₹0                    │
├──────────────────────────────────────────────┤
│  TOTAL                 ~₹7,220/month         │
└──────────────────────────────────────────────┘

Within ₹10,000/month budget. ~₹2,800 headroom.
Headroom covers: unexpected egress, Cloud Run overages, storage growth.
```

---

## VM Setup (One-Time)

### System Packages

```bash
# Update and install essentials
sudo apt-get update && sudo apt-get upgrade -y
sudo apt-get install -y \
  git curl wget unzip \
  build-essential \
  systemd \
  ca-certificates \
  gnupg

# Install Go 1.22+
wget https://go.dev/dl/go1.22.0.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
source ~/.bashrc

# Install Prometheus
# Download from prometheus.io/download, install to /usr/local/bin

# Install Grafana
sudo apt-get install -y apt-transport-https software-properties-common
wget -q -O - https://packages.grafana.com/gpg.key | sudo apt-key add -
echo "deb https://packages.grafana.com/oss/deb stable main" | sudo tee /etc/apt/sources.list.d/grafana.list
sudo apt-get update && sudo apt-get install -y grafana
```

### Systemd Service Files

Each binary is managed by systemd for automatic restart on failure.

```ini
# /etc/systemd/system/core.service
[Unit]
Description=Trading Core Binary
After=network.target
Wants=network.target

[Service]
Type=simple
User=trading
WorkingDirectory=/opt/trading
ExecStart=/opt/trading/bin/core
Restart=always
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60
EnvironmentFile=/opt/trading/.env
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Same pattern for: `tick-receiver.service`, `executor.service`, `db-writer.service`, `monitoring.service`

```bash
# Enable all services
sudo systemctl enable tick-receiver core executor db-writer monitoring grafana-server prometheus
sudo systemctl start tick-receiver core executor db-writer monitoring grafana-server prometheus
```

### Environment Variables

```bash
# /opt/trading/.env (loaded by systemd EnvironmentFile)
# Values pulled from Secret Manager on VM startup via startup script

GCP_PROJECT_ID=trading-core
GCP_REGION=asia-south1
PUBSUB_PROJECT_ID=trading-core

DB_HOST=10.x.x.x          # Cloud SQL private IP
DB_PORT=5432
DB_NAME=trading
DB_USER=trading_app
DB_PASSWORD=${SECRET:DB_PASSWORD}

REDIS_HOST=10.x.x.x        # Memorystore private IP
REDIS_PORT=6379

TRUEDATA_API_KEY=${SECRET:TRUEDATA_API_KEY}
TRUEDATA_API_SECRET=${SECRET:TRUEDATA_API_SECRET}
TRUEDATA_WEBSOCKET_URL=wss://push.truedata.in

ZERODHA_API_KEY=${SECRET:ZERODHA_API_KEY}
ZERODHA_API_SECRET=${SECRET:ZERODHA_API_SECRET}
ZERODHA_TOTP_SECRET=${SECRET:ZERODHA_TOTP_SECRET}

ENABLED_SEGMENTS=equity,futures,commodity
DAILY_LOSS_LIMIT_INR=18000
ENVIRONMENT=production
```

---

## Database Setup

### TimescaleDB Extension

```sql
-- Connect to Cloud SQL instance
-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Verify
SELECT default_version, installed_version FROM pg_available_extensions
WHERE name = 'timescaledb';
```

### Schema Migrations

```bash
# Use golang-migrate for schema versioning
# migrations/ directory in repo
# Format: 000001_initial_schema.up.sql / .down.sql

migrate -path ./migrations \
        -database "postgres://trading_app:${DB_PASSWORD}@${DB_HOST}:5432/trading" \
        up
```

All schema definitions in DATA_SCHEMA_INDIA.md.
TimescaleDB hypertables, continuous aggregates, retention policies all created via migrations.

---

## CI/CD Pipeline

### Repository Structure

```
trading-suite/
├── cmd/
│   ├── core/           main.go for core binary
│   ├── tick-receiver/  main.go for tick receiver
│   ├── executor/       main.go for executor
│   ├── db-writer/      main.go for db writer
│   └── strategy-api/   main.go for strategy builder API
├── internal/
│   ├── engine/         symbol engine, candle buffer, supervisor
│   ├── scoring/        composite score, Score Mode
│   ├── risk/           risk engine, kill switch, position sizing
│   ├── execution/      executor interface, Zerodha client, paper trader
│   ├── segments/       equity, futures, commodity module implementations
│   ├── strategy/       strategy schema, AST compiler, registry
│   └── pubsub/         Pub/Sub publisher, subscriber wrappers
├── migrations/         SQL migration files
├── frontend/           React SPA source
├── configs/            config YAML templates
├── .github/workflows/  GitHub Actions
└── deploy/             deployment scripts
```

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml
name: Build and Deploy

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }
      - run: go test ./...
      - run: go vet ./...

  build:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.22' }

      # Build all binaries
      - run: |
          GOOS=linux GOARCH=amd64 go build -o dist/core        ./cmd/core
          GOOS=linux GOARCH=amd64 go build -o dist/tick-receiver ./cmd/tick-receiver
          GOOS=linux GOARCH=amd64 go build -o dist/executor    ./cmd/executor
          GOOS=linux GOARCH=amd64 go build -o dist/db-writer   ./cmd/db-writer

      # Upload to Cloud Storage as artefacts
      - uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}
      - run: |
          gsutil cp dist/* gs://trading-core-deploy/latest/

  deploy-vm:
    needs: build
    runs-on: ubuntu-latest
    steps:
      # SSH to VM, pull new binaries, restart services
      - run: |
          gcloud compute ssh trading-vm --zone=asia-south1-a --command='
            sudo systemctl stop core executor tick-receiver db-writer
            gsutil cp gs://trading-core-deploy/latest/* /opt/trading/bin/
            sudo chmod +x /opt/trading/bin/*
            sudo systemctl start core executor tick-receiver db-writer
            sudo systemctl status core
          '

  deploy-cloudrun:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: |
          gcloud run deploy strategy-builder-api \
            --source ./cmd/strategy-api \
            --region asia-south1 \
            --platform managed \
            --allow-unauthenticated=false
```

### Deployment Safety Rules

```
Rules enforced before deploy:
  1. All tests must pass (go test ./...)
  2. No deployment during market hours (09:00–15:35 IST weekdays)
     Enforced by: GitHub Actions time check
  3. Core and Executor are stopped gracefully before binary replacement
     (all open positions must be zero OR manual override required)
  4. Database migrations run BEFORE new binaries start
  5. Rollback: previous binaries kept in gs://trading-core-deploy/previous/
     One-command rollback: ./deploy/rollback.sh
```

---

## Bootstrap Sequence (First Run / Cold Start)

Run once on first deployment, or after a Redis flush.

```bash
# 1. Apply database migrations
./scripts/migrate.sh up

# 2. Load TrueData symbol master (instruments_india table)
./scripts/load-symbol-master.sh

# 3. Backfill historical OHLCV data (TrueData REST API)
./scripts/backfill-historical.sh --from 2024-01-01 --symbols nifty,banknifty,gold,crude

# 4. Run bootstrap binary (DB → Redis warm-up)
./bin/bootstrap

# 5. Verify Redis state
redis-cli GET state:strategies | jq '.strategies | length'
redis-cli GET state:positions

# 6. Start all services
sudo systemctl start tick-receiver core executor db-writer monitoring

# 7. Verify services are running
sudo systemctl status core
# Check logs
journalctl -u core -f
```

---

## Daily Operations

### Automated (No Manual Intervention Needed)

```
08:30 — Symbol master refresh (Cloud Scheduler → allocator Cloud Run)
08:45 — Zerodha token refresh (Cloud Scheduler → runs TOTP auth script)
09:15 — Market opens, tick-receiver starts receiving, core processes
15:35 — Market closes, core stops generating signals
18:30 — Allocator runs, writes weights to Redis (Cloud Scheduler)
19:00 — Candle backfill, any missing bars (Cloud Scheduler)
19:30 — Roll detection, continuous contract update (Cloud Scheduler)
20:00 — Analytics snapshot refresh (Cloud Scheduler)
```

### Manual Weekly

```
Monday morning:
  Review Grafana trading dashboard
  Check: paper trading results, live P&L, rejected trade patterns
  Review: any STRATEGY_HALTED or kill switch events from prior week
  Review: execution quality (slippage trends, fill rates)
```

### Emergency Runbook

```
System down during market hours:
  1. SSH to VM: gcloud compute ssh trading-vm --zone=asia-south1-a
  2. Check service: sudo systemctl status core
  3. Check logs: journalctl -u core --since "10 minutes ago"
  4. If core is down and positions are open:
     → Open Zerodha Kite app on phone
     → Manually close positions
     → Restart service: sudo systemctl restart core
  5. After restart: verify positions loaded from Redis
     curl localhost:8080/positions

Zerodha API error during trading:
  1. Check executor logs: journalctl -u executor --since "5 minutes ago"
  2. Trigger manual kill switch if needed:
     curl -X POST localhost:8081/emergency/stop-all
  3. Refresh Zerodha token manually:
     ./scripts/refresh-zerodha-token.sh
  4. Restart executor: sudo systemctl restart executor
```

---

## Security

```
VM access:
  SSH via IAP (Identity-Aware Proxy) — no public SSH port
  No public IP on VM for SSH
  Command: gcloud compute ssh trading-vm --tunnel-through-iap

Database:
  No public IP — VPC internal only
  Connection from Cloud Run: Cloud SQL Auth Proxy
  Connection from VM: private IP direct

API services (Cloud Run):
  strategy-builder-api: requires Google IAP or service account auth
  analytics-api: requires Google IAP
  No unauthenticated access to any backend service

Frontend:
  Firebase Hosting or Cloud Run
  Google OAuth for login (single user — your Google account)

Secrets:
  All credentials in Secret Manager
  VM reads secrets via startup script
  No secrets in .env files in repository
  No secrets in Docker images

Firewall:
  VM: only inbound ports 8080 (core API), 3000 (Grafana), 9090 (Prometheus)
  All inbound traffic from VPC internal only (no public internet access)
  Outbound: TrueData WebSocket, Zerodha API, GCP services
```
