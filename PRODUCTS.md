# Product Specifications

Detailed specs for each of the 8 products. See ARCHITECTURE.md for technical details and API designs.

---

## 1. Data Manager

**Purpose:** Ingest, validate, and serve market data

### Key Features

1. **Multi-Source Ingestion**
   - TrueData Velocity Ultima (NSE EQ, NSE F&O, MCX — live ticks + historical)
   - NSE Bhavcopy (daily EOD reference, symbol master)
   - MCX Symbol Master (daily instrument refresh)
   - CSV upload (manual historical data if needed)

2. **Data Validation**
   - Gap detection (missing bars)
   - Outlier detection (suspicious spikes)
   - Stale data alerts (delayed updates)
   - Survivorship bias checks (delisted stocks)
   - Split/dividend adjustments

3. **Storage & Access**
   - PostgreSQL: recent data (< 2 years)
   - Parquet: historical archives (> 2 years)
   - Redis cache: hot symbols (1-day TTL)

4. **Data Quality Dashboard**
   - Source status (TrueData WebSocket, NSE Bhavcopy, MCX master)
   - Last refresh time
   - Record counts by symbol
   - Gaps detected
   - Outliers flagged

### User Interaction

```
[Data Manager - Automatic]
├─ Daily 6 PM: Auto-refresh all sources
├─ Check quality (gaps, outliers)
├─ Archive old data to Parquet
└─ Alert if issues found
```

### Configuration

```yaml
sources:
  truedata:
    segments: [NSE_EQ, NSE_FNO, MCX]
    mode: websocket_live          # persistent WebSocket
    historical_backfill: true     # Day 1 bulk pull via REST API
    symbols_per_segment: 700      # Ultima plan with add-on

  nse_bhavcopy:
    refresh: daily 08:30 IST      # Pre-market symbol master refresh
    
  mcx_symbol_master:
    refresh: daily 08:30 IST
```

---

## 2. Strategy Builder

**Purpose:** Create trading strategies visually (no coding)

### Key Features

1. **Visual Rule Builder**
   - Drag-drop conditions
   - AND/OR logic
   - 20+ indicators available (SMA, RSI, MACD, etc.)
   - Compare: price to value, indicator to value

2. **Entry/Exit Definition**
   - Multiple entry conditions (all must be true)
   - Multiple exit rules (any can trigger)
   - Time-based exits (hold max N bars)
   - Profit taking (partial, full)
   - Stop losses (fixed %, trailing %)

3. **Position Sizing Models**
   - Fixed percentage (2% of capital)
   - Volatility-adjusted (scale by volatility)
   - Risk-based (fix risk amount, adjust size)
   - Kelly Criterion (mathematical optimal)

4. **Strategy Versioning**
   - Save v1.0, v1.1, v2.0, etc.
   - Compare versions (backtest results)
   - Rollback to previous version
   - Change log (what changed in each version)

### User Interaction

```
1. Click "Create Strategy"
2. Fill name, asset class, symbols
3. Drag-drop entry conditions
4. Drag-drop exit conditions
5. Configure position sizing
6. Define parameters (for optimization)
7. Click "Backtest"
8. See results in seconds
```

### Parameters (Examples)

```
"sma_period": {
  "type": "integer",
  "min": 20,
  "max": 100,
  "step": 10,
  "optimizable": true
}

"rsi_threshold": {
  "type": "integer",
  "min": 20,
  "max": 40,
  "step": 5,
  "optimizable": true
}

"take_profit_pct": {
  "type": "decimal",
  "min": 0.5,
  "max": 5.0,
  "step": 0.5,
  "optimizable": false  ← Don't optimize exits!
}
```

### Available Indicators

