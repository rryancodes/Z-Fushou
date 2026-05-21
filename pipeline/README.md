# Semantic Boundary Detection Pipeline

A batch pipeline that runs every 12 hours to process cleaned Discord general chat messages from Supabase. It detects topic shifts using TextTiling with embedding-based cosine similarity, classifies segments using LLM (Cloudflare Workers AI), embeds context blocks and stores them in Qdrant, and writes structured cluster data back to Supabase.

**Why this exists:** Naive sliding windows over general chat blend unrelated topics (API errors + billing questions + random chat in the same window), producing poor embeddings and useless clusters. This pipeline detects where topics actually shift first, then builds context windows only within detected segments — dramatically improving downstream cluster quality.

---

## Quick Start

```bash
# Run the pipeline manually
node pipeline/src/index.js

# Run all tests
node --test pipeline/tests/*.test.js

# Run a specific test file
node --test pipeline/tests/boundaryDetection.test.js
```

---

## Environment Variables

All variables are read from `process.env`. The pipeline validates required vars at startup and throws a clear error listing any missing ones.

### Required

| Variable | Description |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID for Workers AI API |
| `CF_API_TOKEN` | Cloudflare API token with Workers AI access |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service key (needs read/write access — NOT the anon key) |
| `QDRANT_URL` | Qdrant instance URL |
| `QDRANT_API_KEY` | Qdrant API key |
| `QDRANT_PIPELINE_COLLECTION` | Qdrant collection name for pipeline vectors |
| `GENERAL_CHAT_CHANNEL_ID` | Discord channel ID for the general chat channel |

### Optional

| Variable | Description |
|---|---|
| `REDIS_URL` | Redis URL for distributed locking and batch tracking. If unavailable, pipeline runs in degraded mode (no lock, risk of duplicate runs). |
| `CLOUDFLARE_EMBEDDING_MODEL` | Embedding model name. Defaults to `@cf/baai/bge-large-en-v1.5`. Must match the model used by the rest of the project. |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  STEP 1: Fetch cleaned messages from Supabase   │
│  (cursor-based pagination, incremental via      │
│   message_ingestion_state)                       │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 2: Boundary Detection (TextTiling)        │
│  - Embed each message individually              │
│  - Sliding-window cosine similarity curve       │
│  - Depth-score valley detection → boundaries    │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 3: Context Block Construction             │
│  - Sliding window of 3 messages per segment     │
│  - Never crosses segment boundaries             │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 4: Final Embedding (Cloudflare Workers AI)│
│  - Embed context block text                     │
│  - Normalize to unit vectors                    │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 5: Upsert to Qdrant                       │
│  - Batch upsert with metadata payload           │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 6: LLM Classification                     │
│  - Category discovery (sample segments)         │
│  - Batch classification with fixed categories   │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│  STEP 7: Write clusters to Supabase             │
│  - pipeline_clusters (metadata)                 │
│  - pipeline_cluster_messages (message links)    │
└─────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Two embedding passes:** Step 2 uses cheap per-message embeddings for boundary detection only. Step 4 embeds the assembled context blocks. These are never mixed.
- **Depth scores, not raw thresholds:** Boundary detection uses depth scoring (distance from neighboring peaks) instead of raw similarity thresholds, making it robust across different conversation volumes.
- **Redis distributed lock:** Prevents concurrent pipeline runs. Falls back to degraded mode if Redis is unavailable.
- **Idempotent:** Tracks last batch end timestamp in Redis. Re-running on the same window won't duplicate data.
- **LLM classification over clustering:** Uses Cloudflare Workers AI (Llama 3.3 70B) for topic classification instead of HDBSCAN. This produces consistent, interpretable topic labels rather than arbitrary cluster IDs.

---

## Supabase Tables

### Source (read-only)

**`community_messages_clean`** — cleaned Discord messages ingested by the existing pipeline.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `message_id` | TEXT UNIQUE |
| `channel_id` | TEXT |
| `user_id` | TEXT |
| `username` | TEXT |
| `content` | TEXT |
| `timestamp` | TIMESTAMPTZ |
| `created_at` | TIMESTAMPTZ |

### Output (write-only)

**`pipeline_clusters`** — one row per detected cluster per batch.

| Column | Type |
|---|---|
| `id` | BIGSERIAL PK |
| `batch_id` | TEXT |
| `cluster_id` | INTEGER |
| `start_timestamp` | TIMESTAMPTZ |
| `end_timestamp` | TIMESTAMPTZ |
| `message_count` | INTEGER |
| `unique_users` | INTEGER |
| `avg_boundary_score` | DOUBLE PRECISION |
| `created_at` | TIMESTAMPTZ |

**`pipeline_cluster_messages`** — one row per message-cluster link.

| Column | Type | Description |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `batch_id` | TEXT | Pipeline batch identifier |
| `cluster_id` | INTEGER | Cluster within the batch |
| `message_id` | TEXT | Discord message ID |
| `context_block_id` | UUID | **Real UUID** referencing the context block where this message is the anchor (last position in the sliding window). Context blocks are generated by `contextBuilder.js` using `crypto.randomUUID()`. This enables precise traceability from messages → context blocks → Qdrant vectors for RAG retrieval. |
| `channel_id` | TEXT | Discord channel ID |
| `user_id` | TEXT | Discord user ID |
| `created_at` | TIMESTAMPTZ | |
| `processing_date` | DATE | Calendar date for isolation (enables idempotent re-processing) |

### First-time setup

Run the SQL migrations in Supabase SQL Editor before the first pipeline run:

