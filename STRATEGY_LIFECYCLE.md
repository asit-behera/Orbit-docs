# Strategy Lifecycle

How strategies move from idea to live trading.
Covers template cloning, promotion flow, versioning, rebalancing, and the position state machine.

See STRATEGY_SCHEMA.md for the strategy JSON format.
See SCORING_ENGINE.md for how win rate transfers on promotion.
See EXECUTION_SPEC.md for how strategies lock to positions.

---

## Overview

```
TEMPLATE (read-only, bundled default)
    ↓  clone
DRAFT → BACKTESTED → VALIDATED → PAPER → LIVE_CANDIDATE → LIVE
                                                              ↓
                                                         DEPRECATED
```

Every strategy follows this path. No shortcuts. No direct jumps.
The path exists to protect real capital from unvalidated strategies.

---

## Template System

### What Templates Are

Templates are read-only strategy definitions shipped with the system.
They represent battle-tested, India-market-proven strategy patterns
with sensible default parameters.

```
Properties of a template:
  is_template: true
  status:      "template"  (special status, not part of normal promotion flow)
  owned_by:    "system"
  editable:    false       (any edit attempt returns 403)

Stored in: PostgreSQL strategy_templates table (separate from user strategies)
```

### Cloning a Template

```
POST /strategies/clone/{template_id}

Creates a new strategy in the user's strategy table:
  id:           new UUID
  name:         "{template_name} (copy)"  — user renames
  is_template:  false
  cloned_from:  template_id
  status:       "draft"
  version:      "1.0.0"
  definition:   deep copy of template definition
  parameters:   deep copy (user can now modify freely)

The template is unaffected. User owns their copy entirely.
Multiple clones of the same template are independent.
```

### Template Updates

```
When a bundled template is improved (e.g., better default params after research):
  Template is updated in strategy_templates table.
  Existing user clones are NOT automatically updated.
  User receives a notification: "Template T02 has been updated. View changes?"
  User can manually re-clone if they want the new defaults.
  Their existing strategy is never touched without consent.
```

---

## Promotion Flow

### Status Definitions

```
DRAFT:
  Strategy has been created and saved.
  Not yet backtested. No performance data.
  Can be freely edited (any field, any change).
  Cannot be deployed to paper or live.

BACKTESTED:
  Strategy has at least one passing backtest.
  Passing criteria: Sharpe > 1.0, Max DD < 30%, Trades > 50.
  Parameters are now "suggested" — can still change but triggers re-backtest requirement.
  Cannot be deployed to live directly.

VALIDATED:
  Strategy has passed validation suite.
  Walk-forward degradation < 30%, Monte Carlo robustness MEDIUM+.
  Structural changes (add/remove conditions) require re-validation.
  Parameter changes require re-backtest (back to BACKTESTED).
  Ready for paper trading.

PAPER:
  Strategy is deployed to paper trading.
  Receiving live TrueData ticks. Simulating fills.
  Entry and exit conditions are now locked — no structural changes.
  Parameter-only changes allowed (creates new MINOR version, restarts paper session).
  Win rate accumulating from paper trades — feeds into Scoring Engine.

LIVE_CANDIDATE:
  Paper trading completed successfully.
  Criteria: 2+ weeks paper trading, paper Sharpe within 10% of backtest.
  Requires explicit human sign-off (not automatic).
  Operator reviews paper results and manually promotes.
  No automatic promotion under any circumstances.

LIVE:
  Real money trading active.
  Structural changes: BLOCKED (create new version instead).
  Parameter changes: PATCH changes allowed while running (see Versioning).
  MINOR/MAJOR changes: require new version, old version runs to completion.

DEPRECATED:
  Strategy has been superseded by a newer version or manually retired.
  No new signals generated.
  Any open positions run to their natural exit.
  Read-only. Historical data preserved forever.
```

### Promotion API

```
POST /strategies/{id}/promote

Validates current status before allowing promotion:

  DRAFT → BACKTESTED:
    Requires: backtest_results present AND Sharpe >= 1.0 AND trades >= 50
    If not met: returns 400 with specific reason

  BACKTESTED → VALIDATED:
    Requires: validation_results present AND walk_forward_status != FAIL
    If not met: returns 400

  VALIDATED → PAPER:
    Requires: validated_at within last 90 days (stale validation check)
    Action: deploys to Paper Trader, starts paper session, records paper_started_at

  PAPER → LIVE_CANDIDATE:
    Requires: paper_session_days >= 14 AND paper_sharpe_vs_backtest_diff_pct <= 20
    Returns 200 with summary: "Paper trading passed. Review and promote to live."

  LIVE_CANDIDATE → LIVE:
    Requires: explicit acknowledgement in request body:
      { "acknowledge": true, "risk_accepted": true, "capital_inr": 500000 }
    Action: activates live execution, notifies Zerodha executor
    This is the only promotion that requires explicit acknowledgement.

Backward promotion (LIVE → PAPER):
    Allowed only if no open positions.
    Useful for: strategy degraded, want to re-validate before continuing live.
```

