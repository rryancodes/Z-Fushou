const pino = require('pino');

const base = pino({
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

function clean(data) {
  const out = { service: 'LiveEngine', ...data };
  Object.keys(out).forEach((key) => {
    if (out[key] === undefined) delete out[key];
  });
  return out;
}

function log(level, stage, message, data = {}) {
  base[level](clean({ stage, ...data }), message);
}

module.exports = {
  info: (stage, message, data) => log('info', stage, message, data),
  warn: (stage, message, data) => log('warn', stage, message, data),
  error: (stage, message, data) => log('error', stage, message, data),
  debug: (stage, message, data) => log('debug', stage, message, data),
};
