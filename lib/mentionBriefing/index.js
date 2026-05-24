// lib/mentionBriefing/index.js
// Real-time mention briefing service.
// Polls every 60s for monitored mentions that need summarization.
// Restart-safe: uses DB state (mention_summary IS NULL) instead of timers.

const { fetchEligibleMentions, collectContext, writeSummary } = require('./contextCollector');
const { semanticRank, generateSummary } = require('./summaryGenerator');

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

let pollTimer = null;
let isRunning = false;

// ── Single mention processing ─────────────────────────────────────────

async function processMention(mention) {
  const tag = `[mentionBriefing] ${mention.message_id.slice(-8)}`;

  // Step 1: Collect context (previous 5, next 3, author recent 3, reply parent)
  console.log(`${tag} Collecting context for @${mention.username}`);
  const candidates = await collectContext(mention);
  console.log(`${tag} Collected ${candidates.length} context messages`);

  // Step 2: Semantic ranking if > 2 candidates
  let finalContext;
  if (candidates.length > 2) {
    console.log(`${tag} Running semantic ranking`);
    finalContext = await semanticRank(candidates);
    console.log(`${tag} Trimmed to ${finalContext.length} messages`);
  } else {
    finalContext = candidates;
  }

  // Step 3: Generate summary via LLM
  console.log(`${tag} Generating summary`);
  const summary = await generateSummary(finalContext, mention.mentioned_user_ids);

  if (!summary) {
    console.error(`${tag} Summary generation failed — will retry next cycle`);
    return;
  }

  // Step 4: Write summary back to the same row
  await writeSummary(mention.message_id, summary);
  console.log(`${tag} Summary saved: "${summary.slice(0, 80)}..."`);
}

// ── Poll cycle ────────────────────────────────────────────────────────

async function runCycle() {
  if (isRunning) return; // prevent overlapping cycles
  isRunning = true;

  try {
    const mentions = await fetchEligibleMentions();

    if (mentions.length === 0) return;

    console.log(`[mentionBriefing] Found ${mentions.length} eligible mention(s)`);

    // Process sequentially to avoid rate limits on embedding/LLM APIs
    for (const mention of mentions) {
      try {
        await processMention(mention);
      } catch (err) {
        console.error(`[mentionBriefing] Failed to process ${mention.message_id}:`, err.message);
        // Leave both fields NULL — will retry next cycle
      }
    }
  } catch (err) {
    console.error('[mentionBriefing] Poll cycle error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ── Start / Stop ──────────────────────────────────────────────────────

function start() {
  if (pollTimer) return; // already running

  // Run first cycle immediately
  runCycle();

  // Then poll every POLL_INTERVAL_MS
  pollTimer = setInterval(runCycle, POLL_INTERVAL_MS);
  console.log(`[mentionBriefing] Service started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  console.log('[mentionBriefing] Service stopped');
}

module.exports = { start, stop };
