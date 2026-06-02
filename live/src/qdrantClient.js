const crypto = require('crypto');
const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { withRetry } = require('./retry');

function qdrantUrl(path) {
  return `${process.env.QDRANT_URL.replace(/\/$/, '')}${path}`;
}

function headers() {
  return {
    'Content-Type': 'application/json',
    'api-key': process.env.QDRANT_API_KEY,
  };
}

function pointIdForMessage(messageId) {
  const hash = crypto.createHash('sha256').update(String(messageId)).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function qdrantRetry(stage, fn, context = {}) {
  return withRetry(fn, {
    stage,
    logger,
    context,
    retries: LIVE_CONFIG.RETRY_COUNT,
    baseDelayMs: LIVE_CONFIG.RETRY_BASE_MS,
  });
}

async function ensureCollectionExists() {
  return qdrantRetry('Qdrant ensure live collection', async () => {
    const collection = LIVE_CONFIG.QDRANT_COLLECTION;
    const existing = await fetch(qdrantUrl(`/collections/${collection}`), {
      headers: { 'api-key': process.env.QDRANT_API_KEY },
    });

    if (existing.ok) {
      logger.info('Qdrant', 'Live collection exists', { collection });
      await ensurePayloadIndexes();
      return;
    }

    if (existing.status !== 404) {
      const body = await existing.text();
      throw new Error(`Qdrant collection check failed: ${existing.status} ${body.slice(0, 300)}`);
    }

    const created = await fetch(qdrantUrl(`/collections/${collection}`), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        vectors: {
          size: LIVE_CONFIG.QDRANT_VECTOR_SIZE,
          distance: 'Cosine',
        },
      }),
    });

    if (!created.ok) {
      const body = await created.text();
      throw new Error(`Qdrant collection create failed: ${created.status} ${body.slice(0, 300)}`);
    }

    logger.info('Qdrant', 'Created live collection', { collection });
    await ensurePayloadIndexes();
  });
}

async function ensurePayloadIndexes() {
  const fields = ['case_status', 'guild_id', 'channel_id', 'thread_id', 'case_id'];

  for (const field of fields) {
    const res = await fetch(qdrantUrl(`/collections/${LIVE_CONFIG.QDRANT_COLLECTION}/index`), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        field_name: field,
        field_schema: 'keyword',
      }),
    });

    if (!res.ok && res.status !== 409) {
      const body = await res.text();
      if (!body.toLowerCase().includes('already')) {
        throw new Error(`Qdrant index create failed for ${field}: ${res.status} ${body.slice(0, 300)}`);
      }
    }
  }

  logger.info('Qdrant', 'Live payload indexes ensured', {
    collection: LIVE_CONFIG.QDRANT_COLLECTION,
    fields,
  });
}

function threadCondition(threadId) {
  if (threadId) {
    return { key: 'thread_id', match: { value: threadId } };
  }
  return { is_empty: { key: 'thread_id' } };
}

function activeCaseFilter(message) {
  return {
    must: [
      { key: 'case_status', match: { value: 'open' } },
      { key: 'guild_id', match: { value: message.guild_id } },
      { key: 'channel_id', match: { value: message.channel_id } },
      threadCondition(message.thread_id),
    ],
  };
}

async function searchActiveDiscussion(embedding, message) {
  return qdrantRetry('Qdrant search active discussion', async () => {
    const res = await fetch(qdrantUrl(`/collections/${LIVE_CONFIG.QDRANT_COLLECTION}/points/search`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        vector: embedding,
        limit: LIVE_CONFIG.QDRANT_SEARCH_LIMIT,
        with_payload: true,
        filter: activeCaseFilter(message),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant search failed: ${res.status} ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    const hits = json?.result || [];
    const best = hits.find((hit) => hit?.payload?.case_id && hit.score >= LIVE_CONFIG.MATCH_MIN_SCORE);
    if (!best) return null;

    logger.info('Qdrant', 'Matched active discussion', {
      caseId: best.payload.case_id,
      score: Number(best.score.toFixed(4)),
      messageId: message.message_id,
    });

    return {
      caseId: best.payload.case_id,
      score: best.score || 0,
      payload: best.payload,
    };
  }, { messageId: message.message_id });
}

async function upsertLiveMessage(message, caseRow, embedding) {
  return qdrantRetry('Qdrant upsert live message', async () => {
    const payload = {
      message_id: message.message_id,
      case_id: caseRow.id,
      guild_id: message.guild_id,
      channel_id: message.channel_id,
      thread_id: message.thread_id || null,
      created_at: message.timestamp || message.created_at || new Date().toISOString(),
      case_status: caseRow.status || 'open',
    };

    const res = await fetch(qdrantUrl(`/collections/${LIVE_CONFIG.QDRANT_COLLECTION}/points`), {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify({
        points: [{
          id: pointIdForMessage(message.message_id),
          vector: embedding,
          payload,
        }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant upsert failed: ${res.status} ${body.slice(0, 300)}`);
    }

    logger.info('Qdrant', 'Stored live message vector', {
      caseId: caseRow.id,
      messageId: message.message_id,
      collection: LIVE_CONFIG.QDRANT_COLLECTION,
    });
  }, { caseId: caseRow.id, messageId: message.message_id });
}

async function markCaseClosed(caseId) {
  return qdrantRetry('Qdrant mark case closed', async () => {
    const res = await fetch(qdrantUrl(`/collections/${LIVE_CONFIG.QDRANT_COLLECTION}/points/payload`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        payload: { case_status: 'closed' },
        filter: {
          must: [
            { key: 'case_id', match: { value: caseId } },
          ],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant payload update failed: ${res.status} ${body.slice(0, 300)}`);
    }
  }, { caseId });
}

async function fetchRecentCaseEmbeddings(caseId, limit = LIVE_CONFIG.REBUILD_MESSAGE_LIMIT) {
  return qdrantRetry('Qdrant fetch case embeddings', async () => {
    const res = await fetch(qdrantUrl(`/collections/${LIVE_CONFIG.QDRANT_COLLECTION}/points/scroll`), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        limit,
        with_payload: true,
        with_vector: true,
        filter: {
          must: [
            { key: 'case_id', match: { value: caseId } },
            { key: 'case_status', match: { value: 'open' } },
          ],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Qdrant scroll failed: ${res.status} ${body.slice(0, 300)}`);
    }

    const json = await res.json();
    return (json?.result?.points || [])
      .map((point) => ({
        id: point.id,
        vector: point.vector,
        payload: point.payload || {},
      }))
      .filter((point) => Array.isArray(point.vector))
      .sort((a, b) => String(a.payload.created_at || '').localeCompare(String(b.payload.created_at || '')))
      .slice(-limit);
  }, { caseId });
}

module.exports = {
  ensureCollectionExists,
  ensurePayloadIndexes,
  searchActiveDiscussion,
  upsertLiveMessage,
  markCaseClosed,
  fetchRecentCaseEmbeddings,
  pointIdForMessage,
};
