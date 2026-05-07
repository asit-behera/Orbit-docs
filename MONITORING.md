# Monitoring

Observability setup for system health and trading performance.
Prometheus collects metrics. Grafana visualises. Cloud Logging captures structured logs.

See DEPLOYMENT.md for how Prometheus and Grafana are installed on the VM.
See CORE_ARCHITECTURE.md for where metrics are emitted in the goroutine topology.

---

## Observability Stack

```
Go binaries (core, executor, tick-receiver, db-writer)
    ↓ /metrics endpoint (Prometheus exposition format)
Prometheus (scrapes every 15 seconds)
    ↓
Grafana (queries Prometheus, renders dashboards)
    ↓
Alerts (Grafana alerting → Telegram / email)

Structured logs (JSON) from all binaries
    ↓
Cloud Logging (queryable, 30-day retention)
    ↓
Log-based alerts (Cloud Monitoring)
```

---

## Prometheus Configuration

```yaml
# /etc/prometheus/prometheus.yml

global:
  scrape_interval: 15s
  evaluation_interval: 15s

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['localhost:9093']  # Alertmanager (optional, Grafana alerting used instead)

scrape_configs:
  - job_name: 'core'
    static_configs:
      - targets: ['localhost:8080']
    metrics_path: '/metrics'

  - job_name: 'executor'
    static_configs:
      - targets: ['localhost:8081']

  - job_name: 'tick-receiver'
    static_configs:
      - targets: ['localhost:8082']

  - job_name: 'db-writer'
    static_configs:
      - targets: ['localhost:8083']

  - job_name: 'node'
    static_configs:
      - targets: ['localhost:9100']  # node_exporter for VM metrics
```

---

## Metrics Reference

### System Metrics (node_exporter)

```
node_cpu_seconds_total          CPU usage per core
node_memory_MemAvailable_bytes  Available RAM
node_disk_io_time_seconds_total Disk I/O
node_filesystem_avail_bytes     Disk space remaining
node_network_receive_bytes_total Network in/out
```

### Core Binary Metrics

#### Tick Processing

```
# Ticks received from Pub/Sub (counter)
trading_ticks_received_total{symbol, segment}

# Ticks dropped due to full channel buffer (counter — alert if > 0)
trading_ticks_dropped_total{symbol, reason}

# Pub/Sub consumer lag (gauge — milliseconds behind real-time)
trading_pubsub_lag_ms{subscription}

# Bars closed per symbol (counter)
trading_bars_closed_total{symbol, timeframe}
```

#### Strategy Evaluation

```
# Signals generated (counter, includes rejected)
trading_signals_total{symbol, strategy_id, outcome}
# outcome values: traded, rejected_score, rejected_risk, rejected_validation

# Strategy evaluation duration (histogram — microseconds)
trading_strategy_eval_duration_us{strategy_id}

# Active strategies loaded in registry (gauge)
trading_strategies_active{segment}

# Composite score distribution (histogram)
trading_composite_score{strategy_id}
```

#### Symbol Engine Health

```
# Engine status per symbol (gauge: 0=idle, 1=healthy, 2=recovering, 3=stalled, 4=halted)
trading_engine_status{symbol, timeframe}

# Engine restart count (counter)
trading_engine_restarts_total{symbol, reason}

# Heartbeat age (gauge — seconds since last heartbeat)
trading_engine_heartbeat_age_s{symbol}

# Open candle buffer depth (gauge)
trading_candle_buffer_size{symbol, timeframe}

# Tick channel depth per symbol (gauge — alert if approaching capacity)
trading_tick_channel_depth{symbol}
```

#### Position State

```
# Open positions count (gauge)
trading_positions_open{segment, execution_mode}

# Position hold duration (histogram — bars)
trading_position_hold_bars{strategy_id}
```

### Executor Binary Metrics

#### Order Flow

```
# Orders received from Pub/Sub (counter)
trading_orders_received_total{execution_mode}

# Orders submitted to broker (counter)
trading_orders_submitted_total{execution_mode, symbol}

# Order outcomes (counter)
trading_order_outcomes_total{execution_mode, result}
# result: filled, partial_fill, rejected, cancelled, timeout

# Pending orders count (gauge — alert if > 10)
trading_orders_pending{execution_mode}
```

#### Execution Quality

```
# Order fill latency — signal to fill (histogram — milliseconds)
trading_fill_latency_ms{execution_mode}
# Buckets: 50, 100, 200, 500, 1000, 2000, 5000

# Breakdown of fill latency components (histograms)
trading_signal_to_order_ms        # Core processing
trading_order_to_submit_ms        # Pre-flight + Pub/Sub
trading_submit_to_fill_ms         # Zerodha API

# Slippage per trade (histogram — basis points)
trading_slippage_bps{strategy_id, execution_mode}

# Execution quality score (histogram)
trading_execution_quality_score{strategy_id}
```

