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

test("proxy exposes a socket.io endpoint for importer websocket clients", async () => {
  const { createServer: createProxyServer } = require("../index.js");
  const { server, url } = await createProxyServer({ port: 0 });

  try {
    const response = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /^0\{/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("proxy serves the adventure browser endpoints with CORS", async () => {
  const { createServer: createProxyServer } = require("../index.js");
  const { server, url } = await createProxyServer({ port: 0 });

  try {
    const origin = "http://example.com";

    const summaryPreflight = await fetch(`${url}/proxy/maps/metadata/summary`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(summaryPreflight.status, 200);
    assert.equal(summaryPreflight.headers.get("access-control-allow-origin"), origin);

    const summaryResponse = await fetch(`${url}/proxy/maps/metadata/summary`, {
      headers: { Origin: origin },
    });
    assert.equal(summaryResponse.status, 200);
    assert.equal(summaryResponse.headers.get("access-control-allow-origin"), origin);
    const summaryBody = await summaryResponse.json();
    assert.equal(summaryBody.success, true);
    assert.equal(summaryBody.data.books && typeof summaryBody.data.books, "object");

    const ownedPreflight = await fetch(`${url}/proxy/adventure/available-user-content`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    });
    assert.equal(ownedPreflight.status, 200);
    assert.equal(ownedPreflight.headers.get("access-control-allow-origin"), origin);

    const ownedResponse = await fetch(`${url}/proxy/adventure/available-user-content`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cobalt: "dummy", betaKey: "dummy" }),
    });
    assert.equal(ownedResponse.status, 200);
    const ownedBody = await ownedResponse.json();
    assert.equal(ownedBody.success, true);
    assert.deepEqual(ownedBody.data, { bookIds: [], enhancementBookIds: [] });

    const libraryResponse = await fetch(`${url}/proxy/library`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ cobalt: "dummy", betaKey: "dummy" }),
    });
    assert.equal(libraryResponse.status, 200);
    const libraryBody = await libraryResponse.json();
    assert.equal(libraryBody.success, true);
    assert.deepEqual(libraryBody.data, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("proxy implements the /spells socket namespace for class spell jobs", async () => {
  const { io } = require("socket.io-client");
  const { createServer: createProxyServer } = require("../index.js");
  const spells = require("../spells.js");
  const authentication = require("../auth.js");
  const originalLoadSpells = spells.loadSpells;
  const originalGetBearerToken = authentication.getBearerToken;

  spells.loadSpells = async (classInfo, cobaltToken, cantrips) => {
    assert.equal(cobaltToken, "spell-cobalt");
    assert.equal(cantrips, true);
    return [{
      name: "Wizard",
      id: 8,
      spells: [
        { definition: { name: "Magic Missile" }, id: 1 },
        { definition: { name: "Fireball" }, id: 2 },
      ],
    }];
  };

  authentication.getBearerToken = async (cacheId, cobalt) => {
    assert.equal(cobalt, "spell-cobalt");
    assert.equal(typeof cacheId, "string");
    return "test-bearer-token";
  };

  const { server, url } = await createProxyServer({ port: 0 });

  try {
    const socket = io(`${url}/spells`, {
      transports: ["websocket"],
      timeout: 5000,
    });

    const authAck = await new Promise((resolve, reject) => {
      const handleConnect = () => {
        socket.emit("auth", { cobalt: "spell-cobalt", betaKey: "beta" }, (res) => {
          resolve(res);
        });
      };
      socket.once("connect", handleConnect);
      socket.once("connect_error", reject);
    });

    assert.deepEqual(authAck, { ok: true, message: "Spell streaming auth ok" });

    const classSpellsEvent = await new Promise((resolve, reject) => {
      socket.on("event", (event) => {
        if (event.kind === "classSpells") {
          resolve(event);
        }
      });

      socket.emit("start", {
        element: "class-spells",
        params: { className: "Wizard", rulesVersion: "2014", cobalt: "spell-cobalt" },
      }, (res) => {
        if (!res || !res.ok) {
          reject(new Error(res?.message || "start failed"));
        }
      });
      socket.once("connect_error", reject);
    });

    assert.equal(classSpellsEvent.kind, "classSpells");
    assert.equal(classSpellsEvent.payload.spells.length, 2);
    socket.disconnect();
  } finally {
    spells.loadSpells = originalLoadSpells;
    authentication.getBearerToken = originalGetBearerToken;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("proxy implements the /items socket namespace for item bulk jobs", async () => {
  const { io } = require("socket.io-client");
  const { createServer: createProxyServer } = require("../index.js");
  const items = require("../items.js");
  const authentication = require("../auth.js");
  const originalExtractItems = items.extractItems;
  const originalGetBearerToken = authentication.getBearerToken;

  items.extractItems = async (cobaltId, campaignId) => {
    assert.equal(cobaltId, "item-cache-id");
    assert.equal(campaignId, "camp-42");
    return [
      { id: 1, name: "Dagger", canBeAddedToInventory: true, sources: [{ sourceId: 1 }] },
      { id: 2, name: "Shield", canBeAddedToInventory: true, sources: [{ sourceId: 2 }] },
    ];
  };

  authentication.getBearerToken = async (cacheId, cobalt) => {
    assert.equal(cobalt, "item-cobalt");
    assert.equal(typeof cacheId, "string");
    return "test-item-bearer";
  };

  const { server, url } = await createProxyServer({ port: 0 });

  try {
    const socket = io(`${url}/items`, {
      transports: ["websocket"],
      timeout: 5000,
    });

    const authAck = await new Promise((resolve, reject) => {
      socket.once("connect", () => {
        socket.emit("auth", { cobalt: "item-cobalt", betaKey: "beta", campaignId: "camp-42" }, (res) => {
          resolve(res);
        });
      });
      socket.once("connect_error", reject);
    });

    assert.deepEqual(authAck, { ok: true, message: "Item streaming auth ok" });

    const itemsEvent = await new Promise((resolve, reject) => {
      socket.on("event", (event) => {
        if (event.kind === "items") {
          resolve(event);
        }
      });

      socket.emit("start", {
        element: "all-items",
        params: { campaignId: "camp-42", cobalt: "item-cobalt" },
      }, (res) => {
        if (!res || !res.ok) {
          reject(new Error(res?.message || "start failed"));
        }
      });
      socket.once("connect_error", reject);
    });

    assert.equal(itemsEvent.kind, "items");
    assert.equal(itemsEvent.payload.items.length, 2);
    socket.disconnect();
  } finally {
    items.extractItems = originalExtractItems;
    authentication.getBearerToken = originalGetBearerToken;
    await new Promise((resolve) => server.close(resolve));
  }
});
