# Changelog — Live Semantic Discussion Engine

A major addition to Z-Fushou's backend: a real-time discussion tracking engine that processes messages within seconds of arrival, groups them into semantically coherent cases, and maintains live AI-generated summaries, timelines, and status assessments. This runs alongside the existing nightly batch pipeline and shares the same worker process.

---

## What Changed

### New: Live Engine Module (`live/`)

A full processing pipeline that runs on a 15-second poll cycle inside the main Railway worker. Completely separate code path from the nightly pipeline — different tables, different Qdrant collection, different processing model. The nightly pipeline processes a full day in one batch; the live engine processes individual messages as they arrive.

**Message processing flow per tick:**
1. Fetch up to 25 unprocessed cleaned messages from Supabase
2. For each message: generate an embedding, search Qdrant for the nearest active discussion in the same guild/channel/thread
3. If a match is found above the similarity threshold: append the message to that case, update the in-memory centroid
4. If no match: create a new case, run AI analysis immediately
5. If the message triggers a semantic boundary (similarity drops below threshold AND cohesion drops from previous state): close the current case, open a new one
6. If a case has had no activity for 10 minutes: close it with a final AI analysis
7. Mark each message as processed so it's never picked up again

**AI analysis triggers (not every message — only on state changes):**
- New case creation
- Boundary detection (topic shift)
- Quiet-time closure (inactivity timeout)
- Significant timeline updates (severity keywords, resolution signals, or every N messages)

**Per-case AI output:**
- Running summary (max 500 chars, clamped)
- Current status: active / investigating / resolved / dormant
- Routing: product-side / user-side / mixed / unknown
- Attention score: low / medium / high / critical
- Timeline entries: significant events with timestamps (max 20, clamped)
- Unresolved questions (max 5, clamped)

### New: Distributed Lock (`live/src/lock.js`)

Redis-backed lock with UUID ownership tokens. On acquire, the engine writes a random UUID as the lock value. On every tick it verifies the UUID still matches before refreshing the timeout. This prevents a stalled worker from accidentally extending another worker's lock after a failover. Lock timeout is 60 seconds, refreshed every 15 seconds (each tick).

### New: Startup Health Validation (`live/src/health.js`)

Before the engine starts, it pings Supabase, Qdrant, and Redis. If any are unreachable, the engine refuses to start and the worker continues running everything else normally. Cloudflare is intentionally not checked — a temporary embedding outage shouldn't block the entire worker.

### New: Lifecycle Integration (`index.js`)

The live engine runs inside the main Discord bot process, controlled by `LIVE_ENGINE_ENABLED`. On startup it goes through health checks, acquires the distributed lock, and rebuilds state from Qdrant for any open cases. On shutdown (SIGTERM/SIGINT) it releases the lock and disconnects. The `--once` flag runs a single tick for smoke testing.

### New: In-Memory State Management (`live/src/state.js`)

Each open case maintains an in-memory centroid (running average of recent message embeddings), a rolling window of the last 25 embeddings, a cohesion score, and message/user counts. Boundary detection uses a dual condition: the new message's similarity to the centroid must be below 0.62 AND the cohesion must have dropped by at least 0.16 from the previous state. This prevents single off-topic messages from closing a case prematurely.

### New: Vector Normalization Guard (`live/src/vector.js`)

After Cloudflare returns an embedding, the code verifies the vector is actually unit-length (magnitude within 0.01 of 1.0) before using it. If it's not, it normalizes it. This is a safety net against silent upstream format changes that would corrupt all similarity scores.

### New: Metrics (`live/src/metrics.js`)

Counters: messages processed, cases created, cases closed, boundary events, embedding failures, LLM failures, Qdrant failures, retry count. Gauge: active case count (pulled from DB each tick). Logged every tick alongside DB-level metrics (total open/closed cases, average case duration, boundary event count).

### Changed: Dead Code Removal

Removed `findOpenCase()` from the storage layer — the engine routes messages exclusively through Qdrant vector search, not Supabase queries. Keeping an unused routing path would create confusion later.

### Changed: Qdrant Collection Isolation

