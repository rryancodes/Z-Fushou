const { Queue, Worker, QueueEvents } = require('bullmq');
const pino = require('pino');

const log = pino({ level: 'info' }, pino.destination(1));

// Redis connection config — reads from env
const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379'
};

// ─── Queues ───────────────────────────────────────────────────────────
// One queue per job type keeps things clean and debuggable
// TEMP: Use no-op stubs when Redis is unavailable (local dev without Redis)
const noOpQueue = { add: async () => {} };
let issueQueue    = noOpQueue;
let forwardQueue  = noOpQueue;
let notifyQueue   = noOpQueue;
let reminderQueue = noOpQueue;

const redisUrl = process.env.REDIS_URL || '';
const isRedisAvailable = redisUrl && !redisUrl.includes('railway.internal');

if (isRedisAvailable) {
  issueQueue    = new Queue('issue-processing', { connection });
  forwardQueue  = new Queue('issue-forwarding', { connection });
  notifyQueue   = new Queue('user-notification', { connection });
  reminderQueue = new Queue('reminders',         { connection });
} else {
  log.warn('Redis unavailable — BullMQ queues are stubbed (no-op). Set REDIS_URL to enable.');
}

// ─── Add jobs ─────────────────────────────────────────────────────────
async function addIssueJob(data) {
  await issueQueue.add('process-issue', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  log.info({ jobType: 'process-issue', userId: data.userId }, 'Issue job queued');
}

async function addForwardJob(data) {
  await forwardQueue.add('forward-issue', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }
  });
  log.info({ jobType: 'forward-issue', shortId: data.shortId }, 'Forward job queued');
}

async function addNotifyJob(data) {
  await notifyQueue.add('notify-user', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 }
  });
  log.info({ jobType: 'notify-user', shortId: data.shortId }, 'Notify job queued');
}

async function addReminderJob(data) {
  await reminderQueue.add('send-reminder', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 }
  });
}

module.exports = {
  issueQueue,
  forwardQueue,
  notifyQueue,
  reminderQueue,
  addIssueJob,
  addForwardJob,
  addNotifyJob,
  addReminderJob,
  connection,
  log
};