#### Paper Trader

```
# Paper portfolio value (gauge — INR)
trading_paper_portfolio_value_inr{session_id}

# Paper vs backtest divergence (gauge — percent)
trading_paper_backtest_divergence_pct{strategy_id, metric}
# metric: sharpe, win_rate, avg_slippage
```

### Risk Engine Metrics

```
# Kill switch level (gauge: 0–4)
trading_kill_switch_level

# Daily P&L (gauge — INR, can be negative)
trading_daily_pnl_inr

# Daily loss limit utilisation (gauge — percent 0–100+)
trading_daily_loss_limit_pct_used

# Portfolio drawdown (gauge — percent)
trading_portfolio_drawdown_pct

# Available margin (gauge — INR)
trading_available_margin_inr

# Margin utilisation (gauge — percent)
trading_margin_utilisation_pct

# Strategy status (gauge: 0=active, 1=warning, 2=critical, 3=halted)
trading_strategy_status{strategy_id}

# Consecutive losses per strategy (gauge)
trading_strategy_consecutive_losses{strategy_id}
```

### Tick Receiver Metrics

```
# TrueData connection status (gauge: 0=disconnected, 1=connected)
trading_truedata_connected{segment}

# Ticks published to Pub/Sub (counter)
trading_ticks_published_total{segment}

# Reconnection count (counter — alert on frequent reconnections)
trading_truedata_reconnections_total{segment}

# Last tick timestamp age (gauge — seconds since last tick received)
trading_last_tick_age_s{segment}
# Alert if > 30s during market hours
```

### DB Writer Metrics

```
# Events consumed from Pub/Sub (counter)
trading_events_consumed_total{topic}

# DB write latency (histogram — milliseconds)
trading_db_write_latency_ms{table}

# DB write errors (counter — alert if > 0)
trading_db_write_errors_total{table, error_type}

# Pub/Sub consumer lag for DB writer (gauge — messages behind)
trading_dbwriter_pubsub_lag{subscription}
```

---

## Grafana Dashboards

Four dashboards. All auto-provisioned via Grafana dashboard JSON.

### Dashboard 1 — System Health

**Purpose:** Is the system running correctly?

```
Row 1: Service Status
  ├─ Stat: Core running (green/red — trading_engine_status count)
  ├─ Stat: Tick Receiver connected (green/red — trading_truedata_connected)
  ├─ Stat: Executor running (green/red — trading_orders_pending gauge)
  └─ Stat: DB Writer lag (green/yellow/red — trading_dbwriter_pubsub_lag)

Row 2: VM Health
  ├─ Graph: CPU usage % over time
  ├─ Graph: Memory usage over time
  ├─ Stat:  Disk space remaining
  └─ Graph: Network I/O (outbound for API calls)

Row 3: Symbol Engine Health
  ├─ Table: All symbols — engine status, heartbeat age, tick channel depth
  └─ Graph: Tick channel depth over time (top 10 symbols)

Row 4: TrueData Feed
  ├─ Graph: Ticks/second received per segment
  ├─ Stat:  Last tick age per segment (alert if stale)
  └─ Graph: Pub/Sub consumer lag (should stay near 0)
```

### Dashboard 2 — Live Trading

**Purpose:** What is the system doing with real money right now?

```
Row 1: Portfolio Summary (updates every 30s)
  ├─ Stat:  Daily P&L (INR, colour-coded: green profit / red loss)
  ├─ Stat:  Portfolio drawdown % (red if approaching thresholds)
  ├─ Stat:  Kill switch level (green=0, yellow=1, orange=2, red=3+)
  └─ Stat:  Open positions count

Row 2: Risk Status
  ├─ Gauge: Daily loss limit utilisation %
  ├─ Gauge: Margin utilisation %
  ├─ Stat:  Available margin (INR)
  └─ Table: Strategy status (active/warning/critical/halted)

Row 3: Open Positions (live, refreshes every 30s)
  └─ Table: symbol, strategy, direction, entry price, current price,
            unrealised P&L (INR), unrealised P&L (%), hold bars,
            stop loss price, take profit price

Row 4: Today's Activity
  ├─ Table: Completed trades today (symbol, strategy, P&L, exit reason)
  ├─ Graph: Intraday P&L curve
  └─ Stat:  Win rate today (trades_today > 0)
```

### Dashboard 3 — Strategy Performance

**Purpose:** How are strategies performing over time?

