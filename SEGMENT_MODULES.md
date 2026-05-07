# Segment Modules

Plug-and-play interface for instrument-specific behaviour.
Core knows nothing about the difference between a Nifty futures tick and
a Gold MCX tick. All segment-specific logic is encapsulated here.

See CORE_ARCHITECTURE.md for how modules are registered at startup.
See INDIA_MARKETS_SPEC.md for segment characteristics.
See INGESTION_PIPELINE_SPEC.md for how instruments data is kept fresh.

---

## Design Principles

1. **Core is segment-agnostic.** Every call Core makes goes through the interface.
   No `if segment == "MCX"` anywhere in Core's trading logic.
2. **Hard rules cannot be softened.** MCX delivery block, MIS squareoff, expiry block —
   these are enforced unconditionally. No strategy config can override them.
3. **Instruments data comes from Redis.** No module ever calls the database directly.
   Lot sizes, margins, tick sizes, circuit bands — all from Redis cache.
4. **Options module is scaffolded, not implemented.** Phase 2 will implement it.
   Phase 1 activation fails gracefully with a clear error.

---

## Instruments Data Flow

Segment modules need lot sizes, margin requirements, and instrument status
on every pre-trade check. This data must be fast — Redis only.

```
PostgreSQL: instruments_india table (canonical source)
  ↓ populated by:
  08:30 IST: Symbol master refresh job (full refresh)
  12:30 IST: Intraday margin refresh (SPAN margins change with volatility)
  ↓ mirrored to:
Redis: instruments:{segment}:{symbol}
  {
    "symbol": "NIFTY-I",
    "lot_size": 25,
    "tick_size": 0.05,
    "span_margin": 112500,
    "exposure_margin": 56250,
    "total_margin": 168750,
    "upper_circuit": null,      (null for futures — no circuit limit)
    "lower_circuit": null,
    "price_band_pct": null,
    "is_suspended": false,
    "expiry_date": "2026-05-29",
    "days_to_expiry": 21,
    "last_oi": 8750000,
    "refreshed_at": "2026-05-07T08:30:00+05:30"
  }

TTL: 26 hours (covers overnight, refreshed before market open each day)
Stale threshold: 4 hours (alert if not refreshed within 4h of expected refresh time)
```

---

## Go Interface

```go
package segments

import "time"

// SegmentModule encapsulates all segment-specific behaviour.
// Register modules at Core startup based on enabled_segments config.
type SegmentModule interface {

    // ── Identity ────────────────────────────────────────────────────────

    Name()    string  // "equity" | "futures" | "commodity" | "options"
    Segment() string  // "NSE_EQ" | "NSE_FNO" | "MCX" | "NSE_FNO_OPT"

    // ── Market Hours ────────────────────────────────────────────────────

    // MarketOpen returns the time market opens in IST for today.
    // Returns zero time on non-trading days.
    MarketOpen(date time.Time) time.Time

    // MarketClose returns the time market closes in IST.
    MarketClose(date time.Time) time.Time

    // IsMarketOpen returns true if current time is within trading hours.
    IsMarketOpen() bool

    // ForcedExitTime returns the hard cut-off for MIS positions in IST.
    // Core's MIS Squareoff goroutine calls this per segment.
    ForcedExitTime() time.Time

    // IsTradingDay returns true if the exchange is open today.
    IsTradingDay(date time.Time) bool

    // ── Expiry ──────────────────────────────────────────────────────────

    // IsExpirable returns true if instruments in this segment can expire.
    IsExpirable() bool

    // IsExpiryDay returns true if the given symbol expires today.
    IsExpiryDay(symbol string, date time.Time) bool

    // DaysToExpiry returns calendar days until expiry for this symbol.
    DaysToExpiry(symbol string) int

    // HandleExpiry is called when a position expires or is at risk of expiry.
    // Returns the orders needed to close the position cleanly.
    // For futures/commodity: returns a market close order.
    // For equity: returns nil (equity doesn't expire).
    HandleExpiry(pos Position) []Order

    // ── Instrument Data ─────────────────────────────────────────────────

    // LotSize returns the number of units per lot for this symbol.
    // Always reads from Redis instruments cache. Never hardcoded.
    LotSize(symbol string) (int, error)

    // TickSize returns the minimum price movement for this symbol.
    TickSize(symbol string) (float64, error)

    // MarginRequired returns total margin (SPAN + Exposure) in INR for this order.
    MarginRequired(symbol string, lots int, price float64) (float64, error)

    // OrderProduct returns the correct Zerodha product type.
    // positionType: "intraday" | "overnight"
    OrderProduct(positionType string) string

    // ── Validation ──────────────────────────────────────────────────────

    // ValidateInstrument checks if the symbol is tradeable right now.
    // Returns error if suspended, in circuit, or not found in instruments table.
    ValidateInstrument(symbol string) error

    // ValidateOrder performs segment-specific order validation.
    // Returns error if order cannot be placed (invalid lot size, etc.)
    ValidateOrder(o Order) error

    // PreTradeChecks runs all segment-specific pre-trade guard rules.
    // Returns a slice of violations. Empty slice = all clear.
    // Called at Stage 4 of the rejection pipeline.
    PreTradeChecks(o Order, portfolio Portfolio) []RiskViolation
}
```

