const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { fetchJsonWithRetry, getHttpQueueStats, runWithCorrelationId } = require("../httpClient");

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

test("fetchJsonWithRetry retries transient failures and reports retry count", async () => {
  let calls = 0;
  let seenCorrelation = null;

  const { server, url } = await createServer((req, res) => {
    calls += 1;
    seenCorrelation = req.headers["x-correlation-id"] ?? null;
    if (calls === 1) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: false, message: "retry me" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });

  try {
    const result = await fetchJsonWithRetry(`${url}/retry`, {}, {
      retries: 2,
      retryDelayMs: 1,
      timeoutMs: 2000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.retryCount, 1);
    assert.equal(calls, 2);
    assert.equal(typeof result.correlationId, "string");
    assert.equal(result.correlationId.length > 0, true);
    assert.equal(typeof seenCorrelation, "string");
    assert.equal(seenCorrelation.length > 0, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runWithCorrelationId propagates request correlation id to outbound calls", async () => {
  let seenCorrelation = null;

  const { server, url } = await createServer((req, res) => {
    seenCorrelation = req.headers["x-correlation-id"] ?? null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });

  try {
    const result = await runWithCorrelationId("cid-test-123", () =>
      fetchJsonWithRetry(`${url}/cid`, {}, { retries: 0, timeoutMs: 2000 }),
    );

    assert.equal(result.ok, true);
    assert.equal(result.correlationId, "cid-test-123");
    assert.equal(seenCorrelation, "cid-test-123");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("getHttpQueueStats exposes latency percentile samples", async () => {
  const { server, url } = await createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true }));
  });

  try {
    await fetchJsonWithRetry(`${url}/metrics`, {}, { retries: 0, timeoutMs: 2000 });
    const stats = getHttpQueueStats();

    assert.equal(typeof stats.latencyMs.samples, "number");
    assert.equal(stats.latencyMs.samples > 0, true);
    assert.equal(stats.latencyMs.p50 === null || typeof stats.latencyMs.p50 === "number", true);
    assert.equal(stats.latencyMs.p95 === null || typeof stats.latencyMs.p95 === "number", true);
    assert.equal(stats.latencyMs.p99 === null || typeof stats.latencyMs.p99 === "number", true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
