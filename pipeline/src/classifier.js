const logger = require('./logger');
const { PIPELINE_CONFIG } = require('../pipeline.config');

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CHAT_MODEL = PIPELINE_CONFIG.CHAT_MODEL;

const CHAT_ENDPOINT = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/ai/v1/chat/completions`;

/**
 * Call the Cloudflare LLM via OpenAI-compatible chat completions endpoint.
 * Uses raw fetch (consistent with pipeline's existing pattern).
 *
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {number} [retries]
 * @returns {Promise<string>} LLM response content
 */
async function callLLM(systemPrompt, userContent, retries) {
  retries = retries || PIPELINE_CONFIG.CLASSIFIER_MAX_RETRIES;
  const baseDelay = PIPELINE_CONFIG.CLASSIFIER_RETRY_BASE_MS;

  for (let attempt = 1; attempt <= retries; attempt++) {
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
          temperature: 0.1,
        }),
      });

      if (res.status === 429) {
        const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 100);
        logger.warn('classifier', `LLM rate limited, retry ${attempt}/${retries}`);
        if (attempt === retries) throw new Error(`LLM 429 after ${retries} retries`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM call failed: ${res.status} ${errText.slice(0, 300)}`);
      }

      const json = await res.json();
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      if (!content) throw new Error('LLM returned empty content');
      return content;
    } catch (err) {
      if (attempt === retries) throw err;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      logger.warn('classifier', `LLM retry ${attempt}/${retries}`, { error: err.message });
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

/**
 * Format a segment into a short text preview for the LLM.
 *
 * @param {object} segment
 * @param {number} [maxMessages]
 * @returns {string}
 */
function formatSegmentPreview(segment, maxMessages) {
  maxMessages = maxMessages || PIPELINE_CONFIG.CLASSIFIER_PREVIEW_MESSAGES;
  var msgs = segment.messages.slice(0, maxMessages);
  return msgs.map(function(m) { return m.username + ': ' + m.content; }).join('\n');
}

/**
 * Extract JSON from LLM response (handles markdown code blocks or already-parsed arrays).
 *
 * @param {string|Array} text
 * @returns {string}
 */
function extractJSON(text) {
  // If LLM already returned parsed array, stringify it
  if (Array.isArray(text)) {
    console.log('[classifier] extractJSON received array, stringifying...');
    return JSON.stringify(text);
  }
  
  if (!text || typeof text !== 'string') {
    console.error('[classifier] extractJSON received non-string:', typeof text, text);
    return '{}';
  }
  
  var codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();
  return text.trim();
}

/**
 * Pass 1: Discover topic categories from a sample of segments.
 * The LLM analyzes segments and produces its own list of category labels.
 *
 * @param {Array} segments
 * @param {number} [sampleSize]
 * @returns {Promise<string[]>} array of category label strings
 */
async function discoverCategories(segments, sampleSize) {
  sampleSize = sampleSize || PIPELINE_CONFIG.CLASSIFIER_SAMPLE_SIZE;

  // Stratified sample — spread across the segment array
  var step = Math.max(1, Math.floor(segments.length / sampleSize));
  var sampled = [];
  for (var i = 0; i < segments.length && sampled.length < sampleSize; i += step) {
    sampled.push(segments[i]);
  }

  var segmentTexts = sampled.map(function(seg) {
    return '--- Segment ' + seg.segmentIndex + ' ---\n' + formatSegmentPreview(seg);
  }).join('\n\n');

  var systemPrompt =
    'You are analyzing conversation segments from a Discord community. Each segment is a contiguous block of messages where the topic stays consistent. ' +
    'Your task is to discover the natural topic categories present in this community by analyzing the sample segments below. ' +
    'Produce a JSON array of category strings. Each category should be a short, descriptive label (2-4 words) that captures the main topic or issue. ' +
    'Aim for 8-15 categories. Make labels specific enough to be meaningful but short enough to be clear. ' +
    'Return ONLY the JSON array, no explanation.';

  console.log('[classifier] Calling LLM for category discovery with', sampled.length, 'sample segments...');
  var raw = await callLLM(systemPrompt, segmentTexts);
  console.log('[classifier] LLM raw response type:', typeof raw, 'length:', typeof raw === 'string' ? raw.length : 'N/A');
  console.log('[classifier] LLM raw response preview:', typeof raw === 'string' ? raw.slice(0, 200) : raw);
  
  var jsonStr = extractJSON(raw);
  console.log('[classifier] Extracted JSON string:', jsonStr.slice(0, 200));
  
  var categories;
  try {
    categories = JSON.parse(jsonStr);
  } catch (parseErr) {
    console.error('[classifier] JSON parse failed:', parseErr.message);
    console.error('[classifier] JSON string that failed:', jsonStr);
    throw new Error(`Failed to parse LLM categories: ${parseErr.message}`);
  }

  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error('LLM returned invalid categories: expected non-empty array');
  }

  // Validate each entry is a string
  var validCategories = categories.filter(function(c) {
    return typeof c === 'string' && c.trim().length > 0;
  }).map(function(c) { return c.trim(); });

  if (validCategories.length === 0) {
    throw new Error('LLM returned no valid category strings');
  }

  logger.info('classifier', 'Discovered ' + validCategories.length + ' categories', { categories: validCategories });
  return validCategories;
}

