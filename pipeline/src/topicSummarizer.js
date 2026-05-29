const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CHAT_MODEL = PIPELINE_CONFIG.CHAT_MODEL;

const CHAT_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`;

/**
 * Call Cloudflare LLM for summarization.
 * Uses generous token limits for detailed summaries.
 */
async function callLLMForSummary(systemPrompt, userContent) {
  const maxRetries = 3;
  const baseDelay = 500;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(CHAT_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CF_API_TOKEN}`,
        },
        body: JSON.stringify({
          model: CHAT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent },
          ],
          temperature: 0.3,  // Slightly higher for creative summarization
          max_tokens: 2048,  // Generous token limit for detailed summaries
        }),
      });

      if (res.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        logger.warn('topicSummarizer', `Rate limited, retry ${attempt}/${maxRetries}`);
        if (attempt === maxRetries) throw new Error(`LLM 429 after ${maxRetries} retries`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM call failed: ${res.status} ${errText.slice(0, 300)}`);
      }

      const json = await res.json();
      let content = json.choices?.[0]?.message?.content;

      if (!content) throw new Error('LLM returned empty content');

      // Cloudflare Workers AI may return parsed JSON objects instead of strings.
      // Normalize to string so downstream extractJSON() always receives a string.
      if (typeof content === 'object') {
        content = JSON.stringify(content);
      }
      
      // Extract usage info
      const usage = json.usage || { total_tokens: 0 };
      
      return { content, usage };
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.warn('topicSummarizer', `Retry ${attempt}/${maxRetries}`, { error: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Strip all markdown code fences from text.
 * Handles ```json, ```JSON, ``` and bare backtick pairs.
 */
function stripMarkdownFences(text) {
  return text
    .replace(/```(?:json|JSON)?\s*\n?/g, '')
    .replace(/\n?```\s*/g, '')
    .replace(/```/g, '')
    .trim();
}

/**
 * Find the first valid JSON object in text using balanced-brace matching.
 * Returns the validated JSON string or null.
 */
function findBalancedJSON(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          try { JSON.parse(candidate); return candidate; } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * Extract JSON object from LLM response.
 * Handles: markdown code blocks, prose before/after JSON, multiple objects.
 * Returns the validated JSON string or null — never returns raw text.
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Try fenced code block extraction (handles ```json ... ```)
  const codeBlockMatch = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    const candidate = codeBlockMatch[1].trim();
    try { JSON.parse(candidate); return candidate; } catch { /* fall through */ }
  }

  // 2. Strip all fences and try balanced-brace matching on cleaned text
  const cleaned = stripMarkdownFences(text);
  const balanced = findBalancedJSON(cleaned);
  if (balanced) return balanced;

  // 3. Greedy regex on cleaned text (catches edge cases balanced-brace misses)
  const greedyMatch = cleaned.match(/\{[\s\S]*\}/);
  if (greedyMatch) {
    const candidate = greedyMatch[0].trim();
    try { JSON.parse(candidate); return candidate; } catch { /* fall through */ }
  }

  // 4. Last attempt: balanced-brace on original text (in case stripping broke something)
  const originalBalanced = findBalancedJSON(text);
  if (originalBalanced) return originalBalanced;

  // No valid JSON found — return null so caller can retry with stricter prompt
  return null;
}

/**
 * Build conversation text from segments for LLM summarization.
 * Includes full message content with user attribution.
 */
function buildConversationText(segments) {
  const lines = [];
  
  segments.forEach((seg, idx) => {
    lines.push(`\n=== Topic Segment ${idx + 1} ===`);
    lines.push(`Time: ${seg.startTimestamp} → ${seg.endTimestamp}`);
    lines.push(`Messages: ${seg.messages.length}\n`);
    
    seg.messages.forEach((msg, msgIdx) => {
      const timestamp = msg.timestamp.split('T')[1]?.split('.')?.[0] || '';
      lines.push(`[${timestamp}] ${msg.username}: ${msg.content}`);
    });
  });
  
  return lines.join('\n');
}

/**
 * Generate detailed LLM summary for a topic cluster.
 * Uses generous tokens for comprehensive analysis.
 */
async function summarizeTopic(topicLabel, segments) {
  const conversationText = buildConversationText(segments);
  
  const systemPrompt = `You are an expert community analyst. Your task is to analyze Discord community discussions and produce detailed, actionable summaries.

ANALYSIS REQUIREMENTS:

 1. **Summary Paragraph** (5-10 sentences — be detailed and specific):
    - What is the main topic/issue?
    - What exactly are users talking about? Include specific details, problems, product names, error messages, feature names, and concrete examples from the conversation — not vague summaries.
    - What happened and when?
    - Who was involved (mention specific usernames when relevant)?
    - What is the current status?
    - If users are discussing an issue, describe the issue in detail — what they tried, what failed, what worked.
    - If users are sharing feedback or requests, capture exactly what they want and why.

2. **Key Issues** (list all identified problems):
   - Technical problems (errors, bugs, performance issues)
   - User complaints (frustrations, pain points)
   - Feature requests or suggestions
   - Confusion or misunderstandings

3. **Unanswered Questions** (questions that were asked but never resolved):
   - Direct questions from users
   - Problems without solutions
   - Issues requiring team response

4. **Sentiment Analysis**:
   - frustrated: Users are angry, upset, or experiencing blockers
   - confused: Users are uncertain, asking for help, or seeking clarification
   - neutral: Factual discussion, information sharing, or casual chat
   - satisfied: Users express happiness, gratitude, or successful resolution

5. **Severity Assessment**:
   - critical: Widespread outage, data loss, security issue, or many users affected
   - high: Major feature broken, significant user impact, urgent attention needed
   - medium: Minor bug, workaround exists, moderate user impact
   - low: Cosmetic issue, feature request, or minimal user impact

Be thorough and detailed. Do not omit important details. Include specific error codes, affected features, and user quotes when relevant.`;

  const userPrompt = `Analyze this community discussion about "${topicLabel}" and provide a comprehensive summary.

CONVERSATION DATA:
${conversationText}

OUTPUT FORMAT — RAW JSON ONLY:
{"summary":"Your 3-5 sentence summary","key_issues":["Issue 1","Issue 2"],"unanswered_questions":["Question 1"],"sentiment":"frustrated or confused or neutral or satisfied","severity":"critical or high or medium or low"}

CRITICAL RULES:
- Return ONLY the raw JSON object — no markdown, no code fences, no backticks, no explanation text before or after
- Do NOT wrap the JSON in \`\`\`json blocks
- Do NOT add any text before or after the JSON object
- If no unanswered questions, use empty array []
- If no key issues, use empty array []`;

  const strictRetryPrompt = `You MUST respond with ONLY a raw JSON object. No markdown. No code fences. No backticks. No explanation.

Output this exact JSON structure with real data filled in:
{"summary":"summary text","key_issues":["issue"],"unanswered_questions":["question"],"sentiment":"neutral","severity":"medium"}

The topic is "${topicLabel}". Here is the conversation:
${conversationText}

Respond with the JSON object now. Nothing else.`;

  try {
    const { content, usage } = await callLLMForSummary(systemPrompt, userPrompt);
    let jsonStr = extractJSON(content);
    let retried = false;

    // Retry once with stricter prompt if extraction failed
    if (!jsonStr) {
      logger.warn('topicSummarizer', `First attempt failed for "${topicLabel}", retrying with strict prompt`);
      const retryResult = await callLLMForSummary(systemPrompt, strictRetryPrompt);
      jsonStr = extractJSON(retryResult.content);
      retried = true;
    }

    if (!jsonStr) {
      throw new Error('No JSON found in LLM response after retry');
    }

    const parsed = JSON.parse(jsonStr);

    // Validate required fields
    if (!parsed.summary || !Array.isArray(parsed.key_issues) || !Array.isArray(parsed.unanswered_questions)) {
      throw new Error('Invalid summary structure');
    }

    // Validate sentiment and severity
    const validSentiments = ['frustrated', 'confused', 'neutral', 'satisfied'];
    const validSeverities = ['critical', 'high', 'medium', 'low'];

    parsed.sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    parsed.severity = validSeverities.includes(parsed.severity) ? parsed.severity : 'medium';

    // Add token usage
    parsed.tokensUsed = usage?.total_tokens || 0;

    logger.info('topicSummarizer', `Generated summary for "${topicLabel}"`, {
      tokensUsed: parsed.tokensUsed,
      sentiment: parsed.sentiment,
      severity: parsed.severity,
      keyIssuesCount: parsed.key_issues.length,
      unansweredCount: parsed.unanswered_questions.length,
      retried,
    });

    return parsed;
  } catch (err) {
    logger.error('topicSummarizer', `FAILED to summarize "${topicLabel}" — throwing, no silent fallback`, {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

/**
 * Calculate engagement metrics for a topic.
 */
function calculateEngagementMetrics(segments) {
  if (segments.length === 0) {
    return {
      messageCount: 0,
      uniqueUsers: 0,
      messagesPerHour: 0,
    };
  }

  const allMessages = segments.flatMap(s => s.messages);
  const uniqueUserIds = new Set(allMessages.map(m => m.user_id));
  const uniqueMessageIds = new Set(allMessages.map(m => m.message_id));

  // Calculate time span
  const timestamps = allMessages.map(m => new Date(m.timestamp).getTime());
  const minTime = Math.min(...timestamps);
  const maxTime = Math.max(...timestamps);
  
  // Calculate hours span, handling edge cases
  const durationMs = maxTime - minTime;
  const durationHours = durationMs / (1000 * 60 * 60);
  
  // For very short clusters (< 1 minute), use minimum of 1 minute to avoid extreme outliers
  // For clusters with 0 duration (all messages same timestamp), use 1 minute
  const minDurationHours = 1 / 60; // 1 minute
  const effectiveHours = Math.max(minDurationHours, durationHours);
  
  const messagesPerHour = uniqueMessageIds.size / effectiveHours;

  return {
    messageCount: uniqueMessageIds.size,
    uniqueUsers: uniqueUserIds.size,
    messagesPerHour: parseFloat(messagesPerHour.toFixed(2)),
  };
}

/**
 * Generate summaries for all topic clusters.
 * Returns array of summary objects ready for database insertion.
 *
 * @param {Map<number, string>} classifications - segmentIndex → topicLabel
 * @param {Array} segments - Array of segment objects with messages
 * @param {string} batchId - Batch UUID for tracking
 * @param {string} processingDate - Calendar date (YYYY-MM-DD) for date isolation
 * @returns {Promise<Array>} Array of summary objects with processing_date field
 */
async function generateTopicSummaries(classifications, segments, batchId, processingDate) {
  // Validate processingDate
  if (!processingDate) {
    throw new Error('processingDate is required for date isolation. See pipeline/README.md for migration.');
  }

  // Group segments by topic label
  const topicGroups = new Map();

  classifications.forEach((topicLabel, segmentIndex) => {
    if (!topicGroups.has(topicLabel)) {
      topicGroups.set(topicLabel, []);
    }
    const segment = segments.find(s => s.segmentIndex === segmentIndex);
    if (segment) {
      topicGroups.get(topicLabel).push(segment);
    }
  });

  const summaries = [];
  let clusterId = 0;

  for (const [topicLabel, topicSegments] of topicGroups) {
    logger.info('topicSummarizer', `Generating summary for topic: "${topicLabel}"`, {
      segmentCount: topicSegments.length,
      processingDate,
    });

    // Generate LLM summary
    const llmSummary = await summarizeTopic(topicLabel, topicSegments);

    // Calculate engagement metrics
    const metrics = calculateEngagementMetrics(topicSegments);

    // Calculate time range
    const allTimestamps = topicSegments.flatMap(s =>
      s.messages.map(m => new Date(m.timestamp).getTime())
    );
    const startTimestamp = new Date(Math.min(...allTimestamps)).toISOString();
    const endTimestamp = new Date(Math.max(...allTimestamps)).toISOString();

    summaries.push({
      batch_id: batchId,
      cluster_id: clusterId++,
      topic_label: topicLabel,
      summary: llmSummary.summary,
      key_issues: llmSummary.key_issues,
      unanswered_questions: llmSummary.unanswered_questions,
      sentiment: llmSummary.sentiment,
      severity: llmSummary.severity,
      message_count: metrics.messageCount,
      unique_users: metrics.uniqueUsers,
      messages_per_hour: metrics.messagesPerHour,
      start_timestamp: startTimestamp,
      end_timestamp: endTimestamp,
      llm_model: CHAT_MODEL,
      llm_tokens_used: llmSummary.tokensUsed,
      processing_date: processingDate, // DATE ISOLATION: Explicit date column
    });

    // Small delay between summaries to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  logger.info('topicSummarizer', `Generated ${summaries.length} topic summaries`, {
    totalSegments: segments.length,
    totalTopics: summaries.length,
    processingDate,
  });

  return summaries;
}

module.exports = {
  generateTopicSummaries,
  summarizeTopic,
  buildConversationText,
  calculateEngagementMetrics,
  extractJSON,
  stripMarkdownFences,
  findBalancedJSON,
  callLLMForSummary,
};
