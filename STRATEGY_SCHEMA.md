# Strategy Schema

Complete specification for the strategy definition format.
All strategies — whether created in the UI, cloned from a template, or hand-authored — 
conform to this schema.

See STRATEGY_LIFECYCLE.md for how strategies move from DRAFT to LIVE.
See SCORING_ENGINE.md for how entry.mode and condition weights affect scoring.
See SEGMENT_MODULES.md for how instrument fields are validated per segment.

---

## Format

Canonical format: **JSON** (stored in PostgreSQL, transported via API, loaded by Core).
Display format: **YAML** (rendered in Strategy Builder UI for human readability).
YAML ↔ JSON conversion happens in the frontend only. Backend never parses YAML.

---

## Complete Schema

```json
{
  "id": "strat_uuid_v4",
  "name": "Nifty Mean Reversion",
  "description": "Buy oversold Nifty futures when RSI is below 30 and price is under SMA(50)",
  "version": "1.0.0",
  "status": "draft",
  "is_template": false,
  "cloned_from": null,
  "created_at": "2026-05-07T10:00:00+05:30",
  "updated_at": "2026-05-07T10:00:00+05:30",
  "backtested_at": null,
  "validated_at": null,

  "instrument": {
    "symbol": "NIFTY-I",
    "exchange": "NSE",
    "segment": "FNO",
    "lot_size_source": "instruments_table"
  },

  "execution": {
    "timeframe": "5m",
    "trade_direction": "long",
    "mode": "paper",
    "strategy_type": "mean_reversion"
  },

  "entry": {
    "mode": "AND",
    "score_threshold": null,
    "conditions": {
      "type": "AND",
      "nodes": [
        {
          "id": "cond_1",
          "type": "comparison",
          "left":  { "indicator": "RSI", "params": { "period": 14 } },
          "op":    "lt",
          "right": { "value": 30 },
          "weight": 40
        },
        {
          "id": "cond_2",
          "type": "comparison",
          "left":  { "indicator": "PRICE", "field": "close" },
          "op":    "lt",
          "right": { "indicator": "SMA", "params": { "period": 50 } },
          "weight": 35
        },
        {
          "id": "cond_3",
          "type": "comparison",
          "left":  { "indicator": "VOLUME" },
          "op":    "gt",
          "right": { "indicator": "AVG_VOLUME", "params": { "period": 20 } },
          "weight": 25
        }
      ]
    }
  },

  "exit": {
    "priority_order": [
      {
        "id": "exit_forced",
        "type": "forced",
        "description": "MIS squareoff 15:15 IST, expiry day, MCX delivery block"
      },
      {
        "id": "exit_risk",
        "type": "risk_breach",
        "description": "Daily loss limit, kill switch Level 3+"
      },
      {
        "id": "exit_sl",
        "type": "stop_loss",
        "value": 1.0,
        "unit": "percent",
        "trailing": false
      },
      {
        "id": "exit_tp",
        "type": "take_profit",
        "value": 2.0,
        "unit": "percent"
      },
      {
        "id": "exit_signal",
        "type": "signal_exit",
        "description": "Entry conditions reverse"
      },
      {
        "id": "exit_time",
        "type": "time_exit",
        "max_bars": 5
      }
    ]
  },

  "position_sizing": {
    "model": "risk_based",
    "risk_per_trade_pct": 1.0,
    "max_position_pct": 10.0
  },

  "risk": {
    "max_open_positions": 1,
    "daily_loss_limit_pct": 2.0,
    "avoid_expiry_day": true,
    "trade_window": {
      "start": "09:30",
      "end": "15:00"
    }
  },

  "parameters": {
    "rsi_period": {
      "value": 14,
      "min": 7,
      "max": 21,
      "step": 1,
      "optimizable": true
    },
    "sma_period": {
      "value": 50,
      "min": 20,
      "max": 100,
      "step": 10,
      "optimizable": true
    },
    "take_profit_pct": {
      "value": 2.0,
      "min": 1.0,
      "max": 5.0,
      "step": 0.5,
      "optimizable": false
    },
    "stop_loss_pct": {
      "value": 1.0,
      "min": 0.5,
      "max": 2.0,
      "step": 0.25,
      "optimizable": false
    }
  },

  "backtest_results": null,
  "paper_results": null
}
```

---

## Field Reference

### Top-Level Fields

| Field | Type | Description |
|---|---|---|
| `id` | UUID string | Immutable after creation |
| `name` | string | Human-readable, unique per user |
| `version` | semver string | See STRATEGY_LIFECYCLE.md for versioning rules |
| `status` | enum | `draft` `backtested` `validated` `paper` `live_candidate` `live` `deprecated` |
| `is_template` | bool | True = read-only bundled default. Never modified. |
| `cloned_from` | UUID or null | ID of template this was cloned from |

