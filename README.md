# Z-Fushou

Discord community analytics system. A silent bot collects messages from Discord channels, cleans and analyzes them overnight, and serves the results through API endpoints that a desktop app reads to show dashboards.

## What it does

1. **Collects messages** from configured Discord channels in real time
2. **Cleans them** — removes noise, normalizes text, resolves user mentions
3. **Analyzes them nightly** — groups messages into conversation topics, generates summaries using an AI model, rates sentiment (frustrated, confused, neutral, satisfied) and urgency (critical, high, medium, low)
4. **Serves analytics** through authenticated API endpoints (message counts, topic clusters, activity charts, mention alerts)
5. **Flags important mentions** — when specific people (team leads, community managers) are mentioned, those messages get tagged for review

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
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│  Nightly Pipeline (7 AM Beijing)     │
│  Boundary detection → topic grouping │
│  AI summarization → sentiment rating │
│  Results stored in Supabase          │
│  Vectors indexed in Qdrant           │
└──────────────┬───────────────────────┘
               │
               ▼
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

## Two Runtime Environments

### Railway (always-on Node.js process)
Runs `index.js` — the bot stays connected to Discord 24/7. Handles:
- Real-time message ingestion
- Periodic cleaning
- Scheduled nightly pipeline (7 AM Beijing time via node-cron)

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
│   └── noiseFilters.js               # Emoji-only, duplicate detection
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
    ├── logger.js                     # Structured logging with batch IDs
    ├── mentionBriefing.js            # Real-time mention alert generation
    └── __tests__/
        └── topicSummarizer.test.js   # 33 tests covering JSON extraction, LLM calls, error handling
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
| `MENTION_BRIEFING_ENABLED` | Enable mention alerts | `false` |
| `CF_ACCOUNT_ID` | Cloudflare account for AI model | — |
| `CF_API_TOKEN` | Cloudflare API token | — |
| `QDRANT_URL` | Vector database URL | — |
| `QDRANT_API_KEY` | Vector database key | — |
| `REDIS_URL` | Redis for dedup/locking (optional, degrades gracefully) | — |
| `FORCE_FULL_PIPELINE` | Reprocess all history on next run | `false` |

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
npm start              # Bot + cleaning
npm run pipeline       # Run pipeline manually once
npm test               # Run summarizer tests (33 tests)
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
