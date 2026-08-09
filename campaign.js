// This data is the light version of data available in the character builder
const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const Cache = require("./cache");
const { fetchJsonWithRetry } = require("./httpClient");
var CACHE_CAMPAIGNS = new Cache("CAMPAIGNS", 0.25);

// this endpoint aggressively caches campaigns as it's prone to been marked as a bot
const getCampaigns = (cobalt, cacheId) => {
  return new Promise((resolve, reject) => {
    const auth = authentication.CACHE_AUTH.exists(cacheId);
    if (!auth || !auth.data) {
      reject("Unable to authorise cobalt cookie");
      return;
    }

    const headers = {
      "Authorization": `Bearer ${auth.data}`,
      "User-Agent": "Foundry VTT Character Integrator",
      "Accept": "application/json",
      "Accept-Encoding": "gzip, deflate, br",
      "Cookie": `CobaltSession=${cobalt}`,
    };

    const options = {
      method: "GET",
      headers: headers,
    };

    CACHE_CAMPAIGNS.getOrCreate(cacheId, async () => {
      const response = await fetchJsonWithRetry(CONFIG.urls.campaignsAPI, options, {
        retries: 2,
        timeoutMs: 20000,
        retryDelayMs: 300,
        requestKey: `campaigns:${cacheId}`,
      });
      if (!response.ok) throw new Error(`Campaign API returned status ${response.status}`);
      return response.data;
    })
      .then((json) => {
        if (json.status == "success") {
          resolve(json.data);
        } else if (json.blockScript) {
          reject("You've been marked as a bot by DDB, please try again later");
        } else {
          reject("Unknown error");
        }
      })
      .catch((error) => {
        console.error(`Error fetching campaigns: ${error}`);
        reject(error);
      });
  });
};

exports.getCampaigns = getCampaigns;