### Demotion

```
Any strategy can be DEMOTED (moved backward) with justification.

POST /strategies/{id}/demote
{ "reason": "Paper results diverging from backtest" }

Rules:
  LIVE → LIVE_CANDIDATE: allowed only with zero open positions
  LIVE → DEPRECATED:     closes all positions at market first, then demotes
  Any status → DEPRECATED: always allowed, closes positions if live

Demotion is logged permanently in strategy audit trail.
```

---

## Semantic Versioning

### Version Format: MAJOR.MINOR.PATCH

```
PATCH bump (1.0.0 → 1.0.1):
  What changes:   Non-structural params that are optimizable: false
                  Examples: take_profit_pct, stop_loss_pct, trade_window times
  Allowed when:   Strategy is LIVE with open positions
  Effect:         Takes effect immediately on next bar evaluation
  Backtest:       Not required
  Paper reset:    No
  Example:        Tighten take profit from 2.0% to 1.8%

MINOR bump (1.0.0 → 1.1.0):
  What changes:   Optimizable parameter values
                  Examples: rsi_period 14→12, sma_period 50→20
  Allowed when:   Strategy has ZERO open positions
  Effect:         Requires fresh paper run before re-promoting to live
  Backtest:       Recommended (not enforced)
  Paper reset:    Yes — new paper session starts at v1.1.0
  Example:        Change RSI period from 14 to 10

MAJOR bump (1.0.0 → 2.0.0):
  What changes:   Structural changes
                  Add or remove conditions, change AND↔SCORE mode,
                  change symbol or timeframe, change strategy_type
  Allowed when:   Always — creates a NEW strategy entry
  Effect:         Old version continues running until positions close naturally
                  New version starts fresh at DRAFT status
  Backtest:       Required
  Paper reset:    Full — new strategy, must complete full promotion flow
  Example:        Add a MACD condition to the entry

Rules:
  Version bumps are irreversible (no rollback to lower version number).
  Open positions always run under the version that created them.
  Version is stored on the position record at entry time.
  position.strategy_version is immutable after position opens.
```

### Version Enforcement in Core

```
Core's StrategyRegistry stores strategies by id:version composite key.
When a new version is loaded:
  → New version added to registry
  → Old version marked inactive (no new entries)
  → Old version NOT removed (open positions may still need its exit rules)
  → Old version removed only when it has zero open positions and is DEPRECATED
```

---

## Rebalancing (Changing a Running Strategy)

### Scenario: You Want to Adjust a LIVE Strategy

```
Current: strat_nifty_mean_rev v1.0.0 — LIVE, 1 open position

You want to change RSI period from 14 to 12.
This is a MINOR change (optimizable parameter).

Option 1 — Wait for natural exit:
  System: "MINOR changes require zero open positions."
  You:    Wait for current position to close.
  After close: bump to v1.1.0
  v1.1.0 goes to PAPER for new paper session
  Re-promote to LIVE after paper validation

Option 2 — Create parallel version:
  Bump to v1.1.0 (new version, status = DRAFT)
  v1.0.0 continues running, handles existing position exit
  v1.1.0 starts fresh paper session simultaneously
  When v1.0.0 position closes and v1.1.0 passes paper:
    Deprecate v1.0.0
    Promote v1.1.0 to LIVE

Option 2 is preferred — no gap in live trading coverage.

You want to change take_profit_pct from 2.0% to 1.8%.
This is a PATCH change (optimizable: false parameter).

Allowed immediately, even with open position.
Takes effect on next bar evaluation.
Existing open position uses new take_profit_pct immediately.
Log: PATCH_APPLIED {version: "1.0.1", changed: "take_profit_pct: 2.0 → 1.8"}
```

### Version History Storage

```json
{
  "strategy_id": "strat_nifty_mean_rev",
  "versions": [
    {
      "version": "1.0.0",
      "status": "deprecated",
      "created_at": "2026-03-01T10:00:00+05:30",
      "deprecated_at": "2026-04-15T18:00:00+05:30",
      "reason": "Superseded by v1.1.0 (rsi_period change)"
    },
    {
      "version": "1.0.1",
      "status": "deprecated",
      "created_at": "2026-03-15T14:00:00+05:30",
      "deprecated_at": "2026-03-20T10:00:00+05:30",
      "reason": "Patch: take_profit_pct 2.0 → 1.8"
    },
    {
      "version": "1.1.0",
      "status": "live",
      "created_at": "2026-04-01T09:00:00+05:30",
      "promoted_live_at": "2026-04-15T18:00:00+05:30"
    }
  ],
  "active_version": "1.1.0"
}
```

---

## Position State Machine

Each symbol engine operates in one of three states.