### instrument

| Field | Values | Notes |
|---|---|---|
| `symbol` | `NIFTY-I`, `RELIANCE`, `GOLD-I`, etc. | TrueData symbol format — see INDIA_MARKETS_SPEC.md |
| `exchange` | `NSE` `MCX` | |
| `segment` | `EQ` `FNO` `MCX` | Determines which SegmentModule handles this strategy |
| `lot_size_source` | `instruments_table` | Always. Never hardcode lot size. |

### execution

| Field | Values | Notes |
|---|---|---|
| `timeframe` | `tick` `1m` `5m` `15m` `1h` `1d` | Candle aggregation timeframe |
| `trade_direction` | `long` `short` `both` | |
| `mode` | `paper` `live` | Changed only via promotion flow, never directly |
| `strategy_type` | `trend_following` `mean_reversion` `breakout` `momentum` `volatility_squeeze` | Used by Scoring Engine regime match |

### entry.mode

| Value | Behaviour |
|---|---|
| `AND` | All root-level condition nodes must be true. Weights ignored. |
| `SCORE` | Weighted sum of met conditions. Entry fires when sum >= score_threshold. |

### entry.conditions — AST Nodes

#### AND / OR Node

```json
{
  "id": "node_id",
  "type": "AND",
  "nodes": [ ...child nodes... ]
}
```

`type` can be `AND` or `OR`. Contains an array of child nodes (comparison or nested AND/OR).

#### Comparison Node

```json
{
  "id": "cond_id",
  "type": "comparison",
  "left":   { ...indicator reference... },
  "op":     "lt",
  "right":  { ...value or indicator reference... },
  "weight": 40
}
```

`weight` is used in SCORE mode only. Ignored in AND mode. Must be > 0 if mode = SCORE.

#### Comparison Operators

| `op` | Meaning |
|---|---|
| `lt` | left < right |
| `gt` | left > right |
| `lte` | left <= right |
| `gte` | left >= right |
| `eq` | left == right (use with care on floats — uses epsilon comparison) |
| `crosses_above` | left crossed above right on this bar (was below on previous bar) |
| `crosses_below` | left crossed below right on this bar |

#### Indicator Reference

```json
{ "indicator": "RSI", "params": { "period": 14 } }
{ "indicator": "PRICE", "field": "close" }
{ "indicator": "SMA", "params": { "period": 50 } }
{ "indicator": "SMA", "params": { "period": 50 }, "offset": -2.0, "offset_type": "percent" }
```

`offset` (optional): Shifts the indicator value before comparison.
  `offset: -2.0, offset_type: percent` → value becomes `SMA(50) × 0.98`
  Allows conditions like "Price is more than 2% below SMA(50)."

#### Value Reference

```json
{ "value": 30 }
{ "value": 0.5 }
```

Scalar number. Used on the `right` side of a comparison.

### exit.priority_order

Array of exit rules evaluated in order. First rule that triggers wins.

| `type` | Fields | Description |
|---|---|---|
| `forced` | — | Broker-level: MIS squareoff, expiry, MCX delivery |
| `risk_breach` | — | Kill switch Level 3+, daily loss limit |
| `stop_loss` | `value`, `unit`, `trailing` | Fixed or trailing stop |
| `take_profit` | `value`, `unit` | Profit target |
| `signal_exit` | `conditions` (optional) | Custom exit signal, or empty = reverse of entry |
| `time_exit` | `max_bars` | Exit after N closed bars |

`unit` values: `percent` `points` `rupees`

`trailing` (stop_loss only): If true, stop price ratchets up as price moves favorably.
Trailing stop tracks the highest price since entry, stops at `value` below that peak.

### position_sizing.model

| Model | Required Fields | Description |
|---|---|---|
| `fixed_pct` | `position_pct` | Always allocate X% of capital |
| `risk_based` | `risk_per_trade_pct` | Size so that max loss = X% of capital (2% rule) |
| `volatility_adj` | `risk_per_trade_pct`, `vol_lookback` | Scale size by recent volatility |
| `kelly` | `win_rate_override` (optional) | Kelly criterion with live win rate |

### parameters

Each parameter has these fields:

```json
{
  "value":       14,      (current active value)
  "min":          7,      (backtester lower bound)
  "max":         21,      (backtester upper bound)
  "step":         1,      (backtester increment)
  "optimizable": true     (whether backtester can sweep this param)
}
```

**Rule:** Never set `optimizable: true` on exit parameters (stop_loss_pct, take_profit_pct).
Exit parameters that are optimised overfit badly. Only optimise entry indicator periods and thresholds.