```
Row 1: Strategy Comparison
  └─ Table: All strategies — status, trades (30d), win rate, avg P&L, Sharpe,
            consecutive losses, drawdown, composite score avg

Row 2: Per-Strategy Deep Dive (variable: strategy selector)
  ├─ Graph: Equity curve (cumulative P&L over time)
  ├─ Graph: Rolling win rate (20-trade window)
  ├─ Graph: Signal → fill latency (P50, P95, P99)
  └─ Graph: Slippage trend over time

Row 3: Paper vs Live Comparison (for strategies with both)
  ├─ Table: Metric divergence (Sharpe, win rate, slippage)
  └─ Graph: Paper equity curve vs Live equity curve

Row 4: Rejection Analysis
  ├─ Bar chart: Rejections by stage (last 30 days)
  ├─ Bar chart: Rejections by reason (last 30 days)
  └─ Stat:  Rejection rate % (rejected / (rejected + traded))
```

### Dashboard 4 — Execution Quality

**Purpose:** How cleanly are orders executing?

```
Row 1: Latency Overview
  ├─ Histogram: Total signal-to-fill latency distribution
  ├─ Graph:     P50/P95 latency trend over time
  └─ Stat:      % of orders with latency > 2 seconds (alert threshold)

Row 2: Slippage Analysis
  ├─ Graph:     Average slippage over time (should stay flat)
  ├─ Histogram: Slippage distribution (basis points)
  └─ Table:     Top 10 worst slippage trades (last 30 days)

Row 3: Fill Quality
  ├─ Stat:  Fill rate % (filled / submitted)
  ├─ Stat:  Partial fill rate %
  ├─ Stat:  Timeout rate %
  └─ Graph: Order outcome breakdown over time

Row 4: Broker Connectivity
  ├─ Graph: Zerodha API response time
  ├─ Counter: Broker rejections by reason (last 7 days)
  └─ Graph: Order queue depth over time
```

---

## Alert Rules

All alerts delivered via Grafana alerting to Telegram (primary) and email (backup).

### Critical Alerts (Immediate Action Required)

```
ALERT: Kill switch Level 3 or 4 activated
  Condition:  trading_kill_switch_level >= 3
  For:        0 seconds (fire immediately)
  Message:    "EMERGENCY: Kill switch level {level}. All positions closing."
  Channel:    Telegram + Email

ALERT: Symbol engine HALTED
  Condition:  trading_engine_status{} == 4 for any symbol
  For:        0 seconds
  Message:    "Symbol engine {symbol} halted after 5 restarts. Manual intervention required."
  Channel:    Telegram

ALERT: TrueData feed disconnected
  Condition:  trading_truedata_connected{} == 0 for any segment
  For:        2 minutes (allow brief reconnect)
  Message:    "TrueData {segment} disconnected for 2+ minutes during market hours."
  Channel:    Telegram

ALERT: Daily loss limit approaching
  Condition:  trading_daily_loss_limit_pct_used >= 90
  For:        0 seconds
  Message:    "Daily loss at {value}% of limit. ₹{remaining} remaining."
  Channel:    Telegram

ALERT: Execution latency spike
  Condition:  histogram_quantile(0.95, trading_fill_latency_ms) > 5000
  For:        5 minutes
  Message:    "P95 fill latency is {value}ms — above 5 second threshold."
  Channel:    Telegram
```

### Warning Alerts (Review Required, Not Immediate)

```
ALERT: Kill switch Level 1 or 2
  Condition:  trading_kill_switch_level >= 1
  For:        0 seconds
  Message:    "Risk warning: kill switch level {level} — {reason}."
  Channel:    Telegram

ALERT: Strategy halted
  Condition:  trading_strategy_status{} == 3
  For:        0 seconds
  Message:    "Strategy {strategy_id} halted by risk rules."
  Channel:    Telegram

ALERT: Tick channel filling
  Condition:  trading_tick_channel_depth{} > 800
  For:        1 minute
  Message:    "Tick channel for {symbol} at {depth}/1000 — engine may be slow."
  Channel:    Telegram

ALERT: Paper vs backtest divergence
  Condition:  abs(trading_paper_backtest_divergence_pct{metric="sharpe"}) > 20
  For:        0 seconds (fires once after paper session)
  Message:    "Strategy {strategy_id} paper/backtest Sharpe diverged by {value}%."
  Channel:    Telegram

ALERT: DB write errors
  Condition:  increase(trading_db_write_errors_total[5m]) > 0
  For:        0 seconds
  Message:    "DB write errors detected: {count} in last 5 minutes."
  Channel:    Telegram

ALERT: High slippage trend
  Condition:  avg_over_time(trading_slippage_bps[1h]) > 30
  For:        30 minutes
  Message:    "Average slippage {value}bps — above 30bps threshold. Backtest assumptions may be invalid."
  Channel:    Email
```

