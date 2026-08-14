const crypto = require("crypto");
const Cache = require("./cache");
const CONFIG = require("./config.js");
const { fetchJsonWithRetry } = require("./httpClient");

var CACHE_AUTH = new Cache("AUTH", 0.08);

function isJSON(str) {
  try {
    return (JSON.parse(str) && !!str);
  } catch (e) {
    return false;
  }
}

async function getBearerToken(id, cobalt) {
  try {
    if (!cobalt || cobalt === "") {
      console.log(`[ddb-proxy] [auth] Missing cobalt token for cacheId=${id}`);
      return null;
    }

    if (!isJSON(`{ "cobalt": "${cobalt}" }`)) {
      console.log(`[ddb-proxy] [auth] Invalid token shape for cacheId=${id}`);
      return null;
    }

    console.log(`[ddb-proxy] [auth] Requesting bearer token for cacheId=${id}`);
    const response = await fetchJsonWithRetry(CONFIG.urls.authService, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `CobaltSession=${cobalt}`,
      },
    }, {
      retries: 2,
      timeoutMs: 12000,
      retryDelayMs: 250,
    });

    const data = response.data;
    if (!response.ok || !data?.token || !data.token.length) {
      console.log(`[ddb-proxy] [auth] Bearer token request did not return a usable token for cacheId=${id} (status=${response.status})`);
      return null;
    }

    CACHE_AUTH.add(id, data.token);
    console.log(`[ddb-proxy] [auth] Cached bearer token for cacheId=${id}`);
    return data.token;
  } catch (error) {
    console.log(`[ddb-proxy] [auth] Error retrieving bearer token for cacheId=${id}`);
    console.log(error);
    return null;
  }
}


function getCacheId(value) {
  const hash = crypto.createHash("sha256");
  hash.update(value);
  const cacheId = hash.digest("hex");
  return cacheId;
}



exports.CACHE_AUTH = CACHE_AUTH;
exports.getBearerToken = getBearerToken;
exports.getCacheId = getCacheId;
