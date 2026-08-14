const CONFIG = require("./config.js");
const authentication = require("./auth.js");
const { fetchJsonWithRetry } = require("./httpClient");


const isValidData = data => {
  return data.success === true;
};


const extractItems = (cobaltId, campaignId) => {
  return new Promise((resolve, reject) => {
    console.log(`[ddb-proxy] [items] Retrieving items for ${cobaltId}`);

    console.log("[ddb-proxy] [items] Items API cache miss");
    const url = CONFIG.urls.itemsAPI(campaignId);
    const headers = (authentication.CACHE_AUTH.exists(cobaltId).data !== null) ? {headers: {"Authorization": `Bearer ${authentication.CACHE_AUTH.exists(cobaltId).data}`}} : {};
    fetchJsonWithRetry(url, headers, {
      retries: 2,
      timeoutMs: 15000,
      retryDelayMs: 250,
      requestKey: `items:${cobaltId}:${campaignId ?? "none"}`,
    })
      .then(({ data: json, ok }) => {
        // console.log(json.data.map(sp => sp.definition.name).join(", "));
        if (ok && isValidData(json)) {
          const filteredItems = json.data.filter(item =>
            item.sources && (item.sources.length === 0 || item.sources.some((source) => source.sourceId != 39))
          );
          console.log(
            `[ddb-proxy] [items] Adding ${filteredItems.length} items to the response for ${cobaltId}`
          );
          resolve(filteredItems);
        } else {
          console.log(`[ddb-proxy] [items] Received no valid item data: ${json.message}`);
          reject(json.message);
        }
      })
      .catch(error => {
        console.log("[ddb-proxy] [items] Error retrieving items");
        console.log(error);
        reject(error);
      });
  });
};

exports.extractItems = extractItems;
