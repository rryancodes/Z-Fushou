# Live Incident & Topic Tracking Engine

Separate real-time semantic worker for active discussions. It reads new rows from
`community_messages_clean` where `live_processed_at IS NULL`, enriches them with
`guild_id` and `thread_id` from `community_messages`, stores live message vectors
in Qdrant, and writes business records to:

- `live_cases`
- `live_case_messages`
- `live_case_events`

The daily `/pipeline` code path is not used by this worker.

## Qdrant

Live vectors use a separate collection from the daily pipeline:

```text
live_discussion_messages
```

Override with `LIVE_QDRANT_COLLECTION` if needed. Do not point this at
`QDRANT_PIPELINE_COLLECTION`.

Each point uses the message embedding and this payload:

```json
{
  "message_id": "...",
  "case_id": "...",
  "guild_id": "...",
  "channel_id": "...",
  "thread_id": "...",
  "created_at": "...",
  "case_status": "open"
}
```

On startup, the worker loads open cases from Supabase, fetches the latest live
vectors for each case from Qdrant, reconstructs centroids in memory, and resumes.

## Run

```bash
npm run live       # long-running Railway worker
npm run live:once  # one poll/closure tick for smoke tests
```

For Railway, create a separate service with start command:

```bash
npm run live
```

## Required env

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `CF_ACCOUNT_ID`
- `CF_API_TOKEN`
- `QDRANT_URL`
- `QDRANT_API_KEY`

## Optional tuning

- `LIVE_ENGINE_POLL_INTERVAL_MS` default `15000`
- `LIVE_ENGINE_FETCH_LIMIT` default `25`
- `LIVE_ENGINE_QUIET_TIME_MINUTES` default `10`
- `LIVE_ENGINE_SIMILARITY_THRESHOLD` default `0.62`
- `LIVE_ENGINE_COHESION_DROP_THRESHOLD` default `0.16`
- `LIVE_ENGINE_TIMELINE_UPDATE_MIN_MESSAGES` default `3`
- `LIVE_QDRANT_COLLECTION` default `live_discussion_messages`
- `LIVE_QDRANT_SEARCH_LIMIT` default `8`
- `LIVE_QDRANT_VECTOR_SIZE` default `1024`
- `LIVE_ENGINE_CHAT_MODEL` default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`
- `CLOUDFLARE_EMBEDDING_MODEL` default `@cf/baai/bge-large-en-v1.5`

## Processing rules

- No fixed message-count segmentation.
- New messages are routed by Qdrant nearest-neighbor search over active live
  discussion messages in the same guild/channel/thread.
- Boundary requires both low similarity to the active case centroid and a
  cohesion drop from the previous state.
- LLM runs only on new case creation, boundary closure, quiet-time closure, and
  gated significant timeline updates.
- Rows are marked with `live_processed_at` only after successful handling.
- Qdrant point payloads are marked `case_status: closed` when the case closes.
- Failures are logged with stage, case ID where available, message ID, and error.
