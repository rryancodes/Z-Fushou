# Z-Fushou

Discord community analytics system. A silent bot collects messages from Discord channels, cleans and analyzes them overnight, and serves the results through API endpoints that a desktop app reads to show dashboards.

## What it does

1. **Collects messages** from configured Discord channels in real time
2. **Cleans them** — removes noise, normalizes text, resolves user mentions
3. **Analyzes them nightly** — groups messages into conversation topics, generates summaries using an AI model, rates sentiment (frustrated, confused, neutral, satisfied) and urgency (critical, high, medium, low)
4. **Tracks live discussions** — as conversations happen, it groups related messages into cases, keeps running summaries and timelines, and closes them when the topic shifts or goes quiet
5. **Serves analytics** through authenticated API endpoints (message counts, topic clusters, activity charts, mention alerts)
6. **Flags important mentions** — when specific people (team leads, community managers) are mentioned, those messages get tagged for review

The desktop app connects to the API endpoints, authenticates the user, and renders charts and dashboards.

## Architecture

```
Discord
  │
  ▼
┌──────────────────────────────────────┐
│  Ingestion (index.js)                │
│  Real-time message capture via bot   │
│  Batch writes to Supabase            │
└──────────────┬───────────────────────┘
                │
                ▼
┌──────────────────────────────────────┐
│  Cleaning (every 30 min)             │
│  Noise removal, mention resolution,  │
│  text normalization → clean table    │
└──────┬──────────────────┬────────────┘
       │                  │
       ▼                  ▼
┌──────────────┐  ┌──────────────────────────────────────┐
│ Nightly      │  │  Live Engine (every 15 seconds)      │
│ Pipeline     │  │  Picks up new cleaned messages       │
│ (11:55 PM)   │  │  Embeds them via Cloudflare          │
│              │  │  Matches to active discussions        │
│ Full-day     │  │  via Qdrant vector search            │
│ batch        │  │  Creates/updates/closes cases        │
│ processing   │  │  Runs AI analysis on triggers        │
│              │  │  Writes cases + events to Supabase   │
└──────┬───────┘  └──────────────┬───────────────────────┘
       │                         │
       ▼                         ▼
┌──────────────────────────────────────┐
│  Edge Functions (Supabase)           │
│  /kpi  /clusters  /activity          │
│  /mentions  /messages                │
│  /cluster-detail  /date-availability │
│  Authenticated via desktop JWT       │
└──────────────┬───────────────────────┘
                │
                ▼
           Desktop App
      (Electron + Charts)
```

## Two Processing Systems

### Nightly Pipeline

Runs once at 11:55 PM Beijing time. Processes the entire day's cleaned messages as a batch:
1. Segments messages into conversation topics using similarity boundaries
2. Classifies each segment into a topic category using AI
3. Generates summaries with sentiment and urgency ratings
4. Stores results in Supabase and indexes vectors in Qdrant

Good for: daily reports, historical analysis, trend charts.

### Live Engine

Runs continuously every 15 seconds. Processes new messages as they arrive:
1. Picks up cleaned messages not yet processed by the live engine
2. Embeds each message and searches Qdrant for the nearest active discussion across the entire server (guild-wide)
3. Two-tier matching: same channel/thread accepts at 0.55, cross-channel requires 0.75
4. If it finds a match, appends the message to that case. If not, checks recently-closed cases (within 3 hours) for context continuation before creating a new case
5. Tracks when a conversation topic shifts (similarity drops + cohesion drops) and closes the case
6. Closes cases that go quiet (no messages for 10 minutes)
7. Detects when the AI says the issue is resolved and closes the case
8. Daily reset at 2AM Beijing time: closes all remaining open cases and wipes Qdrant vectors for a clean slate
9. Each case gets: summary, status (active/investigating/resolved/dormant), routing (product-side/user-side/mixed), attention score (low/medium/high/critical), timeline of events, unresolved questions

Good for: real-time awareness, active incident tracking, live dashboards.

The two systems are completely independent. They read from the same cleaned messages table but write to different tables. The nightly pipeline marks messages with `semantic_processed_at`, the live engine marks them with `live_processed_at`.

## Runtime

### Railway (always-on Node.js process)
Runs `index.js` — the bot stays connected to Discord 24/7. Handles:
- Real-time message ingestion
- Periodic cleaning
- Scheduled nightly pipeline (11:55 PM Beijing time)
- Live engine polling (every 15 seconds, if enabled)

Deploys automatically on push to main.

### Supabase (Edge Functions)
Seven API endpoints deployed directly to Supabase via CLI. The desktop app calls these. Each endpoint:
- Verifies the user's auth token
- Queries the database
- Returns structured JSON

Not connected to Railway — deployed and logged separately.

## Project Structure

