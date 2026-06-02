const { LIVE_CONFIG } = require('../live.config');
const { averageVectors, cosineSimilarity, updateCentroid } = require('./vector');

class LiveStateStore {
  constructor(options = {}) {
    this.recentLimit = options.recentLimit || LIVE_CONFIG.RECENT_EMBEDDINGS_LIMIT;
    this.states = new Map();
  }

  get(caseId) {
    return this.states.get(caseId) || null;
  }

  set(caseId, state) {
    this.states.set(caseId, {
      activeCentroid: state.activeCentroid || [],
      recentEmbeddings: state.recentEmbeddings || [],
      cohesionScore: state.cohesionScore ?? null,
      lastBoundaryScore: state.lastBoundaryScore ?? null,
      firstMessageAt: state.firstMessageAt || null,
      lastMessageAt: state.lastMessageAt || null,
      processedSinceAnalysis: state.processedSinceAnalysis || 0,
      messageCount: state.messageCount || state.recentEmbeddings?.length || 0,
      userIds: state.userIds || new Set(),
    });
    return this.states.get(caseId);
  }

  init(caseId, message, embedding) {
    return this.set(caseId, {
      activeCentroid: embedding,
      recentEmbeddings: [embedding],
      cohesionScore: 1,
      firstMessageAt: message.timestamp || message.created_at || null,
      lastMessageAt: message.timestamp || message.created_at || null,
      processedSinceAnalysis: 0,
      messageCount: 1,
      userIds: new Set(message.user_id ? [message.user_id] : []),
    });
  }

  rebuild(caseId, messages, embeddings) {
    const recentEmbeddings = embeddings.slice(-this.recentLimit);
    const userIds = new Set(messages.map((message) => message.user_id).filter(Boolean));
    return this.set(caseId, {
      activeCentroid: averageVectors(recentEmbeddings),
      recentEmbeddings,
      cohesionScore: null,
      firstMessageAt: messages[0]?.timestamp || messages[0]?.created_at || null,
      lastMessageAt: messages[messages.length - 1]?.timestamp || messages[messages.length - 1]?.created_at || null,
      processedSinceAnalysis: 0,
      messageCount: messages.length,
      userIds,
    });
  }

  rebuildFromVectors(caseId, caseRow, points) {
    const ordered = points
      .filter((point) => Array.isArray(point.vector))
      .sort((a, b) => String(a.payload?.created_at || '').localeCompare(String(b.payload?.created_at || '')));
    const embeddings = ordered.map((point) => point.vector);
    const recentEmbeddings = embeddings.slice(-this.recentLimit);

    return this.set(caseId, {
      activeCentroid: averageVectors(recentEmbeddings),
      recentEmbeddings,
      cohesionScore: null,
      firstMessageAt: caseRow.first_seen_at || ordered[0]?.payload?.created_at || null,
      lastMessageAt: caseRow.last_seen_at || ordered[ordered.length - 1]?.payload?.created_at || null,
      processedSinceAnalysis: 0,
      messageCount: caseRow.message_count || ordered.length,
      userIds: new Set(),
    });
  }

  evaluateBoundary(state, embedding, config = LIVE_CONFIG) {
    if (!state || !Array.isArray(state.activeCentroid) || state.activeCentroid.length === 0) {
      return {
        isBoundary: false,
        similarity: 1,
        cohesionDrop: 0,
      };
    }

    const similarity = cosineSimilarity(embedding, state.activeCentroid);
    const previousCohesion = state.cohesionScore ?? similarity;
    const cohesionDrop = previousCohesion - similarity;
    const isBoundary = (
      cohesionDrop >= config.COHESION_DROP_THRESHOLD &&
      similarity <= config.SIMILARITY_BOUNDARY_THRESHOLD
    );

    return {
      isBoundary,
      similarity,
      cohesionDrop,
    };
  }

  append(caseId, message, embedding, similarity) {
    const state = this.get(caseId);
    if (!state) {
      return this.init(caseId, message, embedding);
    }

    const nextCount = state.messageCount + 1;
    state.activeCentroid = updateCentroid(state.activeCentroid, embedding, state.messageCount);
    state.recentEmbeddings.push(embedding);
    if (state.recentEmbeddings.length > this.recentLimit) {
      state.recentEmbeddings.shift();
    }
    state.cohesionScore = similarity;
    state.lastMessageAt = message.timestamp || message.created_at || new Date().toISOString();
    state.messageCount = nextCount;
    state.processedSinceAnalysis += 1;
    if (message.user_id) state.userIds.add(message.user_id);
    return state;
  }

  resetAnalysisCounter(caseId) {
    const state = this.get(caseId);
    if (state) state.processedSinceAnalysis = 0;
  }

  forget(caseId) {
    this.states.delete(caseId);
  }
}

function hasResolutionSignal(content) {
  return /\b(resolved|fixed|works now|working now|solved|closed|done|workaround|no longer|back up)\b/i.test(content || '');
}

function hasSeveritySignal(content) {
  return /\b(down|outage|broken|critical|urgent|blocked|500|timeout|failed|failure|cannot|can't|error|latency|rate limit)\b/i.test(content || '');
}

function shouldGenerateTimelineUpdate(state, message) {
  if (!state) return false;
  if (hasResolutionSignal(message.content)) return true;
  if (state.processedSinceAnalysis < LIVE_CONFIG.TIMELINE_UPDATE_MIN_MESSAGES) return false;
  return hasSeveritySignal(message.content) || state.processedSinceAnalysis >= LIVE_CONFIG.TIMELINE_UPDATE_MIN_MESSAGES;
}

module.exports = {
  LiveStateStore,
  hasResolutionSignal,
  hasSeveritySignal,
  shouldGenerateTimelineUpdate,
};
