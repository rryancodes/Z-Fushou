// index.js — Discord Message Ingestion Bot
// Silent bot: listens to configured channels, ingests messages into Supabase.
// No replies, no AI, no support workflows, no commands.

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  Partials,
} = require('discord.js');

const ingestion = require('./lib/ingestion');
const cleaning = require('./lib/cleaning');

// ── Semantic pipeline scheduler (cron-based) ──────────────────────
// Runs daily at 7:00 AM Beijing Time (Asia/Shanghai) via node-cron
// Set PIPELINE_ENABLED=true to activate
const PIPELINE_ENABLED = process.env.PIPELINE_ENABLED === 'true';
const PIPELINE_CRON = process.env.PIPELINE_CRON || '0 7 * * *';       // default: 7:00 AM
const PIPELINE_TZ = process.env.PIPELINE_TZ || 'Asia/Shanghai';       // default: Beijing time
let pipelineJob = null;

function startPipelineScheduler() {
  if (!PIPELINE_ENABLED) return;

  const cron = require('node-cron');
  const { runPipeline } = require('./pipeline/src/index');

  pipelineJob = cron.schedule(PIPELINE_CRON, async () => {
    console.log('[pipeline] Starting scheduled semantic pipeline run');
    try {
      await runPipeline();
      console.log('[pipeline] Scheduled run complete');
    } catch (err) {
      console.error('[pipeline] Scheduled run failed:', err.message);
    }
  }, {
    scheduled: true,
    timezone: PIPELINE_TZ,
  });

  console.log(`[pipeline] Scheduler active — cron "${PIPELINE_CRON}" (${PIPELINE_TZ})`);
}

function stopPipelineScheduler() {
  if (pipelineJob) {
    pipelineJob.stop();
    pipelineJob = null;
  }
}

// ── Client setup ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel]
});

// ── Ready ────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`[bot] Online as ${client.user.tag} (${client.guilds.cache.size} guilds)`);
  console.log('[bot] Mode: ingestion-only — silent listener, no replies');

  // Start message ingestion (backfill + real-time batch writer)
  try {
    await ingestion.init(client);
    console.log('[ingestion] Started');
  } catch (err) {
    console.error('[ingestion] Init failed:', err.message);
  }

  // Start autonomous cleaning loop
  // CLEAN_INTERVAL_MINUTES: number in minutes (default: 5)
  const cleanMinutes = parseInt(process.env.CLEAN_INTERVAL_MINUTES, 10) || 5;
  const cleanIntervalMs = cleanMinutes * 60 * 1000;
  try {
    cleaning.start({ intervalMs: cleanIntervalMs });
    console.log(`[cleaning] Autonomous loop started (every ${cleanMinutes} min)`);
  } catch (err) {
    console.error('[cleaning] Start failed:', err.message);
  }

  // Start semantic pipeline scheduler (if enabled)
  if (PIPELINE_ENABLED) {
    startPipelineScheduler();
  } else {
    console.log('[pipeline] Disabled (set PIPELINE_ENABLED=true to activate)');
  }

  console.log('[bot] Systems running — ingestion + cleaning active');
});

// ── Message listener — route all messages through ingestion ─────────
client.on('messageCreate', message => {
  ingestion.handleMessage(message);
});

// ── Graceful shutdown ────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[bot] ${signal} received — shutting down gracefully`);
  stopPipelineScheduler();
  cleaning.stop();
  await ingestion.shutdown();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Login ────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
