const logger = require('./logger');
const { embedMessagesForDetection } = require('./embedder');
const { PIPELINE_CONFIG } = require('../pipeline.config');

/**
 * Dot product of two vectors (assumes both are normalized).
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Mean-pool a set of normalized vectors into a single vector.
 * @param {number[][]} vectors
 * @returns {number[]}
 */
function meanPool(vectors) {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const result = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      result[i] += vec[i];
    }
  }
  const scale = 1 / vectors.length;
  return result.map(v => v * scale);
}

/**
 * Normalize vector in-place style (returns new array).
 * @param {number[]} vec
 * @returns {number[]}
 */
function normalize(vec) {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (mag === 0) return vec;
  return vec.map(v => v / mag);
}

/**
 * Simple 3-point moving average smoothing.
 * @param {number[]} scores
 * @returns {number[]}
 */
function smooth(scores) {
  if (scores.length < 3) return [...scores];
  const result = new Array(scores.length);
  result[0] = scores[0];
  result[scores.length - 1] = scores[scores.length - 1];
  for (let i = 1; i < scores.length - 1; i++) {
    result[i] = (scores[i - 1] + scores[i] + scores[i + 1]) / 3;
  }
  return result;
}

/**
 * Phase B: Compute similarity curve using TextTiling sliding window.
 * For each position i (from k to len-k), compare left block [i-k, i-1] vs right block [i, i+k-1].
 *
 * @param {Map<number, number[]>} embeddings - index → normalized vector
 * @param {number} len - total number of messages
 * @param {number} k - window size per side
 * @returns {Float64Array} similarityScore at each position (only meaningful for k..len-k)
 */
function computeSimilarityCurve(embeddings, len, k) {
  const scores = new Float64Array(len);

  for (let i = k; i <= len - k; i++) {
    // Left block: [i-k, i-1]
    const leftVecs = [];
    for (let j = i - k; j < i; j++) {
      leftVecs.push(embeddings.get(j));
    }
    // Right block: [i, i+k-1]
    const rightVecs = [];
    for (let j = i; j < i + k; j++) {
      rightVecs.push(embeddings.get(j));
    }

    const leftBlock = normalize(meanPool(leftVecs));
    const rightBlock = normalize(meanPool(rightVecs));
    scores[i] = dotProduct(leftBlock, rightBlock);
  }

  return scores;
}

/**
 * Phase C: Compute depth scores and detect boundaries.
 * Depth score = (leftPeak - score) + (rightPeak - score) at each position.
 * Smooth with moving average, then threshold.
 *
 * @param {Float64Array} similarityScores
 * @param {number} len
 * @param {number} k
 * @param {number} threshold
 * @returns {number[]} array of boundary positions
 */
function detectBoundaries(similarityScores, len, k, threshold) {
  // Compute depth scores
  const depthScores = new Float64Array(len);

  for (let i = k; i <= len - k; i++) {
    const leftStart = Math.max(k, i - k);
    const rightEnd = Math.min(len - k, i + k);

    let leftPeak = -Infinity;
    for (let j = leftStart; j <= i; j++) {
      if (similarityScores[j] > leftPeak) leftPeak = similarityScores[j];
    }

    let rightPeak = -Infinity;
    for (let j = i; j <= rightEnd; j++) {
      if (similarityScores[j] > rightPeak) rightPeak = similarityScores[j];
    }

    depthScores[i] = (leftPeak - similarityScores[i]) + (rightPeak - similarityScores[i]);
  }

  // Smooth
  const smoothed = smooth(Array.from(depthScores));

  // Threshold
  const boundaries = [];
  for (let i = k; i <= len - k; i++) {
    if (smoothed[i] > threshold) {
      boundaries.push(i);
    }
  }

  return { boundaries, depthScores: smoothed };
}

/**
 * Phase D: Enforce minimum and maximum segment size constraints.
 *
 * @param {number[]} rawBoundaries - raw boundary positions
 * @param {number} len - total message count
 * @param {number} minSize
 * @param {number} maxSize
 * @returns {number[]} filtered boundary positions
 */