```
Price-based:
├─ SMA (Simple Moving Average)
├─ EMA (Exponential Moving Average)
├─ Bollinger Bands (upper, middle, lower)
├─ 52-week high/low

Momentum:
├─ RSI (Relative Strength Index)
├─ MACD (Moving Average Convergence Divergence)
├─ Stochastic (fast, slow)
├─ CCI (Commodity Channel Index)

Volume:
├─ On-Balance Volume (OBV)
├─ Volume Average
├─ Volume spike detection

Volatility:
├─ ATR (Average True Range)
├─ Bollinger Band width
├─ Historical volatility (%)

Trend:
├─ ADX (Average Directional Index)
├─ Supertrend
└─ Trend direction (up/down)
```

---

## 3. Backtesting Engine

**Purpose:** Simulate historical strategy performance

### Key Features

1. **Event-Driven Simulation**
   - Bar-by-bar execution
   - Realistic order matching
   - Market/limit/stop orders
   - Partial fills

2. **Realistic Execution**
   - Slippage: fixed %, adaptive (volume-based)
   - Commission: $ per trade, % of trade
   - Bid-ask spread modeling
   - Gap risk (big overnight moves)

3. **Metrics Calculation**
   - Return, Sharpe ratio, Sortino ratio
   - Max drawdown, recovery time
   - Win rate, profit factor
   - Average trade, consecutive losses
   - Monthly/yearly returns

4. **Trade Logging**
   - Every trade: entry, exit, P&L, hold time
   - Slippage per trade
   - Equity curve (daily)
   - Underwater plot (drawdown over time)

### Configuration Options

```yaml
execution:
  slippage_model: "adaptive"  # or "fixed"
  slippage_pct: 0.02
  commission_type: "fixed"    # or "percent"
  commission_value: 1.0       # $ or %
  
order_execution:
  market_fill_price: "close"  # or "open", "hl2"
  limit_order_timeout: "infinite"  # or N bars
  
leverage: 1.0  # 1x for equity delivery; F&O/MCX use SPAN margin (set per instrument)
initial_capital: 100000
```

### Output Format

```json
{
  "backtest_id": "uuid",
  "metrics": {
    "total_return_pct": 47.3,
    "sharpe_ratio": 1.23,
    "max_drawdown_pct": -12.4,
    "win_rate_pct": 52.0,
    "profit_factor": 1.85,
    "trades": 247
  },
  "trades": [
    {
      "date": "2015-01-15",
      "symbol": "NIFTY-I",
      "action": "BUY",
      "qty": 100,
      "entry_price": 127.50,
      "exit_price": 130.20,
      "pnl": 270,
      "pnl_pct": 2.11,
      "hold_bars": 4
    }
  ],
  "equity_curve": [
    {"date": "2015-01-15", "equity": 100270}
  ]
}
```

---

## 4. Validation Suite

**Purpose:** Separate real edges from luck (overfitting)

### Key Features

1. **Walk-Forward Validation**
   - Train on past data, test on future data
   - Multiple folds (e.g., annual splits)
   - Compare in-sample vs. out-of-sample
   - Detect overfitting (IS Sharpe 1.5 but OOS 0.5)

2. **Monte Carlo Testing**
   - Randomize trade order (1000 simulations)
   - Test with slippage variations (±0.1%)
   - Statistical distribution of returns
   - Robustness score

3. **Regime Analysis**
   - Trending markets (ADX > 25)
   - Ranging markets (ADX < 20)
   - Volatile markets (ATR > mean + 1 SD)
   - Performance breakdown by regime

4. **Statistical Significance**
   - Confidence intervals (95%)
   - Min sample size for significance
   - Hypothesis testing (is Sharpe > 0?)
   - T-tests

### Validation Verdict

```
PASS criteria:
├─ Walk-forward avg degradation < 30%
├─ Monte Carlo: robust (Sharpe stable)
├─ Works in at least 1 regime well
└─ Trades > 100 (statistically significant)

CAUTION criteria:
├─ Degradation 30-50%
├─ Medium robustness
├─ Works best in 1 specific regime
└─ Should add regime filter

FAIL criteria:
├─ Degradation > 50%
├─ Sharpe drops > 50% in MC
├─ Only works in 1 month/year
└─ Suggest major strategy changes
```