/**
 * Pass 2: Classify all segments using the discovered categories.
 * Segments are batched to reduce API calls.
 *
 * @param {Array} segments
 * @param {string[]} categories
 * @returns {Promise<Map<number, string>>} segmentIndex → topicLabel
 */
async function classifySegments(segments, categories) {
  var batchSize = PIPELINE_CONFIG.CLASSIFIER_BATCH_SIZE;
  var delay = PIPELINE_CONFIG.CLASSIFIER_BATCH_DELAY_MS;
  var classifications = new Map();
  var apiCalls = 0;

  var categoryList = categories.map(function(c, i) { return (i + 1) + '. ' + c; }).join('\n');

  for (var i = 0; i < segments.length; i += batchSize) {
    var batch = segments.slice(i, i + batchSize);

    var segmentTexts = batch.map(function(seg) {
      return '--- Segment ' + seg.segmentIndex + ' ---\n' + formatSegmentPreview(seg);
    }).join('\n\n');

    var systemPrompt =
      'You are classifying Discord conversation segments by SPECIFIC issue or topic. Each segment below is a contiguous block of messages on one topic. ' +
      'Classify each segment into exactly ONE of these categories:\n' +
      categoryList + '\n\n' +
      'IMPORTANT: Choose the MOST SPECIFIC category that fits. If a segment talks about multiple issues, pick the DOMINANT one. ' +
      'If no category fits perfectly, choose the closest one. Never invent a new category. ' +
      'Focus on the SPECIFIC technical problem or topic being discussed, not general themes.\n\n' +
      'Return a JSON array of objects with "segmentIndex" (number) and "category" (exact string from the list above). ' +
      'Return ONLY the JSON array, no explanation.';

    try {
      var raw = await callLLM(systemPrompt, segmentTexts);
      var jsonStr = extractJSON(raw);
      var results = JSON.parse(jsonStr);

      if (!Array.isArray(results)) throw new Error('Expected array of objects');

      for (var j = 0; j < results.length; j++) {
        var result = results[j];
        if (typeof result.segmentIndex === 'number' && typeof result.category === 'string') {
          classifications.set(result.segmentIndex, result.category.trim());
        }
      }

      apiCalls++;
    } catch (err) {
      // Mark failed batch segments as uncategorized rather than crashing
      logger.warn('classifier', 'Classification batch failed, marking as uncategorized', {
        error: err.message,
        segmentIndices: batch.map(function(s) { return s.segmentIndex; }),
      });
      for (var k = 0; k < batch.length; k++) {
        if (!classifications.has(batch[k].segmentIndex)) {
          classifications.set(batch[k].segmentIndex, 'uncategorized');
        }
      }
    }

    // Delay between batches to avoid rate limits
    if (i + batchSize < segments.length) {
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }

  // Ensure every segment has a classification
  for (var m = 0; m < segments.length; m++) {
    if (!classifications.has(segments[m].segmentIndex)) {
      classifications.set(segments[m].segmentIndex, 'uncategorized');
    }
  }

  logger.info('classifier', 'Classified ' + classifications.size + ' segments in ' + apiCalls + ' API calls', {
    categories: Array.from(new Set(classifications.values())),
  });

  return classifications;
}

/**
 * Full classification pipeline: discover categories, then classify all segments.
 *
 * @param {Array} segments
 * @returns {Promise<Map<number, string>>} segmentIndex → topicLabel
 */
async function classifyPipeline(segments) {
  if (segments.length === 0) return new Map();

  var categories = await discoverCategories(segments);
  var classifications = await classifySegments(segments, categories);

  return classifications;
}

module.exports = { classifyPipeline, discoverCategories, classifySegments, callLLM, formatSegmentPreview, extractJSON };
