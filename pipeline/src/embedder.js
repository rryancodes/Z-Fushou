const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const CF_BASE = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run`;
const CF_TOKEN = process.env.CF_API_TOKEN;
const EMBEDDING_MODEL = PIPELINE_CONFIG.EMBEDDING_MODEL;

/**
 * Normalize a vector to unit length. Returns zero vector if input is zero.
 * @param {number[]} vec
 * @returns {number[]}
 */
function normalize(vec) {
  const mag = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (mag === 0) return new Array(vec.length).fill(0);
  return vec.map(v => v / mag);
}

/**
 * Call Cloudflare embedding API for a batch of texts.
 * Uses pooling: 'cls' to match lib/cloudflare.js pattern.
 *
 * @param {string[]} texts - array of text strings
 * @param {number} timeoutMs
 * @returns {Promise<number[][]>} array of vectors
 */
async function callEmbeddingAPI(texts, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${CF_BASE}/${EMBEDDING_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: texts.map(t => t.slice(0, 8000)),
        pooling: 'cls',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Cloudflare embed API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const json = await res.json();
    const vectors = json?.result?.data;

    if (!vectors || !Array.isArray(vectors) || vectors.length === 0) {
      throw new Error(`Empty embeddings from API. Response: ${JSON.stringify(json).slice(0, 300)}`);
    }

    return vectors;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sleep helper with jitter (±50ms).
 * @param {number} baseMs
 * @returns {Promise<void>}
 */
function sleepWithJitter(baseMs) {
  const jitter = Math.round((Math.random() - 0.5) * 100);
  return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
}

/**
 * Helper to embed a batch of texts with retry logic.
 * @param {string[]} texts
 * @returns {Promise<number[][]|null>} array of normalized vectors, or null if batch failed
 */
async function embedBatchWithRetry(texts) {
  const maxRetries = PIPELINE_CONFIG.EMBEDDING_MAX_RETRIES;
  const baseDelay = PIPELINE_CONFIG.EMBEDDING_RETRY_BASE_MS;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const vectors = await callEmbeddingAPI(texts, 30000);
      return vectors.map(vec => normalize(vec));
    } catch (err) {
      const isLast = attempt === maxRetries;
      logger.warn('embedder', `Batch embedding attempt ${attempt}/${maxRetries} failed: ${err.message}`, {
        batchSize: texts.length,
      });
      if (isLast) return null;
      await sleepWithJitter(baseDelay * Math.pow(2, attempt - 1));
    }
  }
  return null;
}

/**
 * Step 2: Embed each message's content for boundary detection.
 * Batches API calls using chunks of 100 to maximize throughput.
 *
 * @param {Array<{content: string}>} messages
 * @returns {Promise<Map<number, number[]>>} message index → normalized vector (zero vec on failure)
 */
async function embedMessagesForDetection(messages) {
  // Cloudflare often limits payload sizes or rate limits heavily. Let's send smaller, safer batches
  const batchSize = 10;
  const concurrency = 2;
  const delayMs = 500;

  const results = new Map();
  let failCount = 0;

  // Split into API-sized batches (e.g. 100 messages each)
  const apiBatches = [];
  for (let i = 0; i < messages.length; i += batchSize) {
    apiBatches.push(messages.slice(i, i + batchSize));
  }

  // Process batch groups concurrently
  for (let i = 0; i < apiBatches.length; i += concurrency) {
    const batchGroup = apiBatches.slice(i, i + concurrency);

    // Each element in batchGroup is an array of messages
    const promises = batchGroup.map(async (batch, groupIdx) => {
      const globalOffset = (i + groupIdx) * batchSize;
      const texts = batch.map(msg => msg.content);

      const vectors = await embedBatchWithRetry(texts);

      if (!vectors) {
        // Entire batch failed — assign zero vectors
        failCount += batch.length;
        for (let j = 0; j < batch.length; j++) {
          results.set(globalOffset + j, new Array(1024).fill(0));
        }
      } else {
        // Success — map vectors to global indices
        for (let j = 0; j < batch.length; j++) {
          results.set(globalOffset + j, vectors[j]);
        }
      }
    });

    await Promise.all(promises);

    if (i + concurrency < apiBatches.length) {
      await sleepWithJitter(delayMs);
    }
  }

  logger.info('embedder', `Detection embedding complete`, {
    total: messages.length,
    failed: failCount,
    success: messages.length - failCount,
    apiBatches: apiBatches.length
  });

  return results;
}

/**
 * Step 4: Embed context blocks in batches for final vector generation.
 * Groups blocks into API-sized batches, processes with concurrency.
 *
 * @param {Array<{contextBlockId: string, contextText: string}>} blocks
 * @returns {Promise<Array>} blocks enriched with `vector` or `embeddingFailed: true`
 */
async function embedContextBlocks(blocks) {
  if (blocks.length === 0) return [];

  const batchSize = PIPELINE_CONFIG.EMBEDDING_BATCH_SIZE;
  const concurrency = PIPELINE_CONFIG.EMBEDDING_CONCURRENCY;
  const delayMs = PIPELINE_CONFIG.EMBEDDING_BATCH_DELAY_MS;
  const maxRetries = PIPELINE_CONFIG.EMBEDDING_MAX_RETRIES;
  const baseDelay = PIPELINE_CONFIG.EMBEDDING_RETRY_BASE_MS;

  // Split into API-sized batches
  const apiBatches = [];
  for (let i = 0; i < blocks.length; i += batchSize) {
    apiBatches.push(blocks.slice(i, i + batchSize));
  }

  let apiCallCount = 0;
  let successCount = 0;
  let failCount = 0;

  // Process apiBatches with concurrency
  for (let i = 0; i < apiBatches.length; i += concurrency) {
    const batchGroup = apiBatches.slice(i, i + concurrency);

    const promises = batchGroup.map(async (batch) => {
      const texts = batch.map(b => b.contextText);

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          apiCallCount++;
          const vectors = await callEmbeddingAPI(texts);
          // Enrich each block with its normalized vector
          for (let j = 0; j < batch.length; j++) {
            batch[j].vector = normalize(vectors[j]);
          }
          successCount += batch.length;
          return; // success
        } catch (err) {
          const isLast = attempt === maxRetries;
          logger.warn('embedder', `Context batch attempt ${attempt}/${maxRetries} failed: ${err.message}`, {
            batchSize: batch.length,
          });
          if (isLast) {
            // Mark all blocks in this batch as failed
            for (const block of batch) {
              block.embeddingFailed = true;
            }
            failCount += batch.length;
            return;
          }
          await sleepWithJitter(baseDelay * Math.pow(2, attempt - 1));
        }
      }
    });

    await Promise.all(promises);

    if (i + concurrency < apiBatches.length) {
      await sleepWithJitter(delayMs);
    }
  }

  logger.info('embedder', `Context block embedding complete`, {
    total: blocks.length,
    success: successCount,
    failed: failCount,
    apiCalls: apiCallCount,
  });

  return blocks;
}

module.exports = { normalize, callEmbeddingAPI, embedMessagesForDetection, embedContextBlocks };
