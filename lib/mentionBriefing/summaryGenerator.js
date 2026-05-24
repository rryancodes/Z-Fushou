// lib/mentionBriefing/summaryGenerator.js
// Semantic ranking + LLM summary generation for monitored mentions.
// Uses the same Cloudflare embedding + chat models as the rest of the system.

const { embed, embedBatch } = require('../cloudflare');
const { chat } = require('../cloudflare');

const MAX_CONTEXT_MESSAGES = 8;

// ── Semantic ranking ──────────────────────────────────────────────────

/**
 * Compute cosine similarity between two vectors.
 */
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank context messages by semantic relevance to the mention message.
 * Returns trimmed array capped at MAX_CONTEXT_MESSAGES.
 *
 * The mention message is always kept (ranked first).
 * Other messages are ranked by cosine similarity to the mention embedding.
 */
async function semanticRank(candidates) {
  if (!candidates || candidates.length <= 2) return candidates;

  // Separate the mention message from the rest
  const mentionMsg = candidates.find(m => m.is_mention);
  const others = candidates.filter(m => !m.is_mention);

  if (!mentionMsg || others.length === 0) return candidates;

  // Embed the mention message as the query
  const mentionText = buildEmbeddingText(mentionMsg);
  const mentionEmbedding = await embed(mentionText);

  // Embed all other messages in batch
  const otherTexts = others.map(buildEmbeddingText);
  const otherEmbeddings = await embedBatch(otherTexts);

  // Score and sort by similarity (descending)
  const scored = others.map((msg, i) => ({
    msg,
    score: cosineSimilarity(mentionEmbedding, otherEmbeddings[i]),
  }));

  scored.sort((a, b) => b.score - a.score);

  // Keep top N (leaving room for the mention message itself)
  const keepCount = Math.max(1, MAX_CONTEXT_MESSAGES - 1);
  const topOthers = scored.slice(0, keepCount).map(s => s.msg);

  // Reassemble: mention message + top ranked, sorted chronologically
  const result = [mentionMsg, ...topOthers];
  result.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return result;
}

/**
 * Build a concise text representation for embedding.
 * Strips Discord mention markup for cleaner semantic matching.
 */
function buildEmbeddingText(msg) {
  let text = msg.content || '';
  // Replace <@123456> with plain text
  text = text.replace(/<@!?(\d+)>/g, '@user');
  // Replace <#123456> with plain text
  text = text.replace(/<#(\d+)>/g, '#channel');
  // Truncate for embedding model
  return text.slice(0, 2000) || '(empty message)';
}

// ── LLM summary generation ───────────────────────────────────────────

const SYSTEM_PROMPT = `You write urgent, punchy issue alerts for a team dashboard.
Given Discord messages where a staff member was pinged, write a FOMO-style brief that makes the reader want to click and respond immediately.

Rules:
- Maximum 2 short lines
- Use simple everyday English — no fancy words, no jargon
- Start directly with the issue — NEVER start with "User is", "Customer is", "Someone is", or any preamble
- Lead with the subject: the product, feature, or problem itself
- Make it feel urgent and specific (names of features, error details, dollar amounts)
- Do NOT mention any usernames or Discord IDs
- Do NOT quote messages verbatim
- Output plain text only, no formatting

Good: "Claude Pro X3 rate limiting has been broken for a month — people are asking for refunds."
Bad: "User is reporting rate limiting issues and wants a refund."`;

/**
 * Build the user prompt for the LLM from the final context messages.
 */
function buildSummaryPrompt(candidates, mentionedUserIds) {
  const lines = candidates.map(m => {
    const time = new Date(m.timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const marker = m.is_mention ? ' ← MENTION MESSAGE' : '';
    return `[${time}] ${m.username}: ${m.content || '(empty)'}${marker}`;
  });

  const mentionLabel = 'The message marked with ← MENTION MESSAGE is the monitored mention.';

  return [
    'Context messages around the monitored mention:',
    '',
    ...lines,
    '',
    mentionLabel,
    '',
    'Write a 1-2 sentence issue brief for this mention.',
  ].filter(Boolean).join('\n');
}

/**
 * Generate a summary for a mention given its context candidates.
 * Returns the summary string, or null on failure.
 */
async function generateSummary(candidates, mentionedUserIds) {
  const prompt = buildSummaryPrompt(candidates, mentionedUserIds);

  try {
    const messages = [
      { role: 'user', content: prompt },
    ];

    const summary = await chat(SYSTEM_PROMPT, messages);

    if (!summary || typeof summary !== 'string' || !summary.trim()) {
      console.error('[mentionBriefing] LLM returned empty response');
      return null;
    }

    // Cap summary length — should be short but enforce a hard limit
    return summary.slice(0, 500);
  } catch (err) {
    console.error('[mentionBriefing] LLM call failed:', err.message);
    return null;
  }
}

module.exports = {
  semanticRank,
  generateSummary,
};