function enforceSegmentConstraints(rawBoundaries, len, minSize, maxSize) {
  // Filter out boundaries that would create segments smaller than minSize
  const filtered = [];
  for (let idx = 0; idx < rawBoundaries.length; idx++) {
    const b = rawBoundaries[idx];
    const prevBoundary = filtered.length > 0 ? filtered[filtered.length - 1] : 0;
    const nextBoundary = rawBoundaries[idx + 1] ?? len;
    const leftSize = b - prevBoundary;
    const rightSize = nextBoundary - b;

    if (leftSize >= minSize && rightSize >= minSize) {
      filtered.push(b);
    }
    // If either side is too small, discard this boundary (merge tiny segment)
  }

  // Force-split segments that exceed maxSize
  const result = [];
  let prev = 0;
  for (const b of filtered) {
    if (b - prev > maxSize) {
      // Force splits between prev and b
      let pos = prev + maxSize;
      while (pos < b) {
        result.push(pos);
        pos += maxSize;
      }
    }
    result.push(b);
    prev = b;
  }
  // Check final segment
  if (len - prev > maxSize) {
    let pos = prev + maxSize;
    while (pos < len) {
      result.push(pos);
      pos += maxSize;
    }
  }

  // Deduplicate and sort
  return [...new Set(result)].sort((a, b) => a - b);
}

/**
 * Main entry point for Step 2: Boundary Detection.
 *
 * @param {Array} messages - chronologically sorted message objects
 * @returns {Promise<Array<{segmentIndex: number, messages: Array, boundaryScore: number|null, startTimestamp: string, endTimestamp: string}>>}
 */
async function detectBoundariesPipeline(messages) {
  const k = PIPELINE_CONFIG.BOUNDARY_WINDOW_SIZE;
  const threshold = PIPELINE_CONFIG.BOUNDARY_DEPTH_THRESHOLD;
  const minSize = PIPELINE_CONFIG.MIN_SEGMENT_SIZE;
  const maxSize = PIPELINE_CONFIG.MAX_SEGMENT_SIZE;
  const len = messages.length;

  // Edge case: tiny batch — not enough messages for similarity curve
  if (len < 2 * k + 1) {
    logger.info('boundaryDetection', `Batch too small for detection (${len} < ${2 * k + 1}), treating as single segment`);
    return [{
      segmentIndex: 0,
      messages,
      boundaryScore: null,
      startTimestamp: messages[0]?.timestamp ?? null,
      endTimestamp: messages[len - 1]?.timestamp ?? null,
    }];
  }

  // Phase A: Embed each message individually
  logger.info('boundaryDetection', `Phase A: Embedding ${len} messages for detection`);
  const embeddings = await embedMessagesForDetection(messages);

  // Phase B: Compute similarity curve
  logger.info('boundaryDetection', 'Phase B: Computing similarity curve');
  const similarityScores = computeSimilarityCurve(embeddings, len, k);

  // Phase C: Valley detection
  logger.info('boundaryDetection', 'Phase C: Detecting valleys via depth scoring');
  const { boundaries: rawBoundaries, depthScores } = detectBoundaries(similarityScores, len, k, threshold);

  // Phase D: Enforce constraints
  const boundaries = enforceSegmentConstraints(rawBoundaries, len, minSize, maxSize);

  // Build segments — boundaryScore is the depth score at the boundary position
  const segments = [];
  let prevPos = 0;

  for (let i = 0; i < boundaries.length; i++) {
    const bPos = boundaries[i];
    const segMessages = messages.slice(prevPos, bPos);
    if (segMessages.length > 0) {
      segments.push({
        segmentIndex: segments.length,
        messages: segMessages,
        boundaryScore: i === 0 ? null : depthScores[boundaries[i - 1]] ?? null,
        startTimestamp: segMessages[0].timestamp,
        endTimestamp: segMessages[segMessages.length - 1].timestamp,
      });
    }
    prevPos = bPos;
  }

  // Final segment
  const finalMessages = messages.slice(prevPos);
  if (finalMessages.length > 0) {
    segments.push({
      segmentIndex: segments.length,
      messages: finalMessages,
      boundaryScore: boundaries.length > 0 ? depthScores[boundaries[boundaries.length - 1]] ?? null : null,
      startTimestamp: finalMessages[0].timestamp,
      endTimestamp: finalMessages[finalMessages.length - 1].timestamp,
    });
  }

  // Stats
  const sizes = segments.map(s => s.messages.length);
  const avgSize = sizes.length > 0 ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 0;
  logger.info('boundaryDetection', `Segmentation complete`, {
    segmentCount: segments.length,
    avgSegmentSize: avgSize.toFixed(1),
    minSegmentSize: Math.min(...sizes),
    maxSegmentSize: Math.max(...sizes),
    rawBoundaries: rawBoundaries.length,
    enforcedBoundaries: boundaries.length,
  });

  return segments;
}

// Export internal functions for testing
module.exports = {
  detectBoundariesPipeline,
  dotProduct,
  meanPool,
  normalize,
  smooth,
  computeSimilarityCurve,
  detectBoundaries: detectBoundaries,
  enforceSegmentConstraints,
};
