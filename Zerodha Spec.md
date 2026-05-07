# Zerodha Kite Connect Integration Specification

This document defines how our system integrates with Zerodha Kite Connect v3 for order execution, position tracking, and margin monitoring. Based directly on the official Kite Connect v3 documentation.

**Implementation language:** Go — using the official `gokiteconnect` SDK.

-----

## 1. Account Setup

### 1.1 Switching to Kite Connect

A regular Zerodha retail account has no API access. Enroll at the developer portal.

**Steps:**

1. Visit [developers.kite.trade](https://developers.kite.trade) and sign up
1. Create a new app → select **“Personal”**
1. Set redirect URL → use `http://127.0.0.1:8765/callback` for local automation
1. Submit → approved instantly for personal apps
1. Note your `api_key` and `api_secret`

**Pricing (official):**

|Plan       |Cost          |Includes                                                       |
|-----------|--------------|---------------------------------------------------------------|
|Personal   |Free          |Orders, GTT, alerts, margin, portfolio                         |
|**Connect**|**₹500/month**|Personal + **WebSocket streaming** + **Historical candle data**|

We need **Connect (₹500/month)** — WebSocket is required for live order status updates. Billed from your Zerodha account automatically.

### 1.2 TOTP Setup

For automation you need the raw **TOTP secret key**, not just the QR code.

**How to get it:**

1. Kite → My Profile → Account Security → Two Factor Authentication
1. When enabling (or re-enabling) TOTP, Zerodha shows a 32-character secret key
1. **Save immediately to Google Secret Manager — shown only once**
1. If TOTP already enabled without the secret: disable and re-enable to retrieve it

**Credentials to store in Secret Manager:**

```
zerodha/api_key       → your API key
zerodha/api_secret    → your API secret
zerodha/totp_secret   → 32-char TOTP key
zerodha/user_id       → Zerodha user ID (e.g. AB1234)
zerodha/password      → Kite login password
```

-----

## 2. SDK

Use the official Go SDK. Do not make raw HTTP calls — the SDK handles auth headers, serialisation, and error types.

```bash
go get github.com/zerodha/gokiteconnect/v4
```

**Official SDKs across languages:**

|Language                           |Repo                                                                           |
|-----------------------------------|-------------------------------------------------------------------------------|
|**Go**                             |[github.com/zerodha/gokiteconnect](https://github.com/zerodha/gokiteconnect)   |
|Python                             |[github.com/zerodha/pykiteconnect](https://github.com/zerodha/pykiteconnect)   |
|Node.js, Java, .NET, PHP, Rust, C++|See [kite.trade/docs/connect/v3/sdks](https://kite.trade/docs/connect/v3/sdks/)|

The Live Executor is Go — use `gokiteconnect`. No other service should hold Zerodha credentials or call Zerodha directly.

-----

## 3. Authentication

### 3.1 Login Flow

Kite Connect uses a **redirect-based flow**. For automation we simulate it with an HTTP client.

```
1. Navigate to login URL (automated browser / HTTP simulation):
   https://kite.zerodha.com/connect/login?v=3&api_key=YOUR_API_KEY

2. After login + TOTP, Zerodha redirects to your redirect URL:
   http://127.0.0.1:8765/callback?request_token=XXXX&action=login&status=success

3. Extract request_token from the redirect URL query params

4. POST to /session/token:
   api_key       = your api key
   request_token = one-time token from step 2
   checksum      = SHA-256(api_key + request_token + api_secret)

5. Response contains access_token
   → Expires at 6:00 AM IST the next day (regulatory requirement)

6. Store in Secret Manager + Redis
   Redis: SET zerodha:access_token <token> EX 72000   (20-hour TTL)
```

### 3.2 TOTP Automation in Go

```go
package auth

import (
    "crypto/sha256"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "net/http/cookiejar"
    "net/url"
    "time"

    "github.com/pquerna/otp/totp"
    kiteconnect "github.com/zerodha/gokiteconnect/v4"
)

// go get github.com/pquerna/otp

type Credentials struct {
    APIKey     string
    APISecret  string
    UserID     string
    Password   string
    TOTPSecret string
}

func GetAccessToken(creds Credentials) (string, error) {
    jar, _ := cookiejar.New(nil)
    client := &http.Client{
        Jar: jar,
        CheckRedirect: func(req *http.Request, via []*http.Request) error {
            return http.ErrUseLastResponse // capture redirect, don't follow
        },
    }

    // Step 1: POST credentials
    resp, err := client.PostForm("https://kite.zerodha.com/api/login", url.Values{
        "user_id":  {creds.UserID},
        "password": {creds.Password},
    })
    if err != nil {
        return "", fmt.Errorf("login failed: %w", err)
    }
    defer resp.Body.Close()

    body, _ := io.ReadAll(resp.Body)
    var loginResp struct {
        Data struct {
            RequestID string `json:"request_id"`
        } `json:"data"`
    }
    if err := json.Unmarshal(body, &loginResp); err != nil {
        return "", fmt.Errorf("login response parse failed: %w", err)
    }

    // Step 2: POST TOTP
    totpCode, err := totp.GenerateCode(creds.TOTPSecret, time.Now())
    if err != nil {
        return "", fmt.Errorf("TOTP generation failed: %w", err)
    }

    resp2, err := client.PostForm("https://kite.zerodha.com/api/twofa", url.Values{
        "request_id":  {loginResp.Data.RequestID},
        "twofa_value": {totpCode},
        "twofa_type":  {"totp"},
    })
    if err != nil {
        return "", fmt.Errorf("TOTP verification failed: %w", err)
    }
    defer resp2.Body.Close()

    // Step 3: Extract request_token from redirect Location header
    location := resp2.Header.Get("Location")
    if location == "" {
        return "", fmt.Errorf("no redirect location after TOTP — login may have failed")
    }
    parsedURL, err := url.Parse(location)
    if err != nil {
        return "", fmt.Errorf("redirect URL parse failed: %w", err)
    }
    requestToken := parsedURL.Query().Get("request_token")
    if requestToken == "" {
        return "", fmt.Errorf("request_token missing from redirect URL")
    }

    // Step 4: Exchange for access_token using SDK
    kc := kiteconnect.New(creds.APIKey)
    session, err := kc.GenerateSession(requestToken, creds.APISecret)
    if err != nil {
        return "", fmt.Errorf("session generation failed: %w", err)
    }

    return session.AccessToken, nil
}
```

**TOTP retry note:** TOTP codes are valid for 30 seconds. If verification fails at a window boundary, retry once with a fresh `totp.GenerateCode()`. Do not retry login more than twice — Zerodha may lock the account.

### 3.3 Signing Requests

Set the access token on the SDK client once. The SDK attaches `Authorization: token api_key:access_token` to every request automatically.

```go
kc := kiteconnect.New(apiKey)
kc.SetAccessToken(accessToken)
// All subsequent kc.XYZ() calls are authenticated
```

### 3.4 Daily Token Refresh

Token expires at **6:00 AM IST**. Refresh at **08:00 IST** daily.

```
08:00 IST — Cloud Scheduler triggers refresh job
  1. Read credentials from Google Secret Manager
  2. Run GetAccessToken() → new access_token
  3. Write to Secret Manager (overwrite previous)
  4. Write to Redis: SET zerodha:access_token <token> EX 72000
  5. Metric: zerodha_token_refresh_success = 1
  6. Alert on any failure → halt trading for the day
```

-----

## 4. Constants

### Order Varieties

|Value    |Description                       |Our Usage              |
|---------|----------------------------------|-----------------------|
|`regular`|Standard exchange order           |All entries and exits  |
|`amo`    |After Market Order                |Not used initially     |
|`co`     |Cover Order (entry + mandatory SL)|Future optimisation    |
|`iceberg`|Auto-split for large orders       |Not needed at our scale|
|`auction`|Exchange auction                  |Not used               |

### Product Types

|Value |Applies To      |Behaviour                                                                  |
|------|----------------|---------------------------------------------------------------------------|
|`CNC` |NSE Equity only |Delivery (T+1). No auto-squareoff. Full capital required.                  |
|`MIS` |NSE EQ, NFO, MCX|Intraday. Auto-squared off before market close (see below). Reduced margin.|
|`NRML`|NFO, MCX        |Overnight. Carries forward. Full SPAN + Exposure margin.                   |
|`MTF` |NSE Equity      |Margin Trading Facility. **Not used in our system.**                       |

**MIS auto-squareoff times:**

|Segment          |Squareoff Time|
|-----------------|--------------|
|NSE Equity MIS   |15:15 IST     |
|NSE F&O MIS      |15:20 IST     |
|MCX MIS (morning)|16:55 IST     |
|MCX MIS (evening)|23:25 IST     |

### Order Types

|Value   |Description                                                |
|--------|-----------------------------------------------------------|
|`MARKET`|Fill at best available price immediately                   |
|`LIMIT` |Fill at specified price or better                          |
|`SL`    |Stop-Loss Limit — triggers a LIMIT order at trigger_price  |
|`SL-M`  |Stop-Loss Market — triggers a MARKET order at trigger_price|

### Order Validity

|Value|Description                               |
|-----|------------------------------------------|
|`DAY`|Valid for the trading day                 |
|`IOC`|Immediate or Cancel                       |
|`TTL`|Valid for N minutes (`validity_ttl` param)|

-----

## 5. Product Type Decision Rules

```
NSE Equity:
  delivery strategy  → CNC
  intraday strategy  → MIS

NSE F&O / MCX:
  intraday strategy       → MIS
  swing / positional      → NRML
  DEFAULT (any doubt)     → NRML
```

**The rule is simple:** Default to NRML for all derivatives. Only use MIS if the strategy definition explicitly declares itself intraday. An unexpected MIS squareoff is an execution failure; missing an overnight hold is a strategy miss — these are not equivalent, but both are avoidable.

-----

## 6. Placing Orders

### 6.1 Go SDK Example

```go
import kiteconnect "github.com/zerodha/gokiteconnect/v4"

// NRML LIMIT buy — Nifty front-month futures
orderID, err := kc.PlaceOrder(kiteconnect.VARIETY_REGULAR, kiteconnect.OrderParams{
    Exchange:        "NFO",
    Tradingsymbol:   "NIFTY25MAYFUT",    // Zerodha symbol, not TrueData NIFTY-I
    TransactionType: kiteconnect.TRANSACTION_TYPE_BUY,
    Quantity:        25,                  // 1 lot = 25 units
    Product:         kiteconnect.PRODUCT_NRML,
    OrderType:       kiteconnect.ORDER_TYPE_LIMIT,
    Price:           24350.0,
    Validity:        kiteconnect.VALIDITY_DAY,
    Tag:             "strat001_entry",    // max 20 alphanumeric chars
})
if err != nil {
    // SDK returns typed error — check error type
    if kiteErr, ok := err.(kiteconnect.Error); ok {
        log.Printf("order rejected: %s — %s", kiteErr.Code, kiteErr.Message)
    }
}
```

### 6.2 Order Parameters

|Parameter          |Notes                                                                                             |
|-------------------|--------------------------------------------------------------------------------------------------|
|`tradingsymbol`    |Zerodha exchange symbol — must map from TrueData symbol daily                                     |
|`exchange`         |NSE, NFO, MCX                                                                                     |
|`quantity`         |Must be multiple of lot_size for derivatives                                                      |
|`product`          |CNC / MIS / NRML                                                                                  |
|`price`            |0 for MARKET orders                                                                               |
|`trigger_price`    |Required for SL and SL-M                                                                          |
|`tag`              |Max 20 alphanumeric chars. Use strategy ID for audit trail                                        |
|`market_protection`|% cap for MARKET/SL-M fills. `-1` = auto, `0` = none, `1–100` = custom. **Set 2 for SL-M orders.**|
|`autoslice`        |`true` splits orders exceeding exchange freeze limits (max 10 slices). Returns array of order_ids.|

### 6.3 Symbol Mapping: TrueData → Zerodha

Strategy signals use TrueData continuous symbols (`NIFTY-I`). Orders require the actual contract (`NIFTY25MAYFUT`).

```go
type SymbolMapper struct {
    mu      sync.RWMutex
    mapping map[string]ZerodhaInstrument  // truedata_symbol → {tradingsymbol, lot_size, tick_size}
}

// Rebuilt daily at 08:30 from:
// 1. continuous_contracts.active_contract in our DB
// 2. kc.GetInstruments("NFO") and kc.GetInstruments("MCX")
```

Refresh this mapping on every roll event, not just daily.

### 6.4 Pre-Trade Checks

```go
func (e *Executor) preTrade(order OrderRequest) error {
    // 1. Kill switch
    if e.redis.Exists("executor:kill_switch") {
        return ErrKillSwitch
    }
    // 2. Daily order count (Zerodha hard cap: 5000/day)
    if e.dailyOrderCount >= 4900 {
        return ErrDailyOrderLimitApproaching
    }
    // 3. Lot size
    if order.IsDerivative() && order.Qty%order.LotSize != 0 {
        return ErrInvalidLotSize
    }
    // 4. Margin
    required := e.calcMargin(order)
    available := e.getMargin(order.Segment)
    if required > available*0.80 {
        return ErrInsufficientMargin
    }
    // 5. Daily P&L
    if e.todayPnL < e.dailyLossLimit {
        return ErrDailyLossLimitHit
    }
    return nil
}
```

-----

## 7. Order Status Lifecycle

```
PUT ORDER REQ RECEIVED
        ↓
VALIDATION PENDING   (RMS risk checks)
        ↓
OPEN PENDING         (being sent to exchange)
        ↓
OPEN                 (live at exchange, waiting to fill)
        ↓
COMPLETE / REJECTED / CANCELLED
```

For SL/SL-M orders, state is `TRIGGER PENDING` until trigger_price is hit.

`COMPLETE` on `PlaceOrder()` response means the OMS accepted the request — **not that it filled**. Always track actual status via WebSocket.

-----

## 8. Stop Losses

### 8.1 Exchange SL-M (Intraday MIS positions)

```go
kc.PlaceOrder(kiteconnect.VARIETY_REGULAR, kiteconnect.OrderParams{
    Exchange:         "NFO",
    Tradingsymbol:    "NIFTY25MAYFUT",
    TransactionType:  kiteconnect.TRANSACTION_TYPE_SELL,
    Quantity:         25,
    Product:          kiteconnect.PRODUCT_MIS,
    OrderType:        kiteconnect.ORDER_TYPE_SLM,
    TriggerPrice:     24000.0,
    Validity:         kiteconnect.VALIDITY_DAY,
    MarketProtection: 2,      // fill within 2% of trigger — avoids extreme slippage
    Tag:              "strat001_sl",
})
```

Exchange SL orders expire at end of day. **Never use for overnight NRML positions.**

### 8.2 GTT Orders (Overnight NRML positions)

GTT persists across days. Zerodha monitors price server-side and fires a regular order on trigger. Not a true exchange order — small execution delay possible in fast markets.

```go
// OCO: fires stop-loss OR target, cancels the other
gttID, err := kc.PlaceGTT(kiteconnect.GTTParams{
    TriggerType:   kiteconnect.GTTTypeOCO,
    Tradingsymbol: "NIFTY25MAYFUT",
    Exchange:      "NFO",
    LastPrice:     24350.0,          // current market price — required by Zerodha
    TriggerValues: []float64{24000.0, 24700.0},  // [stop_loss, target]
    Orders: []kiteconnect.GTTOrderParams{
        {   // stop loss leg
            Exchange: "NFO", Tradingsymbol: "NIFTY25MAYFUT",
            TransactionType: "SELL", Quantity: 25,
            Product: "NRML", OrderType: "LIMIT", Price: 23990.0,
        },
        {   // target leg
            Exchange: "NFO", Tradingsymbol: "NIFTY25MAYFUT",
            TransactionType: "SELL", Quantity: 25,
            Product: "NRML", OrderType: "LIMIT", Price: 24690.0,
        },
    },
})
```

### 8.3 Stop-Loss Policy

```
MIS intraday:
  → Place exchange SL-M immediately after fill confirmation
  → market_protection: 2
  → Cancel SL on normal exit

NRML overnight:
  → Place GTT OCO immediately after fill confirmation
  → Hard rule: no NRML position exists without a GTT
  → Cancel GTT when position closed by any other means

Kill switch:
  → Cancel ALL open orders (SL + GTT)
  → MARKET exit all open positions immediately
```

-----

## 9. Order Monitoring via WebSocket

For individual developer accounts, Zerodha **recommends WebSocket for order postbacks** over HTTP webhooks. The WebSocket delivers all order updates regardless of how the order was placed (web, mobile, API).

```go
import "github.com/zerodha/gokiteconnect/v4/ticker"

tick := ticker.New(apiKey, accessToken)

// Order status updates
tick.OnOrderUpdate(func(order kiteconnect.Order) {
    switch order.Status {
    case "COMPLETE":
        e.handleFill(order)       // update positions, place GTT
    case "REJECTED":
        e.handleRejection(order)  // log, alert, investigate
    case "CANCELLED":
        e.handleCancelled(order)  // log
    case "UPDATE":
        e.handlePartialFill(order) // partial fill or modification
    }
})

// Optional: live quotes for position marking
// Note: TrueData is used for strategy signals — Kite Ticker here is only for
// real-time P&L marking and order status
tick.OnTick(func(ticks []ticker.Tick) {
    e.markPositions(ticks)
})

tick.OnError(func(err error) {
    log.Printf("ticker error: %v", err)
    // reconnect with backoff
})

tick.Serve()
```

**WebSocket endpoint:** `wss://ws.kite.trade`

Use `GET /orders` polling every 30 seconds as fallback when WebSocket is disconnected.

-----

## 10. Margin

### 10.1 Available Margin

```go
margins, err := kc.GetUserMargins()

// equity = NSE Equity + NSE F&O (same pool)
equityFree := margins.Equity.Available.LiveBalance
equitySpan := margins.Equity.Utilised.Span
equityExp  := margins.Equity.Utilised.Exposure

// commodity = MCX (completely separate pool)
commodityFree := margins.Commodity.Available.LiveBalance
```

**NSE EQ and NFO share the same margin pool. MCX is separate.** You cannot use commodity margin for F&O positions or vice versa.

### 10.2 Pre-Trade Margin Calculator

```go
marginResult, err := kc.GetOrderMargins([]kiteconnect.OrderMarginParams{
    {
        Exchange:        "NFO",
        Tradingsymbol:   "NIFTY25MAYFUT",
        TransactionType: "BUY",
        Variety:         "regular",
        Product:         "NRML",
        OrderType:       "LIMIT",
        Quantity:        25,
        Price:           24350.0,
    },
})
// marginResult[0].Total = SPAN + Exposure required
// Compare against available * 0.80 before placing
```

-----

## 11. Rate Limits

|Endpoint                   |Limit                                       |
|---------------------------|--------------------------------------------|
|Market quotes              |1 req/second                                |
|Historical candle          |3 req/second                                |
|Order placement            |10 req/second                               |
|All other endpoints        |10 req/second                               |
|**Orders per minute**      |**400 hard cap**                            |
|**Orders per day**         |**5,000 hard cap (all segments combined)**  |
|**Modifications per order**|**25 max — after that, cancel and re-place**|

At our scale (~50 orders/day across 3–5 strategies), none of these limits are relevant. Documented for future scaling awareness.

**Rate limiter in Go:**

```go
import "golang.org/x/time/rate"

// 10/second burst, refill 10/second
orderLimiter := rate.NewLimiter(10, 10)

func (e *Executor) placeOrder(params kiteconnect.OrderParams) (string, error) {
    ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
    defer cancel()
    if err := orderLimiter.Wait(ctx); err != nil {
        return "", fmt.Errorf("rate limit exceeded: %w", err)
    }
    return e.kc.PlaceOrder(kiteconnect.VARIETY_REGULAR, params)
}
```

-----

## 12. Error Handling

### 12.1 Error Types

|Type              |HTTP Code|Meaning                       |Response                               |
|------------------|---------|------------------------------|---------------------------------------|
|`TokenException`  |403      |Token expired or invalidated  |Refresh token immediately, retry once  |
|`UserException`   |4xx      |Account error                 |Log, alert, no retry                   |
|`OrderException`  |4xx      |Order placement/fetch failure |Log, fix params if possible, retry once|
|`InputException`  |400      |Bad request parameters        |Log, investigate, no retry             |
|`MarginException` |4xx      |Insufficient margin           |Pre-trade check should prevent this    |
|`HoldingException`|4xx      |Insufficient holdings for sell|Check position state                   |
|`NetworkException`|5xx      |API can’t reach OMS           |Retry 3× with exponential backoff      |
|`DataException`   |5xx      |OMS response parse failure    |Log, alert, manual review              |
|`GeneralException`|5xx      |Unclassified                  |Log, alert, manual review              |

### 12.2 HTTP Status Codes

|Code|Meaning                            |
|----|-----------------------------------|
|400 |Bad parameters                     |
|403 |Session expired — re-login required|
|429 |Rate limited — back off immediately|
|502 |OMS is down                        |
|503 |API is down                        |
|504 |Gateway timeout                    |

### 12.3 Common Rejection Messages

|`status_message` contains              |Cause                                                           |
|---------------------------------------|----------------------------------------------------------------|
|`Insufficient funds` / `Margin Exceeds`|Margin too low — pre-trade check should catch                   |
|`circuit`                              |Symbol hit circuit breaker — wait                               |
|`freeze`                               |Qty exceeds exchange freeze limit — use `autoslice: true`       |
|`Outside market hours`                 |Exchange closed — use AMO or wait                               |
|`RMS:` prefix                          |Risk Management System rejection — log full `status_message_raw`|

-----

## 13. Postback Verification

HTTP postback is for multi-user platforms. For us, WebSocket is primary. Still configure postback URL as fallback.

**Checksum formula (from official docs):**

```go
func verifyPostback(orderID, orderTimestamp, apiSecret, received string) bool {
    h := sha256.New()
    h.Write([]byte(orderID + orderTimestamp + apiSecret))
    computed := fmt.Sprintf("%x", h.Sum(nil))
    return computed == received
}
```

> Checksum = SHA-256(`order_id` + `order_timestamp` + `api_secret`)

Reject any postback where checksum does not match.

-----

## 14. Instrument Master

Download at 08:30 IST daily. Changes every day as contracts expire and new ones list.

```go
nfoInstruments, _ := kc.GetInstruments("NFO")
mcxInstruments, _ := kc.GetInstruments("MCX")

// Key fields per instrument:
// .InstrumentToken  uint32  — for WebSocket subscriptions
// .Tradingsymbol    string  — for order placement
// .Expiry           civil.Date
// .LotSize          float64
// .TickSize         float64
// .InstrumentType   string  — EQ, FUT, CE, PE
```

Build the TrueData → Zerodha symbol map from this master combined with `continuous_contracts.active_contract` in our DB.

-----

## 15. Expiry Day Rules

```
NSE F&O — expiry day:
  14:00 IST  Alert: open position in expiring contract
  15:00 IST  Force close at MARKET if no strategy exit
  Log: EXPIRY_FORCE_CLOSE

MCX (Gold, Silver — physical delivery risk):
  2 days before expiry  Alert
  1 day before expiry   Force close if still open
  Log: MCX_DELIVERY_PROTECTION_CLOSE
```

-----

## 16. Audit Trail

```sql
CREATE TABLE order_audit_log (
    id                BIGSERIAL PRIMARY KEY,
    timestamp         TIMESTAMP DEFAULT NOW(),
    event_type        VARCHAR(50),
    strategy_id       UUID,
    zerodha_order_id  VARCHAR(50),
    tradingsymbol     VARCHAR(50),
    exchange          VARCHAR(10),
    product           VARCHAR(10),
    order_type        VARCHAR(10),
    transaction_type  VARCHAR(10),
    quantity          INTEGER,
    price             DECIMAL(12,2),
    trigger_price     DECIMAL(12,2),
    filled_qty        INTEGER,
    average_price     DECIMAL(12,2),
    status            VARCHAR(30),
    error_type        VARCHAR(50),
    error_message     TEXT,
    raw_request       JSONB,
    raw_response      JSONB,
    INDEX idx_ts       (timestamp DESC),
    INDEX idx_order    (zerodha_order_id),
    INDEX idx_strategy (strategy_id)
);
-- Append-only. No updates, no deletes.
```

-----

## 17. Operational Runbook

|Situation                           |Action                                                                                                                  |
|------------------------------------|------------------------------------------------------------------------------------------------------------------------|
|Token refresh fails at 08:00        |Alert immediately. Max 2 retries (lockout risk). Manual fix: log in via Kite web → paste access_token to Secret Manager.|
|`TokenException` mid-day            |Trigger token refresh. Retry order once. Halt if refresh fails.                                                         |
|`MarginException`                   |Do not retry. Reduce size or close another position first.                                                              |
|Zerodha API 502/503                 |Queue orders. Do not force-retry. Check status.zerodha.com. Alert user.                                                 |
|WebSocket disconnects               |Fall back to `GET /orders` every 30 seconds. Reconnect with exponential backoff.                                        |
|GTT not triggered                   |Check `GET /gtt`. If stale, cancel and re-place.                                                                        |
|Position mismatch (our DB ≠ Zerodha)|Reconciliation job flags this. Alert immediately for live discrepancy.                                                  |
|Expiry day                          |Monitor manually. Hard auto-close at 15:00 is a safety net, not a substitute for active monitoring.                     |

-----

## 18. Cost Reference

|Item                        |Cost                                 |
|----------------------------|-------------------------------------|
|Kite Connect (Connect plan) |**₹500/month**                       |
|Equity delivery (CNC)       |Zero brokerage                       |
|Equity intraday (MIS)       |0.03% or ₹20/order (lower of the two)|
|F&O — NSE (NRML/MIS)        |₹20/order flat                       |
|MCX commodity (NRML/MIS)    |₹20/order flat                       |
|STT + exchange charges + GST|~0.05% per trade (regulatory)        |

-----

*Official SDK: https://github.com/zerodha/gokiteconnect*  
*Official docs: https://kite.trade/docs/connect/v3/*  
*See TRUEDATA_SPEC.md for data feed.*  
*See INDIA_MARKETS_SPEC.md for segment rules and lot sizes.*  
*See PRODUCTS.md for Live Executor product spec.*