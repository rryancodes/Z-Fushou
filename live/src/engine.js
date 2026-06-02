const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { embedText } = require('./cloudflare');
const { analyzeCase } = require('./analyzer');
const { LiveStateStore, shouldGenerateTimelineUpdate } = require('./state');
const storage = require('./storage');
const qdrantClient = require('./qdrantClient');
const metrics = require('./metrics');

function validateEnv() {
  const missing = LIVE_CONFIG.REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required live engine environment variables: ${missing.join(', ')}`);
  }
}

function analysisPatch(caseRow, analysis) {
  return {
    summary: analysis.summary,
    current_status: analysis.current_status,
    routing_type: analysis.routing_type,
    attention_score: analysis.attention_score,
    timeline: analysis.timeline,
    unresolved_questions: analysis.unresolved_questions,
    updated_at: new Date().toISOString(),
  };
}

class LiveEngine {
  constructor(options = {}) {
    this.stateStore = options.stateStore || new LiveStateStore();
    this.storage = options.storage || storage;
    this.qdrant = options.qdrant || qdrantClient;
    this.embedText = options.embedText || embedText;
    this.analyzeCase = options.analyzeCase || analyzeCase;
  }

  async initialize() {
    await this.qdrant.ensureCollectionExists();
    const openCases = await this.storage.fetchOpenCases();
    let rebuilt = 0;

    for (const caseRow of openCases) {
      try {
        const points = await this.qdrant.fetchRecentCaseEmbeddings(caseRow.id, LIVE_CONFIG.REBUILD_MESSAGE_LIMIT);
        if (points.length === 0) continue;
        this.stateStore.rebuildFromVectors(caseRow.id, caseRow, points);
        rebuilt += 1;
      } catch (error) {
        logger.error('Startup', 'Failed to rebuild live case state from Qdrant', {
          caseId: caseRow.id,
          error: error.message,
        });
      }
    }

    logger.info('Startup', 'Live state rebuilt from Qdrant', {
      openCases: openCases.length,
      rebuiltCases: rebuilt,
    });
  }

  async rebuildState(caseRow) {
    const points = await this.qdrant.fetchRecentCaseEmbeddings(caseRow.id, LIVE_CONFIG.REBUILD_MESSAGE_LIMIT);
    if (points.length === 0) return null;
    return this.stateStore.rebuildFromVectors(caseRow.id, caseRow, points);
  }

  async createAndAnalyzeCase(message, embedding) {
    let caseRow = await this.storage.createCase(message);
    await this.storage.linkMessage(caseRow.id, message);
    this.stateStore.init(caseRow.id, message, embedding);

    const analysis = await this.analyzeCase({
      trigger: 'new_case_creation',
      caseRow,
      messages: [message],
    });

    caseRow = await this.storage.updateCase(caseRow.id, analysisPatch(caseRow, analysis));
    await this.storage.createEvent(caseRow.id, 'case_created', analysis.event_summary || analysis.summary, message.message_id);
    await this.qdrant.upsertLiveMessage(message, caseRow, embedding);
    this.stateStore.resetAnalysisCounter(caseRow.id);
    metrics.increment('caseCreationCount');

    logger.info('Case creation', 'Created live case', {
      caseId: caseRow.id,
      messageId: message.message_id,
      routingType: caseRow.routing_type,
      attentionScore: caseRow.attention_score,
    });

    return caseRow;
  }

  async closeCaseForBoundary(caseRow, message) {
    const messages = await this.storage.fetchCaseMessages(caseRow.id, LIVE_CONFIG.REBUILD_MESSAGE_LIMIT);
    const analysis = await this.analyzeCase({
      trigger: 'boundary_closure',
      caseRow,
      messages,
    });

    await this.storage.updateCase(caseRow.id, {
      ...analysisPatch(caseRow, analysis),
      status: 'closed',
      current_status: analysis.current_status === 'resolved' ? 'resolved' : 'dormant',
    });
    await this.storage.createEvent(caseRow.id, 'boundary_detected', analysis.event_summary || 'Semantic boundary detected', message.message_id);
    await this.storage.createEvent(caseRow.id, 'case_closed', analysis.summary, message.message_id);
    await this.qdrant.markCaseClosed(caseRow.id);
    this.stateStore.forget(caseRow.id);
    metrics.increment('boundaryCount');
    metrics.increment('caseClosureCount');

    logger.info('Boundary detection', 'Closed case after semantic boundary', {
      caseId: caseRow.id,
      messageId: message.message_id,
    });
  }

  async updateExistingCase(caseRow, message, embedding, state, boundaryResult) {
    const linked = await this.storage.linkMessage(caseRow.id, message);
    if (!linked) {
      logger.warn('Message processing', 'Skipping duplicate live case message link', {
        caseId: caseRow.id,
        messageId: message.message_id,
      });
      await this.qdrant.upsertLiveMessage(message, caseRow, embedding);
      return caseRow;
    }

    const nextState = this.stateStore.append(caseRow.id, message, embedding, boundaryResult.similarity);
    const basePatch = {
      last_message_id: message.message_id,
      last_seen_at: message.timestamp || new Date().toISOString(),
      message_count: (caseRow.message_count || 0) + 1,
      update_count: (caseRow.update_count || 0) + 1,
      last_similarity: boundaryResult.similarity,
      confidence: boundaryResult.similarity,
      state: boundaryResult.similarity >= 0.75 ? 'active' : 'cooling',
    };

    let updatedCase = await this.storage.updateCase(caseRow.id, basePatch);
    await this.qdrant.upsertLiveMessage(message, updatedCase, embedding);

    if (shouldGenerateTimelineUpdate(nextState, message)) {
      const messages = await this.storage.fetchCaseMessages(caseRow.id, LIVE_CONFIG.REBUILD_MESSAGE_LIMIT);
      const analysis = await this.analyzeCase({
        trigger: 'significant_timeline_update',
        caseRow: updatedCase,
        messages,
      });

      if (analysis.current_status === 'resolved') {
        await this.storage.updateCase(caseRow.id, {
          ...analysisPatch(updatedCase, analysis),
          status: 'closed',
          current_status: 'resolved',
        });
        await this.storage.createEvent(caseRow.id, 'resolution_detected', analysis.event_summary || analysis.summary, message.message_id);
        await this.storage.createEvent(caseRow.id, 'case_closed', analysis.summary, message.message_id);
        await this.qdrant.markCaseClosed(caseRow.id);
        this.stateStore.forget(caseRow.id);
        metrics.increment('caseClosureCount');

        logger.info('Resolution detection', 'Closed case after LLM detected resolution', {
          caseId: caseRow.id,
          messageId: message.message_id,
        });
      } else {
        updatedCase = await this.storage.updateCase(caseRow.id, analysisPatch(updatedCase, analysis));
        await this.storage.createEvent(caseRow.id, 'timeline_update', analysis.event_summary || analysis.summary, message.message_id);
        this.stateStore.resetAnalysisCounter(caseRow.id);
      }
    }

    logger.info('Message processed', 'Updated live case', {
      caseId: caseRow.id,
      messageId: message.message_id,
      similarity: Number(boundaryResult.similarity.toFixed(4)),
      cohesionDrop: Number(boundaryResult.cohesionDrop.toFixed(4)),
    });

    return updatedCase;
  }

  async processMessage(message) {
    if (!message.content || !String(message.content).trim()) {
      await this.storage.markMessageProcessed(message.message_id);
      return null;
    }

    const embedding = await this.embedText(message.content, {
      stage: 'Embedding',
      messageId: message.message_id,
    });

    const retryCase = await this.storage.findCaseByMessageId(message.message_id);
    if (retryCase) {
      let recoveredCase = retryCase;
      if (!retryCase.summary && retryCase.first_message_id === message.message_id && retryCase.status === 'open') {
        const analysis = await this.analyzeCase({
          trigger: 'new_case_creation_retry',
          caseRow: retryCase,
          messages: [message],
        });
        recoveredCase = await this.storage.updateCase(retryCase.id, analysisPatch(retryCase, analysis));
        await this.storage.createEvent(retryCase.id, 'case_created', analysis.event_summary || analysis.summary, message.message_id);
        this.stateStore.init(retryCase.id, message, embedding);
        this.stateStore.resetAnalysisCounter(retryCase.id);
      }

      await this.qdrant.upsertLiveMessage(message, recoveredCase, embedding);
      await this.storage.markMessageProcessed(message.message_id);
      logger.warn('Message processing', 'Recovered already-linked live message', {
        caseId: recoveredCase.id,
        messageId: message.message_id,
      });
      return recoveredCase;
    }

    const qdrantMatch = await this.qdrant.searchActiveDiscussion(embedding, message);
    let caseRow = qdrantMatch ? await this.storage.getCaseById(qdrantMatch.caseId) : null;
    if (caseRow && caseRow.status !== 'open') {
      caseRow = null;
    }

    if (!caseRow) {
      const created = await this.createAndAnalyzeCase(message, embedding);
      await this.storage.markMessageProcessed(message.message_id);
      return created;
    }

    let state = this.stateStore.get(caseRow.id);
    if (!state) {
      state = await this.rebuildState(caseRow);
    }

    const boundaryResult = this.stateStore.evaluateBoundary(state, embedding);
    if (boundaryResult.isBoundary) {
      await this.closeCaseForBoundary(caseRow, message);
      const newCase = await this.createAndAnalyzeCase(message, embedding);
      await this.storage.markMessageProcessed(message.message_id);
      return newCase;
    }

    const updated = await this.updateExistingCase(caseRow, message, embedding, state, boundaryResult);
    await this.storage.markMessageProcessed(message.message_id);
    return updated;
  }

  async processBatch() {
    const messages = await this.storage.fetchUnprocessedMessages(LIVE_CONFIG.FETCH_LIMIT);
    if (messages.length === 0) return 0;

    logger.info('Polling', 'Fetched live messages', { count: messages.length });

    let processed = 0;
    for (const message of messages) {
      try {
        await this.processMessage(message);
        processed += 1;
        metrics.increment('messagesProcessed');
      } catch (error) {
        logger.error('Message processing', 'Failed to process live message', {
          messageId: message.message_id,
          channelId: message.channel_id,
          threadId: message.thread_id,
          error: error.message,
          stack: error.stack?.slice(0, 1000),
        });
      }
    }

    return processed;
  }

  async tick() {
    const processed = await this.processBatch();
    await this.logOperationalMetrics(processed);
    return { processed };
  }

  async logOperationalMetrics(processed) {
    try {
      const dbMetrics = await this.storage.fetchOperationalMetrics();
      const activeCases = dbMetrics.openCases || 0;
      metrics.set('activeCases', activeCases);

      if (activeCases > 100) {
        logger.error('Metrics', 'Abnormal active case count — possible runaway case creation', {
          activeCases,
          threshold: 100,
        });
      }

      logger.info('Metrics', 'Live engine metrics', {
        ...dbMetrics,
        ...metrics.snapshot(),
        processedThisTick: processed,
      });
    } catch (error) {
      logger.error('Metrics', 'Failed to fetch live engine metrics', {
        error: error.message,
      });
    }
  }
}

module.exports = {
  LiveEngine,
  validateEnv,
  analysisPatch,
};
