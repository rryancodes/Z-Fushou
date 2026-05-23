# Z-Fushou — Discord Message Ingestion & Cleaning Bot

A silent Discord bot that ingests messages from configured channels into Supabase and runs an autonomous cleaning pipeline. No replies, no AI, no support workflows — pure data collection and processing.

## Architecture

```
Discord Messages
      │
      ▼
┌─────────────────────────────────────┐
│  messageListener.js                 │  Real-time ingestion
│  ├─ Filter: bot/system/empty        │
│  ├─ Filter: channel whitelist       │
│  ├─ Filter: MIN_MESSAGE_DATE        │
│  └─ Enqueue → batchWriter           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  batchWriter.js                     │  In-memory queue
│  ├─ Flush every 10s or 50 msgs     │
│  └─ bulkInsert → Supabase           │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  community_messages (Supabase)      │  Raw message storage
│  ├─ message_id (PK, text)           │
│  ├─ channel_id, thread_id           │
│  ├─ user_id, username               │
│  ├─ content, attachments (JSONB)    │
│  ├─ is_monitored_mention            │
│  ├─ mentioned_user_ids              │
│  ├─ is_cleaned (boolean)            │
│  └─ cleaned_message_id              │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  cleanWorker.js (autonomous loop)   │  Every N minutes
│  ├─ Phase 1: Filter noise           │
│  ├─ Phase 2: Normalize mentions     │
│  │   <@id> → <mentioned_username>   │
│  ├─ Phase 3: Normalize text         │
│  │   Strip markdown, lowercase      │
│  ├─ Phase 4: Upsert to clean table  │
│  └─ Phase 5: Mark raw as cleaned    │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  community_messages_clean           │  Cleaned message storage
│  ├─ id (PK, auto)                   │
│  ├─ message_id (FK → raw)           │
│  ├─ channel_id, thread_id           │
│  ├─ user_id, username               │
│  └─ clean_content                   │
└─────────────────────────────────────┘
```

## Features

### Ingestion
- **Real-time capture** — Listens to `messageCreate` events from configured channels
- **Thread support** — Automatically captures messages inside threads belonging to watched parent channels
- **Batch writing** — In-memory queue flushes to Supabase every 10 seconds or 50 messages (whichever comes first)
- **Checkpoint-based backfill** — On startup, fetches missed messages since last checkpoint per channel
- **Minimum date boundary** — `MIN_MESSAGE_DATE` env var rejects messages older than a configurable cutoff
- **Reply reference tracking** — Stores `message.reference` (replied-to message ID, channel, guild) in the `attachments` JSONB field
- **Monitored mention detection** — Flags messages that mention specific users (ambassadors/officials) with `is_monitored_mention` and `mentioned_user_ids`

### Cleaning Pipeline
- **Autonomous loop** — Runs on a configurable interval (default: 5 minutes)
- **5-phase processing:**
  1. **Noise filtering** — Skips emoji-only, short acknowledgements, duplicates
  2. **Mention normalization** — Batch resolves `<@id>` → `<mentioned_username>` using bulk username lookup
  3. **Text normalization** — Strips markdown, lowercases, removes special characters (preserves `<mentioned_>` tokens)
  4. **Upsert to clean table** — Inserts into `community_messages_clean`
  5. **Flag raw rows** — Sets `is_cleaned = TRUE` + `cleaned_message_id` on the original row
- **Retention cleanup** — Configurable retention period for old raw messages

## Project Structure

```
index.js                              # Entry point — starts ingestion + cleaning
lib/
├── supabase.js                       # Supabase client singleton
├── ingestion/
│   ├── index.js                      # Ingestion init (channels, backfill, batch writer)
│   ├── messageListener.js            # Discord messageCreate handler + filters
│   ├── ingestionCheckpoint.js        # structureMessage(), backfill(), mention detection
│   ├── batchWriter.js                # In-memory queue + periodic flush
│   ├── messageQueue.js               # Queue data structure
│   └── supabaseClient.js             # bulkInsert, checkpoint read/write
├── cleaning/
│   ├── index.js                      # Autonomous loop (start/stop)
│   ├── cleanWorker.js                # 5-phase cleaning pipeline
│   ├── mentionNormalizer.js          # Batch <@id> → <mentioned_username>
│   ├── normalizeText.js              # Text normalization with token preservation
│   ├── noiseFilters.js               # Emoji-only, acknowledgement, duplicate detection
│   └── retentionCleanup.js           # Old message retention + summary storage
```

## Environment Variables

### Required (Active)