---

## Equity Module (NSE_EQ)

```go
// EquityModule implements SegmentModule for NSE cash equity.
type EquityModule struct {
    redis     RedisClient
    calendar  MarketCalendar
}

func (m *EquityModule) Name()    string { return "equity" }
func (m *EquityModule) Segment() string { return "NSE_EQ" }

func (m *EquityModule) MarketOpen(date time.Time) time.Time {
    if !m.IsTradingDay(date) { return time.Time{} }
    return dateAt(date, 9, 15)  // 09:15 IST
}

func (m *EquityModule) MarketClose(date time.Time) time.Time {
    return dateAt(date, 15, 30)  // 15:30 IST
}

func (m *EquityModule) ForcedExitTime() time.Time {
    return todayAt(15, 15)  // 15:15 IST — MIS squareoff
}

func (m *EquityModule) IsExpirable() bool { return false }

func (m *EquityModule) IsExpiryDay(symbol string, date time.Time) bool {
    return false  // equity doesn't expire
}

func (m *EquityModule) HandleExpiry(pos Position) []Order {
    return nil  // equity: nothing to do
}

func (m *EquityModule) OrderProduct(positionType string) string {
    switch positionType {
    case "overnight": return "CNC"   // Cash and Carry — delivery
    default:          return "MIS"   // Margin Intraday Square-off
    }
}
```

### Equity PreTradeChecks

```go
func (m *EquityModule) PreTradeChecks(o Order, portfolio Portfolio) []RiskViolation {
    var violations []RiskViolation
    instr := m.redis.GetInstrument("NSE_EQ", o.Symbol)

    // Check 1: Is symbol suspended?
    if instr.IsSuspended {
        violations = append(violations, RiskViolation{
            Code:    "INSTRUMENT_SUSPENDED",
            Message: fmt.Sprintf("%s is currently suspended from trading", o.Symbol),
            Severity: HARD,  // cannot trade — hard block
        })
        return violations  // no point checking further
    }

    // Check 2: Price band — is the order price within daily limits?
    if instr.PriceBandPct != nil {
        upperBand := instr.LastClose * (1 + *instr.PriceBandPct/100)
        lowerBand := instr.LastClose * (1 - *instr.PriceBandPct/100)
        if o.Price > upperBand || o.Price < lowerBand {
            violations = append(violations, RiskViolation{
                Code:    "ORDER_OUTSIDE_PRICE_BAND",
                Message: fmt.Sprintf("Price %.2f outside band [%.2f, %.2f]",
                    o.Price, lowerBand, upperBand),
                Severity: HARD,
            })
        }
    }

    // Check 3: Corporate action warning (ex-dividend, bonus, split)
    if m.calendar.IsCorporateActionDay(o.Symbol, time.Now()) {
        violations = append(violations, RiskViolation{
            Code:    "CORPORATE_ACTION_DAY",
            Message: "Today is a corporate action date — price may gap",
            Severity: WARNING,  // not a hard block, but logged and alerted
        })
    }

    return violations
}
```

