const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { withRetry } = require('./retry');
const { normalize, isNormalized } = require('./vector');

function embeddingEndpoint() {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${LIVE_CONFIG.EMBEDDING_MODEL}`;
}

function chatEndpoint() {
  return `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1/chat/completions`;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function embedText(text, context = {}) {
  return withRetry(async () => {
    const res = await fetchWithTimeout(embeddingEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: [String(text || '').slice(0, 8000)],
        pooling: 'cls',
      }),
    }, 15000);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cloudflare embed failed: ${res.status} ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    const vector = json?.result?.data?.[0];
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new Error(`Cloudflare embed returned empty vector: ${JSON.stringify(json).slice(0, 300)}`);
    }

    return isNormalized(vector) ? vector : normalize(vector);
  }, {
    stage: 'Embedding',
    logger,
    context,
    failureMetric: 'embeddingFailures',
  });
}

async function callLLM(systemPrompt, userContent, context = {}) {
  return withRetry(async () => {
    const res = await fetchWithTimeout(chatEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LIVE_CONFIG.CHAT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        max_tokens: 1200,
      }),
    }, 30000);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Cloudflare LLM failed: ${res.status} ${body.slice(0, 500)}`);
    }

    const json = await res.json();
    let content = json?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`Cloudflare LLM returned empty content: ${JSON.stringify(json).slice(0, 300)}`);
    }

    if (typeof content === 'object') {
      content = JSON.stringify(content);
    }

    return {
      content,
      usage: json.usage || { total_tokens: 0 },
    };
  }, {
    stage: 'LLM',
    logger,
    context,
    failureMetric: 'llmFailures',
  });
}

module.exports = { embedText, callLLM };