### Output

```json
{
  "walk_forward": {
    "results": [
      {
        "train_period": "2015-2019",
        "test_period": "2020",
        "train_sharpe": 1.45,
        "test_sharpe": 0.92,
        "degradation_pct": -37
      }
    ],
    "avg_degradation": -45,
    "status": "CAUTION"
  },
  "monte_carlo": {
    "original_sharpe": 1.23,
    "mc_mean": 0.98,
    "mc_std": 0.35,
    "percentile_5": 0.45,
    "percentile_95": 1.51,
    "status": "MEDIUM"
  },
  "regime_analysis": {
    "trending": {"sharpe": 1.8, "trade_count": 120},
    "ranging": {"sharpe": 0.2, "trade_count": 80},
    "volatile": {"sharpe": -0.3, "trade_count": 47}
  },
  "recommendation": "Add trend filter before live trading"
}
```

---

## 5. Risk Monitor

**Purpose:** Real-time position sizing and drawdown protection

### Key Features

1. **Position Sizing**
   - Fixed % of capital (2% per trade)
   - Volatility-adjusted (scale by 30-day vol)
   - Risk-based (fix $ risk, adjust size)
   - Dynamic (recalculate every trade)

2. **Portfolio Tracking**
   - Current equity, cash, margin
   - Open positions, unrealized P&L
   - Correlation matrix (strategy pairs)
   - Margin ratio (SPAN + Exposure for F&O/MCX)

3. **Alerts & Limits**
   - Drawdown > 10%: Reduce positions 50%
   - Drawdown > 15%: Close all positions
   - Margin > 95%: Reduce largest position
   - Correlation spike: Reduce correlated pairs
   - Daily loss > limit: Pause trading

4. **Risk Rules**
   ```
   Max risk per trade: 2% of capital
   Max portfolio exposure: 100% (no naked leverage)
   F&O/MCX margin: SPAN + Exposure margin enforced
   Max drawdown alert: 10%
   Max drawdown halt: 15%
   Daily loss limit: ₹5,000 (configurable)
   Max margin utilization: 80%
   MCX position close: 3 days before expiry (physical delivery risk)
   Intraday MIS auto-squareoff: 15:15 IST
   ```

### Signals

Receives:
- Strategy signal: "BUY 1 LOT NIFTY-I"
- Current positions: {...}
- Account equity: ₹5,00,000
- Market prices: {NIFTY-I: 24350, GOLD-I: 72400, ...}
- SPAN margin requirements: from instruments_india table

Outputs:
- Approved size: "Buy 1 lot (25 units, margin ₹1,10,000)"
- Or: "Rejected — margin utilization would exceed 80%"
- Position sizing calculation: "2% risk = ₹10,000; ATR stop = ₹150; lots = 2"

---

## 6. Analytics Dashboard

**Purpose:** Real-time trading metrics and historical analysis

### Key Features

1. **Live Metrics**
   - P&L today, month, year
   - Sharpe, drawdown, win rate
   - Current positions (entry, current, P&L)
   - Open order status

2. **Historical Analysis**
   - Equity curve (account growth)
   - Monthly returns heatmap
   - Trade distribution (wins vs losses)
   - Slippage analysis
   - Regime performance

3. **Real-Time Updates**
   - WebSocket streaming
   - <100ms latency
   - Position updates
   - Alert notifications

4. **Comparison Views**
   - Backtest vs. Paper
   - Backtest vs. Live
   - Strategy A vs. Strategy B
   - This month vs. last month

### Grafana Dashboards

See [MONITORING.md](./MONITORING.md) for detailed dashboard specs.

---

## 7. Paper Trading

**Purpose:** Risk-free testing before live trading

### Key Features

1. **Live Market Data**
   - Real-time prices (same as live trading)
   - Real order book (realistic fills)
   - Real event times (gaps, afterhours)