---

## Futures Module (NSE_FNO)

```go
type FuturesModule struct {
    redis    RedisClient
    calendar MarketCalendar
}

func (m *FuturesModule) Name()    string { return "futures" }
func (m *FuturesModule) Segment() string { return "NSE_FNO" }

func (m *FuturesModule) ForcedExitTime() time.Time {
    return todayAt(15, 25)  // 15:25 IST — Zerodha MIS squareoff for F&O
    // Core fires at 15:15 (10 min earlier) to avoid the last-minute rush
    // See RISK_ENGINE_SPEC.md — MIS squareoff goroutine fires at 15:15
}

func (m *FuturesModule) IsExpirable() bool { return true }

func (m *FuturesModule) IsExpiryDay(symbol string, date time.Time) bool {
    instr := m.redis.GetInstrument("NSE_FNO", symbol)
    return instr.ExpiryDate.Truncate(24 * time.Hour).Equal(date.Truncate(24 * time.Hour))
}

func (m *FuturesModule) DaysToExpiry(symbol string) int {
    instr := m.redis.GetInstrument("NSE_FNO", symbol)
    return int(time.Until(instr.ExpiryDate).Hours() / 24)
}

func (m *FuturesModule) HandleExpiry(pos Position) []Order {
    // Force market close order — Core calls this on expiry day
    return []Order{{
        Symbol:      pos.Symbol,
        Direction:   opposite(pos.Direction),
        Quantity:    pos.Quantity,
        OrderType:   "MARKET",
        OrderProduct: "MIS",
        Reason:      "EXPIRY_FORCE_CLOSE",
    }}
}

func (m *FuturesModule) OrderProduct(positionType string) string {
    switch positionType {
    case "overnight": return "NRML"
    default:          return "MIS"
    }
}

func (m *FuturesModule) MarginRequired(symbol string, lots int, price float64) (float64, error) {
    instr := m.redis.GetInstrument("NSE_FNO", symbol)
    if instr == nil { return 0, ErrInstrumentNotFound }
    // SPAN + Exposure margin from instruments table (refreshed intraday)
    // Scaled by lot count
    return (instr.SpanMargin + instr.ExposureMargin) * float64(lots), nil
}
```

### Futures PreTradeChecks

```go
func (m *FuturesModule) PreTradeChecks(o Order, portfolio Portfolio) []RiskViolation {
    var violations []RiskViolation
    instr := m.redis.GetInstrument("NSE_FNO", o.Symbol)

    // Check 1: Expiry day block
    if m.IsExpiryDay(o.Symbol, time.Now()) {
        // Only block if strategy has avoid_expiry_day = true
        // (checked by Core before calling PreTradeChecks — if false, skip)
        violations = append(violations, RiskViolation{
            Code:     "EXPIRY_DAY_BLOCK",
            Message:  fmt.Sprintf("%s expires today — avoid_expiry_day is set", o.Symbol),
            Severity: HARD,
        })
        return violations
    }

    // Check 2: Expiry proximity warning
    daysLeft := m.DaysToExpiry(o.Symbol)
    if daysLeft <= 3 {
        violations = append(violations, RiskViolation{
            Code:     "EXPIRY_APPROACHING",
            Message:  fmt.Sprintf("%s expires in %d days — increased volatility", o.Symbol, daysLeft),
            Severity: WARNING,  // warn, not block — strategy can choose to continue
        })
    }

    // Check 3: OI liquidity check
    if instr.LastOI < OI_MINIMUM_THRESHOLD {
        violations = append(violations, RiskViolation{
            Code:     "LOW_OPEN_INTEREST",
            Message:  fmt.Sprintf("OI %d below minimum threshold %d", instr.LastOI, OI_MINIMUM_THRESHOLD),
            Severity: WARNING,
        })
    }

    return violations
}
```