```
┌─────────┐   Signal + Score pass      ┌──────────────────┐
│  IDLE   │ ─── + Risk check pass ───▶ │  WAITING_FOR_FILL │
└─────────┘                             └────────┬─────────┘
     ▲                                           │
     │         Fill confirmed                    │  Broker rejects
     │         (events.order_results)            │  or timeout
     │                                           ▼
     │                                   ┌──────────────┐
     │    Exit rule fires                │ POSITION_OPEN │
     └──────────────────────────────────│              │
                                         └──────────────┘
```

### IDLE State

```
What happens:
  - All active strategies evaluated on every bar close
  - Composite scores calculated for all that signal
  - Winner selected if above min_composite_threshold
  - Risk checks run
  - If all pass: OrderIntent emitted, state → WAITING_FOR_FILL

What does NOT happen:
  - No exit rule evaluation (nothing to exit)
  - No position monitoring
```

### WAITING_FOR_FILL State

```
What happens:
  - Waiting for events.order_results from Executor Consumer
  - Tick processing continues (candle buffer updating)
  - No new entry signals generated (one order pending)

On fill confirmed:
  - Position opened in Redis
  - locked_strategy = strategy that generated the signal (id + version)
  - State → POSITION_OPEN

On fill rejected / timeout:
  - Rejection logged
  - State → IDLE (try again on next bar)

Timeout: if no order_result received within 60 seconds:
  - Log: FILL_TIMEOUT
  - State → IDLE
  - The Executor Consumer handles actual cancellation at broker
```

### POSITION_OPEN State

```
What happens:
  - ONLY locked_strategy's exit rules evaluated on each bar close
  - All other strategies: skipped entirely for this symbol
  - Position P&L tracked in Redis

What does NOT happen:
  - No entry signal evaluation for ANY strategy
  - No composite scoring
  - No risk check for entries (only exit monitoring)

On exit rule fires:
  - OrderIntent emitted (SELL / BUY_TO_CLOSE)
  - State → WAITING_FOR_FILL (exit fill pending)
  - After exit fill confirmed: State → IDLE

Strategy lock rule:
  locked_strategy.id + locked_strategy.version are immutable
  from position open to position close.
  If strategy is updated (PATCH) while position is open:
    PATCH changes (non-structural) apply immediately to exit evaluation
    (stop_loss_pct, take_profit_pct may change on a running position)
  If strategy is deprecated while position is open:
    Strategy continues running exit rules until position closes
    Then deprecated cleanly
```

---

## Strategy Audit Trail

Every action on a strategy is logged immutably.
Stored in PostgreSQL `strategy_audit` table.

```
Events logged:
  STRATEGY_CREATED       {id, version, cloned_from}
  STRATEGY_EDITED        {version_before, version_after, fields_changed}
  BACKTEST_RUN           {backtest_id, result: pass/fail, sharpe}
  VALIDATION_RUN         {validation_id, result: pass/caution/fail}
  STATUS_CHANGED         {from_status, to_status, operator}
  VERSION_BUMPED         {from_version, to_version, bump_type: patch/minor/major}
  PAPER_SESSION_STARTED  {session_id, initial_capital}
  PAPER_SESSION_ENDED    {session_id, result: pass/fail, sharpe_vs_backtest_pct}
  LIVE_PROMOTED          {operator, acknowledged: true, capital_inr}
  STRATEGY_DEPRECATED    {reason, open_positions_at_deprecation}
  PATCH_APPLIED          {field, old_value, new_value}
  POSITION_OPENED        {position_id, entry_price, lots}
  POSITION_CLOSED        {position_id, exit_price, pnl_inr, exit_reason}
```

Audit trail is never deleted. Preserved for regulatory compliance and analysis.

---

## API Endpoints (Strategy Builder Service)

```
Templates:
  GET  /templates                   → list all bundled templates
  GET  /templates/{id}              → template details
  POST /templates/{id}/clone        → clone template to user strategy

Strategies:
  GET  /strategies                  → list user's strategies
  GET  /strategies/{id}             → strategy details + version history
  POST /strategies                  → create new strategy (DRAFT)
  PUT  /strategies/{id}             → update strategy definition
  DELETE /strategies/{id}           → soft delete (sets status = deprecated)

Lifecycle:
  POST /strategies/{id}/promote     → advance to next status
  POST /strategies/{id}/demote      → move backward with reason
  GET  /strategies/{id}/audit       → full audit trail

Versioning:
  GET  /strategies/{id}/versions         → list all versions
  GET  /strategies/{id}/versions/{ver}   → specific version definition
  POST /strategies/{id}/patch            → apply PATCH change
  POST /strategies/{id}/fork            → create MAJOR version (new strategy)

Results:
  GET  /strategies/{id}/backtest-results    → latest backtest results
  GET  /strategies/{id}/paper-results       → current paper session results
  GET  /strategies/{id}/live-results        → live trading results
  GET  /strategies/{id}/compare            → side-by-side: backtest vs paper vs live
```

---

*See DEPLOYMENT.md for how Strategy Builder API is deployed on GCP.*
