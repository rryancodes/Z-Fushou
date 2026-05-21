const pino = require('pino');

// Create pino logger with pretty output for Railway logs
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'production' ? undefined : {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});

let batchId = 'no-batch';

function setBatchId(id) {
  batchId = id;
}

function log(level, step, message, data = {}) {
  // Use pino's structured logging for better Railway log visibility
  const logData = {
    batchId,
    step,
    ...data,
  };

  // Remove undefined values for cleaner logs
  Object.keys(logData).forEach(key => {
    if (logData[key] === undefined) delete logData[key];
  });

  logger[level](logData, message);
}

const loggerExport = {
  info: (step, message, data) => log('info', step, message, data),
  warn: (step, message, data) => log('warn', step, message, data),
  error: (step, message, data) => log('error', step, message, data),
  debug: (step, message, data) => log('debug', step, message, data),
  setBatchId,
};

module.exports = loggerExport;
