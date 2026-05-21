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

  console.log('[bot] Systems running — ingestion + cleaning active');
});

// ── Message listener — route all messages through ingestion ─────────
client.on('messageCreate', message => {
  ingestion.handleMessage(message);
});

// ── Graceful shutdown ────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[bot] ${signal} received — shutting down gracefully`);
  cleaning.stop();
  await ingestion.shutdown();
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── Login ────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
