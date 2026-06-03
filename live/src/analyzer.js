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

const STATUS_KEYWORDS = ['resolved', 'investigating', 'dormant', 'active'];

function normalizeStatus(raw) {
  const value = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ');

  if (!value) {
    throw new Error(`Invalid current_status: empty or missing`);
  }

  for (const keyword of STATUS_KEYWORDS) {
    if (value.includes(keyword)) return keyword;
  }

  throw new Error(`Invalid current_status: "${raw}" — no known status keyword found`);
}

function normalizeAnalysis(parsed) {
  const routingType = String(parsed.routing_type || 'unknown').toLowerCase();
  const attentionScore = String(parsed.attention_score || 'low').toLowerCase();

  const currentStatus = normalizeStatus(parsed.current_status || parsed.status);

  return {
    summary: String(parsed.summary || '').trim().slice(0, MAX_SUMMARY_LENGTH),
    current_status: currentStatus,
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
    'You are a real-time Discord discussion analyst on a Z.AI product community server.',
    'Users discuss Z.AI products: GLM models, API (api.z.ai), coding tools, billing, plans,',
    'and related AI tools and services. This includes but is not limited to tools like',
    'Claude Code, VSCode extensions, Opencode, Cline, or similar coding assistants.',
    'Never assume a specific tool name if the user didn\'t say it — use exactly what they said.',
    '',
    'When users say "the API" they mean Z.AI API. "The model" means GLM. "My plan" means Z.AI subscription.',
    'Never write "unspecified product" or "no details provided" — infer from context.',
    '',
    'Your job is to identify WHAT users are talking about — not just problems or issues.',
    'Discussions can be: bug reports, feature requests, questions, feedback, comparisons,',
    'general discussion, or praise. Describe the topic accurately.',
    '',
    'SUMMARY RULES:',
    '- One single line describing what is being discussed.',
    '- Bad: "User reported a vague issue without providing details"',
    '- Bad: "Discussion about an unspecified product or service"',
    '- Good: "Z.AI API returns 500 errors on VSCode extension with GLM models"',
    '- Good: "User asks about token limits and context window for GLM 5.1"',
    '- Good: "Users comparing GLM vs DeepSeek for coding tasks"',
    '',
    'UNRESOLVED QUESTIONS RULES:',
    '- ONLY include questions that users ACTUALLY asked in their messages.',
    '- NEVER fabricate or invent questions.',
    '- If no user asked a question, return an empty array [].',
    '',
    'TIMELINE RULES:',
    '- Only add entries for significant changes, confirmations, resolution, scope changes, or important new facts.',
    '- Describe what was said, not meta-commentary about the discussion.',
    '',
    'Return raw JSON only.',
  ].join('\n');

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
  "summary": "one line describing what is being discussed",
  "current_status": "active | investigating | resolved | dormant",
  "routing_type": "product-side | user-side | mixed | unknown",
  "attention_score": "low | medium | high | critical",
  "timeline": [{"time":"ISO timestamp or null","summary":"what was said"}],
  "unresolved_questions": ["ONLY questions users actually asked in messages. Empty array if none asked."],
  "event_summary": "one line about the actual topic discussed"
}`;

  const { content } = await callLLM(systemPrompt, userPrompt, {
    stage: 'Timeline generation',
    caseId: caseRow?.id,
  });

  logger.info('Timeline generation', 'LLM response received', {
    caseId: caseRow?.id,
    trigger,
    responseType: typeof content,
    responseLength: typeof content === 'string' ? content.length : 0,
  });

  const jsonStr = extractJSONObject(content);
  if (!jsonStr) {
    logger.error('Timeline generation', 'LLM response did not contain JSON', {
      caseId: caseRow?.id,
      trigger,
      responseType: typeof content,
      responseLength: typeof content === 'string' ? content.length : 0,
      rawResponse: typeof content === 'string' ? content.slice(0, 1000) : String(content).slice(0, 1000),
    });
    throw new Error('No JSON object found in live analysis response');
  }

  const parsed = JSON.parse(jsonStr);
  const analysis = normalizeAnalysis(parsed);

  logger.info('Timeline generation', 'LLM output validated', {
    caseId: caseRow?.id,
    trigger,
    hasSummary: !!analysis.summary,
    hasStatus: !!analysis.current_status,
    hasRouting: !!analysis.routing_type,
    hasAttention: !!analysis.attention_score,
    timelineCount: analysis.timeline.length,
    questionsCount: analysis.unresolved_questions.length,
  });

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
