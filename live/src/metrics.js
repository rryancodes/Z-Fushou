const counters = {
  boundaryCount: 0,
  caseCreationCount: 0,
  caseClosureCount: 0,
  embeddingFailures: 0,
  llmFailures: 0,
  messagesProcessed: 0,
  qdrantFailures: 0,
  retryCount: 0,
};

const gauges = {
  activeCases: 0,
};

function increment(name, amount = 1) {
  if (!Object.prototype.hasOwnProperty.call(counters, name)) {
    counters[name] = 0;
  }
  counters[name] += amount;
}

function set(name, value) {
  gauges[name] = value;
}

function snapshot() {
  return { ...counters, ...gauges };
}

function reset() {
  Object.keys(counters).forEach((key) => {
    counters[key] = 0;
  });
  Object.keys(gauges).forEach((key) => {
    gauges[key] = 0;
  });
}

module.exports = {
  increment,
  set,
  snapshot,
  reset,
};
