# Strategy Advisor Specification

**Version:** 1.0  
**Status:** Deferred — implement after Core Engine is live and data exists  
**Depends on:** TRADE_INTELLIGENCE_SPEC.md, STRATEGY_LIFECYCLE.md, STRATEGY_SCHEMA.md  
**Prerequisites:** Minimum 3 months of paper or live trading data before activating

---

## Why This Exists

The Trade Intelligence Store captures everything the system does — every signal,
every rejection, every fill, every outcome. The Strategy Degradation Detector
identifies when a strategy is underperforming. But neither of these answers
the question that matters:

**What specifically should change, and why?**

The Strategy Advisor is an AI-powered analysis layer that sits on top of the
existing Trade Intelligence Store. It reads the data that is already being
collected, calls the Claude API with structured context, and returns specific,
actionable refinement suggestions for human review.

It does not auto-apply anything. It advises. The operator decides.

---

## When to Build This

Do not build until all of the following are true:

```
✓ Backtest Engine is live and at least 5 strategies have been backtested
✓ Paper Trading is live and has been running for minimum 3 months
✓ Core Engine is live (even in paper mode)
✓ Trade Intelligence Store has minimum data:
    signals table:      ≥ 200 records
    positions table:    ≥ 50 closed positions across all strategies
    rejections table:   ≥ 100 enriched rejections (would_have_profited tagged)
    snapshots table:    ≥ 60 daily snapshots per strategy
```

Building earlier produces suggestions without statistical validity.
The Claude API call is only as good as the data fed into it.

---

## Design Principles

1. **Human always in the loop.** Claude suggests. You decide. No auto-apply.
2. **Data-driven, not pattern-matching.** Every suggestion must cite specific
   data from the Trade Intelligence Store. No generic advice.
3. **Conservative suggestions.** When in doubt, suggest tightening conditions,
   not loosening them. Loosening conditions increases trade frequency and
   increases the chance of overfitting to recent data.
4. **Version discipline.** Every approved suggestion creates a new strategy
   version. The original is preserved. Rollback is always possible.
5. **Minimum data gate.** The advisor refuses to run if trade count is below
   the minimum. Analyzing 8 trades is misleading, not helpful.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              Trade Intelligence Store (PostgreSQL)           │
│  signals / rejections / positions / snapshots               │
└──────────────────────────┬──────────────────────────────────┘
                           │ read-only queries
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                 Strategy Advisor Service                     │
│                    (Node.js, Cloud Run)                      │
│                                                             │
│  1. Data Collector    — queries Trade Intelligence Store    │
│  2. Context Builder   — assembles structured prompt payload │
│  3. Claude API Client — calls claude-sonnet-4 API           │
│  4. Response Parser   — validates and structures suggestions│
│  5. Review API        — exposes suggestions for UI          │
└──────────────────────────┬──────────────────────────────────┘
                           │ suggestions
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                Strategy Builder UI (Review Panel)           │
│                                                             │
│  Shows each suggestion as a card:                          │
│  [Finding] [Evidence] [Suggested Change] [Approve/Reject]  │
└──────────────────────────┬──────────────────────────────────┘
                           │ approved changes
                           ▼
┌─────────────────────────────────────────────────────────────┐
│              Strategy Lifecycle (PATCH + version bump)      │
│  Approved change → POST /strategies/{id}/patch             │
│  New version created. Original preserved.                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Trigger Conditions

The advisor runs in two modes:

### Manual Trigger
Operator clicks "Analyse Strategy" in Strategy Builder UI for a specific strategy.
Available any time minimum data requirements are met.

### Automatic Trigger
Triggered by the Strategy Degradation Detector when a strategy reaches
WARNING or CRITICAL status. The advisor runs automatically and the operator
receives a Telegram alert:

```
"Strategy [name] has reached WARNING status (win rate -24% from backtest).
 Strategy Advisor has generated 3 suggestions. Review required before
 trading resumes."
```

---

## Data Collection Queries

The Data Collector runs these queries before each analysis.
All data is scoped to the target strategy and a rolling window.

**Note on field names:** The queries below use logical field names based on
the Trade Intelligence Store design in TRADE_INTELLIGENCE_SPEC.md. Before
implementing, verify exact column names against the live schema — particularly
for the executions table (slippage fields) and the join between signals and
positions (order_id → entry_order_id relationship). Treat these as reference
queries, not production SQL.

### Query 1 — Condition Performance Breakdown

For each condition in the strategy, calculate win rate when that condition
was the "deciding factor" — present in losses but absent in some wins,
or vice versa.

