const { createClient } = require('@supabase/supabase-js');
const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { withRetry } = require('./retry');

let supabase = null;

function getSupabase() {
  if (!supabase) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

function setSupabaseClient(client) {
  supabase = client;
}

async function dbRetry(stage, fn, context = {}) {
  return withRetry(fn, {
    stage,
    logger,
    context,
    retries: LIVE_CONFIG.RETRY_COUNT,
    baseDelayMs: LIVE_CONFIG.RETRY_BASE_MS,
  });
}

function applyThreadFilter(query, threadId) {
  return threadId ? query.eq('thread_id', threadId) : query.is('thread_id', null);
}

async function fetchUnprocessedMessages(limit = LIVE_CONFIG.FETCH_LIMIT) {
  return dbRetry('Supabase fetch live rows', async () => {
    const db = getSupabase();
    const { data: cleanRows, error } = await db
      .from('community_messages_clean')
      .select('id, message_id, channel_id, user_id, username, content, timestamp, created_at')
      .is('live_processed_at', null)
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    if (!cleanRows || cleanRows.length === 0) return [];

    const messageIds = cleanRows.map((row) => row.message_id);
    const { data: rawRows, error: rawError } = await db
      .from('community_messages')
      .select('message_id, guild_id, thread_id, channel_id')
      .in('message_id', messageIds);

    if (rawError) throw rawError;

    const rawById = new Map((rawRows || []).map((row) => [row.message_id, row]));
    return cleanRows.map((row) => {
      const raw = rawById.get(row.message_id) || {};
      return {
        ...row,
        guild_id: raw.guild_id || 'unknown',
        channel_id: raw.channel_id || row.channel_id || 'unknown',
        thread_id: raw.thread_id || null,
      };
    });
  });
}

async function fetchOpenCases(limit = 500) {
  return dbRetry('Supabase fetch open cases', async () => {
    const { data, error } = await getSupabase()
      .from('live_cases')
      .select('*')
      .eq('status', 'open')
      .order('last_seen_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data || [];
  });
}

async function getCaseById(caseId) {
  return dbRetry('Supabase get case by id', async () => {
    const { data, error } = await getSupabase()
      .from('live_cases')
      .select('*')
      .eq('id', caseId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }, { caseId });
}

async function findCaseByMessageId(messageId) {
  return dbRetry('Supabase find case by message', async () => {
    const db = getSupabase();
    const { data: links, error } = await db
      .from('live_case_messages')
      .select('case_id')
      .eq('message_id', messageId)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error) throw error;
    const caseId = links?.[0]?.case_id;
    if (!caseId) return null;
    return getCaseById(caseId);
  }, { messageId });
}

async function createCase(message) {
  return dbRetry('Supabase create case', async () => {
    const now = new Date().toISOString();
    const { data, error } = await getSupabase()
      .from('live_cases')
      .insert({
        guild_id: message.guild_id,
        channel_id: message.channel_id,
        thread_id: message.thread_id,
        status: 'open',
        summary: null,
        current_status: 'active',
        routing_type: 'unknown',
        attention_score: 'low',
        timeline: [],
        unresolved_questions: [],
        first_message_id: message.message_id,
        last_message_id: message.message_id,
        first_seen_at: message.timestamp || now,
        last_seen_at: message.timestamp || now,
        message_count: 1,
        updated_at: now,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }, { messageId: message.message_id });
}

async function updateCase(caseId, patch) {
  return dbRetry('Supabase update case', async () => {
    const { data, error } = await getSupabase()
      .from('live_cases')
      .update({
        ...patch,
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }, { caseId });
}

async function linkMessage(caseId, message) {
  return dbRetry('Supabase link case message', async () => {
    const { data: existing, error: existingError } = await getSupabase()
      .from('live_case_messages')
      .select('id')
      .eq('case_id', caseId)
      .eq('message_id', message.message_id)
      .limit(1);

    if (existingError) throw existingError;
    if (existing && existing.length > 0) return false;

    const { error } = await getSupabase()
      .from('live_case_messages')
      .insert({
        case_id: caseId,
        message_id: message.message_id,
        created_at: message.timestamp || new Date().toISOString(),
      });

    if (error) throw error;
    return true;
  }, { caseId, messageId: message.message_id });
}

async function createEvent(caseId, eventType, eventSummary, messageId) {
  return dbRetry('Supabase create event', async () => {
    const { error } = await getSupabase()
      .from('live_case_events')
      .insert({
        case_id: caseId,
        event_type: eventType,
        event_summary: eventSummary || null,
      });

    if (error) throw error;
  }, { caseId, messageId, eventType });
}

async function markMessageProcessed(messageId) {
  return dbRetry('Supabase mark live processed', async () => {
    const { error } = await getSupabase()
      .from('community_messages_clean')
      .update({ live_processed_at: new Date().toISOString() })
      .eq('message_id', messageId);

    if (error) throw error;
  }, { messageId });
}

async function fetchCaseMessages(caseId, limit = LIVE_CONFIG.REBUILD_MESSAGE_LIMIT) {
  return dbRetry('Supabase fetch case messages', async () => {
    const db = getSupabase();
    const { data: links, error } = await db
      .from('live_case_messages')
      .select('message_id, created_at')
      .eq('case_id', caseId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!links || links.length === 0) return [];

    const messageIds = links.map((row) => row.message_id);
    const { data: messages, error: msgError } = await db
      .from('community_messages_clean')
      .select('id, message_id, channel_id, user_id, username, content, timestamp, created_at')
      .in('message_id', messageIds);

    if (msgError) throw msgError;

    const byId = new Map((messages || []).map((row) => [row.message_id, row]));
    return links
      .map((link) => byId.get(link.message_id))
      .filter(Boolean)
      .reverse();
  }, { caseId });
}

async function fetchQuietOpenCases(cutoffIso, limit = 50) {
  return dbRetry('Supabase fetch quiet cases', async () => {
    const { data, error } = await getSupabase()
      .from('live_cases')
      .select('*')
      .eq('status', 'open')
      .lt('last_seen_at', cutoffIso)
      .order('last_seen_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  });
}

async function fetchOperationalMetrics() {
  return dbRetry('Supabase fetch live metrics', async () => {
    const db = getSupabase();
    const [openCases, closedCases, boundaryEvents, recentClosed] = await Promise.all([
      db.from('live_cases').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      db.from('live_cases').select('id', { count: 'exact', head: true }).eq('status', 'closed'),
      db.from('live_case_events').select('id', { count: 'exact', head: true }).eq('event_type', 'boundary_detected'),
      db
        .from('live_cases')
        .select('first_seen_at, last_seen_at')
        .eq('status', 'closed')
        .not('first_seen_at', 'is', null)
        .not('last_seen_at', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(100),
    ]);

    for (const result of [openCases, closedCases, boundaryEvents, recentClosed]) {
      if (result.error) throw result.error;
    }

    const durations = (recentClosed.data || [])
      .map((row) => new Date(row.last_seen_at).getTime() - new Date(row.first_seen_at).getTime())
      .filter((ms) => Number.isFinite(ms) && ms >= 0);
    const averageCaseDurationMinutes = durations.length
      ? Math.round((durations.reduce((sum, ms) => sum + ms, 0) / durations.length) / 60000)
      : 0;

    return {
      openCases: openCases.count || 0,
      closedCases: closedCases.count || 0,
      averageCaseDurationMinutes,
      boundaryCount: boundaryEvents.count || 0,
    };
  });
}

module.exports = {
  getSupabase,
  setSupabaseClient,
  fetchUnprocessedMessages,
  fetchOpenCases,
  getCaseById,
  findCaseByMessageId,
  createCase,
  updateCase,
  linkMessage,
  createEvent,
  markMessageProcessed,
  fetchCaseMessages,
  fetchQuietOpenCases,
  fetchOperationalMetrics,
};
