const fetch = require("node-fetch");
const crypto = require("crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_MAX_QUEUE = 128;
const DEFAULT_LATENCY_WINDOW = 500;
const inFlightByKey = new Map();
const latencyMsHistory = [];
const correlationStorage = new AsyncLocalStorage();

const queueState = {
  active: 0,
  maxConcurrency: DEFAULT_MAX_CONCURRENCY,
  maxQueue: DEFAULT_MAX_QUEUE,
  queue: [],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCorrelationId() {
  return `proxy-${Date.now().toString(36)}-${crypto.randomUUID()}`;
}

function getCurrentCorrelationId() {
  return correlationStorage.getStore() || null;
}

function runWithCorrelationId(correlationId, fn) {
  const safeCorrelationId = correlationId || buildCorrelationId();
  return correlationStorage.run(safeCorrelationId, fn);
}

function recordLatency(durationMs) {
  latencyMsHistory.push(durationMs);
  if (latencyMsHistory.length > DEFAULT_LATENCY_WINDOW) {
    latencyMsHistory.splice(0, latencyMsHistory.length - DEFAULT_LATENCY_WINDOW);
  }
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * (sorted.length - 1))));
  return sorted[index];
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function runQueued(operation) {
  return new Promise((resolve, reject) => {
    if (queueState.active >= queueState.maxConcurrency && queueState.queue.length >= queueState.maxQueue) {
      reject(new Error("HTTP queue is saturated"));
      return;
    }

    const execute = () => {
      queueState.active += 1;
      Promise.resolve()
        .then(operation)
        .then(resolve)
        .catch(reject)
        .finally(() => {
          queueState.active -= 1;
          const next = queueState.queue.shift();
          if (next) next();
        });
    };

    if (queueState.active < queueState.maxConcurrency) {
      execute();
    } else {
      queueState.queue.push(execute);
    }
  });
}

async function fetchJsonWithRetry(url, options = {}, {
  retries = 2,
  timeoutMs = 15000,
  retryDelayMs = 300,
  retryStatuses = DEFAULT_RETRY_STATUSES,
  requestKey = null,
  correlationId = null,
} = {}) {
  const perform = async () => {
    let attempt = 0;
    let lastError;
    const requestStartedAt = Date.now();
    const requestCorrelationId = correlationId || getCurrentCorrelationId() || buildCorrelationId();

    const requestOptions = {
      ...options,
      headers: {
        ...(options.headers || {}),
        "x-correlation-id": requestCorrelationId,
      },
    };

    while (attempt <= retries) {
      try {
        const response = await runQueued(() => fetchWithTimeout(url, requestOptions, timeoutMs));
        const shouldRetry = retryStatuses.has(response.status);

        if (!shouldRetry || attempt === retries) {
          const data = await response.json();
          const durationMs = Date.now() - requestStartedAt;
          recordLatency(durationMs);
          return {
            ok: response.ok,
            status: response.status,
            data,
            durationMs,
            retryCount: attempt,
            correlationId: requestCorrelationId,
          };
        }
      } catch (err) {
        lastError = err;
        if (attempt === retries) throw err;
      }

      const backoff = retryDelayMs * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 100);
      await sleep(backoff + jitter);
      attempt += 1;
    }

    throw lastError ?? new Error("Request failed without an explicit error");
  };

  if (!requestKey) return perform();

  if (inFlightByKey.has(requestKey)) {
    return inFlightByKey.get(requestKey);
  }

  const promise = perform().finally(() => inFlightByKey.delete(requestKey));
  inFlightByKey.set(requestKey, promise);
  return promise;
}

function getHttpQueueStats() {
  return {
    active: queueState.active,
    queued: queueState.queue.length,
    maxConcurrency: queueState.maxConcurrency,
    maxQueue: queueState.maxQueue,
    inFlightKeys: inFlightByKey.size,
    latencyMs: {
      p50: percentile(latencyMsHistory, 0.5),
      p95: percentile(latencyMsHistory, 0.95),
      p99: percentile(latencyMsHistory, 0.99),
      samples: latencyMsHistory.length,
    },
  };
}

module.exports = {
  fetchJsonWithRetry,
  getHttpQueueStats,
  runWithCorrelationId,
  getCurrentCorrelationId,
};