| Variable | Description | Example |
|---|---|---|
| `DISCORD_TOKEN` | Bot token from Discord Developer Portal | `MTQ4...` |
| `CLIENT_ID` | Bot application ID | `1483052099133509683` |
| `INGESTION_CHANNELS` | Comma-separated channel IDs to ingest from | `chan1,chan2` |
| `SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `SUPABASE_KEY` | Supabase anon key | `eyJ...` |
| `SUPABASE_SERVICE_KEY` | Supabase service role key | `eyJ...` |

### Optional (Active)

| Variable | Description | Default |
|---|---|---|
| `MONITORED_USER_IDS` | Comma-separated user IDs to track mentions for | `""` (none) |
| `MIN_MESSAGE_DATE` | ISO 8601 UTC — messages older than this are ignored | `""` (no filter) |
| `CLEAN_INTERVAL_MINUTES` | Cleaning cycle interval in minutes | `5` |
| `LOG_PRETTY` | Pretty-print console logs | `false` |

### Disabled (For Future Use)

| Variable | Description |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account for AI/embeddings |
| `CF_API_TOKEN` | Cloudflare API token |
| `QDRANT_URL` | Qdrant vector DB URL |
| `QDRANT_API_KEY` | Qdrant API key |
| `QDRANT_PIPELINE_COLLECTION` | Qdrant collection name |
| `REDIS_URL` | Redis for BullMQ job queues |
| `GUILD_ID` | Server ID (only for slash commands) |
| `ROLE_BILLING` / `ROLE_PRODUCT` / `ROLE_TECHNICAL` / `ROLE_UNCLASSIFIED` | Support role IDs |
| `BAD_REPORT_CHANNEL_ID` | Channel for bad reports |
| `AUTO_BACKFILL` / `AUTO_RUN_PIPELINE` / `FORCE_FULL_PIPELINE` | Pipeline flags |

## Database Schema

### `community_messages` (raw)

| Column | Type | Description |
|---|---|---|
| `message_id` | `text` (PK) | Discord snowflake ID |
| `channel_id` | `text` | Parent channel ID (for threads: the parent channel) |
| `thread_id` | `text` | Thread ID (null for regular messages) |
| `guild_id` | `text` | Server ID |
| `user_id` | `text` | Author's Discord ID |
| `username` | `text` | Author's username |
| `content` | `text` | Raw message content |
| `timestamp` | `timestamptz` | Message creation time |
| `attachments` | `jsonb` | `{ attachments: [...], reply: { message_id, channel_id, guild_id } }` |
| `is_monitored_mention` | `boolean` | True if message mentions a monitored user |
| `mentioned_user_ids` | `text[]` | Array of monitored user IDs mentioned |
| `is_cleaned` | `boolean` | True after cleaning pipeline processes this row |
| `cleaned_message_id` | `int` | FK to `community_messages_clean.id` |

### `community_messages_clean` (cleaned)

| Column | Type | Description |
|---|---|---|
| `id` | `serial` (PK) | Auto-increment ID |
| `message_id` | `text` | Original Discord snowflake ID |
| `channel_id` | `text` | Channel ID |
| `thread_id` | `text` | Thread ID (nullable) |
| `user_id` | `text` | Author's Discord ID |
| `username` | `text` | Author's username |
| `clean_content` | `text` | Normalized content (mentions resolved, markdown stripped) |
| `timestamp` | `timestamptz` | Original message timestamp |

### `message_ingestion_state` (checkpoints)

| Column | Type | Description |
|---|---|---|
| `channel_id` | `text` (PK) | Channel ID |
| `last_message_id` | `text` | Last ingested message snowflake |

## Deployment

### Railway

1. Push to GitHub
2. Connect repo in Railway
3. Set all **Required** env vars in Railway → Service → Variables
4. Railway auto-deploys on push

### Local Development

```bash
npm install
cp .env.example .env   # Fill in your values
npm start
```

## Adding the Bot to a Server

Use this invite URL (replace `CLIENT_ID`):

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=66560&scope=bot
```

Required permissions (`66560`):
- **View Channels** (1024)
- **Read Message History** (65536)

**Critical:** Enable **Message Content Intent** in Discord Developer Portal → Bot → Privileged Gateway Intents.

## Moving to a New Server

1. Invite bot to new server (URL above)
2. Update env vars:
   - `INGESTION_CHANNELS` — new server's channel IDs
   - `MONITORED_USER_IDS` — new server's ambassador/official IDs
3. Restart the bot

No code changes needed — the bot is guild-agnostic.

## Disabled Features (Preserved in Codebase)

These modules exist but are not loaded by the current `index.js`:

- **AI Agent** (`lib/agent.js`) — RAG orchestration with Cloudflare Workers AI
- **Issue Management** (`lib/issues.js`) — Support ticket lifecycle
- **Department Routing** (`lib/departments.js`) — Auto-classification
- **Forwarding** (`lib/forward.js`) — Cross-channel issue forwarding
- **Notifications** (`lib/notify.js`) — DM status updates
- **Reminders** (`lib/reminders.js`) — Stale issue follow-ups
- **Pipeline** (`pipeline/`) — Semantic segmentation, embedding, Qdrant indexing
- **Slash Commands** (`commands/`) — `/report`, `/close`, `/resolve`, etc.
- **Job Queues** (`lib/queue.js`, `lib/workers.js`) — BullMQ workers

These can be re-enabled by restoring the original `index.js` and uncommenting the corresponding env vars.