---

## Commodity Module (MCX)

The most complex module due to physical delivery risk and evening session.

```go
type CommodityModule struct {
    redis    RedisClient
    calendar MarketCalendar
}

func (m *CommodityModule) Name()    string { return "commodity" }
func (m *CommodityModule) Segment() string { return "MCX" }

func (m *CommodityModule) MarketOpen(date time.Time) time.Time {
    if !m.IsTradingDay(date) { return time.Time{} }
    return dateAt(date, 9, 0)   // 09:00 IST (MCX opens before NSE)
}

func (m *CommodityModule) MarketClose(date time.Time) time.Time {
    // MCX standard close: 23:30 IST
    // On holiday-eve: 17:00 IST
    if m.calendar.IsMCXHolidayEve(date) {
        return dateAt(date, 17, 0)
    }
    return dateAt(date, 23, 30)  // 23:30 IST
}

func (m *CommodityModule) ForcedExitTime() time.Time {
    // Exit 30 minutes before MCX close to avoid last-minute volatility
    // Regular day: 23:00 IST
    // Holiday eve: 16:30 IST
    if m.calendar.IsMCXHolidayEve(time.Now()) {
        return todayAt(16, 30)
    }
    return todayAt(23, 0)
}

func (m *CommodityModule) IsExpirable() bool { return true }

func (m *CommodityModule) HandleExpiry(pos Position) []Order {
    // Same as futures — force market close
    return []Order{{
        Symbol:      pos.Symbol,
        Direction:   opposite(pos.Direction),
        Quantity:    pos.Quantity,
        OrderType:   "MARKET",
        OrderProduct: "MIS",
        Reason:      "MCX_EXPIRY_FORCE_CLOSE",
    }}
}

func (m *CommodityModule) OrderProduct(positionType string) string {
    switch positionType {
    case "overnight": return "NRML"
    default:          return "MIS"
    }
}
```

### Commodity PreTradeChecks

Physical delivery block is the most critical rule in the entire system.

```go
func (m *CommodityModule) PreTradeChecks(o Order, portfolio Portfolio) []RiskViolation {
    var violations []RiskViolation
    instr := m.redis.GetInstrument("MCX", o.Symbol)

    // ═══════════════════════════════════════════════════════════════════
    // HARD RULE: Physical Delivery Block — cannot be overridden
    // ═══════════════════════════════════════════════════════════════════
    // If the contract expires in < 3 days, physical delivery is at risk.
    // Gold (1kg bars), Silver (30kg), Copper (1MT) — these are real.
    // Do NOT hold any MCX position into delivery.
    if m.DaysToExpiry(o.Symbol) < 3 {
        violations = append(violations, RiskViolation{
            Code:    "MCX_DELIVERY_BLOCK",
            Message: fmt.Sprintf("%s expires in %d days — physical delivery risk",
                o.Symbol, m.DaysToExpiry(o.Symbol)),
            Severity: HARD_IRREVOCABLE,  // not just HARD — cannot be bypassed by any config
        })
        return violations
    }

    // Existing positions check: if open position in this symbol
    // is within 3 days of expiry → force close (Position Watchdog also handles this)
    for _, pos := range portfolio.OpenPositions {
        if pos.Symbol == o.Symbol && m.DaysToExpiry(o.Symbol) < 3 {
            violations = append(violations, RiskViolation{
                Code:    "MCX_EXISTING_DELIVERY_RISK",
                Message: "Existing position approaching delivery — close before entering new trade",
                Severity: HARD_IRREVOCABLE,
            })
        }
    }

    // Check: MCX session — are we within valid trading hours?
    if !m.IsMarketOpen() {
        violations = append(violations, RiskViolation{
            Code:    "MCX_MARKET_CLOSED",
            Message: "MCX is not in a trading session right now",
            Severity: HARD,
        })
    }

    // Warning: USD-denominated commodities with large INR move
    if m.isUSDDenominated(o.Symbol) {
        inrMove := m.redis.GetIntraDayINRMove()
        if inrMove > 1.0 {  // > 1% INR move intraday
            violations = append(violations, RiskViolation{
                Code:    "USD_INR_EXPOSURE_WARNING",
                Message: fmt.Sprintf("INR has moved %.2f%% intraday — affects %s P&L", inrMove, o.Symbol),
                Severity: WARNING,
            })
        }
    }

    return violations
}

// isUSDDenominated returns true for Crude Oil and Natural Gas
// (priced in USD, P&L in INR — currency exposure)
func (m *CommodityModule) isUSDDenominated(symbol string) bool {
    return symbol == "CRUDEOIL-I" || symbol == "NATURALGAS-I"
}
```