The live engine uses its own Qdrant collection (`live_discussion_messages`) separate from the nightly pipeline. Payload indexes are created on startup for `case_status`, `guild_id`, `channel_id`, `thread_id`, and `case_id`. When a case closes, all its Qdrant points get their payload updated to `case_status: closed` so they're excluded from future nearest-neighbor searches.

### Changed: Retention Cleanup (`lib/cleaning/retentionCleanup.js`)

Messages flagged as monitored mentions (`is_monitored_mention = true`) are now excluded from the 7-day retention sweep. This ensures the mention briefing system and mentions API always have access to these messages regardless of age.

### Changed: Nightly Pipeline Cron (`index.js`)

Pipeline schedule moved to 11:55 PM Beijing time (was 4:55 AM). Processes the day that's about to end so results are ready by morning instead of waiting until late morning.

### Changed: Nightly Pipeline Summarizer Logging (`pipeline/src/topicSummarizer.js`)

When the summarizer fails to parse an LLM response, it now logs the raw LLM output (up to 2000 chars) for both the first attempt and the retry. Previously only logged "No JSON found" with no visibility into what the model actually returned.

### Changed: Activity Edge Function (`supabase/functions/activity/index.ts`)

Two fixes:
1. Single-day queries now work — `from=2026-05-30&to=2026-05-30` returns the full 24 hours instead of zero results. Bare date strings (no time component) get the upper bound expanded to end-of-day. Timestamps with time components pass through untouched, so single-hour queries still work.
2. The `hour` field is now always an ISO 8601 timestamp string, never a bare integer. The sanitiser handles both string and number inputs defensively.

---

## New Database Tables

| Table | Purpose |
|---|---|
| `live_cases` | Discussion cases with summary, status, routing, attention score, timeline |
| `live_case_messages` | Links each message to the case it belongs to |
| `live_case_events` | Timeline events: case created, topic shift, timeline update, case closed |

---

## New Environment Variables

| Variable | Description | Default |
|---|---|---|
| `LIVE_ENGINE_ENABLED` | Enable the live engine | `false` |
| `LIVE_ENGINE_POLL_INTERVAL_MS` | Poll interval | `15000` |
| `LIVE_ENGINE_FETCH_LIMIT` | Max messages per tick | `25` |
| `LIVE_ENGINE_QUIET_TIME_MINUTES` | Close cases after this much silence | `10` |
| `LIVE_ENGINE_SIMILARITY_THRESHOLD` | Similarity cutoff for matching | `0.62` |
| `LIVE_ENGINE_COHESION_DROP_THRESHOLD` | Cohesion drop for boundary detection | `0.16` |
| `LIVE_QDRANT_COLLECTION` | Qdrant collection for live vectors | `live_discussion_messages` |

---

## Files Changed

| File | Change |
|---|---|
| `live/src/index.js` | Full rewrite — health check, lock acquisition, poll loop with lock refresh, cleanup on shutdown |
| `live/src/engine.js` | Added metrics counters per message and active cases gauge |
| `live/src/storage.js` | Removed dead `findOpenCase()` |
| `live/src/analyzer.js` | Hard limits: summary 500 chars, timeline 20 entries, questions 5 |
| `live/src/vector.js` | Added `isNormalized()` guard |
| `live/src/cloudflare.js` | Normalization guard on embedding output |
| `live/src/metrics.js` | Added counters, gauges, `set()` function |
| `live/src/lock.js` | New — distributed Redis lock with UUID ownership |
| `live/src/health.js` | New — startup dependency validation |
| `index.js` | Live engine wired into main worker lifecycle + shutdown |
| `lib/cleaning/retentionCleanup.js` | Preserves monitored mentions from 7-day deletion |
| `pipeline/src/topicSummarizer.js` | Logs raw LLM response on parse failure |
| `supabase/functions/activity/index.ts` | Single-day query fix + consistent ISO hour format |

---

## Current Status

Code complete. All 15 live engine modules load cleanly. Disabled by default. No new infrastructure required — uses existing Redis, Supabase, Qdrant, and Cloudflare. Deploy and set `LIVE_ENGINE_ENABLED=true` to activate.