```
index.js                              # Entry point — bot + cron scheduler
lib/
├── supabase.js                       # Supabase client
├── ingestion/
│   ├── index.js                      # Channel setup, backfill, batch writer
│   ├── messageListener.js            # Discord event handler + filters
│   ├── ingestionCheckpoint.js        # Message formatting, mention detection
│   ├── batchWriter.js                # In-memory queue + periodic flush
│   └── supabaseClient.js             # Database inserts, checkpoint read/write
├── cleaning/
│   ├── index.js                      # Autonomous loop (start/stop)
│   ├── cleanWorker.js                # 5-phase cleaning
│   ├── mentionNormalizer.js          # <@id> → <@username>
│   ├── normalizeText.js              # Text normalization
│   ├── noiseFilters.js               # Emoji-only, duplicate detection
│   └── retentionCleanup.js           # 7-day raw message deletion (preserves monitored mentions)
├── mentionBriefing/
│   └── index.js                      # Real-time mention alert generation
pipeline/
├── pipeline.config.js                # Model config, env requirements
└── src/
    ├── index.js                      # Pipeline orchestrator (fetch → segment → summarize → store)
    ├── fetchMessages.js              # Fetch cleaned messages from Supabase
    ├── boundaryDetection.js          # Segment conversations by topic boundary
    ├── classifier.js                 # AI topic classification
    ├── topicSummarizer.js            # AI summarization + sentiment + severity
    ├── storeResults.js               # Write results to Supabase (date-isolated)
    ├── contextBuilder.js             # Build context blocks for embedding
    ├── embedder.js                   # Generate embeddings via Cloudflare
    ├── qdrantClient.js               # Vector DB upsert
    ├── batchTracker.js               # Redis-based dedup + distributed lock
    └── logger.js                     # Structured logging with batch IDs
live/
├── live.config.js                    # Poll intervals, thresholds, model config
└── src/
    ├── index.js                      # Entry point — lifecycle, lock, health checks
    ├── engine.js                     # Core logic — create/update/close cases
    ├── state.js                      # In-memory centroid tracking + boundary detection
    ├── storage.js                    # Supabase CRUD for live cases/messages/events
    ├── analyzer.js                   # AI analysis (summary, status, routing, timeline)
    ├── cloudflare.js                 # Embedding + LLM API client
    ├── qdrantClient.js               # Vector search for matching active discussions
    ├── lock.js                       # Redis distributed lock with ownership token
    ├── health.js                     # Startup dependency checks
    ├── vector.js                     # Vector math (cosine similarity, centroid update)
    ├── retry.js                      # Exponential backoff with jitter
    ├── metrics.js                    # Counters and gauges
    ├── json.js                       # JSON extraction from LLM output
    └── logger.js                     # Structured logging
supabase/
├── config.toml                       # Supabase project config
├── migrations/
│   └── *_create_hourly_activity_rpc.sql  # Postgres aggregation function
└── functions/
    ├── _shared/
    │   ├── admin.ts                  # Service-role Supabase client
    │   ├── cors.ts                   # CORS headers
    │   ├── date-utils.ts             # Date range helpers (pipeline vs realtime)
    │   ├── error-handler.ts          # Structured error responses (401 vs 500)
    │   └── verify-desktop-auth.ts    # JWT verification via external auth
    ├── kpi/index.ts                  # KPI metrics with period comparison
    ├── clusters/index.ts             # Topic cluster listing with pagination
    ├── cluster-detail/index.ts       # Single cluster + messages + sparkline
    ├── mentions/index.ts             # Flagged mention messages
    ├── messages/index.ts             # Cleaned message browser
    ├── activity/index.ts             # Hourly activity chart (DB aggregation)
    └── date-availability/index.ts    # Which dates have data
```

## Database Tables

### Message tables
| Table | Purpose |
|---|---|
| `community_messages` | Raw Discord messages as ingested |
| `community_messages_clean` | Normalized version (noise removed, mentions resolved) |

### Pipeline result tables
| Table | Purpose |
|---|---|
| `pipeline_clusters` | Grouped conversation topics per day |
| `pipeline_topic_summaries` | AI summaries with sentiment, severity, key issues |
| `pipeline_cluster_messages` | Which messages belong to which topic |

### Live engine tables
| Table | Purpose |
|---|---|
| `live_cases` | Active and closed discussion cases with summaries, status, routing, attention scores |
| `live_case_messages` | Links messages to the case they belong to |
| `live_case_events` | Timeline events (case created, topic shift, timeline update, case closed) |

### Database views
| View | Purpose |
|---|---|
| `pipeline_daily_clusters` | Deduplicated clusters per date |
| `pipeline_daily_summaries` | Deduplicated summaries per date |