```sql
-- For each condition: how often was it met in winning vs losing trades?
WITH trade_outcomes AS (
  SELECT
    s.signal_id,
    s.conditions_met,
    s.conditions_failed,
    s.regime,
    s.india_vix,
    EXTRACT(HOUR FROM s.timestamp) + EXTRACT(MINUTE FROM s.timestamp)/60.0
      AS hour_of_day,
    p.net_pnl_inr,
    p.exit_reason,
    CASE WHEN p.net_pnl_inr > 0 THEN 1 ELSE 0 END AS is_winner
  FROM signals s
  JOIN positions p ON s.order_id = p.entry_order_id
  WHERE s.strategy_id = $1
    AND s.timestamp > NOW() - INTERVAL '90 days'
    AND p.closed_at IS NOT NULL
),
condition_stats AS (
  SELECT
    unnest(conditions_met) AS condition_id,
    AVG(is_winner)         AS win_rate_when_met,
    COUNT(*)               AS times_met
  FROM trade_outcomes
  GROUP BY unnest(conditions_met)
)
SELECT
  condition_id,
  win_rate_when_met,
  times_met
FROM condition_stats
ORDER BY win_rate_when_met ASC;
```

### Query 2 — Regime Distribution of Wins vs Losses

```sql
SELECT
  regime,
  COUNT(*)                              AS total_trades,
  SUM(is_winner)                        AS winners,
  AVG(is_winner)                        AS win_rate,
  AVG(p.net_pnl_inr)                   AS avg_pnl
FROM trade_outcomes
GROUP BY regime
ORDER BY win_rate ASC;
```

### Query 3 — Time of Day Performance

```sql
SELECT
  FLOOR(hour_of_day)                    AS hour_bucket,
  COUNT(*)                              AS trades,
  AVG(is_winner)                        AS win_rate,
  AVG(p.net_pnl_inr)                   AS avg_pnl
FROM trade_outcomes
GROUP BY FLOOR(hour_of_day)
ORDER BY hour_bucket;
```

### Query 4 — Exit Reason Breakdown

```sql
SELECT
  exit_reason,
  COUNT(*)                              AS count,
  AVG(net_pnl_inr)                     AS avg_pnl,
  AVG(is_winner)                        AS win_rate
FROM trade_outcomes
GROUP BY exit_reason;
```

### Query 5 — Rejection Enrichment Summary

```sql
SELECT
  rejection_reason,
  COUNT(*)                              AS total_rejected,
  AVG(CASE WHEN would_have_profited
    THEN 1 ELSE 0 END)                  AS would_have_won_rate,
  AVG(max_favourable_excursion_pct)     AS avg_profit_missed_pct
FROM rejections
WHERE strategy_id = $1
  AND enriched_at IS NOT NULL
  AND timestamp > NOW() - INTERVAL '90 days'
GROUP BY rejection_reason
ORDER BY would_have_won_rate DESC;
```

### Query 6 — Slippage vs Assumption

```sql
SELECT
  AVG(fill_price - signal_entry_price)  AS avg_entry_slippage_pts,
  AVG(paper_assumed_slippage_pct)       AS assumed_slippage_pct,
  AVG(actual_slippage_pct)              AS actual_slippage_pct,
  AVG(actual_slippage_pct
    - paper_assumed_slippage_pct)       AS slippage_gap_pct
FROM executions e
JOIN signals s ON e.signal_id = s.signal_id
WHERE s.strategy_id = $1
  AND e.timestamp > NOW() - INTERVAL '90 days';
```

---

## Prompt Design

The prompt sent to Claude API is structured and explicit.
Claude is not asked for opinions — it is asked to analyze data and
return specific, quantified suggestions in JSON format only.

### System Prompt

```
You are a quantitative trading strategy analyst.

You will receive:
1. A strategy definition in JSON format
2. Performance data from live trading
3. Condition-level analysis
4. Rejection analysis

Your job is to identify specific, data-supported improvements to the strategy.

Rules:
- Every suggestion must cite specific numbers from the data provided.
- Do not suggest changes that are not supported by the data.
- Conservative bias: when uncertain, suggest tightening conditions
  (higher thresholds, tighter windows) rather than loosening them.
- Do not suggest adding new conditions unless the data clearly shows
  a specific failure mode that an additional condition would address.
- Do not discuss general trading theory. Only discuss this specific strategy
  and this specific data.
- Return ONLY valid JSON. No preamble. No explanation outside the JSON.
  No markdown code fences.
```

### User Prompt Structure

