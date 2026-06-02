require('dotenv').config();

const { LIVE_CONFIG } = require('../live.config');
const logger = require('./logger');
const { sleep } = require('./retry');
const { LiveEngine, validateEnv } = require('./engine');
const { checkDependencies } = require('./health');
const lock = require('./lock');

let stopped = false;

async function runLiveEngine() {
  validateEnv();

  // Fail hard if any dependency is unreachable
  await checkDependencies();

  // Acquire distributed lock — prevents duplicate workers
  await lock.initRedis();
  const acquired = await lock.acquireLock();
  if (!acquired) {
    throw new Error('Live engine lock already held — another instance is running. Exiting.');
  }

  const engine = new LiveEngine();
  await engine.initialize();

  logger.info('Startup', 'Live engine started', {
    pollIntervalMs: LIVE_CONFIG.POLL_INTERVAL_MS,
    fetchLimit: LIVE_CONFIG.FETCH_LIMIT,
  });

  try {
    while (!stopped) {
      try {
        // Refresh lock every tick — if lost, another instance took over
        const refreshed = await lock.refreshLock();
        if (!refreshed) {
          logger.error('Polling', 'Lock lost — stopping engine');
          break;
        }

        await engine.tick();
      } catch (error) {
        logger.error('Polling', 'Live engine tick failed', {
          error: error.message,
          stack: error.stack?.slice(0, 1000),
        });
      }

      await sleep(LIVE_CONFIG.POLL_INTERVAL_MS);
    }
  } finally {
    await lock.releaseLock();
    await lock.close();
    logger.info('Shutdown', 'Live engine stopped and lock released');
  }
}

async function runLiveEngineOnce() {
  validateEnv();
  await checkDependencies();

  await lock.initRedis();
  const acquired = await lock.acquireLock();
  if (!acquired) {
    throw new Error('Live engine lock already held — another instance is running.');
  }

  try {
    const engine = new LiveEngine();
    await engine.initialize();
    logger.info('Startup', 'Live engine one-shot tick started');
    const result = await engine.tick();
    logger.info('Shutdown', 'Live engine one-shot tick complete', result);
    return result;
  } finally {
    await lock.releaseLock();
    await lock.close();
  }
}

function stopLiveEngine() {
  stopped = true;
}

if (require.main === module) {
  const runner = process.argv.includes('--once') ? runLiveEngineOnce : runLiveEngine;
  runner().catch((error) => {
    logger.error('Startup', 'Live engine fatal error', {
      error: error.message,
      stack: error.stack?.slice(0, 1000),
    });
    process.exitCode = 1;
  });

  process.on('SIGTERM', () => stopLiveEngine());
  process.on('SIGINT', () => stopLiveEngine());
}

module.exports = { runLiveEngine, runLiveEngineOnce, stopLiveEngine };