2. **Simulated Fills**
   - Market orders: instant fill, realistic slippage
   - Limit orders: wait for price, possible timeout
   - Partial fills: based on volume
   - Latency simulation: 100-200ms

3. **Portfolio Management**
   - Position tracking
   - P&L calculation
   - Risk monitoring
   - Performance metrics

4. **Comparison Engine**
   - Compare paper vs. backtest
   - Identify slippage differences
   - Check fill quality
   - Confidence signal for live

### Decision Criteria for Live

```
Go live only if:
✓ Backtest Sharpe > 1.0
✓ Paper trading 2+ weeks
✓ Paper Sharpe within 10% of backtest
✓ Slippage matches assumptions ± 20%
✓ No surprises in real-time execution
✓ Comfortable with max loss scenario
```

---

## 8. Live Executor

**Purpose:** Execute real trades with safeguards

### Key Features

1. **Order Management**
   - Submit market/limit/stop orders
   - Track pending orders
   - Handle partial fills
   - Reject orders violating risk limits

2. **Broker Integration**
   - Zerodha Kite API (all segments: NSE EQ, NSE F&O, MCX)
   - Order types: CNC (equity delivery), MIS (intraday), NRML (F&O/MCX overnight)
   - GTT (Good Till Triggered) orders for stop losses
   - See ZERODHA_SPEC.md for full integration details

3. **Execution Quality**
   - Track latency (signal → fill)
   - Measure slippage
   - Monitor fill rate
   - Alert on anomalies

4. **Safety Mechanisms**
   - Pre-flight checks (balance, margin)
   - Position limits enforced
   - Emergency stop (close all)
   - Order timeout (cancel if not filled)

5. **Audit Trail**
   - Immutable log of all trades
   - Kafka topic: every order event
   - Replay capability
   - Regulatory compliance

### Broker Configuration

```yaml
zerodha:
  api_key: ${ZERODHA_API_KEY}
  api_secret: ${ZERODHA_API_SECRET}
  access_token: ${ZERODHA_ACCESS_TOKEN}   # Refreshed daily via login flow
  segments: [NSE, NFO, MCX]
  paper_mode: false
```

### Safety Limits (Enforced)

```
Position checks:
├─ Check account balance
├─ Check available margin (for leverage)
├─ Check position size <= max allowed
└─ Reject if violates any rule

Risk checks:
├─ Current equity > min required
├─ Leverage < max allowed
├─ Drawdown < alert threshold
└─ Daily P&L > limit
```

---

## Summary Table

| Product | Latency | Frequency | Update Interval | Critical? |
|---------|---------|-----------|-----------------|-----------|
| Data Manager | < 1s | Daily | 6 PM daily | ✓✓✓ |
| Strategy Builder | < 200ms | Manual | N/A | Low |
| Backtest Engine | 30-60s | Manual | N/A | Medium |
| Validation Suite | 5-10m | Manual | N/A | ✓✓ |
| Risk Monitor | < 10ms | Real-time | Every tick | ✓✓✓ |
| Analytics API | < 100ms | Real-time | Every trade | Medium |
| Paper Trader | < 500ms | Real-time | Every fill | ✓ |
| Live Executor | < 100ms | Real-time | Every order | ✓✓✓ |

---

## Interaction Matrix

```
                     Read From           Write To
Data Manager       └─ TrueData WS      → TimescaleDB, Redis
Strategy Builder   ├─ DB               → DB
Backtest Engine    ├─ DB, Parquet      → DB (trades, metrics)
Validation Suite   ├─ DB               → DB (validation results)
Risk Monitor       ├─ Redis, DB        → Redis (positions)
Analytics API      ├─ DB, Redis        → Grafana
Paper Trader       ├─ TrueData live    → DB (paper trades)
Live Executor      ├─ DB, Redis        → Zerodha Kite API, DB (audit)
```

---

## Next Steps

See [MONITORING.md](./MONITORING.md) for dashboard specifications.
See [ARCHITECTURE.md](./ARCHITECTURE.md) for API and database details.