```
Analyze this strategy and its performance data. Return suggestions as JSON.

STRATEGY DEFINITION:
{strategy_json}

PERFORMANCE SUMMARY:
- Total trades analyzed: {n}
- Overall win rate: {win_rate}%
- Backtest win rate: {backtest_win_rate}%
- Win rate divergence: {divergence}%
- Average R achieved: {avg_r}
- Degradation status: {status}

CONDITION PERFORMANCE:
{condition_stats_table}
[condition_id, win_rate_when_met, times_met — sorted by win_rate ascending]

REGIME BREAKDOWN:
{regime_table}
[regime, total_trades, win_rate, avg_pnl]

TIME OF DAY BREAKDOWN:
{time_table}
[hour_bucket, trades, win_rate, avg_pnl]

EXIT REASON BREAKDOWN:
{exit_reason_table}
[exit_reason, count, avg_pnl, win_rate]

REJECTION ANALYSIS:
{rejection_table}
[rejection_reason, total_rejected, would_have_won_rate, avg_profit_missed_pct]

SLIPPAGE:
- Assumed slippage: {assumed_pct}%
- Actual slippage: {actual_pct}%
- Gap: {gap_pct}%

Return your analysis as JSON matching this exact schema:
{response_schema}
```

---

## Response Schema

Claude must return JSON matching this schema exactly.
The Response Parser validates the structure before any UI rendering.

```json
{
  "analysis_id": "uuid",
  "strategy_id": "string",
  "analyzed_at": "ISO8601",
  "trades_analyzed": 0,
  "data_quality": "SUFFICIENT | MARGINAL | INSUFFICIENT",

  "summary": {
    "overall_health": "HEALTHY | WATCH | DEGRADING | CRITICAL",
    "primary_issue": "string — one sentence describing the main problem",
    "confidence": "HIGH | MEDIUM | LOW"
  },

  "findings": [
    {
      "finding_id": "string",
      "category": "CONDITION_WEAK | REGIME_MISMATCH | TIME_FILTER |
                   EXIT_TIMING | SLIPPAGE | REJECTION_THRESHOLD",
      "severity": "HIGH | MEDIUM | LOW",
      "description": "string — what the data shows",
      "evidence": {
        "metric": "string — which metric",
        "value": "string — exact number from data",
        "comparison": "string — vs what benchmark"
      }
    }
  ],

  "suggestions": [
    {
      "suggestion_id": "string",
      "finding_id": "string — links to a finding above",
      "type": "ADJUST_THRESHOLD | TIGHTEN_TIME_WINDOW |
               ADD_CONDITION | REMOVE_CONDITION | ADJUST_EXIT",
      "description": "string — what to change",
      "current_value": "string or number",
      "suggested_value": "string or number",
      "expected_impact": {
        "trade_frequency_change": "string — e.g. -30% fewer trades",
        "win_rate_change": "string — e.g. +8% estimated win rate",
        "confidence": "HIGH | MEDIUM | LOW"
      },
      "data_support": "string — specific numbers that justify this suggestion"
    }
  ],

  "do_not_change": [
    {
      "condition_id": "string",
      "reason": "string — why this condition should stay"
    }
  ],

  "warnings": [
    "string — any data quality issues or caveats"
  ]
}
```

---

## Human Review UI

Each suggestion is rendered as a card in the Strategy Builder UI.

### Suggestion Card Layout

```
┌────────────────────────────────────────────────────────────┐
│  [HIGH] ADX Threshold Too Low                              │
│                                                            │
│  Finding:                                                  │
│  Trades entered when ADX was 25-28 have a 34% win rate.   │
│  Trades entered when ADX was above 30 have a 61% win rate. │
│                                                            │
│  Suggested Change:                                         │
│  Raise ADX minimum from 25 → 30                           │
│                                                            │
│  Expected Impact:                                          │
│  ~35% fewer trades, estimated +12% win rate improvement    │
│  Confidence: MEDIUM                                        │
│                                                            │
│  Data Support:                                             │
│  Based on 38 trades at ADX 25-28 vs 24 trades at ADX >30  │
│  over the last 90 days.                                    │
│                                                            │
│  [Approve]  [Reject]  [Defer]                             │
└────────────────────────────────────────────────────────────┘
```

### Review Actions

| Action | Effect |
|---|---|
| Approve | Change added to pending patch queue |
| Reject | Suggestion dismissed, logged in audit trail |
| Defer | Flagged for review in next cycle |

Approved changes are applied as a batch when operator clicks
"Apply X Changes" — not one at a time. This creates a single
new strategy version with all approved changes, not N versions.

---

## Version Management on Apply

When changes are applied:

```
Before apply:
  Strategy: Nifty ADX Pullback v1.2 (PAPER)
  Changes approved: 2

Apply action:
  1. Strategy Advisor calls POST /strategies/{id}/patch for each change
  2. Version bumps from 1.2 → 1.3 (MINOR bump — parameter change)
     If a condition is added/removed: version bumps to 2.0 (MAJOR)
  3. New version is reset to BACKTESTED status (must re-validate)
  4. Original v1.2 is preserved and marked as DEPRECATED
  5. Audit entry: ADVISOR_PATCH_APPLIED {suggestion_ids, operator}

Re-validation requirement:
  Parameter change (threshold value): re-backtest required, re-validate optional
  Structural change (add/remove condition): full re-backtest + re-validation required
  Exit change: re-backtest required
```