---

## Options Module (NSE_FNO — Phase 2 Scaffold)

```go
// OptionsModule is a Phase 2 placeholder.
// All methods return ErrNotImplemented.
// Activated when options.enabled = true in config.
// Core will panic on startup if options.enabled = true — Phase 2 only.
type OptionsModule struct{}

func (m *OptionsModule) Name()    string { return "options" }
func (m *OptionsModule) Segment() string { return "NSE_FNO_OPT" }

// Every method returns ErrPhase2NotImplemented
// This ensures that if options are accidentally enabled,
// the error is loud and immediate — not silent.

var ErrPhase2NotImplemented = errors.New(
    "options module is Phase 2 — not implemented. " +
    "Set options.enabled = false in config")

func (m *OptionsModule) LotSize(symbol string) (int, error) {
    return 0, ErrPhase2NotImplemented
}
// ... all interface methods similarly

// Why scaffold at all?
// The Go interface requires all methods to be implemented for the type
// to satisfy the interface. Scaffolding ensures the codebase compiles
// and that the interface contract is stable for Phase 2 development.
// When Phase 2 begins: implement methods one by one, remove ErrPhase2NotImplemented.
```

---

## Module Registration

At Core startup, modules are loaded based on config.

```go
func LoadSegmentModules(cfg Config, redis RedisClient, calendar MarketCalendar) map[string]SegmentModule {
    modules := make(map[string]SegmentModule)

    for _, seg := range cfg.EnabledSegments {
        switch seg {
        case "equity":
            modules["NSE_EQ"] = &EquityModule{redis: redis, calendar: calendar}

        case "futures":
            modules["NSE_FNO"] = &FuturesModule{redis: redis, calendar: calendar}

        case "commodity":
            modules["MCX"] = &CommodityModule{redis: redis, calendar: calendar}

        case "options":
            // Guard: reject at startup if options are not yet implemented
            log.Fatal("options module is Phase 2 — set options.enabled = false")

        default:
            log.Fatalf("unknown segment: %s", seg)
        }
    }

    return modules  // Core stores this map, calls via interface on each order
}
```

---

## RiskViolation Severity Levels

```go
type ViolationSeverity int

const (
    WARNING           ViolationSeverity = iota  // log + alert, do not block
    SOFT                                        // can be overridden by operator with justification
    HARD                                        // blocks trade, no override possible via API
    HARD_IRREVOCABLE                            // blocks trade, no config can disable this rule
                                                // used ONLY for: MCX delivery block
)
```

