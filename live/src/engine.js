const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { embedText } = require('./cloudflare');
const { analyzeCase } = require('./analyzer');
const { LiveStateStore, shouldGenerateTimelineUpdate } = require('./state');
const storage = require('./storage');
const qdrantClient = require('./qdrantClient');
const metrics = require('./metrics');

function validateEnv() {
  const { validateCredentials } = require('../../lib/cfCredentials');
  const missing = LIVE_CONFIG.REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required live engine environment variables: ${missing.join(', ')}`);
  }
  validateCredentials();
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
    this.refreshLock = options.refreshLock || (() => Promise.resolve(true));
    this.lastDailyResetDate = null;
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
      state: 'closed',
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
          state: 'closed',
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

  async closeStaleCases() {
    const staleCases = await this.storage.fetchStaleOpenCases();
    if (staleCases.length === 0) return 0;

    logger.info('Stale closure', 'Closing stale open cases', { count: staleCases.length });

    let closed = 0;
    for (const caseRow of staleCases) {
      try {
        await this.storage.updateCase(caseRow.id, {
          status: 'closed',
          state: 'closed',
          current_status: 'dormant',
        });
        await this.storage.createEvent(caseRow.id, 'stale_closed', `Case closed after ${LIVE_CONFIG.STALE_CASE_MINUTES} minutes of inactivity`);
        await this.qdrant.markCaseClosed(caseRow.id);
        this.stateStore.forget(caseRow.id);
        metrics.increment('caseClosureCount');
        closed += 1;
      } catch (error) {
        logger.error('Stale closure', 'Failed to close stale case', {
          caseId: caseRow.id,
          error: error.message,
        });
      }
    }

    logger.info('Stale closure', 'Closed stale cases', { closed, total: staleCases.length });
    return closed;
  }

  async dailyReset() {
    const now = new Date();
    const utcHour = now.getUTCHours();
    const todayStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

    // Only run if we're past the reset hour and haven't run yet today
    if (utcHour < LIVE_CONFIG.DAILY_RESET_HOUR_UTC) return 0;
    if (this.lastDailyResetDate === todayStr) return 0;

    const openCases = await this.storage.fetchOpenCases();
    if (openCases.length === 0) {
      this.lastDailyResetDate = todayStr;
      return 0;
    }

    logger.info('Daily reset', 'Closing all remaining open cases for daily reset', {
      count: openCases.length,
      resetHour: LIVE_CONFIG.DAILY_RESET_HOUR_UTC,
    });

    let closed = 0;
    for (const caseRow of openCases) {
      try {
        await this.storage.updateCase(caseRow.id, {
          status: 'closed',
          state: 'closed',
          current_status: 'dormant',
        });
        await this.storage.createEvent(caseRow.id, 'daily_reset', 'Case closed by daily reset');
        await this.qdrant.markCaseClosed(caseRow.id);
        this.stateStore.forget(caseRow.id);
        metrics.increment('caseClosureCount');
        closed += 1;
      } catch (error) {
        logger.error('Daily reset', 'Failed to close case during daily reset', {
          caseId: caseRow.id,
          error: error.message,
        });
      }
    }

    this.lastDailyResetDate = todayStr;

    // Wipe all closed Qdrant points — fresh start for the new day
    try {
      await this.qdrant.deleteClosedPoints();
    } catch (error) {
      logger.error('Daily reset', 'Failed to delete closed Qdrant points', {
        error: error.message,
      });
    }

    logger.info('Daily reset', 'Daily reset complete', {
      closed,
      total: openCases.length,
      date: todayStr,
    });

    return closed;
  }

  async reopenCase(closedCaseRow, message, embedding, matchScore) {
    const caseId = closedCaseRow.id;

    // Reopen in Supabase — always use current time for last_seen_at
    // to prevent immediate stale closure
    let caseRow = await this.storage.updateCase(caseId, {
      status: 'open',
      state: 'active',
      current_status: 'active',
      last_message_id: message.message_id,
      last_seen_at: new Date().toISOString(),
      message_count: (closedCaseRow.message_count || 0) + 1,
      update_count: (closedCaseRow.update_count || 0) + 1,
      last_similarity: matchScore,
      confidence: matchScore,
    });

    // Link the new message to the reopened case
    await this.storage.linkMessage(caseId, message);

    // Reopen Qdrant points — flip all old points back to 'open'
    await this.qdrant.markCaseReopened(caseId);
    // Upsert the new message with open status
    await this.qdrant.upsertLiveMessage(message, caseRow, embedding);

    // Rebuild in-memory centroid from Qdrant vectors
    await this.rebuildState(caseRow);

    // Fetch ALL messages (old + new) and run full LLM analysis with context
    const messages = await this.storage.fetchCaseMessages(caseId, LIVE_CONFIG.REBUILD_MESSAGE_LIMIT);
    const analysis = await this.analyzeCase({
      trigger: 'case_reopened',
      caseRow,
      messages,
    });

    if (analysis.current_status === 'resolved') {
      await this.storage.updateCase(caseId, {
        ...analysisPatch(caseRow, analysis),
        status: 'closed',
        state: 'closed',
        current_status: 'resolved',
      });
      await this.storage.createEvent(caseId, 'resolution_detected', analysis.event_summary || analysis.summary, message.message_id);
      await this.storage.createEvent(caseId, 'case_closed', analysis.summary, message.message_id);
      await this.qdrant.markCaseClosed(caseId);
      this.stateStore.forget(caseId);
      metrics.increment('caseClosureCount');
    } else {
      caseRow = await this.storage.updateCase(caseId, analysisPatch(caseRow, analysis));
      this.stateStore.resetAnalysisCounter(caseId);
    }

    await this.storage.createEvent(caseId, 'case_reopened', analysis.event_summary || `Case reopened — new message matched closed case (score: ${matchScore.toFixed(4)})`, message.message_id);
    metrics.increment('caseReopenCount');

    logger.info('Case reopen', 'Reopened closed case with new message', {
      caseId,
      messageId: message.message_id,
      matchScore: Number(matchScore.toFixed(4)),
      previousMessages: closedCaseRow.message_count || 0,
    });

    return caseRow;
  }

  async processMessage(message, batchContext = {}) {
    if (!message.content || !String(message.content).trim()) {
      await this.storage.markMessageProcessed(message.message_id);
      return null;
    }

    const content = String(message.content).trim();
    if (content.length < 5) {
      logger.info('Message processing', `Skipping low-content message (${content.length} chars): "${content}"`, {
        messageId: message.message_id,
      });
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
        recoveredCase = await this.storage.updateCase(recoveredCase.id, analysisPatch(recoveredCase, analysis));
        await this.storage.createEvent(recoveredCase.id, 'case_created', analysis.event_summary || analysis.summary, message.message_id);
        this.stateStore.init(recoveredCase.id, message, embedding);
        this.stateStore.resetAnalysisCounter(recoveredCase.id);
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
      // No open case matched — check recently-closed cases for context continuation
      // Uses batch-cached closed case list to avoid repeated Supabase queries
      try {
        const closedCases = batchContext.closedCases || [];
        if (closedCases.length > 0) {
          const closedCaseIds = closedCases.map((c) => c.id);
          const closedMatch = await this.qdrant.searchByCaseIds(embedding, closedCaseIds, message);
          if (closedMatch) {
            const closedCaseRow = closedCases.find((c) => c.id === closedMatch.caseId) || await this.storage.getCaseById(closedMatch.caseId);
            if (closedCaseRow) {
              const reopened = await this.reopenCase(closedCaseRow, message, embedding, closedMatch.score);
              await this.storage.markMessageProcessed(message.message_id);
              return reopened;
            }
          }
        }
      } catch (error) {
        logger.error('Case reopen', 'Failed to check closed cases, creating new case instead', {
          error: error.message,
          messageId: message.message_id,
        });
      }

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

    // Fetch recently-closed cases once for the entire batch
    let closedCases = [];
    try {
      const guildIds = [...new Set(messages.map((m) => m.guild_id).filter(Boolean))];
      if (guildIds.length > 0) {
        const allClosed = await Promise.all(
          guildIds.map((gid) => this.storage.fetchRecentlyClosedCases(gid, LIVE_CONFIG.CASE_REOPEN_WINDOW_HOURS)),
        );
        closedCases = allClosed.flat();
      }
    } catch (error) {
      logger.error('Polling', 'Failed to prefetch closed cases for batch', {
        error: error.message,
      });
    }

    const batchContext = { closedCases };

    let processed = 0;
    for (const message of messages) {
      try {
        await this.processMessage(message, batchContext);
        processed += 1;
        metrics.increment('messagesProcessed');

        // Refresh lock every 5 messages to prevent expiry during long batches
        if (processed % 5 === 0) {
          const alive = await this.refreshLock();
          if (!alive) {
            logger.error('Polling', 'Lock lost during batch — stopping');
            return processed;
          }
        }
      } catch (error) {
        const preview = String(message.content || '').slice(0, 80);
        logger.error('Message processing', `Failed to process live message: ${error.message}`, {
          messageId: message.message_id,
          channelId: message.channel_id,
          threadId: message.thread_id,
          contentPreview: preview,
          stack: error.stack?.slice(0, 1000),
        });
      }
    }

    return processed;
  }

  async tick() {
    const processed = await this.processBatch();
    await this.closeStaleCases();
    await this.dailyReset();
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