---

## Minimum Data Requirements (Enforced in Code)

The service refuses to analyze if data is insufficient.
Returns HTTP 422 with a clear reason.

```
HARD MINIMUMS (refuse to run):
  Closed positions:         < 20   → INSUFFICIENT_DATA
  Days of data:             < 14   → INSUFFICIENT_DATA
  Enriched rejections:      < 10   → INSUFFICIENT_REJECTION_DATA

MARGINAL (run with warning in response):
  Closed positions:         20–49  → data_quality = MARGINAL
  Days of data:             14–29  → data_quality = MARGINAL
  Degradation snapshots:    < 30   → data_quality = MARGINAL

SUFFICIENT:
  Closed positions:         ≥ 50
  Days of data:             ≥ 30
  Degradation snapshots:    ≥ 30
```

When data_quality = MARGINAL, every suggestion card shows a banner:
"Based on limited data (23 trades). Treat suggestions as directional,
not conclusive. Re-run after 50+ trades for higher confidence."

---

## Claude API Configuration

```javascript
// Strategy Advisor Claude API call
{
  model: "claude-sonnet-4-6",
  max_tokens: 2000,
  system: SYSTEM_PROMPT,
  messages: [
    { role: "user", content: assembledPrompt }
  ]
}
```

Response handling:

```javascript
// Parse and validate response
const text = data.content
  .filter(b => b.type === "text")
  .map(b => b.text)
  .join("");

// Strip any accidental markdown fences
const clean = text.replace(/```json|```/g, "").trim();

// Parse and validate against schema
const parsed = JSON.parse(clean);
validateAgainstSchema(parsed);   // throws if invalid
```

If Claude returns invalid JSON or fails schema validation:
- Log the raw response for debugging
- Return HTTP 502 to the UI with message:
  "Analysis failed — model returned unexpected format. Try again."
- Do not show partial results

---

## Cost Estimate

Each analysis call sends approximately 2,000–4,000 tokens of context
(strategy JSON + performance tables) and receives ~1,000 tokens back.

```
Cost per analysis call:  ~$0.01–0.02 USD
Expected frequency:      2–4 calls per strategy per month
                         (manual triggers + auto-trigger on degradation)

Monthly cost estimate (10 strategies):
  10 strategies × 3 calls × $0.015 = $0.45/month

This is negligible. Cost is not a design constraint.
```

---

## What This Service Does NOT Do

Explicitly out of scope — to prevent scope creep:

- Does not automatically apply any changes to strategies
- Does not generate new strategy conditions from scratch
- Does not backtest the suggested changes (human initiates re-backtest)
- Does not compare strategies against each other
- Does not predict future performance
- Does not learn or fine-tune over time (each call is stateless)
- Does not run continuously — only on trigger

---

## Integration Points

| System | Integration | Direction |
|---|---|---|
| Trade Intelligence Store | Read trade data | Advisor → DB |
| Strategy Builder API | POST /strategies/{id}/patch | Advisor → Strategy Builder |
| Strategy Lifecycle | Version bump on apply | Via Strategy Builder API |
| Grafana | Advisor run count, suggestion acceptance rate | Advisor → Prometheus |
| Telegram | Alert on auto-trigger (degradation detected) | Advisor → Telegram |
| Cloud Run | Deployment target | — |
| Claude API | Analysis | Advisor → Anthropic |

---

## Deployment

```
Service:     strategy-advisor
Runtime:     Node.js 20
Deploy:      Cloud Run (on-demand, not always-on)
Min instances: 0 (scales to zero when not in use)
Memory:      512MB
Timeout:     120 seconds (Claude API call + DB queries)

Environment:
  ANTHROPIC_API_KEY    from Secret Manager
  DATABASE_URL         Cloud SQL connection string
  STRATEGY_API_URL     Strategy Builder API internal URL
```

No VM deployment needed — this is a request-response service, not a
persistent process. Cloud Run is the correct deployment target.

---

## Build Order

When the time comes to build this, the sequence is:

```
1. Confirm Trade Intelligence Store has sufficient data
   (run the minimum data check queries manually first)

2. Build Data Collector
   (the 6 SQL queries above, wrapped in a service)

3. Build Context Builder
   (assembles data into the prompt template)

4. Build Claude API Client
   (simple fetch call, response validation)

5. Build Review API
   (GET /advisor/{strategy_id}/analysis,
    POST /advisor/{strategy_id}/apply)

6. Build UI review panel
   (suggestion cards in Strategy Builder)

7. Wire auto-trigger
   (Degradation Detector → Pub/Sub → Strategy Advisor)
```

---

*Implement after: Core Engine is live, 3+ months of paper/live data exists.*  
*Related: TRADE_INTELLIGENCE_SPEC.md, STRATEGY_LIFECYCLE.md, STRATEGY_SCHEMA.md*