Rules by severity:
- `WARNING`: logged, Telegram alert sent, trade proceeds
- `SOFT`: blocks trade, Core logs. (Reserved — not used in Phase 1. All Phase 1 rules are HARD or WARNING)
- `HARD`: blocks trade. No API endpoint or config can bypass this
- `HARD_IRREVOCABLE`: blocks trade, code-level enforcement. Even if someone edits config to disable it, the module ignores the config

---

## Module Feature Matrix

| Feature | Equity | Futures | Commodity | Options |
|---|---|---|---|---|
| Market hours | 09:15–15:30 | 09:15–15:30 | 09:00–23:30 | Phase 2 |
| Forced exit time | 15:15 MIS | 15:25 MIS | 23:00 MIS | Phase 2 |
| Expires | No | Yes | Yes | Phase 2 |
| Roll detection | No | Via OI (CONTINUOUS_CONTRACTS_SPEC) | Via OI | Phase 2 |
| SPAN margin | No (cash market) | Yes | Yes | Phase 2 |
| Circuit breaker | Yes | No | No | Phase 2 |
| Price band | Yes | No | No | Phase 2 |
| Delivery block | No | No (cash settled) | HARD_IRREVOCABLE | Phase 2 |
| Physical delivery | No | No | Yes (Gold, Silver, Copper) | No |
| USD exposure | No | No | Yes (Crude, NatGas) | Phase 2 |
| CNC product | Yes (overnight) | No | No | Phase 2 |
| OI monitoring | No | Yes (liquidity check) | Yes | Phase 2 |
| Evening session | No | No | Yes (17:00–23:30) | No |

---

## Redis Instruments Schema

```
Key pattern:   instruments:{SEGMENT}:{SYMBOL}
Example:       instruments:NSE_FNO:NIFTY-I
               instruments:NSE_EQ:RELIANCE
               instruments:MCX:GOLD-I

Fields (per instrument):
  symbol              string    TrueData symbol
  exchange_symbol     string    NSE/MCX native symbol (for order placement)
  lot_size            int
  tick_size           float64
  span_margin         float64   INR per lot (NSE_FNO + MCX only)
  exposure_margin     float64   INR per lot (NSE_FNO + MCX only)
  total_margin        float64   span + exposure
  upper_circuit       float64   null for futures/options
  lower_circuit       float64   null for futures/options
  price_band_pct      float64   null for futures
  is_suspended        bool
  expiry_date         date      null for equity
  days_to_expiry      int       -1 for equity
  last_oi             int64     0 for equity
  isin                string    equity only
  corporate_action    string    null | "EX_DIVIDEND" | "BONUS" | "SPLIT"
  refreshed_at        timestamp

TTL: 26 hours
Refresh: 08:30 IST (full), 12:30 IST (margins only)
Alert if stale > 4 hours past expected refresh time
```

---

## Sequencing — How Core Calls a Module

```
1. Tick received for NIFTY-I
   → Dispatcher routes to NIFTY-I symbol engine
   → Symbol engine knows: segment = "NSE_FNO"
   → module = moduleMap["NSE_FNO"]   (SegmentModule interface)

2. Before order:
   → module.ValidateInstrument("NIFTY-I")
   → module.LotSize("NIFTY-I")          → 25
   → module.MarginRequired("NIFTY-I", 1, 19503.5) → ₹1,68,750
   → module.OrderProduct("intraday")    → "MIS"
   → module.PreTradeChecks(order, portfolio) → []violations

3. On expiry:
   → module.IsExpiryDay("NIFTY-I", today) → true
   → module.HandleExpiry(position) → [close order]

4. On forced exit time:
   → module.ForcedExitTime() → 15:25 IST
   → Core squareoff goroutine fires close orders for all MIS positions
```

---

*See INDIA_MARKETS_SPEC.md for detailed market rules per segment.*
*See INGESTION_PIPELINE_SPEC.md for how instruments data is refreshed.*
*See CONTINUOUS_CONTRACTS_SPEC.md for roll handling (separate from segment modules).*