### Informational Alerts (Daily Summary)

```
ALERT: Daily trading summary
  Condition: time() == 16:00 IST on weekdays
  Message:   "Today: {trades} trades, P&L ₹{pnl}, Win rate {wr}%, Slippage avg {slip}bps"
  Channel:   Telegram

ALERT: Session start confirmation
  Condition: time() == 09:15 IST on weekdays
             AND trading_truedata_connected == 1 for all segments
  Message:   "Market open. All feeds live. {strategies} strategies active."
  Channel:   Telegram
```

---

## Structured Logging

All Go binaries emit structured JSON logs to stdout, captured by Cloud Logging.

### Log Format

```json
{
  "timestamp": "2026-05-07T09:20:00.012+05:30",
  "level": "INFO",
  "service": "core",
  "binary_version": "1.2.3",
  "symbol": "NIFTY-I",
  "strategy_id": "strat_nifty_mean_rev",
  "event": "SIGNAL_GENERATED",
  "composite_score": 0.756,
  "bar_close_time": "2026-05-07T09:20:00+05:30",
  "message": "Signal generated for NIFTY-I, strategy mean_rev_v1.1, score 0.756"
}
```

### Log Levels

```
DEBUG:   Detailed per-tick processing (disabled in production — too verbose)
INFO:    Normal events (signal generated, position opened, bar close)
WARNING: Non-critical issues (Redis fallback used, score threshold close, stale data)
ERROR:   Failures that affect functionality (DB write failed, engine restarted)
CRITICAL: System-threatening issues (kill switch triggered, engine halted)
```

### Key Log Events to Search

```
Cloud Logging query for alerts (last hour):
  jsonPayload.level = "CRITICAL"

Cloud Logging query for trading activity (today):
  jsonPayload.event =~ "SIGNAL|POSITION|ORDER|REJECTION"
  jsonPayload.symbol = "NIFTY-I"

Cloud Logging query for risk events:
  jsonPayload.event =~ "KILL_SWITCH|RISK|HALT"

Cloud Logging query for execution issues:
  jsonPayload.event =~ "TIMEOUT|BROKER_REJECT|FILL_TIMEOUT"
  jsonPayload.service = "executor"
```

---

## Health Check Endpoints

Used by Cloud Monitoring and internal checks.

```
Core:          GET localhost:8080/health
Executor:      GET localhost:8081/health
Tick Receiver: GET localhost:8082/health
DB Writer:     GET localhost:8083/health

Response (healthy):
  HTTP 200
  { "status": "ok", "uptime_s": 3600, "version": "1.2.3" }

Response (degraded):
  HTTP 200
  { "status": "degraded", "issues": ["redis_stale", "2_engines_recovering"] }

Response (unhealthy):
  HTTP 503
  { "status": "unhealthy", "reason": "truedata_disconnected_10min" }
```

---

## Grafana Setup

```bash
# Access Grafana
# URL: http://{VM_IP}:3000  (via SSH tunnel in production)
# SSH tunnel: gcloud compute ssh trading-vm -- -L 3000:localhost:3000

# First login: admin / {GRAFANA_ADMIN_PASSWORD from Secret Manager}
# Change password immediately on first login

# Add Prometheus data source:
#   URL: http://localhost:9090
#   Access: Server (default)

# Import dashboards from repo:
#   grafana/dashboards/system-health.json
#   grafana/dashboards/live-trading.json
#   grafana/dashboards/strategy-performance.json
#   grafana/dashboards/execution-quality.json

# Configure Telegram alerting:
#   Alerting > Contact points > Add contact point
#   Type: Telegram
#   Bot token: {TELEGRAM_BOT_TOKEN}
#   Chat ID: {TELEGRAM_CHAT_ID}
```

---

## Monthly Monitoring Review Checklist

```
Performance:
  [ ] Review strategy composite scores — any consistently below 0.65?
  [ ] Check rejection patterns — any rejection_reason dominating?
  [ ] Review slippage trend — still within backtest assumptions?
  [ ] Check paper vs live divergence for all live strategies

Risk:
  [ ] Review kill switch history — any Level 1+ events?
  [ ] Review strategy drawdown — any approaching warning thresholds?
  [ ] Check margin utilisation peaks — ever above 70%?

System:
  [ ] Review engine restart counts — any symbol restarting frequently?
  [ ] Check DB writer lag — any accumulation?
  [ ] Review tick drop counts — should be zero
  [ ] Check Cloud SQL disk usage — still under 80%?
  [ ] Review Cloud costs — within ₹10k budget?
```