---

## Indicator Library

All indicators available in the condition builder.

### Price

| Indicator | Params | Returns | Notes |
|---|---|---|---|
| `PRICE` | `field`: open/high/low/close/vwap | single value | Current bar price field |
| `PREV_PRICE` | `field`, `bars_back` | single value | Price N bars ago |
| `HIGH_N` | `period` | highest high | N-bar high |
| `LOW_N` | `period` | lowest low | N-bar low |
| `52W_HIGH` | — | float | 52-week high (requires daily candles) |
| `52W_LOW` | — | float | 52-week low |

### Moving Averages

| Indicator | Params | Notes |
|---|---|---|
| `SMA` | `period` | Simple moving average of close |
| `EMA` | `period` | Exponential moving average |
| `VWAP` | — | Session VWAP (resets each day) |
| `SUPERTREND` | `period`, `multiplier` | Supertrend indicator (also provides direction) |

### Momentum

| Indicator | Params | Returns | Notes |
|---|---|---|---|
| `RSI` | `period` | 0–100 | Relative Strength Index |
| `MACD` | `fast`, `slow`, `signal` | MACD line | Use `MACD_SIGNAL` for signal line, `MACD_HIST` for histogram |
| `MACD_SIGNAL` | `fast`, `slow`, `signal` | signal line | |
| `MACD_HIST` | `fast`, `slow`, `signal` | histogram | |
| `STOCH_K` | `k_period`, `d_period` | 0–100 | Stochastic %K |
| `STOCH_D` | `k_period`, `d_period` | 0–100 | Stochastic %D |
| `CCI` | `period` | float | Commodity Channel Index |
| `ROC` | `period` | percent | Rate of change |

### Volume

| Indicator | Params | Notes |
|---|---|---|
| `VOLUME` | — | Current bar volume |
| `AVG_VOLUME` | `period` | Average volume over N bars |
| `VOLUME_RATIO` | `period` | Current volume / average volume |
| `OBV` | — | On-Balance Volume |

### Volatility

| Indicator | Params | Notes |
|---|---|---|
| `ATR` | `period` | Average True Range |
| `BB_UPPER` | `period`, `std_dev` | Bollinger Band upper |
| `BB_MIDDLE` | `period`, `std_dev` | Bollinger Band middle (= SMA) |
| `BB_LOWER` | `period`, `std_dev` | Bollinger Band lower |
| `BB_WIDTH` | `period`, `std_dev` | Band width (upper - lower) / middle |
| `BB_PCT` | `period`, `std_dev` | %B — where price is within the bands |
| `HIST_VOL` | `period` | Historical volatility (annualised) |

### Trend

| Indicator | Params | Returns | Notes |
|---|---|---|---|
| `ADX` | `period` | 0–100 | Average Directional Index (trend strength) |
| `DI_PLUS` | `period` | 0–100 | +DI (directional movement) |
| `DI_MINUS` | `period` | 0–100 | -DI |
| `SUPERTREND_DIR` | `period`, `multiplier` | 1 or -1 | 1 = uptrend, -1 = downtrend |

### India-Specific

| Indicator | Params | Notes |
|---|---|---|
| `INDIA_VIX` | — | India VIX last value (from TrueData) |
| `OI` | — | Open interest (F&O and MCX only) |
| `OI_CHANGE` | `period` | OI change over N bars |
| `BASIS` | — | Futures - Spot (F&O only, requires spot symbol config) |

### Time

| Indicator | Params | Notes |
|---|---|---|
| `SESSION_MINUTES` | — | Minutes elapsed since market open |
| `BAR_NUMBER` | — | Bar count since market open |

---

## Bundled Strategy Templates

Shipped as read-only defaults in the PostgreSQL `strategy_templates` table.
Users clone these — they never edit the originals.

### Phase 1 Templates (Build First)

#### T01 — EMA Crossover (9/21) Intraday
```json
{
  "name": "EMA Crossover 9/21 Intraday",
  "execution": { "timeframe": "5m", "strategy_type": "trend_following" },
  "entry": {
    "mode": "AND",
    "conditions": {
      "type": "AND",
      "nodes": [
        { "type": "comparison", "left": { "indicator": "EMA", "params": {"period": 9} },
          "op": "crosses_above", "right": { "indicator": "EMA", "params": {"period": 21} } },
        { "type": "comparison", "left": { "indicator": "ADX", "params": {"period": 14} },
          "op": "gt", "right": { "value": 20 } }
      ]
    }
  },
  "exit": { "priority_order": [
    {"type": "forced"}, {"type": "risk_breach"},
    {"type": "stop_loss", "value": 1.0, "unit": "percent"},
    {"type": "take_profit", "value": 2.0, "unit": "percent"},
    {"type": "signal_exit"}, {"type": "time_exit", "max_bars": 10}
  ]}
}
```
Best on: Nifty-I, BankNifty-I, large-cap equity. Works in trending markets.

