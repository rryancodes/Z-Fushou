const PIPELINE_CONFIG = {
  // TextTiling parameters
  BOUNDARY_WINDOW_SIZE: 3,
  BOUNDARY_DEPTH_THRESHOLD: 0.15,
  BOUNDARY_SMOOTHING_WINDOW: 3,

  // Segment constraints
  MIN_SEGMENT_SIZE: 3,
  MAX_SEGMENT_SIZE: 80,

  // Context block construction
  CONTEXT_WINDOW_SIZE: 3,
  CONTEXT_WINDOW_STEP: 1,


  // Embedding — final pass (Step 4)
  EMBEDDING_BATCH_SIZE: 100,
  EMBEDDING_CONCURRENCY: 10,
  EMBEDDING_BATCH_DELAY_MS: 300,
  EMBEDDING_RETRY_BASE_MS: 200,
  EMBEDDING_MAX_RETRIES: 3,


  // LLM Classifier (primary clustering path)
  CHAT_MODEL: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  CLASSIFIER_SAMPLE_SIZE: 15,        // segments sampled for category discovery
  CLASSIFIER_PREVIEW_MESSAGES: 20,   // max messages per segment in LLM prompt (minimum 20)
  CLASSIFIER_BATCH_SIZE: 10,         // segments per classification API call
  CLASSIFIER_BATCH_DELAY_MS: 500,    // delay between classification batches
  CLASSIFIER_MAX_RETRIES: 3,
  CLASSIFIER_RETRY_BASE_MS: 500,

  // Qdrant
  QDRANT_UPSERT_BATCH_SIZE: 100,
  QDRANT_RETRY_COUNT: 5,
  QDRANT_RETRY_DELAY_MS: 1000,

  // Pipeline
  BATCH_WINDOW_HOURS: 12,
  FETCH_CHUNK_SIZE: 1000,

  // Redis lock
  LOCK_TTL_SECONDS: 900, // 15 minutes
  LOCK_KEY: 'pipeline:semantic:lock',
  BATCH_STATUS_KEY_PREFIX: 'pipeline:semantic:batch:',
  LAST_BATCH_KEY: 'pipeline:semantic:last_batch',

  // Embedding model (must match lib/cloudflare.js)
  EMBEDDING_MODEL: process.env.CLOUDFLARE_EMBEDDING_MODEL || '@cf/baai/bge-large-en-v1.5',

  // Required env vars — validated at startup
  REQUIRED_ENV_VARS: [
    'CF_ACCOUNT_ID',
    'CF_API_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_KEY',
    'QDRANT_URL',
    'QDRANT_API_KEY',
    'QDRANT_PIPELINE_COLLECTION',
    // 'GENERAL_CHAT_CHANNEL_ID', // Not needed if community_messages_clean is pre-populated
  ],

  // Optional env vars
  OPTIONAL_ENV_VARS: ['REDIS_URL'],
};

module.exports = { PIPELINE_CONFIG };
