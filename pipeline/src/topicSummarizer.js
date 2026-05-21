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
      const content = json.choices?.[0]?.message?.content;
      
      if (!content) throw new Error('LLM returned empty content');
      
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
 * Extract JSON from LLM response (handles markdown code blocks).
 */
function extractJSON(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }
  
  // Try to find JSON in markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  
  // Try to find JSON object in text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return jsonMatch[0].trim();
  }
  
  return text.trim();
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

1. **Summary Paragraph** (3-5 sentences):
   - What is the main topic/issue?
   - What happened and when?
   - Who was involved (number of users)?
   - What is the current status?

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

OUTPUT FORMAT:
Return a valid JSON object with this exact structure:

{
  "summary": "Your detailed 3-5 sentence summary here...",
  "key_issues": [
    "Issue 1 description",
    "Issue 2 description",
    "Issue 3 description"
  ],
  "unanswered_questions": [
    "Question 1 that was never answered",
    "Question 2 that needs team response"
  ],
  "sentiment": "frustrated|confused|neutral|satisfied",
  "severity": "critical|high|medium|low"
}

IMPORTANT:
- Return ONLY the JSON object, no explanation
- Be specific and detailed in all fields
- Include error codes, timestamps, and specific details where relevant
- If no unanswered questions exist, use empty array []
- If no key issues exist, use empty array []`;

  try {
    const { content, usage } = await callLLMForSummary(systemPrompt, userPrompt);
    const jsonStr = extractJSON(content);
    
    if (!jsonStr) {
      throw new Error('No JSON found in LLM response');
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
    });
    
    return parsed;
  } catch (err) {
    logger.error('topicSummarizer', `Failed to summarize "${topicLabel}"`, { error: err.message });
    
    // Return fallback summary
    return {
      summary: `Discussion about ${topicLabel} involving ${segments.length} segments.`,
      key_issues: [],
      unanswered_questions: [],
      sentiment: 'neutral',
      severity: 'medium',
      tokensUsed: 0,
      error: err.message,
    };
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
};