#### T02 — Supertrend Intraday
```json
{
  "name": "Supertrend 5m",
  "execution": { "timeframe": "5m", "strategy_type": "trend_following" },
  "entry": {
    "mode": "AND",
    "conditions": {
      "type": "AND",
      "nodes": [
        { "type": "comparison", "left": { "indicator": "SUPERTREND_DIR", "params": {"period": 10, "multiplier": 3} },
          "op": "eq", "right": { "value": 1 } },
        { "type": "comparison", "left": { "indicator": "PRICE", "field": "close" },
          "op": "gt", "right": { "indicator": "SUPERTREND", "params": {"period": 10, "multiplier": 3} } }
      ]
    }
  }
}
```
Best on: All segments. India's most popular intraday indicator. Trailing stop built into signal.

#### T03 — Opening Range Breakout (ORB)
```json
{
  "name": "Opening Range Breakout 15m",
  "execution": { "timeframe": "15m", "strategy_type": "breakout" },
  "entry": {
    "mode": "SCORE",
    "score_threshold": 65,
    "conditions": {
      "type": "AND",
      "nodes": [
        { "type": "comparison",
          "left": { "indicator": "PRICE", "field": "close" },
          "op": "gt",
          "right": { "indicator": "HIGH_N", "params": {"period": 2} },
          "weight": 50 },
        { "type": "comparison",
          "left": { "indicator": "VOLUME_RATIO", "params": {"period": 10} },
          "op": "gt", "right": { "value": 1.5 },
          "weight": 30 },
        { "type": "comparison",
          "left": { "indicator": "SESSION_MINUTES" },
          "op": "lte", "right": { "value": 60 },
          "weight": 20 }
      ]
    }
  },
  "risk": { "trade_window": { "start": "09:30", "end": "11:00" } }
}
```
Best on: Nifty-I, BankNifty-I. Only trades in first hour. Classic India intraday setup.

#### T04 — VWAP Mean Reversion
```json
{
  "name": "VWAP Reversion 5m",
  "execution": { "timeframe": "5m", "strategy_type": "mean_reversion" },
  "entry": {
    "mode": "AND",
    "conditions": {
      "type": "AND",
      "nodes": [
        { "type": "comparison",
          "left": { "indicator": "PRICE", "field": "close" },
          "op": "lt",
          "right": { "indicator": "VWAP", "offset": -0.5, "offset_type": "percent" } },
        { "type": "comparison",
          "left": { "indicator": "RSI", "params": {"period": 14} },
          "op": "lt", "right": { "value": 40 } }
      ]
    }
  }
}
```
Best on: Nifty-I, BankNifty-I, liquid equity. Institutional anchor — VWAP is the reference price for large orders.

### Phase 2 Templates (After Phase 1 Validated)

| ID | Name | Type | Best Segment |
|---|---|---|---|
| T05 | RSI Mean Reversion Daily | mean_reversion | NSE Equity |
| T06 | Donchian Channel Breakout | breakout | MCX Gold, Crude |
| T07 | ADX + EMA Trend Filter | trend_following | All futures |

### Phase 3 Templates (Advanced)

| ID | Name | Type | Notes |
|---|---|---|---|
| T08 | Bollinger Squeeze Breakout | volatility_squeeze | Needs Score Mode |
| T09 | Gap Fill | mean_reversion | Equity only, daily open |
| T10 | VIX Overlay Filter | regime_filter | Add-on to any strategy |

---

## Validation Rules (Enforced on Strategy Save)

```
1. instrument.symbol must exist in instruments_india table
2. instrument.segment must match symbol's actual segment
3. entry.mode = SCORE requires all condition weights > 0
4. entry.score_threshold must be <= sum of all condition weights
5. exit.priority_order must contain at least: stop_loss AND take_profit
   (forced and risk_breach are added automatically if missing)
6. position_sizing.risk_per_trade_pct must be in range [0.1, 5.0]
7. risk.trade_window.end must be before segment's forced_exit_time
   (cannot set trade window end after MIS squareoff time)
8. parameters — if optimizable: min < max AND step > 0
9. execution.timeframe must be valid for segment:
   tick/1m only available for FNO and MCX (too many ticks for equity at scale)
```

---

*See STRATEGY_LIFECYCLE.md for promotion flow, versioning, and template cloning.*