### Database function
| Function | Purpose |
|---|---|
| `get_hourly_activity(start, end)` | Aggregates messages and clusters into hourly buckets |

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal |
| `CLIENT_ID` | Bot application ID |
| `INGESTION_CHANNELS` | Comma-separated channel IDs to watch |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon key |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |

### Pipeline

| Variable | Description | Default |
|---|---|---|
| `PIPELINE_ENABLED` | Enable nightly analysis | `false` |
| `PIPELINE_CRON` | Cron schedule (Beijing timezone) | `50 23 * * *` |
| `MENTION_BRIEFING_ENABLED` | Enable mention alerts | `false` |
| `PIPELINE_CF_ACCOUNT_ID` | Cloudflare account for pipeline AI model | — |
| `PIPELINE_CF_API_TOKEN` | Cloudflare API token for pipeline | — |
| `QDRANT_URL` | Vector database URL | — |
| `QDRANT_API_KEY` | Vector database key | — |
| `QDRANT_PIPELINE_COLLECTION` | Qdrant collection for nightly pipeline | — |
| `REDIS_URL` | Redis for dedup/locking | — |
| `FORCE_FULL_PIPELINE` | Reprocess all history on next run | `false` |

### Live Engine

| Variable | Description | Default |
|---|---|---|
| `LIVE_ENGINE_ENABLED` | Enable real-time discussion tracking | `false` |
| `LIVE_ENGINE_POLL_INTERVAL_MS` | How often to check for new messages | `15000` |
| `LIVE_ENGINE_FETCH_LIMIT` | Max messages per poll tick | `25` |
| `CF_ACCOUNT_ID` | Cloudflare account for live engine AI model | — |
| `CF_API_TOKEN` | Cloudflare API token for live engine | — |
| `QDRANT_URL` | Vector database URL | — |
| `QDRANT_API_KEY` | Vector database key | — |
| `LIVE_ENGINE_MATCH_MIN_SCORE` | Same-channel similarity threshold to match a case | `0.55` |
| `LIVE_ENGINE_CROSS_CHANNEL_MIN_SCORE` | Cross-channel similarity threshold | `0.75` |
| `LIVE_ENGINE_SIMILARITY_THRESHOLD` | Boundary: max similarity to detect topic shift | `0.62` |
| `LIVE_ENGINE_COHESION_DROP_THRESHOLD` | Boundary: cohesion drop to detect topic shift | `0.16` |
| `LIVE_ENGINE_STALE_CASE_MINUTES` | Close cases with no activity after N minutes | `10` |
| `LIVE_ENGINE_CASE_REOPEN_WINDOW_HOURS` | How long after closing can a case be reopened | `3` |
| `LIVE_ENGINE_CASE_REOPEN_MIN_SCORE` | Similarity threshold to reopen a closed case | `0.65` |
| `LIVE_ENGINE_DAILY_RESET_HOUR_UTC` | UTC hour to close all cases and wipe vectors | `18` |
| `LIVE_QDRANT_COLLECTION` | Qdrant collection for live vectors | `live_discussion_messages` |
| `LIVE_ENGINE_CHAT_MODEL` | Cloudflare model for case analysis | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

### Ingestion tuning

| Variable | Description | Default |
|---|---|---|
| `MONITORED_USER_IDS` | User IDs to track mentions for | `""` |
| `MIN_MESSAGE_DATE` | Ignore messages older than this | `""` |
| `CLEAN_INTERVAL_MINUTES` | Cleaning cycle interval | `30` |
| `LOG_PRETTY` | Pretty-print logs | `false` |

## Deployment

### Railway (bot + pipeline)
1. Push to `main` — Railway auto-deploys
2. Set all required env vars in Railway dashboard
3. Bot connects to Discord, cron schedules the nightly pipeline

### Supabase (API endpoints)
1. `supabase db push` — apply migrations
2. `supabase functions deploy <name> --no-verify-jwt` — deploy each endpoint
3. Set secrets: `SUPABASE_SERVICE_ROLE_KEY`, `AUTH_VERIFY_URL`

### Local development
```bash
npm install
cp .env.example .env   # Fill in your values
npm start              # Bot + cleaning + live engine (if enabled)
npm run pipeline       # Run nightly pipeline manually once
npm run live           # Run live engine standalone
npm run live:once      # Run one live engine tick
npm test               # Run tests
```

## Adding the Bot to a Server

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=66560&scope=bot
```

Required permissions (`66560`): View Channels + Read Message History.

Enable **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents.

## Moving to a New Server

1. Invite bot to new server
2. Update `INGESTION_CHANNELS` and `MONITORED_USER_IDS`
3. Set `FORCE_FULL_PIPELINE=true` once to reprocess all messages
4. Restart

No code changes needed.
