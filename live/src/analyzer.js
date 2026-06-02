const { callLLM } = require('./cloudflare');
const { extractJSONObject } = require('./json');
const logger = require('./logger');

const VALID_STATUS = new Set(['active', 'investigating', 'resolved', 'dormant']);
const VALID_ROUTING = new Set(['product-side', 'user-side', 'mixed', 'unknown']);
const VALID_ATTENTION = new Set(['low', 'medium', 'high', 'critical']);

const MAX_SUMMARY_LENGTH = 500;
const MAX_TIMELINE_ENTRIES = 20;
const MAX_UNRESOLVED_QUESTIONS = 5;

function normalizeArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeTimeline(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return { time: null, summary: item.trim() };
      }
      return {
        time: item?.time ? String(item.time) : null,
        summary: item?.summary ? String(item.summary).trim() : '',
      };
    })
    .filter((item) => item.summary)
    .slice(-MAX_TIMELINE_ENTRIES);
}

function normalizeAnalysis(parsed) {
  const currentStatus = String(parsed.current_status || parsed.status || 'active').toLowerCase();
  const routingType = String(parsed.routing_type || 'unknown').toLowerCase();
  const attentionScore = String(parsed.attention_score || 'low').toLowerCase();

  return {
    summary: String(parsed.summary || '').trim().slice(0, MAX_SUMMARY_LENGTH),
    current_status: VALID_STATUS.has(currentStatus) ? currentStatus : 'active',
    routing_type: VALID_ROUTING.has(routingType) ? routingType : 'unknown',
    attention_score: VALID_ATTENTION.has(attentionScore) ? attentionScore : 'low',
    timeline: normalizeTimeline(parsed.timeline),
    unresolved_questions: normalizeArray(parsed.unresolved_questions).slice(0, MAX_UNRESOLVED_QUESTIONS),
    event_summary: parsed.event_summary ? String(parsed.event_summary).trim() : null,
  };
}

function formatMessages(messages, limit = 40) {
  return messages.slice(-limit).map((message) => {
    const ts = message.timestamp || message.created_at || '';
    const user = message.username || message.user_id || 'unknown';
    return `[${ts}] ${user}: ${message.content}`;
  }).join('\n');
}

async function analyzeCase({ trigger, caseRow, messages }) {
  const systemPrompt = [
    'You are a real-time Discord incident and topic tracking analyst.',
    'Track the current state of one active discussion, not a whole day.',
    'Decide ownership only as product-side, user-side, mixed, or unknown.',
    'Only add timeline entries for significant changes, confirmations, resolution, scope changes, or important new facts.',
    'Return raw JSON only.',
  ].join(' ');

  const userPrompt = `Analyze this live discussion for trigger "${trigger}".

Existing case:
${JSON.stringify({
  id: caseRow?.id || null,
  summary: caseRow?.summary || null,
  current_status: caseRow?.current_status || null,
  routing_type: caseRow?.routing_type || null,
  attention_score: caseRow?.attention_score || null,
  timeline: caseRow?.timeline || [],
  unresolved_questions: caseRow?.unresolved_questions || [],
  message_count: caseRow?.message_count || messages.length,
}, null, 2)}

Messages:
${formatMessages(messages)}

Return ONLY this JSON object:
{
  "summary": "2-4 sentence current summary with concrete product/issue details (max 500 chars)",
  "current_status": "active | investigating | resolved | dormant",
  "routing_type": "product-side | user-side | mixed | unknown",
  "attention_score": "low | medium | high | critical",
  "timeline": [{"time":"ISO timestamp or null","summary":"significant event"}],
  "unresolved_questions": ["question still unanswered (max 5)"],
  "event_summary": "one sentence explaining what changed for this trigger"
}`;

  const { content } = await callLLM(systemPrompt, userPrompt, {
    stage: 'Timeline generation',
    caseId: caseRow?.id,
  });
  const jsonStr = extractJSONObject(content);
  if (!jsonStr) {
    logger.error('Timeline generation', 'LLM response did not contain JSON', {
      caseId: caseRow?.id,
      rawResponse: content.slice(0, 1000),
    });
    throw new Error('No JSON object found in live analysis response');
  }

  const parsed = JSON.parse(jsonStr);
  const analysis = normalizeAnalysis(parsed);
  if (!analysis.summary) {
    throw new Error('Live analysis returned empty summary');
  }

  return analysis;
}

module.exports = {
  analyzeCase,
  normalizeAnalysis,
  formatMessages,
};
