const CONFIG = require("./config.js");
const Cache = require("./cache.js");
const { fetchJsonWithRetry } = require("./httpClient");

var CACHE_CONFIG = new Cache("CONFIG", 1);

const getConfig= () => {
  return new Promise((resolve, reject) => {
    console.log("[ddb-proxy] [lookup] Retrieving DDB config");

    const cache = CACHE_CONFIG.exists("DDB_CONFIG");
    if (cache !== undefined) {
      console.log("[ddb-proxy] [lookup] CONFIG API cache hit");
      return resolve(cache.data);
    }

    const url = CONFIG.urls.configUrl;
    const options = {
      credentials: "include",
      headers: {
        "User-Agent": "Foundry VTT Character Integrator",
        "Accept": "*/*",
      },
      method: "GET",
      mode: "cors",
      redirect: "follow",
    };

    CACHE_CONFIG.getOrCreate("DDB_CONFIG", async () => {
      const response = await fetchJsonWithRetry(url, options, {
        retries: 2,
        timeoutMs: 15000,
        retryDelayMs: 250,
        requestKey: "lookup:ddb-config",
      });
      if (!response.ok) throw new Error("Unable to retrieve DDB config");
      return response.data;
    })
      .then(json => {
        if (json && json.sources) {
          console.log(
            "[ddb-proxy] [lookup] Adding config payload to cache"
          );
          resolve(json);
        } else {
          console.log("[ddb-proxy] [lookup] Received no valid config data: " + JSON.stringify(json));
          reject(json);
        }
      })
      .catch(error => {
        console.log("[ddb-proxy] [lookup] Error retrieving DDB config");
        console.log(error);
        reject(error);
      });

  });
};

exports.getConfig = getConfig;
