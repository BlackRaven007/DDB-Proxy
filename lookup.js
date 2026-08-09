const CONFIG = require("./config.js");
const Cache = require("./cache.js");
const { fetchJsonWithRetry } = require("./httpClient");

var CACHE_CONFIG = new Cache("CONFIG", 1);

const getConfig= () => {
  return new Promise((resolve, reject) => {
    console.log("Retrieving ddb config");

    const cache = CACHE_CONFIG.exists("DDB_CONFIG");
    console.warn(cache);
    if (cache !== undefined) {
      console.log("CONFIG API CACHE_CONFIG HIT!");
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
            "Adding CACHE_CONFIG to cache..."
          );
          resolve(json);
        } else {
          console.log("Received no valid config data, instead:" + json);
          reject(json);
        }
      })
      .catch(error => {
        console.log("Error retrieving DDB Config");
        console.log(error);
        reject(error);
      });

  });
};

exports.getConfig = getConfig;