```bash
# Cluster output tables
psql < sql/pipeline_clusters.sql

# Source table (if not already created by the ingestion pipeline)
psql < sql/community_messages_clean.sql
```

---

## Tuning Boundary Detection

All tunable constants are in `pipeline/pipeline.config.js`:

| Constant | Default | Effect |
|---|---|---|
| `BOUNDARY_WINDOW_SIZE` | 3 | Messages per side of boundary candidate. Higher = smoother curve, less sensitive. |
| `BOUNDARY_DEPTH_THRESHOLD` | 0.15 | Minimum depth score to declare a boundary. Lower = more boundaries (more segments). |
| `BOUNDARY_SMOOTHING_WINDOW` | 3 | Moving average window for depth scores. Higher = less noise, less responsive. |
| `MIN_SEGMENT_SIZE` | 3 | Discard boundaries that create segments smaller than this. |
| `MAX_SEGMENT_SIZE` | 80 | Force-split segments larger than this at their midpoint. |
| `CONTEXT_WINDOW_SIZE` | 3 | Messages per context block. Each block is embedded as one unit. |
| `CLASSIFIER_SAMPLE_SIZE` | 15 | Segments sampled for category discovery. Higher = more diverse categories. |
| `CLASSIFIER_BATCH_SIZE` | 10 | Segments per classification API call. Higher = faster but more rate limit risk. |

**Tips:**
- If topics are getting merged that shouldn't be, decrease `BOUNDARY_DEPTH_THRESHOLD`.
- If too many tiny segments appear, increase `BOUNDARY_DEPTH_THRESHOLD` or `MIN_SEGMENT_SIZE`.
- If the pipeline is slow, reduce `EMBEDDING_CONCURRENCY` or increase `EMBEDDING_BATCH_DELAY_MS` to avoid rate limits.

---

## Logging

All output is structured JSON (one object per line):

```json
{
  "level": "info",
  "timestamp": "2026-03-27T12:00:00.000Z",
  "batchId": "uuid-here",
  "step": "orchestrator",
  "message": "Pipeline complete",
  "data": {
    "durationMs": 45000,
    "messageCount": 1200,
    "segmentCount": 45,
    "contextBlockCount": 1150,
    "clusterCount": 12,
    "messageRows": 1100
  }
}
```

Key logged events: pipeline start, boundary detection stats, context block count, embedding success/failure counts, Qdrant upsert count, cluster stats, Supabase write count, pipeline completion with total duration.

---

## File Structure

```
/pipeline
  /src
    index.js                  ← Orchestrator — runs the full pipeline
    fetchMessages.js          ← Step 1: Supabase cursor-based message fetch
    boundaryDetection.js      ← Step 2: TextTiling cosine boundary detector
    contextBuilder.js         ← Step 3: Context block construction (UUIDs)
    embedder.js               ← Steps 2 & 4: Cloudflare Workers AI embedding
    qdrantClient.js           ← Step 5: Qdrant upsert + batch retrieval
    classifier.js             ← Step 6: LLM topic classification
    storeResults.js           ← Step 7: Cluster results to Supabase (with UUIDs)
    topicSummarizer.js        ← Step 8: Generate LLM summaries per topic
    batchTracker.js           ← Redis distributed lock + batch dedup
    logger.js                 ← Structured JSON logger
  pipeline.config.js          ← All tunable constants
  README.md                   ← This file
```

---

## Known Limitations

- **Segment-level granularity, not token-level.** Boundaries are detected between messages, not within a single message. If one long message covers two topics, it stays in one segment. This is an inherent trade-off of message-level processing.
- **No language detection.** The embedding model handles multilingual input. No language-specific preprocessing is applied, which works well for multilingual communities but means no language-aware optimizations.
- **Short messages embed poorly.** Messages like `"ok"`, `"lol"`, `"yes"` produce noisy embeddings. The cleaning stage is responsible for filtering these; the pipeline does not skip them.
- **Not real-time.** This is a batch-only pipeline designed for 12-hour runs. It does not process messages as they arrive.

---

## Safety Guarantees

- **No existing code touched.** All pipeline code lives in `/pipeline`. No bot, RAG, or moderation files were modified.
- **Distributed lock always released.** The Redis lock is released in a `finally` block — it cannot leak even on crash.
- **Partial failures roll back.** Supabase writes for a batch either fully succeed or fully fail. Half-written clusters are not possible.
- **Failed embeddings are isolated.** If one context block's embedding fails, only that block is skipped. The rest of the pipeline continues.
- **Idempotent re-runs.** Batch tracking via Redis prevents re-processing the same messages.

---

## Changelog

### v2.0 — Real UUIDs for Context Blocks (Latest)
- **Fixed:** `context_block_id` now stores actual UUIDs from `contextBuilder.js` instead of segment index strings
- **Fixed:** `messages_per_hour` calculation now uses 1-minute minimum (was 1-hour) for accurate short-cluster metrics
- **Changed:** `storeResults.js` now builds context blocks before storing, mapping messages to their anchor context block UUID
- **Changed:** Supabase Edge Function (`pipeline-cron/index.ts`) now includes `buildContextBlocks()` function
- **Docs:** Updated schema to reflect `context_block_id` as UUID with traceability to Qdrant vectors

### v1.0 — Initial Implementation
- TextTiling boundary detection with cosine similarity
- LLM classification via Cloudflare Workers AI (Llama 3.3 70B)
- Context block construction with sliding windows
- Qdrant vector storage for RAG retrieval
- Date-isolated storage in Supabase
